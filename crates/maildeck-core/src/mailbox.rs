//! 邮箱读取编排（对应原 mailbox-module.ts）：
//! graph 邮件列表/详情 + 本地缓存直读 + 单条已读。

use crate::account_store::{now_iso, AccountStore};
use crate::contracts::{
    AccountRecord, MailboxListResult, MailboxMessageDetail, MailboxMessageListResult,
};
use crate::credentials::{reveal_refresh_token, TieredTokenStore};
use crate::errors::AppError;
use crate::transports::graph_client::GraphClient;

/// 列表页：优先本地缓存（page>0 时缓存满页即返回），page=1 时可选远端刷新由调用方（jobs 层）决定。
pub fn read_cached_list(
    store: &AccountStore,
    account_id: &str,
    folder_id: &str,
    page: i64,
    page_size: i64,
) -> Result<MailboxMessageListResult, AppError> {
    store
        .get(account_id)
        .map_err(AppError::Unknown)?
        .ok_or_else(|| AppError::AccountNotFound(account_id.to_string()))?;
    let (items, total) = store
        .with_conn(|conn| {
            crate::mail_cache::read_mail_list(conn, account_id, folder_id, page, page_size)
        })
        .map_err(AppError::Unknown)?;
    Ok(MailboxMessageListResult {
        account_id: account_id.to_string(),
        folder_id: folder_id.to_string(),
        page,
        page_size,
        total,
        messages: items,
        source: "cache".into(),
    })
}

/// 远端列表（Graph messages endpoint）+ 本地落缓存。
#[allow(clippy::too_many_arguments)] // 与原版调用形态对齐：store/tokens/record/graph/proxy + 分页参数
pub fn fetch_remote_list(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    graph: &GraphClient,
    proxy_url: &str,
    folder_id: &str,
    page: i64,
    page_size: i64,
) -> Result<MailboxMessageListResult, AppError> {
    let refresh_token = reveal_refresh_token(&record.encrypted_refresh_token)?;
    // 需要有效 access_token：由 jobs 层的 token pipeline 提供；此处允许传入已缓存 token，
    // 若为空则用 refresh_token 直接换发（原版：无 scope，端点轮询）。
    let (access, mode) = match tokens.get_access_with_mode(&record.id) {
        Some((t, m)) if !t.is_empty() => (t, m),
        _ => {
            let resp = crate::oauth::refresh_token_grant(
                &record.client_id,
                &refresh_token,
                proxy_url,
                std::time::Duration::from_secs(15),
            )?;
            let mode = crate::oauth::auth_mode_from_scope(&resp.scope);
            tokens.set_access_token(&record.id, &resp.access_token, resp.expires_in, mode);
            (resp.access_token, mode)
        }
    };
    if mode == "imap" {
        // 原版：imap 账号列表走 IMAP（收件箱用持久化 inboxFolderId，否则先 LIST 发现）
        let target_folder = if folder_id.trim().is_empty() {
            let inbox_id = record.inbox_folder_id.clone().unwrap_or_default();
            if !inbox_id.is_empty() {
                inbox_id
            } else {
                let folders = crate::transports::imap_client::list_folders(
                    &record.email,
                    &access,
                    proxy_url,
                    std::time::Duration::from_secs(15),
                )?;
                folders
                    .iter()
                    .find(|f| ["inbox", "收件箱"].contains(&f.display_name.to_lowercase().as_str()))
                    .map(|f| f.id.clone())
                    .unwrap_or_default()
            }
        } else {
            folder_id.to_string()
        };
        if target_folder.is_empty() {
            return Ok(MailboxMessageListResult {
                account_id: record.id.clone(),
                folder_id: folder_id.to_string(),
                page,
                page_size,
                total: 0,
                messages: Vec::new(),
                source: "imap".into(),
            });
        }
        let result = crate::transports::imap_client::list_messages(
            &record.email,
            &access,
            &target_folder,
            page_size.max(1) as usize,
            "",
            "",
            proxy_url,
            std::time::Duration::from_secs(30),
        )?;
        let messages: Vec<crate::contracts::MailListItem> = result
            .messages
            .into_iter()
            .map(|item| crate::contracts::MailListItem {
                id: item.id,
                subject: item.subject,
                from: item.from,
                received_date_time: item.received_date_time,
                sent_date_time: item.sent_date_time,
                is_read: item.is_read,
                importance: item.importance,
                has_attachments: item.has_attachments,
                body_preview: item.body_preview,
                web_link: None,
            })
            .collect();
        store
            .with_conn(|conn| {
                crate::mail_cache::upsert_mail_messages(conn, &record.id, &target_folder, &messages)
            })
            .map_err(AppError::Unknown)?;
        return Ok(MailboxMessageListResult {
            account_id: record.id.clone(),
            folder_id: target_folder,
            page,
            page_size,
            total: result.total_count,
            messages,
            source: "imap".into(),
        });
    }
    let remote = graph.list_messages(&access, record, folder_id, page, page_size)?;
    store
        .with_conn(|conn| {
            crate::mail_cache::upsert_mail_messages(conn, &record.id, folder_id, &remote.messages)?;
            for (_id, detail) in &remote.details {
                crate::mail_cache::upsert_mail_detail(conn, &record.id, folder_id, detail)?;
            }
            Ok(())
        })
        .map_err(AppError::Unknown)?;
    Ok(MailboxMessageListResult {
        account_id: record.id.clone(),
        folder_id: folder_id.to_string(),
        page,
        page_size,
        total: remote.total,
        messages: remote.messages,
        source: "graph".into(),
    })
}

/// 详情：本地缓存未命中 → Graph 单封拉取 → 落缓存。
pub fn fetch_detail(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    graph: &GraphClient,
    proxy_url: &str,
    folder_id: &str,
    message_id: &str,
) -> Result<MailboxMessageDetail, AppError> {
    if let Some(cached) = store
        .with_conn(|conn| {
            crate::mail_cache::read_mail_detail(conn, &record.id, folder_id, message_id)
        })
        .map_err(AppError::Unknown)?
    {
        return Ok(MailboxMessageDetail {
            account_id: record.id.clone(),
            folder_id: folder_id.to_string(),
            detail: cached,
            source: "cache".into(),
        });
    }
    let (access, mode) = match tokens.get_access_with_mode(&record.id) {
        Some((t, m)) if !t.is_empty() => (t, m),
        _ => {
            let refresh_token = reveal_refresh_token(&record.encrypted_refresh_token)?;
            let resp = crate::oauth::refresh_token_grant(
                &record.client_id,
                &refresh_token,
                proxy_url,
                std::time::Duration::from_secs(15),
            )?;
            let mode = crate::oauth::auth_mode_from_scope(&resp.scope);
            tokens.set_access_token(&record.id, &resp.access_token, resp.expires_in, mode);
            (resp.access_token, mode)
        }
    };
    // 原版 getMessage：按 authMode 路由（imap → getImapMessage，收件箱发现同列表路径）
    let detail = if mode == "imap" {
        let target_folder = if folder_id.trim().is_empty() {
            let inbox_id = record.inbox_folder_id.clone().unwrap_or_default();
            if !inbox_id.is_empty() {
                inbox_id
            } else {
                let folders = crate::transports::imap_client::list_folders(
                    &record.email,
                    &access,
                    proxy_url,
                    std::time::Duration::from_secs(15),
                )?;
                folders
                    .iter()
                    .find(|f| ["inbox", "收件箱"].contains(&f.display_name.to_lowercase().as_str()))
                    .map(|f| f.id.clone())
                    .ok_or_else(|| AppError::Unknown("未找到收件箱".into()))?
            }
        } else {
            folder_id.to_string()
        };
        crate::transports::imap_client::get_message(
            &record.email,
            &access,
            &target_folder,
            message_id,
            proxy_url,
            std::time::Duration::from_secs(30),
        )?
    } else {
        graph.get_message(&access, record, folder_id, message_id)?
    };
    store
        .with_conn(|conn| {
            crate::mail_cache::upsert_mail_detail(conn, &record.id, folder_id, &detail)
        })
        .map_err(AppError::Unknown)?;
    Ok(MailboxMessageDetail {
        account_id: record.id.clone(),
        folder_id: folder_id.to_string(),
        detail,
        source: "graph".into(),
    })
}

/// 单条已读：Graph PATCH + 本地缓存同步。
#[allow(clippy::too_many_arguments)]
pub fn mark_message_read(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    graph: &GraphClient,
    proxy_url: &str,
    folder_id: &str,
    message_id: &str,
    is_read: bool,
) -> Result<(), AppError> {
    let (access, mode) = match tokens.get_access_with_mode(&record.id) {
        Some((t, m)) if !t.is_empty() => (t, m),
        _ => {
            let refresh_token = reveal_refresh_token(&record.encrypted_refresh_token)?;
            let resp = crate::oauth::refresh_token_grant(
                &record.client_id,
                &refresh_token,
                proxy_url,
                std::time::Duration::from_secs(15),
            )?;
            let mode = crate::oauth::auth_mode_from_scope(&resp.scope);
            tokens.set_access_token(&record.id, &resp.access_token, resp.expires_in, mode);
            (resp.access_token, mode)
        }
    };
    if mode == "imap" {
        // 原版 UI 无已读标记 IPC，IMAP 侧 STORE 实现为能力对齐
        crate::transports::imap_client::mark_read(
            &record.email,
            &access,
            folder_id,
            message_id,
            is_read,
            std::time::Duration::from_secs(30),
        )?;
    } else {
        graph.mark_read(&access, record, folder_id, message_id, is_read)?;
    }
    store
        .with_conn(|conn| {
            crate::mail_cache::set_message_read(conn, &record.id, folder_id, message_id, is_read)
        })
        .map_err(AppError::Unknown)?;
    Ok(())
}

/// 收件计数读取（mails 页顶部的统计条）。
pub fn read_inbox_stats(
    store: &AccountStore,
    account_id: &str,
) -> Result<(i64, Option<String>), AppError> {
    let record = store
        .get(account_id)
        .map_err(AppError::Unknown)?
        .ok_or_else(|| AppError::AccountNotFound(account_id.to_string()))?;
    Ok((record.last_inbox_count, record.last_mail_at.clone()))
}

/// MailboxListResult 兼容桥（旧 IPC 契约的单账号快照）。
pub fn build_mailbox_snapshot(
    store: &AccountStore,
    account_id: &str,
) -> Result<MailboxListResult, AppError> {
    let record = store
        .get(account_id)
        .map_err(AppError::Unknown)?
        .ok_or_else(|| AppError::AccountNotFound(account_id.to_string()))?;
    let (messages, total) = store
        .with_conn(|conn| crate::mail_cache::read_mail_list(conn, account_id, "INBOX", 1, 25))
        .map_err(AppError::Unknown)?;
    Ok(MailboxListResult {
        account_id: account_id.to_string(),
        inbox_count: record.last_inbox_count,
        latest_mail_at: record.last_mail_at.clone(),
        total,
        messages,
        fetched_at: now_iso(),
    })
}

// 便于测试直接构造 MailListItem
#[cfg(test)]
use crate::contracts::MailListItem;
#[cfg(test)]
pub(crate) fn test_item(id: &str) -> MailListItem {
    MailListItem {
        id: id.into(),
        subject: format!("s-{id}"),
        from: None,
        received_date_time: Some("2024-05-01T00:00:00Z".into()),
        sent_date_time: None,
        is_read: false,
        importance: "normal".into(),
        has_attachments: false,
        body_preview: None,
        web_link: None,
    }
}

#[allow(dead_code)]
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (tempfile::TempDir, AccountStore) {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AccountStore::open_at(&dir.path().join("t.db")).unwrap();
        (dir, store)
    }

    fn account(id: &str) -> AccountRecord {
        AccountRecord {
            id: id.into(),
            email: format!("{id}@x.com"),
            client_id: "cid".into(),
            encrypted_refresh_token: "enc".into(),
            remark: "".into(),
            group_name: "".into(),
            status: crate::contracts::AccountStatus::Valid,
            last_checked_at: None,
            last_error: None,
            last_refreshed_at: None,
            last_inbox_count: 7,
            last_mail_at: Some("2024-05-01".into()),
            inbox_folder_id: None,
            graph_delta_link: None,
            refresh_cooldown_until: None,
            credential_generation: 1,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn cached_list_requires_existing_account() {
        let (_dir, store) = temp_store();
        let err = read_cached_list(&store, "missing", "INBOX", 1, 25).unwrap_err();
        assert!(matches!(err, AppError::AccountNotFound(_)));
    }

    #[test]
    fn cached_list_reads() {
        let (_dir, store) = temp_store();
        store.insert(&account("a1")).unwrap();
        store
            .with_conn(|conn| {
                crate::mail_cache::replace_account_mail_cache(
                    conn,
                    "a1",
                    "INBOX",
                    &[test_item("m1")],
                    &[],
                    None,
                )
            })
            .unwrap();
        let res = read_cached_list(&store, "a1", "INBOX", 1, 25).unwrap();
        assert_eq!(res.source, "cache");
        assert_eq!(res.messages.len(), 1);
        assert_eq!(res.total, 1);
    }

    #[test]
    fn snapshot_uses_account_stats() {
        let (_dir, store) = temp_store();
        store.insert(&account("a1")).unwrap();
        let snap = build_mailbox_snapshot(&store, "a1").unwrap();
        assert_eq!(snap.inbox_count, 7);
        assert_eq!(snap.latest_mail_at.as_deref(), Some("2024-05-01"));
    }
}

//! mailbox-access.ts 对应：测试连接 / 兜底测试 / 文件夹 / 附件（Graph 主源 + IMAP 兜底）。

use crate::account_store::AccountStore;
use crate::contracts::{AccountRecord, AccountStatus, MailAttachmentMeta, MailFolder};
use crate::credentials::{reveal_refresh_token, TieredTokenStore, TokenSink};
use crate::errors::AppError;
use crate::transports::graph_client::GraphClient;
use crate::transports::imap_client;

// Duration 保留导入供 runtime 外部构造使用。

/// 单账号网络操作的运行时配置（settings 快照投影）。
pub struct MailboxRuntime {
    pub graph: GraphClient,
    pub options: crate::refresh_state::RefreshOptions,
    /// 保留字段：per-request 代理在 reqwest 全局客户端层面处理。
    pub proxy_url: String,
}

/// account-refresh-state.ts 的 INVALID_ACCOUNT_CODES。
fn is_invalid_account_code(code: &str) -> bool {
    matches!(
        code,
        "TOKEN_EXPIRED"
            | "INVALID_CLIENT"
            | "IMAP_AUTH_FAILED"
            | "SCOPE_MISSING"
            | "MAILBOX_NOT_FOUND"
    )
}

fn resolve_failure_status(current: AccountStatus, code: &str) -> AccountStatus {
    if is_invalid_account_code(code) {
        AccountStatus::Invalid
    } else {
        current
    }
}

/// 测试连接结果（renderer 的 TestManyResult 语义）。
pub struct TestConnectionOutcome {
    pub ok: bool,
    pub message: String,
    /// 成功/可写状态失败 → 更新后的记录；STALE_CREDENTIALS → None。
    pub account: Option<AccountRecord>,
    pub error: Option<AppError>,
}

/// 兜底测试结果（renderer 的 TestFallbackResult 语义）。
pub struct TestFallbackOutcome {
    pub ok: bool,
    pub message: String,
    pub transport: String,
    pub count: i64,
    pub elapsed_ms: i64,
    pub account: Option<AccountRecord>,
    pub error: Option<AppError>,
}

/// 取 Graph 访问令牌（force_refresh 固定 true，与测试路径一致；轮换落盘）。
fn get_access_info(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    runtime: &MailboxRuntime,
) -> Result<(String, &'static str), AppError> {
    // 缓存命中：token + 已记录的 authMode
    if let Some((token, mode)) = tokens.get_access_with_mode(&record.id) {
        if !token.is_empty() {
            return Ok((token, mode));
        }
    }
    let refresh_token = reveal_refresh_token(&record.encrypted_refresh_token)?;
    let stored = tokens
        .get(&record.id)
        .unwrap_or_else(|| refresh_token.clone());
    let grant = crate::oauth::refresh_token_grant(
        &record.client_id,
        &stored,
        &runtime.options.proxy_url,
        runtime.options.timeout,
    )?;
    if grant.access_token.is_empty() {
        return Err(AppError::Unknown(
            "token endpoint returned empty access_token".into(),
        ));
    }
    if !grant.refresh_token.is_empty() {
        if let Ok(enc) = crate::credentials::protect_refresh_token(
            &grant.refresh_token,
            crate::credentials::CredentialGeneration::Dpapi,
        ) {
            let _ = store.bump_credential_generation(&record.id, 1, &enc);
            tokens.set(&record.id, &grant.refresh_token);
        }
    }
    let mode = crate::oauth::auth_mode_from_scope(&grant.scope);
    tokens.set_access_token(&record.id, &grant.access_token, grant.expires_in, mode);
    Ok((grant.access_token, mode))
}

/// 仅 Graph 源使用（附件等 IMAP 不支持的能力）。
fn get_graph_token(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    runtime: &MailboxRuntime,
) -> Result<String, AppError> {
    let (token, _mode) = get_access_info(store, tokens, record, runtime)?;
    Ok(token)
}

/// 测试连接：token + 列文件夹 → 状态 valid；失败按错误码落状态（STALE_CREDENTIALS 不写状态）。
pub fn test_connection(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    runtime: &MailboxRuntime,
) -> TestConnectionOutcome {
    // 原版 testConnection：按 authMode 路由（imap → listImapFolders）
    let result = get_access_info(store, tokens, record, runtime).and_then(|(token, mode)| {
        if mode == "imap" {
            crate::transports::imap_client::list_folders(
                &record.email,
                &token,
                &runtime.proxy_url,
                runtime.options.timeout,
            )
            .map(|folders| (token, folders))
        } else {
            runtime
                .graph
                .list_folders(&token)
                .map_err(AppError::from)
                .map(|folders| (token, folders))
        }
    });
    match result {
        Ok((_token, _folders)) => {
            let _ = store.set_status(&record.id, AccountStatus::Valid, None);
            let account = store.get(&record.id).ok().flatten();
            TestConnectionOutcome {
                ok: true,
                message: "连接成功".into(),
                account,
                error: None,
            }
        }
        Err(err) => {
            let message = err.to_string();
            if err.code() == crate::errors::STALE_CREDENTIALS {
                return TestConnectionOutcome {
                    ok: false,
                    message,
                    account: None,
                    error: Some(err),
                };
            }
            let current_status = store
                .get(&record.id)
                .ok()
                .flatten()
                .map(|r| r.status)
                .unwrap_or(AccountStatus::Untested);
            // 测试失败不是一次有效测试：不更新 last_checked_at（set_status 总是写时间戳，
            // 因此失败时直接保持原记录，只在错误码判定为账号级失效时写 invalid）。
            let next_status = resolve_failure_status(current_status, err.code());
            if next_status != current_status {
                let _ = store.set_status(&record.id, next_status, Some(&message));
            }
            let account = store.get(&record.id).ok().flatten();
            TestConnectionOutcome {
                ok: false,
                message,
                account,
                error: Some(err),
            }
        }
    }
}

/// 兜底测试：IMAP XOAUTH2 收件计数。
pub fn test_fallback(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    runtime: &MailboxRuntime,
) -> TestFallbackOutcome {
    let started = std::time::Instant::now();
    let attempt = || -> Result<(String, i64), AppError> {
        let refresh_token = reveal_refresh_token(&record.encrypted_refresh_token)?;
        let stored = tokens
            .get(&record.id)
            .unwrap_or_else(|| refresh_token.clone());
        let grant = crate::oauth::refresh_token_grant(
            &record.client_id,
            &stored,
            &runtime.options.proxy_url,
            runtime.options.timeout,
        )?;
        if grant.access_token.is_empty() {
            return Err(AppError::Unknown(
                "token endpoint returned empty access_token".into(),
            ));
        }
        let (unseen, total) = imap_client::fetch_inbox_counts(
            &record.email,
            &grant.access_token,
            runtime.options.timeout,
        )?;
        Ok((format!("imap (未读 {unseen})"), total))
    };
    match attempt() {
        Ok((transport, count)) => {
            let _ = store.set_status(&record.id, AccountStatus::Valid, None);
            let account = store.get(&record.id).ok().flatten();
            let elapsed_ms = started.elapsed().as_millis() as i64;
            TestFallbackOutcome {
                ok: true,
                message: format!("兜底可用 · {transport} · 收件箱 {count} 封 · {elapsed_ms}ms"),
                transport,
                count,
                elapsed_ms,
                account,
                error: None,
            }
        }
        Err(err) => TestFallbackOutcome {
            ok: false,
            message: err.to_string(),
            transport: "imap".into(),
            count: 0,
            elapsed_ms: started.elapsed().as_millis() as i64,
            account: None,
            error: Some(err),
        },
    }
}

/// 文件夹列表（Graph 主源）。
pub fn list_folders(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    runtime: &MailboxRuntime,
) -> Result<Vec<MailFolder>, AppError> {
    // 原版 mailbox-access.listFolders：按 token.authMode 路由（imap → IMAP LIST）
    let (token, mode) = get_access_info(store, tokens, record, runtime)?;
    if mode == "imap" {
        return crate::transports::imap_client::list_folders(
            &record.email,
            &token,
            &runtime.proxy_url,
            runtime.options.timeout,
        );
    }
    runtime.graph.list_folders(&token).map_err(AppError::from)
}

pub struct MailAttachmentList {
    pub supported: bool,
    pub attachments: Vec<MailAttachmentMeta>,
}

/// 附件列表；非 Graph 源 / helper: 邮件 → supported=false。
pub fn list_attachments(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    runtime: &MailboxRuntime,
    message_id: &str,
) -> Result<MailAttachmentList, AppError> {
    if message_id.starts_with("helper:") {
        return Ok(MailAttachmentList {
            supported: false,
            attachments: Vec::new(),
        });
    }
    // 原版：IMAP 模式拿不到附件列表（界面提示去网页版）
    let (token, mode) = get_access_info(store, tokens, record, runtime)?;
    if mode == "imap" {
        return Ok(MailAttachmentList {
            supported: false,
            attachments: Vec::new(),
        });
    }
    let attachments = runtime
        .graph
        .list_attachments(&token, message_id)
        .map_err(AppError::from)?;
    Ok(MailAttachmentList {
        supported: true,
        attachments,
    })
}

/// 附件原始字节（仅 Graph 源）。
pub fn download_attachment(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    runtime: &MailboxRuntime,
    message_id: &str,
    attachment_id: &str,
) -> Result<(String, Vec<u8>), AppError> {
    let token = get_graph_token(store, tokens, record, runtime)?;
    let metas = runtime
        .graph
        .list_attachments(&token, message_id)
        .map_err(AppError::from)?;
    let name = metas
        .iter()
        .find(|m| m.id == attachment_id)
        .map(|m| m.name.clone())
        .unwrap_or_else(|| "attachment".into());
    let bytes = runtime
        .graph
        .download_attachment(&token, message_id, attachment_id)
        .map_err(AppError::from)?;
    Ok((name, bytes))
}

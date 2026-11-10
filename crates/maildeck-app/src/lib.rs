//! maildeck-app：IPC 命令门面。Tauri 壳的每个 invoke 都应落到这里的一个纯函数，
//! 壳层只做参数反序列化与结果序列化，便于脱离窗口环境测试。

use maildeck_core::account_store::AccountStore;
use maildeck_core::contracts::{
    AppErrorPayload, DeviceCodePoll, DeviceCodeStart, MailboxMessageDetail,
    MailboxMessageListResult, OAuthStart, RefreshReport,
};
use maildeck_core::credentials::TieredTokenStore;
use maildeck_core::errors::AppError;
use maildeck_core::refresh_state::RefreshOptions;
use maildeck_core::transports::GraphClient;
use std::sync::{Arc, Mutex};

pub mod telegram_bot;

/// 全局应用上下文：store + token store + 取消令牌 + 设置缓存。
pub struct AppContext {
    pub store: AccountStore,
    pub tokens: TieredTokenStore,
    pub refresh_cancel: Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>,
    pub oauth_timeout: std::time::Duration,
}

impl AppContext {
    pub fn open() -> Result<Self, String> {
        let _init = maildeck_core::init_user_data();
        let store = AccountStore::open(None)?;
        Ok(Self {
            store,
            tokens: TieredTokenStore::new(),
            refresh_cancel: Mutex::new(None),
            oauth_timeout: std::time::Duration::from_secs(30),
        })
    }

    pub fn graph_client(&self) -> GraphClient {
        // 原版固定 NETWORK_REQUEST_TIMEOUT_MS = 30_000（request-timeout.ts）
        GraphClient::new(
            maildeck_core::contracts::GRAPH_ENDPOINT_V1.to_string(),
            std::time::Duration::from_secs(30),
        )
    }

    pub fn refresh_options(&self) -> RefreshOptions {
        let settings = maildeck_core::settings::get_runtime_settings(
            None,
            &maildeck_core::settings::DefaultSettingsCrypto,
        );
        let concurrency = settings
            .as_ref()
            .map(|s| s.batch_concurrency.max(1) as usize)
            .unwrap_or(4); // DEFAULT_SETTINGS.batchConcurrency
        let proxy_url = settings.map(|s| s.proxy_url).unwrap_or_default();
        RefreshOptions {
            timeout: std::time::Duration::from_secs(30),
            concurrency,
            proxy_url,
            ..RefreshOptions::default()
        }
    }

    /// mailbox_access 的运行时配置投影（createMailboxAccess(settingsSnapshot) 对应）。
    pub fn mailbox_runtime(&self) -> maildeck_core::mailbox_access::MailboxRuntime {
        let proxy_url = maildeck_core::settings::get_runtime_settings(
            None,
            &maildeck_core::settings::DefaultSettingsCrypto,
        )
        .map(|s| s.proxy_url)
        .unwrap_or_default();
        maildeck_core::mailbox_access::MailboxRuntime {
            graph: self.graph_client(),
            options: self.refresh_options(),
            proxy_url,
        }
    }
}

// ---------- accounts ----------

pub fn cmd_account_list(
    ctx: &AppContext,
) -> Result<Vec<maildeck_core::contracts::AccountRecord>, AppError> {
    ctx.store.list().map_err(AppError::Unknown)
}

pub fn cmd_account_add(
    ctx: &AppContext,
    email: &str,
    client_id: &str,
    refresh_token: &str,
    remark: &str,
    group_name: &str,
) -> Result<maildeck_core::contracts::AccountRecord, AppError> {
    if email.trim().is_empty() || client_id.trim().is_empty() || refresh_token.trim().is_empty() {
        return Err(AppError::InvalidRequest(
            "email/clientId/refreshToken 不能为空".into(),
        ));
    }
    if ctx
        .store
        .get_by_email(email)
        .map_err(AppError::Unknown)?
        .is_some()
    {
        return Err(AppError::InvalidRequest(format!("账号已存在: {email}")));
    }
    let encrypted = maildeck_core::credentials::protect_refresh_token(
        refresh_token,
        maildeck_core::credentials::CredentialGeneration::Dpapi,
    )
    .map_err(AppError::Unknown)?;
    let now = maildeck_core::account_store::now_iso();
    let record = maildeck_core::contracts::AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        email: email.trim().to_string(),
        client_id: client_id.trim().to_string(),
        encrypted_refresh_token: encrypted,
        remark: remark.to_string(),
        group_name: group_name.to_string(),
        status: maildeck_core::contracts::AccountStatus::Untested,
        last_checked_at: None,
        last_error: None,
        last_refreshed_at: None,
        last_inbox_count: 0,
        last_mail_at: None,
        inbox_folder_id: None,
        graph_delta_link: None,
        refresh_cooldown_until: None,
        credential_generation: maildeck_core::credentials::CredentialGeneration::Dpapi.as_i64(),
        created_at: now.clone(),
        updated_at: now,
    };
    ctx.store.insert(&record).map_err(AppError::Unknown)?;
    Ok(record)
}

pub fn cmd_account_update(
    ctx: &AppContext,
    id: &str,
    patch: serde_json::Value,
) -> Result<maildeck_core::contracts::AccountRecord, AppError> {
    let mut record = ctx
        .store
        .get(id)
        .map_err(AppError::Unknown)?
        .ok_or_else(|| AppError::AccountNotFound(id.to_string()))?;
    if let Some(v) = patch.get("remark").and_then(|v| v.as_str()) {
        record.remark = v.to_string();
    }
    if let Some(v) = patch.get("groupName").and_then(|v| v.as_str()) {
        record.group_name = v.to_string();
    }
    if let Some(v) = patch.get("clientId").and_then(|v| v.as_str()) {
        if !v.trim().is_empty() {
            record.client_id = v.trim().to_string();
        }
    }
    if let Some(v) = patch.get("refreshToken").and_then(|v| v.as_str()) {
        if !v.trim().is_empty() {
            record.encrypted_refresh_token = maildeck_core::credentials::protect_refresh_token(
                v.trim(),
                maildeck_core::credentials::CredentialGeneration::Dpapi,
            )
            .map_err(AppError::Unknown)?;
            record.credential_generation =
                maildeck_core::credentials::CredentialGeneration::Dpapi.as_i64();
            ctx.tokens.clear_access_token(id);
        }
    }
    record.updated_at = maildeck_core::account_store::now_iso();
    ctx.store.update(&record).map_err(AppError::Unknown)?;
    Ok(record)
}

pub fn cmd_account_delete(ctx: &AppContext, id: &str) -> Result<(), AppError> {
    ctx.store
        .get(id)
        .map_err(AppError::Unknown)?
        .ok_or_else(|| AppError::AccountNotFound(id.to_string()))?;
    ctx.store.delete(id).map_err(AppError::Unknown)?;
    ctx.tokens.clear_access_token(id);
    maildeck_core::credentials::TokenSink::delete(&ctx.tokens, id);
    ctx.tokens.clear_access_token(id);
    ctx.store
        .with_conn(|conn| maildeck_core::mail_cache::clear_mail_cache(conn, id))
        .map_err(AppError::Unknown)?;
    Ok(())
}

// ---------- import ----------

/// 导入文本预览（accounts:previewImportText）。
pub fn cmd_accounts_preview_import_text(
    ctx: &AppContext,
    text: &str,
) -> Result<maildeck_core::contracts::ImportPreviewResult, AppError> {
    let inputs = maildeck_core::import_module::parse_account_import(text);
    maildeck_core::import_module::preview_accounts(&ctx.store, &inputs)
}

/// 导入文本（accounts:importText）：upsert 语义 + 受影响账号凭据缓存失效。
pub fn cmd_accounts_import_text(
    ctx: &AppContext,
    text: &str,
) -> Result<maildeck_core::contracts::ImportResult, AppError> {
    let inputs = maildeck_core::import_module::parse_account_import(text);
    let result = maildeck_core::import_module::upsert_accounts(&ctx.store, &inputs)?;
    for account in &result.accounts {
        ctx.tokens.clear_access_token(&account.id);
    }
    Ok(result)
}

/// 单条 upsert（accounts:upsert）。
pub fn cmd_accounts_upsert(
    ctx: &AppContext,
    input: maildeck_core::import_module::AccountInput,
) -> Result<maildeck_core::contracts::ImportResult, AppError> {
    let result = maildeck_core::import_module::upsert_accounts(&ctx.store, &[input])?;
    for account in &result.accounts {
        ctx.tokens.clear_access_token(&account.id);
    }
    Ok(result)
}

/// 账号编辑（accounts:update）：凭据/身份变化重置状态。
pub fn cmd_accounts_update_input(
    ctx: &AppContext,
    input: maildeck_core::contracts::AccountUpdateInput,
) -> Result<maildeck_core::contracts::AccountView, AppError> {
    let view = maildeck_core::import_module::update_account(&ctx.store, &input)?;
    ctx.tokens.clear_access_token(&input.id);
    Ok(view)
}

// ---------- refresh ----------

pub fn cmd_refresh_accounts(
    ctx: &AppContext,
    account_ids: Option<Vec<String>>,
) -> Result<RefreshReport, AppError> {
    let all = ctx.store.list().map_err(AppError::Unknown)?;
    let accounts: Vec<_> = match &account_ids {
        Some(ids) => all.into_iter().filter(|a| ids.contains(&a.id)).collect(),
        None => all,
    };
    if accounts.is_empty() {
        return Err(AppError::InvalidRequest("没有可刷新的账号".into()));
    }
    let options = ctx.refresh_options();
    let ctx2 = maildeck_core::refresh_state::RefreshContext::new(accounts.len());
    {
        let mut slot = ctx
            .refresh_cancel
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        *slot = Some(ctx2.cancel.clone());
    }
    let graph = ctx.graph_client();
    let report = maildeck_core::refresh_state::refresh_accounts(
        &ctx.store,
        &ctx.tokens,
        &accounts,
        &options,
        &ctx2,
        &graph,
    );
    let mut slot = ctx
        .refresh_cancel
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    *slot = None;
    Ok(report)
}

pub fn cmd_refresh_cancel(ctx: &AppContext) -> Result<(), AppError> {
    if let Ok(slot) = ctx.refresh_cancel.lock() {
        if let Some(cancel) = slot.as_ref() {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    Ok(())
}

// ---------- mailbox ----------

pub fn cmd_mail_list(
    ctx: &AppContext,
    account_id: &str,
    folder_id: &str,
    page: i64,
    page_size: i64,
    remote: bool,
) -> Result<MailboxMessageListResult, AppError> {
    let record = ctx
        .store
        .get(account_id)
        .map_err(AppError::Unknown)?
        .ok_or_else(|| AppError::AccountNotFound(account_id.to_string()))?;
    if remote {
        let graph = ctx.graph_client();
        let runtime = ctx.mailbox_runtime();
        maildeck_core::mailbox::fetch_remote_list(
            &ctx.store,
            &ctx.tokens,
            &record,
            &graph,
            &runtime.options.proxy_url,
            folder_id,
            page,
            page_size,
        )
    } else {
        maildeck_core::mailbox::read_cached_list(&ctx.store, account_id, folder_id, page, page_size)
    }
}

pub fn cmd_mail_detail(
    ctx: &AppContext,
    account_id: &str,
    folder_id: &str,
    message_id: &str,
) -> Result<MailboxMessageDetail, AppError> {
    let record = ctx
        .store
        .get(account_id)
        .map_err(AppError::Unknown)?
        .ok_or_else(|| AppError::AccountNotFound(account_id.to_string()))?;
    let graph = ctx.graph_client();
    let runtime = ctx.mailbox_runtime();
    maildeck_core::mailbox::fetch_detail(
        &ctx.store,
        &ctx.tokens,
        &record,
        &graph,
        &runtime.options.proxy_url,
        folder_id,
        message_id,
    )
}

pub fn cmd_mail_mark_read(
    ctx: &AppContext,
    account_id: &str,
    folder_id: &str,
    message_id: &str,
    is_read: bool,
) -> Result<(), AppError> {
    let record = ctx
        .store
        .get(account_id)
        .map_err(AppError::Unknown)?
        .ok_or_else(|| AppError::AccountNotFound(account_id.to_string()))?;
    let graph = ctx.graph_client();
    let runtime = ctx.mailbox_runtime();
    maildeck_core::mailbox::mark_message_read(
        &ctx.store,
        &ctx.tokens,
        &record,
        &graph,
        &runtime.options.proxy_url,
        folder_id,
        message_id,
        is_read,
    )
}

// ---------- oauth ----------

pub fn cmd_oauth_device_start(
    ctx: &AppContext,
    client_id: &str,
    scope: &str,
) -> Result<DeviceCodeStart, AppError> {
    maildeck_core::oauth::device_code_start(client_id, "common", scope, ctx.oauth_timeout)
}

pub fn cmd_oauth_device_poll(
    ctx: &AppContext,
    client_id: &str,
    device_code: &str,
    scope: &str,
) -> Result<DeviceCodePoll, AppError> {
    maildeck_core::oauth::device_code_poll(
        client_id,
        "common",
        device_code,
        scope,
        ctx.oauth_timeout,
    )
}

pub fn cmd_oauth_interactive_start(
    _ctx: &AppContext,
    client_id: &str,
    scope: &str,
    port: u16,
) -> Result<OAuthStart, AppError> {
    maildeck_core::oauth::interactive_start(client_id, "common", port, scope)
}

// ---------- settings ----------

/// camelCase IPC patch → settings.rs SettingsUpdate（与原 appSettingsUpdateSchema 对齐：
/// strictObject 未知字段报错；proxyUrl 走 schema 级 normalizeProxyUrl）。
fn parse_settings_patch(
    patch: &serde_json::Value,
) -> Result<maildeck_core::settings::SettingsUpdate, AppError> {
    use maildeck_core::settings::{normalize_update_proxy_url, SettingsUpdate};
    let mut update: SettingsUpdate = serde_json::from_value(patch.clone())
        .map_err(|e| AppError::InvalidRequest(format!("settings 参数无效: {e}")))?;
    if let Some(url) = &update.proxy_url {
        update.proxy_url = Some(normalize_update_proxy_url(url)?);
    }
    Ok(update)
}

pub fn cmd_settings_get(
    _ctx: &AppContext,
) -> Result<maildeck_core::settings::AppSettings, AppError> {
    maildeck_core::settings::get_public_settings(
        None,
        &maildeck_core::settings::DefaultSettingsCrypto,
    )
}

pub fn cmd_settings_set(
    _ctx: &AppContext,
    patch: serde_json::Value,
) -> Result<maildeck_core::settings::AppSettings, AppError> {
    let update = parse_settings_patch(&patch)?;
    let result = maildeck_core::settings::update_settings(
        &update,
        None,
        &maildeck_core::settings::DefaultSettingsCrypto,
    )?;
    Ok(result.settings)
}

// ---------- mailbox test / folders / attachments（mailbox-access.ts 对应） ----------

fn account_or_err(
    ctx: &AppContext,
    id: &str,
) -> Result<maildeck_core::contracts::AccountRecord, AppError> {
    ctx.store
        .get(id)
        .map_err(AppError::Unknown)?
        .ok_or_else(|| AppError::AccountNotFound(id.to_string()))
}

/// accounts:test：Graph 主源测试连接。
pub fn cmd_account_test(
    ctx: &AppContext,
    account_id: &str,
) -> Result<maildeck_core::contracts::TestManyResult, AppError> {
    let record = account_or_err(ctx, account_id)?;
    let runtime = ctx.mailbox_runtime();
    let outcome =
        maildeck_core::mailbox_access::test_connection(&ctx.store, &ctx.tokens, &record, &runtime);
    Ok(maildeck_core::contracts::TestManyResult {
        account_id: account_id.to_string(),
        account: outcome
            .account
            .as_ref()
            .map(maildeck_core::import_module::to_view),
        ok: outcome.ok,
        message: outcome.ok.then_some(outcome.message),
        error: outcome.error.as_ref().map(|e| e.payload()),
    })
}

/// accounts:testFallback：IMAP 兒底测试。
pub fn cmd_account_test_fallback(
    ctx: &AppContext,
    account_id: &str,
) -> Result<maildeck_core::contracts::TestFallbackResult, AppError> {
    let record = account_or_err(ctx, account_id)?;
    let runtime = ctx.mailbox_runtime();
    let outcome =
        maildeck_core::mailbox_access::test_fallback(&ctx.store, &ctx.tokens, &record, &runtime);
    Ok(maildeck_core::contracts::TestFallbackResult {
        account: outcome
            .account
            .as_ref()
            .map(maildeck_core::import_module::to_view),
        ok: outcome.ok,
        message: outcome.ok.then_some(outcome.message),
        transport: Some(outcome.transport),
        count: Some(outcome.count.max(0) as usize),
        elapsed_ms: outcome.elapsed_ms.max(0) as u64,
        error: outcome.error.as_ref().map(|e| e.payload()),
    })
}

/// accounts:testMany：按批次并发全部测试（原版 runLimited(batchConcurrency) 的同步简化版：
/// 线程池分段并发，总并发 = settings.batchConcurrency）。
pub fn cmd_accounts_test_many(
    ctx: &AppContext,
    account_ids: Vec<String>,
) -> Result<Vec<maildeck_core::contracts::TestManyResult>, AppError> {
    let concurrency = ctx.refresh_options().concurrency.max(1);
    let results: Mutex<Vec<maildeck_core::contracts::TestManyResult>> = Mutex::new(Vec::new());
    let chunks: Vec<&[String]> = account_ids.chunks(concurrency).collect();
    for chunk in chunks {
        std::thread::scope(|scope| {
            for id in chunk {
                let results = &results;
                scope.spawn(move || {
                    let result = cmd_account_test(ctx, id).unwrap_or_else(|e| {
                        maildeck_core::contracts::TestManyResult {
                            account_id: id.clone(),
                            account: None,
                            ok: false,
                            message: None,
                            error: Some(e.payload()),
                        }
                    });
                    if let Ok(mut slot) = results.lock() {
                        slot.push(result);
                    }
                });
            }
        });
    }
    let mut out = results
        .into_inner()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    out.sort_by(|a, b| a.account_id.cmp(&b.account_id));
    Ok(out)
}

/// mail:listFolders。
pub fn cmd_mail_folders(
    ctx: &AppContext,
    account_id: &str,
) -> Result<Vec<maildeck_core::contracts::MailFolder>, AppError> {
    let record = account_or_err(ctx, account_id)?;
    let runtime = ctx.mailbox_runtime();
    maildeck_core::mailbox_access::list_folders(&ctx.store, &ctx.tokens, &record, &runtime)
}

/// mail:listAttachments。
pub fn cmd_mail_attachments(
    ctx: &AppContext,
    account_id: &str,
    message_id: &str,
) -> Result<maildeck_core::contracts::MailAttachmentListResult, AppError> {
    let record = account_or_err(ctx, account_id)?;
    let runtime = ctx.mailbox_runtime();
    let list = maildeck_core::mailbox_access::list_attachments(
        &ctx.store,
        &ctx.tokens,
        &record,
        &runtime,
        message_id,
    )?;
    Ok(maildeck_core::contracts::MailAttachmentListResult {
        supported: list.supported,
        attachments: list.attachments,
    })
}

pub struct DownloadedAttachment {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// mail:saveAttachment 的第一步：拿字节（对话框在壳层处理）。
pub fn cmd_mail_attachment_bytes(
    ctx: &AppContext,
    account_id: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<DownloadedAttachment, AppError> {
    let record = account_or_err(ctx, account_id)?;
    let runtime = ctx.mailbox_runtime();
    let (name, bytes) = maildeck_core::mailbox_access::download_attachment(
        &ctx.store,
        &ctx.tokens,
        &record,
        &runtime,
        message_id,
        attachment_id,
    )?;
    Ok(DownloadedAttachment { name, bytes })
}

/// mail:cacheStats。
pub fn cmd_mail_cache_stats(
    ctx: &AppContext,
) -> Result<maildeck_core::contracts::MailCacheStats, AppError> {
    ctx.store
        .with_conn(maildeck_core::mail_cache::get_mail_cache_stats)
        .map_err(AppError::Unknown)
}

/// mail:clearCache：指定账号或全部。
pub fn cmd_mail_clear_cache(
    ctx: &AppContext,
    account_id: Option<&str>,
) -> Result<serde_json::Value, AppError> {
    let cleared = match account_id {
        Some(id) => {
            ctx.store
                .with_conn(|conn| maildeck_core::mail_cache::clear_mail_cache(conn, id))
                .map_err(AppError::Unknown)?;
            serde_json::json!(1)
        }
        None => {
            ctx.store
                .with_conn(maildeck_core::mail_cache::clear_all_mail_cache)
                .map_err(AppError::Unknown)?;
            serde_json::json!("all")
        }
    };
    Ok(serde_json::json!({ "cleared": cleared }))
}

// ---------- 外部链接白名单（shared/web-mail-url.ts 移植） ----------

const ALLOWED_WEB_MAIL_HOSTS: [&str; 8] = [
    "outlook.office.com",
    "outlook.office365.com",
    "outlook.live.com",
    "outlook.com",
    "office.com",
    "office365.com",
    "microsoft365.com",
    "outlook.cn",
];

const ALLOWED_ACCOUNT_HOSTS: [&str; 6] = [
    "microsoft.com",
    "live.com",
    "microsoftonline.com",
    "microsoftonline.cn",
    "chinacloudapi.cn",
    "msauth.net",
];

fn allowed_host(host: &str, candidates: &[&str]) -> bool {
    let host = host.to_lowercase();
    candidates
        .iter()
        .any(|c| host == *c || host.ends_with(&format!(".{c}")))
}

fn parse_https_url(raw: &str) -> Option<url::Url> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(value).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    Some(parsed)
}

/// safeWebMailUrl 移植。
pub fn safe_web_mail_url(raw: &str) -> Option<String> {
    let parsed = parse_https_url(raw)?;
    let host = parsed.host_str()?;
    allowed_host(host, &ALLOWED_WEB_MAIL_HOSTS).then(|| parsed.to_string())
}

/// safeAccountUrl 移植。
pub fn safe_account_url(raw: &str) -> Option<String> {
    let parsed = parse_https_url(raw)?;
    let host = parsed.host_str()?;
    allowed_host(host, &ALLOWED_ACCOUNT_HOSTS).then(|| parsed.to_string())
}

/// app:openExternal：白名单校验（实际打开在壳层完成）。
pub fn cmd_app_validate_external_url(raw: &str) -> Result<String, AppError> {
    safe_web_mail_url(raw)
        .or_else(|| safe_account_url(raw))
        .ok_or_else(|| {
            AppError::InvalidRequest("只允许打开 Outlook 网页版或微软账号相关地址".into())
        })
}

// ---------- error bridge ----------

pub fn error_payload(err: &AppError) -> AppErrorPayload {
    err.payload()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ctx() -> (tempfile::TempDir, AppContext) {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AccountStore::open_at(&dir.path().join("t.db")).unwrap();
        (
            dir,
            AppContext {
                store,
                tokens: TieredTokenStore::new(),
                refresh_cancel: Mutex::new(None),
                oauth_timeout: std::time::Duration::from_secs(3),
            },
        )
    }

    #[test]
    fn add_update_delete_account_flow() {
        let (_dir, ctx) = temp_ctx();
        let rec = cmd_account_add(&ctx, "a@x.com", "cid", "rt", "note", "grp").unwrap();
        assert_eq!(
            rec.status,
            maildeck_core::contracts::AccountStatus::Untested
        );
        assert_eq!(rec.credential_generation, 1);
        // 加密落库
        let stored = ctx.store.get(&rec.id).unwrap().unwrap();
        assert!(stored
            .encrypted_refresh_token
            .starts_with(maildeck_core::crypto::secret_prefix()));
        // 重复添加被拒
        assert!(cmd_account_add(&ctx, "a@x.com", "cid", "rt", "", "").is_err());
        // patch
        let upd =
            cmd_account_update(&ctx, &rec.id, serde_json::json!({"remark": "new-note"})).unwrap();
        assert_eq!(upd.remark, "new-note");
        // 换 token
        let upd =
            cmd_account_update(&ctx, &rec.id, serde_json::json!({"refreshToken": "rt-2"})).unwrap();
        assert!(upd
            .encrypted_refresh_token
            .starts_with(maildeck_core::crypto::secret_prefix()));
        // 删除（含缓存清理）
        cmd_account_delete(&ctx, &rec.id).unwrap();
        assert!(ctx.store.get(&rec.id).unwrap().is_none());
    }

    #[test]
    fn refresh_empty_selection_rejected() {
        let (_dir, ctx) = temp_ctx();
        let err = cmd_refresh_accounts(&ctx, Some(vec![])).unwrap_err();
        assert!(matches!(err, AppError::InvalidRequest(_)));
    }

    #[test]
    fn mail_list_missing_account() {
        let (_dir, ctx) = temp_ctx();
        let err = cmd_mail_list(&ctx, "missing", "INBOX", 1, 25, false).unwrap_err();
        assert!(matches!(err, AppError::AccountNotFound(_)));
    }

    #[test]
    fn cancel_is_noop_when_idle() {
        let (_dir, ctx) = temp_ctx();
        assert!(cmd_refresh_cancel(&ctx).is_ok());
    }

    #[test]
    fn import_text_upsert_flow() {
        let (_dir, ctx) = temp_ctx();
        let uid = uuid::Uuid::new_v4().to_string();
        let token = format!("M.{}", "t".repeat(90));
        let text = format!("Email,client_id,refresh_token\na@x.com,{uid},{token}");
        let preview = cmd_accounts_preview_import_text(&ctx, &text).unwrap();
        assert_eq!(preview.valid, 1);
        assert_eq!(preview.duplicates, 0);
        let result = cmd_accounts_import_text(&ctx, &text).unwrap();
        assert_eq!(result.imported, 1);
        // 重复导入 = 更新
        let again = cmd_accounts_import_text(&ctx, &text).unwrap();
        assert_eq!(again.updated, 1);
        assert_eq!(again.imported, 0);
    }

    #[test]
    fn external_url_whitelist() {
        assert!(cmd_app_validate_external_url("https://outlook.live.com/mail/0/inbox").is_ok());
        assert!(cmd_app_validate_external_url("https://microsoft.com/devicelogin").is_ok());
        assert!(cmd_app_validate_external_url("https://evil.example.com").is_err());
        assert!(cmd_app_validate_external_url("http://outlook.live.com").is_err());
        // 子域名白名单
        assert!(cmd_app_validate_external_url("https://outlook.office365.com/owa").is_ok());
        assert!(cmd_app_validate_external_url("https://notoutlook.live.com.evil.io").is_err());
    }

    #[test]
    fn cache_stats_and_clear() {
        let (_dir, ctx) = temp_ctx();
        let stats = cmd_mail_cache_stats(&ctx).unwrap();
        assert_eq!(stats.message_count, 0);
        assert_eq!(stats.approximate_bytes, 0);
        let cleared = cmd_mail_clear_cache(&ctx, None).unwrap();
        assert_eq!(cleared["cleared"], "all");
        let cleared = cmd_mail_clear_cache(&ctx, Some("a1")).unwrap();
        assert_eq!(cleared["cleared"], 1);
    }

    #[test]
    fn settings_bridge() {
        // settings.json 会写 userData 目录；测试期重定向到临时目录并串行化。
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap();
        let (dir, ctx) = temp_ctx();
        std::env::set_var("MAILDECK_USER_DATA_DIR", dir.path());
        let _ctx = &ctx;
        let s = cmd_settings_get(&ctx).unwrap();
        assert_eq!(s.batch_concurrency, 4); // DEFAULT_SETTINGS.batchConcurrency
        assert!(s.proxy_supported); // 无代理时默认支持
        assert_eq!(s.proxy_url, "");
        let s = cmd_settings_set(&ctx, serde_json::json!({"batchConcurrency": 9})).unwrap();
        assert_eq!(s.batch_concurrency, 9);
        // 越界值夹取到上限（原版 boundedInteger 1..=12）
        let s = cmd_settings_set(&ctx, serde_json::json!({"batchConcurrency": 500})).unwrap();
        assert_eq!(s.batch_concurrency, 12);
        // 代理更新往返
        let s = cmd_settings_set(
            &ctx,
            serde_json::json!({"proxyUrl": "http://127.0.0.1:7890"}),
        )
        .unwrap();
        assert_eq!(s.proxy_url, "http://127.0.0.1:7890");
        // 直连清空
        let s = cmd_settings_set(&ctx, serde_json::json!({"proxyUrl": ""})).unwrap();
        assert_eq!(s.proxy_url, "");
        // 带凭据的 URL 被拒（必须走独立字段）
        assert!(cmd_settings_set(
            &ctx,
            serde_json::json!({"proxyUrl": "http://alice:pw@x.local:80"})
        )
        .is_err());
        // 类型错误被拒
        assert!(cmd_settings_set(&ctx, serde_json::json!({"cacheMessages": "yes"})).is_err());
    }
}

//! IPC 契约类型：与原项目 `electron/shared/ipc-contracts.ts` 一一对应。
//! 常量逐字对应；类型字段名保持 camelCase 以便与 React 渲染层直接互通。

use serde::{Deserialize, Serialize};

pub const IMPORT_TEXT_MAX_BYTES: usize = 10 * 1024 * 1024;
pub const ACCOUNT_BATCH_MAX: usize = 5_000;
pub const MAIL_PAGE_MAX: usize = 100;
pub const SEARCH_MAX_CHARS: usize = 500;
pub const CURSOR_MAX_CHARS: usize = 128;
pub const FOLDER_ID_MAX_CHARS: usize = 512;
pub const APP_ERROR_MESSAGE_MAX_CHARS: usize = 4_096;
pub const DIAGNOSTIC_REQUEST_ID_MAX_CHARS: usize = 1_024;

/// invoke 命令通道名，与原版 IPC_CHANNELS 逐字一致。
pub const IPC_CHANNELS: &[(&str, &str)] = &[
    ("appOpenExternal", "app:openExternal"),
    ("accountsList", "accounts:list"),
    ("settingsGet", "settings:get"),
    ("settingsUpdate", "settings:update"),
    ("jobsCancel", "jobs:cancel"),
    ("accountsPreviewImportText", "accounts:previewImportText"),
    ("accountsImportText", "accounts:importText"),
    ("accountsImportFile", "accounts:importFile"),
    ("accountsUpsert", "accounts:upsert"),
    ("accountsUpdate", "accounts:update"),
    ("accountsDelete", "accounts:delete"),
    ("accountsTest", "accounts:test"),
    ("accountsTestFallback", "accounts:testFallback"),
    ("accountsTestMany", "accounts:testMany"),
    ("mailListFolders", "mail:listFolders"),
    ("mailListMessages", "mail:listMessages"),
    ("mailGetMessage", "mail:getMessage"),
    ("mailListAttachments", "mail:listAttachments"),
    ("mailSaveAttachment", "mail:saveAttachment"),
    ("mailCacheStats", "mail:cacheStats"),
    ("mailClearCache", "mail:clearCache"),
    ("mailRefreshMany", "mail:refreshMany"),
    ("authStartDeviceCode", "auth:startDeviceCode"),
    ("authCancelDeviceCode", "auth:cancelDeviceCode"),
    ("updateGetState", "update:getState"),
    ("updateCheck", "update:check"),
    ("updateInstall", "update:install"),
];

/// 事件通道名，与原版 IPC_EVENT_CHANNELS 逐字一致。
pub const IPC_EVENT_CHANNELS: &[(&str, &str)] = &[
    ("accountsTestProgress", "accounts:testProgress"),
    ("mailRefreshProgress", "mail:refreshProgress"),
    ("authDeviceCodeState", "auth:deviceCodeState"),
    ("updateState", "update:state"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AccountStatus {
    #[serde(rename = "untested")]
    Untested,
    #[serde(rename = "valid")]
    Valid,
    #[serde(rename = "invalid")]
    Invalid,
}

impl AccountStatus {
    /// DB 存储字符串（与原版 SQLite 列值一致）。
    pub fn as_str(self) -> &'static str {
        match self {
            AccountStatus::Untested => "untested",
            AccountStatus::Valid => "valid",
            AccountStatus::Invalid => "invalid",
        }
    }

    pub fn from(value: &str) -> Self {
        match value {
            "valid" => AccountStatus::Valid,
            "invalid" => AccountStatus::Invalid,
            _ => AccountStatus::Untested,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuthMode {
    #[serde(rename = "graph")]
    Graph,
    #[serde(rename = "imap")]
    Imap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum JobKind {
    #[serde(rename = "test")]
    Test,
    #[serde(rename = "refresh")]
    Refresh,
    #[serde(rename = "refreshSingle")]
    RefreshSingle,
    #[serde(rename = "refreshBackground")]
    RefreshBackground,
}

pub type RefreshJobKind = JobKind; // refresh / refreshSingle / refreshBackground

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum RefreshScope {
    #[serde(rename = "all")]
    #[default]
    All,
    #[serde(rename = "selected")]
    Selected,
}

impl RefreshScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            RefreshScope::All => "all",
            RefreshScope::Selected => "selected",
        }
    }
}

/// 主题（settings-model.ts theme: 'light' | 'dark' | 'system'）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Theme {
    Light,
    #[default]
    Dark,
    System,
}

impl Theme {
    pub fn as_str(&self) -> &'static str {
        match self {
            Theme::Light => "light",
            Theme::Dark => "dark",
            Theme::System => "system",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// 与原版 AppErrorPayload 字段名一致（camelCase 序列化）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppErrorPayload {
    pub code: String, // AppErrorCode 的 SCREAMING_SNAKE 字符串
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<Diagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInput {
    #[serde(rename = "email")]
    pub email: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
    #[serde(rename = "remark", default, skip_serializing_if = "Option::is_none")]
    pub remark: Option<String>,
    #[serde(rename = "group", default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountUpdateInput {
    pub id: String,
    #[serde(rename = "email")]
    pub email: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(
        rename = "refreshToken",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub refresh_token: Option<String>,
    #[serde(rename = "remark", default, skip_serializing_if = "Option::is_none")]
    pub remark: Option<String>,
    #[serde(rename = "group", default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

/// 渲染层投影（对应原版 AccountView）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountView {
    pub id: String,
    pub email: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub remark: String,
    pub group: String,
    #[serde(rename = "authMode", skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<AuthMode>,
    pub status: AccountStatus,
    #[serde(rename = "lastCheckedAt")]
    pub last_checked_at: Option<String>,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[serde(rename = "lastRefreshedAt", skip_serializing_if = "Option::is_none")]
    pub last_refreshed_at: Option<Option<String>>,
    #[serde(rename = "lastInboxCount", skip_serializing_if = "Option::is_none")]
    pub last_inbox_count: Option<i64>,
    #[serde(rename = "lastMailAt", skip_serializing_if = "Option::is_none")]
    pub last_mail_at: Option<Option<String>>,
    #[serde(rename = "lastMailCursor", skip_serializing_if = "Option::is_none")]
    pub last_mail_cursor: Option<Option<String>>,
    #[serde(rename = "inboxFolderId", skip_serializing_if = "Option::is_none")]
    pub inbox_folder_id: Option<Option<String>>,
    #[serde(rename = "graphDeltaLink", skip_serializing_if = "Option::is_none")]
    pub graph_delta_link: Option<Option<String>>,
    #[serde(
        rename = "refreshCooldownUntil",
        skip_serializing_if = "Option::is_none"
    )]
    pub refresh_cooldown_until: Option<Option<String>>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailFolder {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "totalItemCount")]
    pub total_item_count: i64,
    #[serde(rename = "unreadItemCount")]
    pub unread_item_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailAddress {
    pub name: String,
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailMessageSummary {
    pub id: String,
    pub subject: String,
    pub from: Option<MailAddress>,
    #[serde(rename = "receivedDateTime")]
    pub received_date_time: Option<String>,
    #[serde(rename = "sentDateTime")]
    pub sent_date_time: Option<String>,
    #[serde(rename = "isRead")]
    pub is_read: bool,
    pub importance: String,
    #[serde(rename = "hasAttachments")]
    pub has_attachments: bool,
    #[serde(rename = "bodyPreview")]
    pub body_preview: String,
    #[serde(rename = "webLink")]
    pub web_link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailMessageDetail {
    #[serde(flatten)]
    pub summary: MailMessageSummary,
    #[serde(rename = "toRecipients")]
    pub to_recipients: Vec<MailAddress>,
    #[serde(rename = "ccRecipients")]
    pub cc_recipients: Vec<MailAddress>,
    pub body: MailBody,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MailBody {
    #[serde(rename = "contentType", default)]
    pub content_type: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailAttachmentMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    pub size: i64,
    #[serde(rename = "isInline")]
    pub is_inline: bool,
}

/// IMAP / Hotmail 兜底账号拿不到附件列表：supported=false 让界面直接提示去网页版。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailAttachmentListResult {
    pub supported: bool,
    pub attachments: Vec<MailAttachmentMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveAttachmentResult {
    pub saved: bool,
    pub canceled: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListAttachmentsOptions {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveAttachmentOptions {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub imported: usize,
    pub updated: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
    pub accounts: Vec<AccountView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPreviewResult {
    pub total: usize,
    pub valid: usize,
    pub duplicates: usize,
    pub invalid: usize,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// testConnection / testMany 的单账号结果（原版 TestManyResult）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestManyResult {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "account")]
    pub account: Option<AccountView>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestFallbackResult {
    #[serde(rename = "account")]
    pub account: Option<AccountView>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshMetrics {
    #[serde(rename = "tokenMs")]
    pub token_ms: u64,
    #[serde(rename = "mailMs")]
    pub mail_ms: u64,
    #[serde(rename = "cacheMs")]
    pub cache_ms: u64,
    #[serde(rename = "stateMs")]
    pub state_ms: u64,
    #[serde(rename = "totalMs")]
    pub total_ms: u64,
    #[serde(rename = "fallback", skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshManyResult {
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub ok: bool,
    pub count: usize,
    #[serde(rename = "newCount", skip_serializing_if = "Option::is_none")]
    pub new_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppErrorPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<RefreshMetrics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestProgressEvent {
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub kind: String, // "test"
    pub completed: usize,
    pub total: usize,
    pub ok: usize,
    pub failed: usize,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshProgressEvent {
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub kind: String, // refresh | refreshSingle | refreshBackground
    pub completed: usize,
    pub total: usize,
    pub ok: usize,
    pub failed: usize,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppErrorPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<RefreshMetrics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListMessagesOptions {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "top", default, skip_serializing_if = "Option::is_none")]
    pub top: Option<usize>,
    #[serde(rename = "skip", default, skip_serializing_if = "Option::is_none")]
    pub skip: Option<usize>,
    #[serde(rename = "search", default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(
        rename = "forceRefresh",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub force_refresh: Option<bool>,
    #[serde(rename = "cursor", default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(rename = "since", default, skip_serializing_if = "Option::is_none")]
    pub since: Option<Option<String>>,
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetMessageOptions {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
}

/// MailListResult：stale=true 表示来自过期缓存兜底，渲染层要挂提示条。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailListResult {
    pub messages: Vec<MailMessageSummary>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
    #[serde(rename = "totalCount", skip_serializing_if = "Option::is_none")]
    pub total_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_reason: Option<String>,
}

/// 设置弹窗里“缓存占用”那一行：计数 + 缓存文本的实际字节数。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailCacheStats {
    #[serde(rename = "accountCount")]
    pub account_count: usize,
    #[serde(rename = "messageCount")]
    pub message_count: usize,
    #[serde(rename = "bodyCount")]
    pub body_count: usize,
    #[serde(rename = "approximateBytes")]
    pub approximate_bytes: i64,
}

/// IPC 合同：settings:getEffective 返回的 EffectiveSettings 投影（settings.ts getEffectiveSettings）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    pub theme: Theme,
    pub language: String,
    #[serde(rename = "refreshIntervalMinutes")]
    pub refresh_interval_minutes: i64,
    #[serde(rename = "refreshScope")]
    pub refresh_scope: RefreshScope,
    #[serde(rename = "cacheMessages")]
    pub cache_messages: bool,
    #[serde(rename = "cacheBodies")]
    pub cache_bodies: bool,
    #[serde(rename = "batchSize")]
    pub batch_size: i64,
    #[serde(rename = "maxConcurrent")]
    pub max_concurrent: i64,
    #[serde(rename = "fetchTimeoutMs")]
    pub fetch_timeout_ms: i64,
    #[serde(rename = "retentionDays")]
    pub retention_days: i64,
    #[serde(rename = "proxyEnabled")]
    pub proxy_enabled: bool,
    #[serde(rename = "proxyProtocol")]
    pub proxy_protocol: String,
    #[serde(rename = "proxyHostname")]
    pub proxy_hostname: String,
    #[serde(rename = "proxyPort")]
    pub proxy_port: String,
    #[serde(rename = "proxyUsername")]
    pub proxy_username: String,
    #[serde(rename = "proxyConfigured")]
    pub proxy_configured: bool,
    #[serde(rename = "hasInternalProxyApiKey")]
    pub has_internal_proxy_api_key: bool,
    #[serde(rename = "internalProxyGeneration")]
    pub internal_proxy_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeSessionView {
    #[serde(rename = "userCode")]
    pub user_code: String,
    #[serde(rename = "verificationUri")]
    pub verification_uri: String,
    #[serde(rename = "expiresInSec")]
    pub expires_in_sec: u64,
    #[serde(rename = "clientId")]
    pub client_id: String,
}

pub type DeviceCodeFailureCode = String; // DEVICE_CODE_EXPIRED | DEVICE_CODE_DECLINED | NETWORK_ERROR | UNKNOWN

/// 设备代码登录状态事件：waiting 展示短码，authorized 带回 refresh_token。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "phase")]
pub enum DeviceCodeStateEvent {
    #[serde(rename = "waiting")]
    Waiting {
        #[serde(rename = "userCode")]
        user_code: String,
        #[serde(rename = "verificationUri")]
        verification_uri: String,
        #[serde(rename = "expiresInSec")]
        expires_in_sec: u64,
        #[serde(rename = "clientId")]
        client_id: String,
    },
    #[serde(rename = "authorized")]
    Authorized {
        #[serde(rename = "clientId")]
        client_id: String,
        #[serde(rename = "refreshToken")]
        refresh_token: String,
        #[serde(rename = "email")]
        email: Option<String>,
        #[serde(rename = "scope")]
        scope: String,
    },
    #[serde(rename = "failed")]
    Failed {
        #[serde(rename = "code")]
        code: DeviceCodeFailureCode,
        #[serde(rename = "message")]
        message: String,
    },
    #[serde(rename = "canceled")]
    Canceled {},
}

pub type UpdatePhase = String; // idle|checking|available|not-available|downloading|downloaded|error|unsupported
pub type UpdateErrorCode = String; // UPDATE_NETWORK|UPDATE_CHECK_FAILED|UPDATE_DOWNLOAD_FAILED

/// 自动更新完整状态快照：每次变化全量广播。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateStateEvent {
    pub phase: UpdatePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transferred_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_per_second: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>, // "portable"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<UpdateErrorCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// 请求校验（等价原 zod schema 的限值部分）
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
#[error("IPC request rejected: {0}")]
pub struct IpcRequestValidationError(pub String);

pub type VResult<T> = Result<T, IpcRequestValidationError>;

fn trimmed(value: &str) -> &str {
    value.trim()
}

pub fn validate_account_id(value: &str) -> VResult<String> {
    let v = trimmed(value);
    if v.is_empty() || v.len() > 128 {
        return Err(IpcRequestValidationError(
            "accountId: must be 1..128 chars".into(),
        ));
    }
    Ok(v.to_string())
}

pub fn validate_job_id(value: &str) -> VResult<String> {
    let v = trimmed(value);
    if v.is_empty() || v.len() > 128 {
        return Err(IpcRequestValidationError(
            "jobId: must be 1..128 chars".into(),
        ));
    }
    Ok(v.to_string())
}

pub fn validate_message_id(value: &str) -> VResult<String> {
    let v = trimmed(value);
    if v.is_empty() || v.len() > 2_048 {
        return Err(IpcRequestValidationError(
            "messageId: must be 1..2048 chars".into(),
        ));
    }
    Ok(v.to_string())
}

pub fn validate_email(value: &str) -> VResult<String> {
    let v = trimmed(value);
    if v.is_empty() || v.len() > 320 || !is_email(v) {
        return Err(IpcRequestValidationError("email: invalid email".into()));
    }
    Ok(v.to_string())
}

/// 宽松 email 校验（与 z.email() 等价级别的常见形态判断，不做完整 RFC 解析）。
pub fn is_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !value.contains(' ')
}

pub fn validate_client_id(value: &str) -> VResult<String> {
    let v = trimmed(value);
    if v.is_empty() || v.len() > 256 {
        return Err(IpcRequestValidationError(
            "clientId: must be 1..256 chars".into(),
        ));
    }
    Ok(v.to_string())
}

pub fn validate_refresh_token(value: &str) -> VResult<String> {
    let v = trimmed(value);
    if v.is_empty() || v.len() > 32_768 {
        return Err(IpcRequestValidationError(
            "refreshToken: must be 1..32768 chars".into(),
        ));
    }
    Ok(v.to_string())
}

pub fn validate_optional_short(value: &Option<String>) -> VResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(v) => {
            let v = trimmed(v);
            if v.len() > 1_000 {
                return Err(IpcRequestValidationError(
                    "remark: must be at most 1000 chars".into(),
                ));
            }
            Ok((!v.is_empty()).then(|| v.to_string()))
        }
    }
}

pub fn validate_group(value: &Option<String>) -> VResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(v) => {
            let v = trimmed(v);
            if v.len() > 200 {
                return Err(IpcRequestValidationError(
                    "group: must be at most 200 chars".into(),
                ));
            }
            Ok((!v.is_empty()).then(|| v.to_string()))
        }
    }
}

pub fn validate_account_batch(ids: &[String]) -> VResult<Vec<String>> {
    if ids.len() > ACCOUNT_BATCH_MAX {
        return Err(IpcRequestValidationError(format!(
            "accounts: batch must not exceed {ACCOUNT_BATCH_MAX}"
        )));
    }
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.push(validate_account_id(id)?);
    }
    out.sort();
    out.dedup();
    Ok(out)
}

pub fn validate_search(value: &Option<String>) -> VResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(v) => {
            let v = trimmed(v);
            if v.len() > SEARCH_MAX_CHARS {
                return Err(IpcRequestValidationError(
                    "search: must be at most 500 chars".into(),
                ));
            }
            Ok((!v.is_empty()).then(|| v.to_string()))
        }
    }
}

pub fn validate_cursor(value: &Option<String>) -> VResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(v) => {
            let v = trimmed(v);
            if v.len() > CURSOR_MAX_CHARS {
                return Err(IpcRequestValidationError(
                    "cursor: must be at most 128 chars".into(),
                ));
            }
            Ok((!v.is_empty()).then(|| v.to_string()))
        }
    }
}

pub fn validate_folder_id(value: &Option<String>) -> VResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(v) => {
            let v = trimmed(v);
            if v.is_empty() || v.len() > FOLDER_ID_MAX_CHARS {
                return Err(IpcRequestValidationError(
                    "folderId: must be 1..512 chars".into(),
                ));
            }
            Ok(Some(v.to_string()))
        }
    }
}

/// 进度事件计数不变式：completed ≤ total；ok + failed == completed；total ≥ 1。
pub fn validate_progress_counters(
    completed: usize,
    total: usize,
    ok: usize,
    failed: usize,
) -> VResult<()> {
    if !(1..=ACCOUNT_BATCH_MAX).contains(&total) {
        return Err(IpcRequestValidationError("total: must be 1..5000".into()));
    }
    if completed > total {
        return Err(IpcRequestValidationError(
            "completed: must not exceed total".into(),
        ));
    }
    if ok + failed != completed {
        return Err(IpcRequestValidationError(
            "completed: must equal ok plus failed".into(),
        ));
    }
    Ok(())
}

pub fn validate_list_messages_options(o: &ListMessagesOptions) -> VResult<ListMessagesOptions> {
    if let Some(top) = o.top {
        if !(1..=MAIL_PAGE_MAX).contains(&top) {
            return Err(IpcRequestValidationError(format!(
                "top: must be 1..{MAIL_PAGE_MAX}"
            )));
        }
    }
    if let Some(skip) = o.skip {
        if skip > 1_000_000 {
            return Err(IpcRequestValidationError(
                "skip: must be at most 1000000".into(),
            ));
        }
    }
    Ok(ListMessagesOptions {
        account_id: validate_account_id(&o.account_id)?,
        top: o.top,
        skip: o.skip,
        search: validate_search(&o.search)?,
        force_refresh: o.force_refresh,
        cursor: validate_cursor(&o.cursor)?,
        since: o.since.clone(),
        folder_id: validate_folder_id(&o.folder_id)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_validation_matches_loose_zod_level() {
        assert!(validate_email(" a@b.co ").is_ok());
        assert!(validate_email("not-an-email").is_err());
        assert!(validate_email("a@b").is_err());
        assert!(validate_email("a b@c.com").is_err());
    }

    #[test]
    fn progress_counters_invariant() {
        assert!(validate_progress_counters(3, 10, 2, 1).is_ok());
        assert!(validate_progress_counters(11, 10, 11, 0).is_err());
        assert!(validate_progress_counters(3, 10, 1, 1).is_err());
        assert!(validate_progress_counters(0, 0, 0, 0).is_err());
    }

    #[test]
    fn account_batch_dedups_and_sorts() {
        let out = validate_account_batch(&[" b ".into(), "a".into(), "b".into()]).unwrap();
        assert_eq!(out, vec!["a", "b"]);
    }

    #[test]
    fn constants_match_original() {
        assert_eq!(MAIL_PAGE_MAX, 100);
        assert_eq!(ACCOUNT_BATCH_MAX, 5_000);
        assert_eq!(IMPORT_TEXT_MAX_BYTES, 10 * 1024 * 1024);
    }
}

// ---------------------------------------------------------------------------
// 内部领域类型（对应原 electron/main 内部类型：account-store 行、mail-cache 行、
// refresh-coordinator 报告、oauth/device-code 内部结构）。不直接暴露给 IPC 的部分
// 也统一放在这里，保证序列化字段名与原版一致（camelCase）。
// ---------------------------------------------------------------------------

/// 账号 DB 行（electron/main/account-store.ts 的 AccountRow）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub id: String,
    pub email: String,
    pub client_id: String,
    pub encrypted_refresh_token: String,
    pub remark: String,
    pub group_name: String,
    pub status: AccountStatus,
    pub last_checked_at: Option<String>,
    pub last_error: Option<String>,
    pub last_refreshed_at: Option<String>,
    pub last_inbox_count: i64,
    pub last_mail_at: Option<String>,
    pub inbox_folder_id: Option<String>,
    pub graph_delta_link: Option<String>,
    pub refresh_cooldown_until: Option<String>,
    pub credential_generation: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 邮件列表项（mail-cache.ts 缓存行 / Graph list 投影）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailListItem {
    pub id: String,
    pub subject: String,
    pub from: Option<MailRecipient>,
    pub received_date_time: Option<String>,
    pub sent_date_time: Option<String>,
    pub is_read: bool,
    pub importance: String,
    pub has_attachments: bool,
    pub body_preview: Option<String>,
    pub web_link: Option<String>,
}

/// 收件人（可缺省形态，Graph from/to/cc 解析用）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailRecipient {
    pub name: Option<String>,
    pub address: Option<String>,
}

/// flag 节点（Graph flag.flagStatus）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFlag {
    pub flag_status: String,
}

pub type MailDetailBody = MailBody;
pub type MailAttachment = MailAttachmentMeta;

/// 邮件详情（Graph 单封 / 缓存 detail_json）。缓存行可能缺 attachments/flag 等字段，宽容反序列化。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDetail {
    pub id: String,
    #[serde(default, deserialize_with = "null_or_default")]
    pub subject: String,
    #[serde(default, deserialize_with = "null_or_default")]
    pub body: MailDetailBody,
    #[serde(default, deserialize_with = "null_or_default")]
    pub from: MailRecipient,
    #[serde(default, deserialize_with = "null_or_default")]
    pub to_recipients: Vec<MailRecipient>,
    #[serde(default, deserialize_with = "null_or_default")]
    pub cc_recipients: Vec<MailRecipient>,
    pub received_date_time: Option<String>,
    pub sent_date_time: Option<String>,
    #[serde(default)]
    pub is_read: bool,
    #[serde(default)]
    pub has_attachments: bool,
    #[serde(default, deserialize_with = "null_or_default")]
    pub attachments: Vec<MailAttachment>,
    pub conversation_id: Option<String>,
    pub web_link: Option<String>,
    #[serde(default, deserialize_with = "null_or_default")]
    pub importance: String,
    #[serde(default, deserialize_with = "null_or_default")]
    pub flag: MailFlag,
}

/// JSON 字段缺失或为 null 时回退到 T::Default（原版 zod nullable 兼容）。
fn null_or_default<'de, T, D>(deserializer: D) -> Result<T, D::Error>
where
    T: serde::Deserialize<'de> + Default,
    D: serde::Deserializer<'de>,
{
    let value: Option<T> = serde::Deserialize::deserialize(deserializer)?;
    Ok(value.unwrap_or_default())
}

/// 单账号邮箱快照（旧 mailbox 通道契约的投影）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxListResult {
    pub account_id: String,
    pub inbox_count: i64,
    pub latest_mail_at: Option<String>,
    pub total: i64,
    pub messages: Vec<MailListItem>,
    pub fetched_at: String,
}

/// 分页邮件列表结果（source = "cache" | "graph"）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxMessageListResult {
    pub account_id: String,
    pub folder_id: String,
    pub page: i64,
    pub page_size: i64,
    pub total: i64,
    pub messages: Vec<MailListItem>,
    pub source: String,
}

/// 单封详情结果（source = "cache" | "graph"）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxMessageDetail {
    pub account_id: String,
    pub folder_id: String,
    pub detail: MailDetail,
    pub source: String,
}

/// OAuth token 响应（auth-server token endpoint 形态）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub scope: String,
    pub token_type: String,
}

/// device-code 第一步（v2 endpoints devicecode）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: i64,
    pub interval: i64,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceCodePollPending {
    AuthorizationPending,
    SlowDown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum DeviceCodePoll {
    Completed(OAuthTokenResponse),
    Pending(DeviceCodePollPending),
}

/// interactive（PKCE）登录第一步参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStart {
    pub authorize_url: String,
    pub state: String,
    pub code_verifier: String,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum OAuthCallbackResult {
    Tokens(OAuthTokenResponse),
}

/// 邮件来源（graph 主通道 / imap 兜底）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxSource {
    Graph,
    Imap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefreshStatusSummary {
    Refreshed,
    Failed,
    Skipped,
    CooldownSkipped,
}

/// 单账号刷新结果（refresh-coordinator 内部聚合行）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshAccountOutcome {
    pub account_id: String,
    pub email: String,
    pub status: RefreshStatusSummary,
    pub inbox_count: Option<i64>,
    pub error: Option<String>,
    pub cooldown_seconds: Option<i64>,
}

/// 批量刷新报告（refresh-coordinator 汇总）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshReport {
    pub total: usize,
    pub refreshed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub canceled: bool,
    pub duration_ms: i64,
    pub total_inbox_count: i64,
    pub outcomes: Vec<RefreshAccountOutcome>,
    pub started_at: String,
}

/// 批量导入报告（import-parser 汇总）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountImportReport {
    pub source: String,
    pub total: usize,
    pub imported: usize,
    pub skipped_duplicate: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

// 运行时常量（原 graph-client.ts / request-timeout.ts 默认值）。
pub const GRAPH_ENDPOINT_V1: &str = "https://graph.microsoft.com/v1.0";
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 15_000;

// 设置更新入参见 settings.rs SettingsUpdate（含 camelCase serde 命名，与原 appSettingsUpdateSchema 对齐）。

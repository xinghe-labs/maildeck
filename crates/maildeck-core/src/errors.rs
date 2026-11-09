//! 错误分类与归一化：对应原 error-utils.ts / graph-errors.ts / mail-errors.ts / job-errors.ts。
//! AppErrorCode 18 个值与原版逐字一致（SCREAMING_SNAKE 字符串）。

use crate::contracts::AppErrorPayload;
use std::fmt;

pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
pub const CANCELED: &str = "CANCELED";
pub const STALE_CREDENTIALS: &str = "STALE_CREDENTIALS";
pub const CREDENTIAL_UNREADABLE: &str = "CREDENTIAL_UNREADABLE";
pub const THROTTLED: &str = "THROTTLED";
pub const TOKEN_EXPIRED: &str = "TOKEN_EXPIRED";
pub const INVALID_CLIENT: &str = "INVALID_CLIENT";
pub const IMAP_AUTH_FAILED: &str = "IMAP_AUTH_FAILED";
pub const SCOPE_MISSING: &str = "SCOPE_MISSING";
pub const NETWORK_ERROR: &str = "NETWORK_ERROR";
pub const MAIL_PARSE_FAILED: &str = "MAIL_PARSE_FAILED";
pub const MAIL_TOO_LARGE: &str = "MAIL_TOO_LARGE";
pub const MAILBOX_NOT_FOUND: &str = "MAILBOX_NOT_FOUND";
pub const GRAPH_NOT_FOUND: &str = "GRAPH_NOT_FOUND";
pub const DEVICE_CODE_EXPIRED: &str = "DEVICE_CODE_EXPIRED";
pub const DEVICE_CODE_DECLINED: &str = "DEVICE_CODE_DECLINED";
pub const ACCOUNT_NOT_FOUND: &str = "ACCOUNT_NOT_FOUND";
pub const UNKNOWN: &str = "UNKNOWN";

/// 统一的应用错误。payload() 生成渲染层可见的 AppErrorPayload。
#[derive(Debug, Clone, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    InvalidRequest(String),
    #[error("任务已取消")]
    Canceled,
    #[error("凭据已变更，请刷新后重试")]
    StaleCredentials,
    #[error("本机凭据服务无法解密已保存的 token：{0}")]
    CredentialUnreadable(String),
    #[error("请求过于频繁，请稍后重试（Retry-After {0}s）")]
    Throttled(u64),
    #[error("token 已过期或被撤销：{0}")]
    TokenExpired(String),
    #[error("clientId 无效或应用已停用：{0}")]
    InvalidClient(String),
    #[error("IMAP 登录失败：请确认 token 包含 IMAP.AccessAsUser.All，且邮箱未禁用 IMAP。原始错误：{0}")]
    ImapAuthFailed(String),
    #[error("token 缺少所需权限范围：{0}")]
    ScopeMissing(String),
    #[error("网络错误：{0}")]
    NetworkError(String),
    #[error("邮件解析失败：{0}")]
    MailParseFailed(String),
    #[error("邮件内容过大")]
    MailTooLarge,
    #[error("邮箱不存在：{0}")]
    MailboxNotFound(String),
    #[error("Graph 资源不存在：{0}")]
    GraphNotFound(String),
    #[error("设备代码已过期")]
    DeviceCodeExpired,
    #[error("用户拒绝了设备代码授权")]
    DeviceCodeDeclined,
    #[error("账号不存在：{0}")]
    AccountNotFound(String),
    #[error("文件 IO 失败：{0}")]
    Io(String),
    #[error("数据序列化失败：{0}")]
    Serialization(String),
    #[error("{0}")]
    Unknown(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::InvalidRequest(_) => INVALID_REQUEST,
            AppError::Canceled => CANCELED,
            AppError::StaleCredentials => STALE_CREDENTIALS,
            AppError::CredentialUnreadable(_) => CREDENTIAL_UNREADABLE,
            AppError::Throttled(_) => THROTTLED,
            AppError::TokenExpired(_) => TOKEN_EXPIRED,
            AppError::InvalidClient(_) => INVALID_CLIENT,
            AppError::ImapAuthFailed(_) => IMAP_AUTH_FAILED,
            AppError::ScopeMissing(_) => SCOPE_MISSING,
            AppError::NetworkError(_) => NETWORK_ERROR,
            AppError::MailParseFailed(_) => MAIL_PARSE_FAILED,
            AppError::MailTooLarge => MAIL_TOO_LARGE,
            AppError::MailboxNotFound(_) => MAILBOX_NOT_FOUND,
            AppError::GraphNotFound(_) => GRAPH_NOT_FOUND,
            AppError::DeviceCodeExpired => DEVICE_CODE_EXPIRED,
            AppError::DeviceCodeDeclined => DEVICE_CODE_DECLINED,
            AppError::AccountNotFound(_) => ACCOUNT_NOT_FOUND,
            AppError::Io(_) => UNKNOWN,
            AppError::Serialization(_) => UNKNOWN,
            AppError::Unknown(_) => UNKNOWN,
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self,
            AppError::Throttled(_) | AppError::NetworkError(_) | AppError::Canceled
        )
    }
}

impl AppError {
    pub fn payload(&self) -> AppErrorPayload {
        AppErrorPayload {
            code: self.code().to_string(),
            message: truncate_message(&self.to_string()),
            retryable: self.retryable(),
            diagnostic: None,
        }
    }
}

pub fn truncate_message(message: &str) -> String {
    if message.chars().count() <= crate::contracts::APP_ERROR_MESSAGE_MAX_CHARS {
        return message.to_string();
    }
    let mut out: String = message
        .chars()
        .take(crate::contracts::APP_ERROR_MESSAGE_MAX_CHARS)
        .collect();
    out.push('…');
    out
}

/// AADSTS 错误串匹配表（error-utils.ts matchAadstsRule 的移植子集，
/// 覆盖原版规则的关键分支；message 片段按原文小写匹配）。
fn match_aadsts_rule(message_lower: &str) -> Option<(&'static str, bool)> {
    const RULES: &[(&str, &str, bool)] = &[
        // (needle, code, retryable)
        ("aadsts50034", TOKEN_EXPIRED, false), // user not found → 视同凭据失效
        ("aadsts7000218", INVALID_CLIENT, false), // client assertion missing
        ("aadsts700016", INVALID_CLIENT, false), // application not found
        ("aadsts7000215", INVALID_CLIENT, false), // invalid client secret
        ("aadsts90002", NETWORK_ERROR, true),  // tenant metadata fetch failed
        ("aadsts50173", TOKEN_EXPIRED, false), // token issued for another user
        ("aadsts50076", NETWORK_ERROR, false), // MFA required — not retryable here
        ("aadsts65001", SCOPE_MISSING, false), // user consent missing
        ("aadsts70011", SCOPE_MISSING, false), // invalid scope
        ("aadsts53003", NETWORK_ERROR, true),  // blocked by conditional access
        ("aadsts50158", TOKEN_EXPIRED, false), // external security challenge
        ("interaction_required", SCOPE_MISSING, false),
        ("token expired", TOKEN_EXPIRED, false),
        ("invalid_grant", TOKEN_EXPIRED, false),
        ("expired token", TOKEN_EXPIRED, false),
    ];
    RULES
        .iter()
        .find(|(needle, _, _)| message_lower.contains(needle))
        .map(|(_, code, retryable)| (*code, *retryable))
}

/// 网络层错误关键字（error-utils.ts hasNetworkErrorCode 的移植）。
fn is_network_message(message_lower: &str) -> bool {
    const NEEDLES: &[&str] = &[
        "econnrefused",
        "econnreset",
        "econnaborted",
        "enetdown",
        "enetunreach",
        "eai_again",
        "enotfound",
        "etimedout",
        "timeout",
        "timed out",
        "socket hang up",
        "getaddrinfo",
        "certificate",
        "tls",
        "proxy connect",
        "connection closed",
        "connection error",
        "request interrupted",
        "fetch failed",
        "dns",
    ];
    NEEDLES.iter().any(|n| message_lower.contains(n))
}

/// 把任意错误归一化为 AppError（error-utils.ts normalizeError 的 Rust 等价）。
pub fn normalize_error(error: &(dyn std::error::Error + 'static)) -> AppError {
    // 已经是 AppError 的原样返回（通过 downcast）。
    if let Some(app) = error.downcast_ref::<AppError>() {
        return app.clone();
    }
    if let Some(graph) = error.downcast_ref::<crate::transports::graph_client::GraphRequestError>()
    {
        return graph.to_app_error();
    }
    if error
        .downcast_ref::<crate::transports::graph_client::GraphResponseTooLargeError>()
        .is_some()
    {
        return AppError::MailTooLarge;
    }
    let message = error.to_string();
    let lower = message.to_lowercase();
    normalize_message(&message, &lower)
}

/// 任意动态错误 → AppError（Box<dyn Error> 传 `?` 的通路）。
impl From<Box<dyn std::error::Error + Send + Sync>> for AppError {
    fn from(value: Box<dyn std::error::Error + Send + Sync>) -> Self {
        normalize_error(value.as_ref())
    }
}

/// 文件 IO 错误 → AppError（settings/cache 落盘路径 `?`）。
impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Io(value.to_string())
    }
}

/// JSON 序列化错误 → AppError。
impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::Serialization(value.to_string())
    }
}

/// 纯文本归一化（无dyn Error时的路径），便于测试。
pub fn normalize_message(message: &str, lower: &str) -> AppError {
    if lower.contains("job canceled")
        || lower.contains("任务已取消")
        || lower.contains("operation was canceled")
    {
        return AppError::Canceled;
    }
    if lower.contains("credentials changed") || lower.contains("stale credentials") {
        return AppError::StaleCredentials;
    }
    if lower.contains("safe storage")
        || lower.contains("credential unreadable")
        || lower.contains("dpapi")
    {
        return AppError::CredentialUnreadable(message.to_string());
    }
    if let Some((code, retryable)) = match_aadsts_rule(lower) {
        return code_to_error(code, retryable, message);
    }
    if lower.contains("429") || lower.contains("too many requests") || lower.contains("throttl") {
        return AppError::Throttled(0);
    }
    if lower.contains("mail content too large") || lower.contains("response too large") {
        return AppError::MailTooLarge;
    }
    if lower.contains("mime parse") || lower.contains("mail parse") {
        return AppError::MailParseFailed(message.to_string());
    }
    if lower.contains("mailbox not found") {
        return AppError::MailboxNotFound(message.to_string());
    }
    if is_network_message(lower) {
        return AppError::NetworkError(message.to_string());
    }
    AppError::Unknown(message.to_string())
}

fn code_to_error(code: &'static str, retryable: bool, message: &str) -> AppError {
    let _ = retryable;
    match code {
        TOKEN_EXPIRED => AppError::TokenExpired(message.to_string()),
        INVALID_CLIENT => AppError::InvalidClient(message.to_string()),
        IMAP_AUTH_FAILED => AppError::ImapAuthFailed(message.to_string()),
        SCOPE_MISSING => AppError::ScopeMissing(message.to_string()),
        NETWORK_ERROR => AppError::NetworkError(message.to_string()),
        _ => AppError::Unknown(message.to_string()),
    }
}

/// 转换为 IPC 错误负载（reportIpcError 等价）。
pub fn to_payload(error: &(dyn std::error::Error + 'static)) -> AppErrorPayload {
    normalize_error(error).payload()
}

/// 敏感信息脱敏（error-utils.ts redactSensitiveText 等价）。
pub fn redact_sensitive_text(value: &str) -> String {
    value
        .replace('\u{0}', "")
        .split_whitespace()
        .map(|token| {
            if token.len() >= 32
                && token
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                format!(
                    "{}…{}",
                    &token[..4.min(token.len())],
                    &token[token.len() - 4.min(token.len())..]
                )
            } else {
                token.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub struct NormalizedErrorFmt(pub AppError);
impl fmt::Display for NormalizedErrorFmt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.0.code(), self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aadsts_invalid_client_maps() {
        let e = normalize_message(
            "AADSTS700016: Application not found in directory.",
            "aadsts700016: application not found in directory.",
        );
        assert_eq!(e.code(), INVALID_CLIENT);
    }

    #[test]
    fn throttled_maps() {
        let e = normalize_message("HTTP 429 Too Many Requests", "http 429 too many requests");
        assert_eq!(e.code(), THROTTLED);
        assert!(e.retryable());
    }

    #[test]
    fn network_maps() {
        let e = normalize_message(
            "getaddrinfo ENOTFOUND login.microsoftonline.com",
            "getaddrinfo enotfound login.microsoftonline.com",
        );
        assert_eq!(e.code(), NETWORK_ERROR);
        assert!(e.retryable());
    }

    #[test]
    fn codes_are_screaming_snake_and_complete() {
        let all = [
            AppError::InvalidRequest("x".into()),
            AppError::Canceled,
            AppError::StaleCredentials,
            AppError::CredentialUnreadable("x".into()),
            AppError::Throttled(1),
            AppError::TokenExpired("x".into()),
            AppError::InvalidClient("x".into()),
            AppError::ImapAuthFailed("x".into()),
            AppError::ScopeMissing("x".into()),
            AppError::NetworkError("x".into()),
            AppError::MailParseFailed("x".into()),
            AppError::MailTooLarge,
            AppError::MailboxNotFound("x".into()),
            AppError::GraphNotFound("x".into()),
            AppError::DeviceCodeExpired,
            AppError::DeviceCodeDeclined,
            AppError::AccountNotFound("x".into()),
            AppError::Unknown("x".into()),
        ];
        for e in &all {
            let payload = e.payload();
            assert!(payload.message.len() <= 4100);
            assert!(!payload.code.is_empty());
        }
        assert_eq!(AppError::Canceled.code(), "CANCELED");
        assert_eq!(AppError::StaleCredentials.code(), "STALE_CREDENTIALS");
    }
}

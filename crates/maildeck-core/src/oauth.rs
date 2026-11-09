//! OAuth：device-code 与 interactive（PKCE），对接 login.microsoftonline.com（对应原 oauth-module.ts）。

use crate::contracts::{
    DeviceCodePoll, DeviceCodePollPending, DeviceCodeStart, OAuthCallbackResult, OAuthStart,
    OAuthTokenResponse,
};
use crate::errors::AppError;
use serde_json::Value;

pub const MS_AUTH_HOST: &str = "https://login.microsoftonline.com";
pub const GRAPH_DEFAULT_SCOPE: &str =
    "offline_access Mail.Read User.Read Files.Read.All Sites.Read.All";
pub const IMAP_SCOPE: &str = "offline_access https://outlook.office.com/IMAP.AccessAsUser.All";

fn authority_endpoint(authority: &str) -> String {
    match authority {
        "consumers" | "organizations" | "common" => format!("{MS_AUTH_HOST}/{authority}"),
        other => format!("{MS_AUTH_HOST}/{other}"), // 已是 tenant id
    }
}

fn post_form(
    url: &str,
    form: &[(&str, &str)],
    timeout: std::time::Duration,
) -> Result<Value, AppError> {
    post_form_with_proxy(url, form, "", timeout)
}

fn post_form_with_proxy(
    url: &str,
    form: &[(&str, &str)],
    proxy_url: &str,
    timeout: std::time::Duration,
) -> Result<Value, AppError> {
    let mut builder = reqwest::blocking::Client::builder().timeout(timeout);
    if !proxy_url.is_empty() {
        let proxy = reqwest::Proxy::all(proxy_url)
            .map_err(|e| AppError::InvalidRequest(format!("proxy: {e}")))?;
        builder = builder.proxy(proxy);
    }
    let client = builder
        .build()
        .map_err(|e| AppError::NetworkError(e.to_string()))?;
    let resp = client
        .post(url)
        .form(form)
        .send()
        .map_err(|e| AppError::NetworkError(e.to_string()))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .map_err(|e| AppError::NetworkError(e.to_string()))?;
    let value: Value = serde_json::from_str(&body).map_err(|_| {
        AppError::NetworkError(format!(
            "non-json token response (HTTP {status}): {}",
            truncate(&body)
        ))
    })?;
    if status == 429 {
        let retry_after = value
            .get("retry_after")
            .and_then(|v| v.as_u64())
            .or(value.get("Retry-After").and_then(|v| v.as_u64()))
            .unwrap_or(60);
        return Err(AppError::Throttled(retry_after));
    }
    if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
        let desc = value
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let combined = format!("{err}: {desc}");
        return Err(crate::errors::normalize_message(
            &combined,
            &combined.to_lowercase(),
        ));
    }
    if status != 200 {
        return Err(AppError::Unknown(format!(
            "token endpoint HTTP {status}: {}",
            truncate(&body)
        )));
    }
    Ok(value)
}

fn truncate(s: &str) -> String {
    s.chars().take(300).collect()
}

fn token_from_value(v: Value) -> OAuthTokenResponse {
    OAuthTokenResponse {
        access_token: v
            .get("access_token")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        refresh_token: v
            .get("refresh_token")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        expires_in: v.get("expires_in").and_then(|x| x.as_i64()).unwrap_or(3600),
        scope: v
            .get("scope")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        token_type: v
            .get("token_type")
            .and_then(|x| x.as_str())
            .unwrap_or("Bearer")
            .to_string(),
    }
}

/// device-code 流：第一步拿 user_code/verification_uri（v2 endpoints）。
pub fn device_code_start(
    client_id: &str,
    authority: &str,
    scope: &str,
    timeout: std::time::Duration,
) -> Result<DeviceCodeStart, AppError> {
    let url = format!("{}/oauth2/v2.0/devicecode", authority_endpoint(authority));
    let value = post_form(&url, &[("client_id", client_id), ("scope", scope)], timeout)?;
    Ok(DeviceCodeStart {
        device_code: value
            .get("device_code")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        user_code: value
            .get("user_code")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        verification_uri: value
            .get("verification_uri")
            .and_then(|x| x.as_str())
            .unwrap_or("https://www.microsoft.com/link")
            .to_string(),
        expires_in: value
            .get("expires_in")
            .and_then(|x| x.as_i64())
            .unwrap_or(900),
        interval: value
            .get("interval")
            .and_then(|x| x.as_i64())
            .unwrap_or(5)
            .clamp(1, 30),
        message: value
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("在浏览器完成登录后回来确认")
            .to_string(),
    })
}

/// device-code 第二步轮询：authorization_pending → pending；expired/declined → 终态错误。
pub fn device_code_poll(
    client_id: &str,
    authority: &str,
    device_code: &str,
    scope: &str,
    timeout: std::time::Duration,
) -> Result<DeviceCodePoll, AppError> {
    let url = format!("{}/oauth2/v2.0/token", authority_endpoint(authority));
    match post_form(
        &url,
        &[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", client_id),
            ("device_code", device_code),
            ("scope", scope),
        ],
        timeout,
    ) {
        Ok(value) => Ok(DeviceCodePoll::Completed(token_from_value(value))),
        Err(AppError::InvalidRequest(msg)) if msg.contains("authorization_pending") => Ok(
            DeviceCodePoll::Pending(DeviceCodePollPending::AuthorizationPending),
        ),
        Err(AppError::InvalidRequest(msg)) if msg.contains("slow_down") => {
            Ok(DeviceCodePoll::Pending(DeviceCodePollPending::SlowDown))
        }
        Err(AppError::Unknown(msg)) if msg.contains("authorization_pending") => Ok(
            DeviceCodePoll::Pending(DeviceCodePollPending::AuthorizationPending),
        ),
        Err(AppError::Unknown(msg)) if msg.contains("slow_down") => {
            Ok(DeviceCodePoll::Pending(DeviceCodePollPending::SlowDown))
        }
        Err(AppError::Unknown(msg))
            if msg.contains("expired_token") || msg.contains("code_expired") =>
        {
            Err(AppError::DeviceCodeExpired)
        }
        Err(AppError::Unknown(msg))
            if msg.contains("authorization_declined") || msg.contains("user_declined") =>
        {
            Err(AppError::DeviceCodeDeclined)
        }
        Err(e) => Err(e),
    }
}

/// 与原版 graph-client.ts detectAuthMode 逐字对齐：
/// scope 含 graph.microsoft.com → graph；含 outlook.office.com → imap；默认 graph。
pub fn auth_mode_from_scope(scope: &str) -> &'static str {
    if scope.contains("https://graph.microsoft.com/") {
        return "graph";
    }
    if scope.contains("https://outlook.office.com/") {
        return "imap";
    }
    "graph"
}

/// refresh_token 换 access_token。与原版 refreshAccessToken 逐字对齐：
/// 表单不带 scope（继承原始授权的 scope，AADSTS70000 即 scope 不匹配所致），
/// 依次轮询 common → consumers → organizations 三个端点，首个成功即返回。
pub fn refresh_token_grant(
    client_id: &str,
    refresh_token: &str,
    proxy_url: &str,
    timeout: std::time::Duration,
) -> Result<OAuthTokenResponse, AppError> {
    const TOKEN_AUTHORITIES: [&str; 3] = ["common", "consumers", "organizations"];
    let mut last_err: Option<AppError> = None;
    for authority in TOKEN_AUTHORITIES {
        let url = format!("{}/oauth2/v2.0/token", authority_endpoint(authority));
        match post_form_with_proxy(
            &url,
            &[
                ("grant_type", "refresh_token"),
                ("client_id", client_id),
                ("refresh_token", refresh_token),
            ],
            proxy_url,
            timeout,
        ) {
            Ok(value) => return Ok(token_from_value(value)),
            Err(AppError::Throttled(t)) => return Err(AppError::Throttled(t)),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::Unknown("token 刷新失败：无可用端点".into())))
}

/// PKCE：interactive 登录的参数组装（浏览器流程由壳层完成，这里只产出 URL + verifier）。
pub fn interactive_start(
    client_id: &str,
    authority: &str,
    redirect_port: u16,
    scope: &str,
) -> Result<OAuthStart, AppError> {
    let mut verifier_bytes = [0u8; 48];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut verifier_bytes);
    let verifier = crate::crypto::b64_encode(&verifier_bytes)
        .replace('+', "-")
        .replace('/', "_")
        .replace('=', "");
    use sha2::{Digest, Sha256};
    let challenge = crate::crypto::b64_encode(&Sha256::digest(verifier.as_bytes()))
        .replace('+', "-")
        .replace('/', "_")
        .replace('=', "");
    let state = uuid::Uuid::new_v4().to_string();
    let redirect_uri = format!("http://127.0.0.1:{redirect_port}/auth/callback");
    let url = format!(
        "{}/oauth2/v2.0/authorize?client_id={}&response_type=code&redirect_uri={}&response_mode=query&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        authority_endpoint(authority),
        urlencode(client_id),
        urlencode(&redirect_uri),
        urlencode(scope),
        urlencode(&state),
        urlencode(&challenge),
    );
    Ok(OAuthStart {
        authorize_url: url,
        state,
        code_verifier: verifier,
        redirect_uri,
    })
}

/// 回调 code + verifier 换 token。
pub fn interactive_callback(
    client_id: &str,
    authority: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
    timeout: std::time::Duration,
) -> Result<OAuthCallbackResult, AppError> {
    let url = format!("{}/oauth2/v2.0/token", authority_endpoint(authority));
    let value = post_form(
        &url,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("code", code),
            ("code_verifier", code_verifier),
            ("redirect_uri", redirect_uri),
        ],
        timeout,
    )?;
    Ok(OAuthCallbackResult::Tokens(token_from_value(value)))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_variants() {
        assert_eq!(
            authority_endpoint("consumers"),
            format!("{MS_AUTH_HOST}/consumers")
        );
        assert_eq!(
            authority_endpoint("9188040d-tenant"),
            format!("{MS_AUTH_HOST}/9188040d-tenant")
        );
    }

    #[test]
    fn urlencoding() {
        assert_eq!(urlencode("a b&c"), "a%20b%26c");
        assert_eq!(urlencode("abc-_."), "abc-_.");
    }

    #[test]
    fn pkce_verifier_is_url_safe() {
        let start = interactive_start("cid", "consumers", 46123, GRAPH_DEFAULT_SCOPE).unwrap();
        assert!(!start.code_verifier.contains('+'));
        assert!(!start.code_verifier.contains('/'));
        assert!(start.authorize_url.contains("code_challenge_method=S256"));
        assert!(start
            .authorize_url
            .contains("/consumers/oauth2/v2.0/authorize"));
    }

    #[test]
    fn scopes_preserved() {
        assert!(GRAPH_DEFAULT_SCOPE.contains("offline_access"));
        assert!(IMAP_SCOPE.contains("IMAP.AccessAsUser.All"));
    }
}

//! 版本检查：绿色版没有安装器，做不了应用内自动更新，只能「查最新发布版本 + 引导到发布页」。
//! 对应原版 app-updater.ts 里 electron-updater 的 checkForUpdates 语义（只查不下）。

use crate::errors::AppError;
use std::time::Duration;

pub const RELEASES_API_URL: &str =
    "https://api.github.com/repos/xinghe-labs/maildeck/releases/latest";
pub const RELEASES_PAGE_URL: &str = "https://github.com/xinghe-labs/maildeck/releases/latest";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestRelease {
    /// 纯版本号（已去掉 tag 前缀，如 `rust-v0.5.2` -> `0.5.2`）
    pub version: String,
    pub page_url: String,
}

/// 请求 GitHub Releases 最新发布。代理走设置里的 proxyUrl（与原版 applySessionProxy 一致）。
pub fn fetch_latest_release(
    proxy_url: &str,
    timeout: Duration,
) -> Result<LatestRelease, AppError> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .user_agent("MailDeck-UpdateCheck");
    if !proxy_url.trim().is_empty() {
        let proxy = reqwest::Proxy::all(proxy_url)
            .map_err(|e| AppError::InvalidRequest(format!("proxy: {e}")))?;
        builder = builder.proxy(proxy);
    }
    let client = builder
        .build()
        .map_err(|e| AppError::NetworkError(e.to_string()))?;
    let resp = client
        .get(RELEASES_API_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|e| AppError::NetworkError(e.to_string()))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .map_err(|e| AppError::NetworkError(e.to_string()))?;
    if status != 200 {
        return Err(AppError::Unknown(format!(
            "检查更新失败（HTTP {status}）"
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| AppError::NetworkError("发布信息不是合法 JSON".to_string()))?;
    let tag = value
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let page_url = value
        .get("html_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(RELEASES_PAGE_URL)
        .to_string();
    let version = parse_version(tag)
        .ok_or_else(|| AppError::Unknown(format!("无法解析发布版本号：{tag}")))?;
    Ok(LatestRelease { version, page_url })
}

/// 从 tag 提取版本号：`rust-v0.5.2` / `v0.5.2` / `0.5.2` 都认，末尾非数字字符忽略。
pub fn parse_version(tag: &str) -> Option<String> {
    let tag = tag.trim();
    if tag.is_empty() {
        return None;
    }
    // 取最后一个「v/V 紧跟数字」的位置（tag 前缀可能自带 v，例如 rust-v1.2.3）
    let start = tag
        .char_indices()
        .filter(|(i, c)| (*c == 'v' || *c == 'V') && tag[i + 1..].starts_with(|n: char| n.is_ascii_digit()))
        .map(|(i, _)| i + 1)
        .next_back();
    let body = match start {
        Some(i) => &tag[i..],
        None => tag.trim_start_matches(|c: char| !c.is_ascii_digit()),
    };
    let version: String = body
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let version = version.trim_end_matches('.').to_string();
    if version.is_empty() || version.split('.').all(|p| p.is_empty()) {
        None
    } else {
        Some(version)
    }
}

/// 比较点分版本号（缺位按 0 补齐，非数字段按 0 处理）。
pub fn is_newer(current: &str, latest: &str) -> bool {
    fn parts(v: &str) -> Vec<u64> {
        v.split('.')
            .map(|p| p.trim().parse::<u64>().unwrap_or(0))
            .collect()
    }
    let current = parts(current);
    let latest = parts(latest);
    for i in 0..current.len().max(latest.len()) {
        let a = *current.get(i).unwrap_or(&0);
        let b = *latest.get(i).unwrap_or(&0);
        if a != b {
            return b > a;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_tags() {
        assert_eq!(parse_version("rust-v0.5.2").as_deref(), Some("0.5.2"));
        assert_eq!(parse_version("v0.5.2").as_deref(), Some("0.5.2"));
        assert_eq!(parse_version("0.5.2").as_deref(), Some("0.5.2"));
        assert_eq!(parse_version("release-1.0").as_deref(), Some("1.0"));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("nightly"), None);
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("0.5.2", "0.5.3"));
        assert!(is_newer("0.5.2", "0.6.0"));
        assert!(is_newer("0.5.2", "1.0"));
        assert!(!is_newer("0.5.2", "0.5.2"));
        assert!(!is_newer("0.5.2", "0.5.1"));
        assert!(!is_newer("0.5.2", "0.5"));
    }
}

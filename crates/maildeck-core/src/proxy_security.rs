//! 代理 URL 解析与脱敏（对应原 electron/shared/proxy-security.ts，逐条规则忠实移植）。

pub const MAX_PROXY_URL_CHARS: usize = 2_048;

/// 支持存储的协议集合：http/https + 旧版 socks 系列（存储可识别，运行时仅 http/https 可用）。
pub const STORED_PROTOCOLS: [&str; 5] = ["http:", "https:", "socks:", "socks4:", "socks5:"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedProxyUrl {
    pub protocol: String, // "http:" | "https:" | "socks:" | "socks4:" | "socks5:"
    pub hostname: String,
    pub port: String, // 与原版一致保持字符串（空串 = 未指定）
    pub username: String,
    pub password: String,
    pub supported: bool, // 仅 http:/https: 为 true
}

fn decode_credential(value: &str) -> Result<String, String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| "Proxy credentials must use valid URL encoding".to_string())
}

/// 手写解析器，行为对齐原版 `new URL(value)` + 校验链：
/// 空 -> None；超长/非法协议/缺主机/带 path/query/fragment -> Err。
pub fn parse_proxy_url(
    value: &str,
    allow_legacy_socks: bool,
) -> Result<Option<ParsedProxyUrl>, String> {
    let input = value.trim();
    if input.is_empty() {
        return Ok(None);
    }
    if input.len() > MAX_PROXY_URL_CHARS {
        return Err(format!(
            "Proxy URL must not exceed {MAX_PROXY_URL_CHARS} characters"
        ));
    }

    let sep = input
        .find("://")
        .ok_or_else(|| "Proxy URL is invalid".to_string())?;
    let protocol = input[..sep + 1].to_ascii_lowercase();
    if !STORED_PROTOCOLS.contains(&protocol.as_str()) {
        return Err("Proxy URL must use HTTP or HTTPS".to_string());
    }
    let supported = protocol == "http:" || protocol == "https:";
    if !supported && !allow_legacy_socks {
        return Err("Proxy URL must use HTTP or HTTPS".to_string());
    }

    let mut rest = &input[sep + 3..];
    // 原版按 pathname -> search -> hash 顺序报错；这里先找 fragment，再从剩余串找 query/path，
    // 报错顺序与原版一致（path 优先于 query 优先于 fragment）。
    let hash_idx = rest.find('#');
    let hash_part = hash_idx.map(|i| &rest[i..]);
    if let Some(i) = hash_idx {
        rest = &rest[..i];
    }
    let query_idx = rest.find('?');
    let query_part = query_idx.map(|i| &rest[i..]);
    if let Some(i) = query_idx {
        rest = &rest[..i];
    }
    let path_idx = rest.find('/');
    let path_part = path_idx.map(|i| &rest[i..]);
    if let Some(i) = path_idx {
        rest = &rest[..i];
    }
    if let Some(path) = path_part {
        // 原版：pathname === "/" 视为无路径（URL 解析尾斜杠）。
        if path != "/" {
            return Err("Proxy URL must not include a path".to_string());
        }
    }
    if query_part.is_some() {
        return Err("Proxy URL must not include a query".to_string());
    }
    if hash_part.is_some() {
        return Err("Proxy URL must not include a fragment".to_string());
    }

    // userinfo@host:port（与 WHATWG 一致按最后一个 @ 分割）。
    let (userinfo, hostport) = match rest.rfind('@') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => ("", rest),
    };
    let (username_raw, password_raw) = match userinfo.find(':') {
        Some(i) => (&userinfo[..i], &userinfo[i + 1..]),
        None => (userinfo, ""),
    };
    let username = decode_credential(username_raw)?;
    let password = decode_credential(password_raw)?;

    // host:port（支持 [IPv6]:port）。空主机名报错；端口须为数字且 <= 65535（对齐 URL 解析）。
    let (hostname_raw, port) = if let Some(stripped) = hostport.strip_prefix('[') {
        let close = stripped
            .find(']')
            .ok_or_else(|| "Proxy URL is invalid".to_string())?;
        let host = &stripped[..close];
        let after = &stripped[close + 1..];
        let port: &str = after.strip_prefix(':').unwrap_or_default();
        (host, port)
    } else {
        match hostport.rfind(':') {
            Some(i) => (&hostport[..i], &hostport[i + 1..]),
            None => (hostport, ""),
        }
    };
    let hostname = hostname_raw.to_ascii_lowercase();
    if hostname.is_empty() {
        return Err("Proxy URL must include a hostname".to_string());
    }
    if !port.is_empty()
        && (!port.chars().all(|c| c.is_ascii_digit())
            || port.parse::<u32>().map_err(|_| "Proxy URL is invalid")? > 65535)
    {
        return Err("Proxy URL is invalid".to_string());
    }

    Ok(Some(ParsedProxyUrl {
        protocol,
        hostname,
        port: port.to_string(),
        username,
        password,
        supported,
    }))
}

/// WHATWG URL userinfo 百分号编码集（对齐 JS `url.username = x` 的自动编码）。
const USERINFO_SET: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'<')
    .add(b'>')
    .add(b'`')
    .add(b'#')
    .add(b'?')
    .add(b'{')
    .add(b'}')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'=')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'|');

fn serialize_proxy_url(
    protocol: &str,
    hostname: &str,
    port: &str,
    username: &str,
    password: &str,
) -> String {
    let hostport = if port.is_empty() {
        hostname.to_string()
    } else {
        format!("{hostname}:{port}")
    };
    let mut url = if username.is_empty() && password.is_empty() {
        format!("{protocol}//{hostport}")
    } else {
        let user = percent_encoding::utf8_percent_encode(username, USERINFO_SET);
        let pass = percent_encoding::utf8_percent_encode(password, USERINFO_SET);
        format!("{protocol}//{user}:{pass}@{hostport}")
    };
    // 对齐 JS URL.href 尾斜杠归一化。
    if url.ends_with('/') {
        url.pop();
    }
    url
}

/// 运行时代理 URL（必须受支持协议；带认证）。对应 formatProxyUrl。
pub fn format_proxy_url(proxy: &ParsedProxyUrl, password: &str) -> Result<String, String> {
    if !proxy.supported {
        return Err("Cannot use an unsupported proxy protocol at runtime".to_string());
    }
    Ok(serialize_proxy_url(
        &proxy.protocol,
        &proxy.hostname,
        &proxy.port,
        &proxy.username,
        password,
    ))
}

/// 展示用代理 URL（去掉用户名）。对应 formatPublicProxyUrl。
pub fn format_public_proxy_url(proxy: &ParsedProxyUrl) -> Result<String, String> {
    let mut sanitized = proxy.clone();
    sanitized.username = String::new();
    serialize_proxy_url_public(&sanitized)
}

fn serialize_proxy_url_public(proxy: &ParsedProxyUrl) -> Result<String, String> {
    let mut url = format!("{}//{}", proxy.protocol, proxy.hostname);
    if !proxy.port.is_empty() {
        url.push(':');
        url.push_str(&proxy.port);
    }
    let out = url;
    Ok(out.strip_suffix('/').map(|s| s.to_string()).unwrap_or(out))
}

/// 日志脱敏：host:***@。对应 redactProxyCredentials。
pub fn redact_proxy_credentials(value: &str) -> String {
    // 原版正则 /\b((?:https?|socks(?:4|5)?):\/\/[^@\s]*?):([^@\s]*)@/giu
    let mut out = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &value[i..];
        if let Some(proto_end) = rest.find("://") {
            let scheme = &rest[..proto_end];
            let scheme_lower = scheme.to_ascii_lowercase();
            let is_scheme = ["https", "http", "socks4", "socks5", "socks"]
                .iter()
                .any(|s| scheme_lower == *s)
                && proto_end > 0
                && !scheme
                    .chars()
                    .any(|c| !(c.is_ascii_alphanumeric() || c == '+'));
            if is_scheme {
                let after = &rest[proto_end + 3..];
                if let Some(at) = after.find('@') {
                    let userinfo = &after[..at];
                    if !userinfo.chars().any(|c| c == '@' || c.is_whitespace()) {
                        // 正则 [^@\s]*?):([^@\s]*)@：group1 贪婪到最后一个 ':'；无 ':' 不匹配，原样保留。
                        if let Some(colon) = userinfo.rfind(':') {
                            out.push_str(scheme);
                            out.push_str("://");
                            out.push_str(&userinfo[..colon]);
                            out.push_str(":***@");
                            i += proto_end + 3 + at + 1;
                            continue;
                        }
                    }
                }
            }
        }
        let ch_len = rest.chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&rest[..ch_len]);
        i += ch_len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_http_proxy() {
        let p = parse_proxy_url("http://127.0.0.1:10808", false)
            .unwrap()
            .unwrap();
        assert_eq!(p.protocol, "http:");
        assert_eq!(p.hostname, "127.0.0.1");
        assert_eq!(p.port, "10808");
        assert!(p.supported);
        assert_eq!(format_proxy_url(&p, "").unwrap(), "http://127.0.0.1:10808");
        assert_eq!(
            format_public_proxy_url(&p).unwrap(),
            "http://127.0.0.1:10808"
        );
    }

    #[test]
    fn socks_rejected_unless_legacy() {
        assert!(parse_proxy_url("socks5://h:1080", false).is_err());
        let p = parse_proxy_url("socks5://h:1080", true).unwrap().unwrap();
        assert!(!p.supported);
        assert!(format_proxy_url(&p, "").is_err());
    }

    #[test]
    fn rejects_path_query_fragment() {
        assert!(parse_proxy_url("http://h/p", false)
            .unwrap_err()
            .contains("path"));
        assert!(parse_proxy_url("http://h/?x=1", false)
            .unwrap_err()
            .contains("query"));
        assert!(parse_proxy_url("http://h/#f", false)
            .unwrap_err()
            .contains("fragment"));
    }

    #[test]
    fn credentials_separate_fields() {
        let p = parse_proxy_url("http://user:pass@h:8080", false)
            .unwrap()
            .unwrap();
        assert_eq!(p.username, "user");
        assert_eq!(p.password, "pass");
        assert_eq!(
            format_proxy_url(&p, "pass").unwrap(),
            "http://user:pass@h:8080"
        );
        assert_eq!(format_public_proxy_url(&p).unwrap(), "http://h:8080");
    }

    #[test]
    fn redacts_credentials() {
        assert_eq!(
            redact_proxy_credentials("http://u:p@h:1"),
            "http://u:***@h:1"
        );
        assert_eq!(redact_proxy_credentials("plain"), "plain");
    }

    #[test]
    fn empty_returns_none() {
        assert!(parse_proxy_url("  ", false).unwrap().is_none());
    }
}

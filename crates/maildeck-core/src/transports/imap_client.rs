//! IMAP 传输适配器（outlook.office365.com:993，XOAUTH2）。
//!
//! 与原版 electron/main/imap-client.ts（imapflow）语义对齐：
//! - list_folders：LIST "" "*" → MailFolder[]（id=displayName=path，计数 0）
//! - list_messages：UID SEARCH/SUBJECT 窗口 + UID FETCH(ENVELOPE/FLAGS/INTERNALDATE/BODYSTRUCTURE)
//! - get_message：≤10MB 全文 RFC822，否则取首选文本 part；MIME 解析出 html/text 正文
//! - mark_read：UID STORE ±FLAGS (\Seen)
//!
//! 原版通过 imapflow + proxyAgent 支持 SOCKS/HTTP 代理；此处 IMAP 仅直连（代理传入被忽略，
//! 已记录于 REFACTOR-PLAN 遗留）。信封/头部的 RFC2047 编码字在此解码（imapflow 内建行为）。

use crate::contracts::{MailAddress, MailFolder, MailListItem, MailRecipient};
use crate::errors::AppError;

pub const IMAP_HOST: &str = "outlook.office365.com";
pub const IMAP_PORT: u16 = 993;
/// 原版 IMAP_FULL_SOURCE_MAX_BYTES：超过则不拉全量源，改取首选文本 part。
pub const IMAP_FULL_SOURCE_MAX_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug)]
pub struct ImapError(pub String);

impl ImapError {
    pub fn to_app_error(&self) -> AppError {
        let msg = self.0.to_lowercase();
        if msg.contains("authenticate")
            || msg.contains("authentication")
            || msg.contains("authnfailed")
            || msg.contains("login")
        {
            AppError::ImapAuthFailed(self.0.clone())
        } else if msg.contains("connect")
            || msg.contains("resolve")
            || msg.contains("tls")
            || msg.contains("read")
            || msg.contains("write")
            || msg.contains("timeout")
            || msg.contains("timed out")
        {
            AppError::NetworkError(self.0.clone())
        } else {
            AppError::Unknown(self.0.clone())
        }
    }
}

impl std::fmt::Display for ImapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub fn build_xoauth2(username: &str, access_token: &str) -> String {
    format!(
        "user={}\u{1}auth=Bearer {}\u{1}\u{1}",
        username, access_token
    )
}

// ---------------------------------------------------------------------------
// 会话：阻塞式 TLS + 字面量感知的响应读取
// ---------------------------------------------------------------------------

/// 最小 IMAP 会话（连接 → XOAUTH2 → 命令收发）。
pub struct ImapSession {
    stream: rustls::StreamOwned<rustls::ClientConnection, std::net::TcpStream>,
    tag_no: u32,
}

struct CmdResult {
    raw: Vec<u8>,
    tagged: String,
    ok: bool,
}

fn tls_config() -> Result<rustls::ClientConfig, ImapError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Ok(rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth())
}

impl ImapSession {
    /// 连接 + 认证。失败按错误内容分类（auth / network）。
    pub fn connect(
        email: &str,
        access_token: &str,
        timeout: std::time::Duration,
    ) -> Result<Self, AppError> {
        // connect_timeout 需要 SocketAddr：先 DNS 解析域名
        use std::net::ToSocketAddrs;
        let addrs: Vec<std::net::SocketAddr> = (IMAP_HOST, IMAP_PORT)
            .to_socket_addrs()
            .map_err(|e| ImapError(format!("resolve {IMAP_HOST}: {e}")).to_app_error())?
            .collect();
        let mut last_err: Option<ImapError> = None;
        let mut tcp = None;
        for addr in &addrs {
            match std::net::TcpStream::connect_timeout(addr, timeout) {
                Ok(s) => {
                    tcp = Some(s);
                    break;
                }
                Err(e) => last_err = Some(ImapError(format!("connect {addr}: {e}"))),
            }
        }
        let stream = tcp.ok_or_else(|| {
            last_err
                .unwrap_or_else(|| ImapError(format!("connect {IMAP_HOST}: no addresses")))
                .to_app_error()
        })?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|e| ImapError(format!("set timeout: {e}")).to_app_error())?;
        let server_name = rustls::pki_types::ServerName::try_from(IMAP_HOST.to_string())
            .map_err(|e| ImapError(format!("server name: {e}")).to_app_error())?;
        let conn = rustls::ClientConnection::new(
            std::sync::Arc::new(tls_config().map_err(|e| e.to_app_error())?),
            server_name,
        )
        .map_err(|e| ImapError(format!("tls: {e}")).to_app_error())?;
        let mut session = Self {
            stream: rustls::StreamOwned::new(conn, stream),
            tag_no: 1,
        };
        // greeting
        let greeting = session.read_line_raw().map_err(|e| e.to_app_error())?;
        if !greeting.starts_with(b"* OK") && !greeting.starts_with(b"* PREAUTH") {
            return Err(ImapError(format!(
                "unexpected greeting: {}",
                String::from_utf8_lossy(&greeting)
            ))
            .to_app_error());
        }
        // AUTHENTICATE XOAUTH2
        let auth = crate::crypto::b64_encode(build_xoauth2(email, access_token).as_bytes());
        let result = session.cmd(&format!("AUTHENTICATE XOAUTH2 {auth}"))?;
        if !result.ok {
            return Err(
                ImapError(format!("authentication failed: {}", result.tagged.trim()))
                    .to_app_error(),
            );
        }
        Ok(session)
    }

    fn read_line_raw(&mut self) -> Result<Vec<u8>, ImapError> {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            match std::io::Read::read(&mut self.stream, &mut byte) {
                Ok(0) => {
                    if buf.is_empty() {
                        return Err(ImapError("connection closed".into()));
                    }
                    break;
                }
                Ok(_) => {
                    buf.push(byte[0]);
                    if byte[0] == b'\n' {
                        break;
                    }
                    if buf.len() > 512 * 1024 {
                        return Err(ImapError("line too long".into()));
                    }
                }
                Err(e) => return Err(ImapError(format!("read: {e}"))),
            }
        }
        Ok(buf)
    }

    fn read_exact_raw(&mut self, n: usize) -> Result<Vec<u8>, ImapError> {
        let mut buf = vec![0u8; n];
        use std::io::Read;
        self.stream
            .read_exact(&mut buf)
            .map_err(|e| ImapError(format!("read literal: {e}")))?;
        Ok(buf)
    }

    /// 读取一条完整响应（含嵌套字面量字节），直到 tag 行。
    fn read_response(&mut self, tag: &str) -> Result<Vec<u8>, ImapError> {
        let mut raw = Vec::new();
        loop {
            let line = self.read_line_raw()?;
            raw.extend_from_slice(&line);
            // 行尾 {n}\r\n → 字面量：精确读 n 字节后继续
            if ends_with_literal(&line) {
                let n = literal_size(&line).unwrap_or(0);
                if n > 0 {
                    raw.extend_from_slice(&self.read_exact_raw(n)?);
                }
                continue;
            }
            if line.starts_with(tag.as_bytes()) {
                break;
            }
            if raw.len() > 64 * 1024 * 1024 {
                return Err(ImapError("response too large".into()));
            }
        }
        Ok(raw)
    }

    fn cmd(&mut self, command: &str) -> Result<CmdResult, AppError> {
        let tag = format!("a{:02x}", self.tag_no);
        self.tag_no += 1;
        {
            use std::io::Write;
            write!(self.stream, "{tag} {command}\r\n")
                .map_err(|e| ImapError(format!("write: {e}")).to_app_error())?;
            self.stream
                .flush()
                .map_err(|e| ImapError(format!("flush: {e}")).to_app_error())?;
        }
        let raw = self.read_response(&tag).map_err(|e| e.to_app_error())?;
        let tagged = raw
            .split(|b| *b == b'\n')
            .rev()
            .find(|l| l.starts_with(tag.as_bytes()))
            .map(|l| String::from_utf8_lossy(l).to_string())
            .unwrap_or_default();
        Ok(CmdResult {
            ok: tagged.contains(&format!("{tag} OK")),
            tagged,
            raw,
        })
    }

    fn logout(&mut self) {
        let _ = self.cmd("LOGOUT");
    }
}

/// 行尾是否为字面量标记 `{n}\r\n`。
fn ends_with_literal(line: &[u8]) -> bool {
    if line.len() < 5 {
        return false;
    }
    // 去掉行尾 \r\n（read_line_raw 读到 \n 为止，末尾应是 \r\n）
    let mut end = line.len();
    if line[end - 1] == b'\n' {
        end -= 1;
    }
    if end > 0 && line[end - 1] == b'\r' {
        end -= 1;
    }
    if end < 2 || line[end - 1] != b'}' {
        return false;
    }
    // } 前面应是全数字，数字前是 {
    let mut i = end - 2;
    while i > 0 && line[i].is_ascii_digit() {
        i -= 1;
    }
    line[i] == b'{' && (i + 1 < end) && line[i + 1..end - 1].iter().all(|b| b.is_ascii_digit())
}

fn literal_size(line: &[u8]) -> Option<usize> {
    let mut end = line.len();
    if end > 0 && line[end - 1] == b'\n' {
        end -= 1;
    }
    if end > 0 && line[end - 1] == b'\r' {
        end -= 1;
    }
    if end < 1 || line[end - 1] != b'}' {
        return None;
    }
    let close = end - 1;
    let mut open = close;
    while open > 0 && line[open - 1].is_ascii_digit() {
        open -= 1;
    }
    if open == 0 || line[open - 1] != b'{' {
        return None;
    }
    std::str::from_utf8(&line[open..close]).ok()?.parse().ok()
}

// ---------------------------------------------------------------------------
// Token 流：把响应解析为括号/原子/引号/字面量树
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Tok {
    Atom(String),
    Str(String),     // quoted 或 literal → 文本
    Group(Vec<Tok>), // (...)
}

struct Lexer<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Lexer<'a> {
    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && (self.bytes[self.pos] as char).is_whitespace() {
            self.pos += 1;
        }
    }

    /// 解析一个 token；到达末尾返回 None。括号组递归。
    fn next_tok(&mut self) -> Option<Tok> {
        self.skip_ws();
        if self.pos >= self.bytes.len() {
            return None;
        }
        match self.bytes[self.pos] {
            b'(' => {
                self.pos += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_ws();
                    if self.pos >= self.bytes.len() {
                        break;
                    }
                    if self.bytes[self.pos] == b')' {
                        self.pos += 1;
                        break;
                    }
                    items.push(self.next_tok()?);
                }
                Some(Tok::Group(items))
            }
            b'"' => {
                self.pos += 1;
                let mut out = Vec::new();
                while self.pos < self.bytes.len() && self.bytes[self.pos] != b'"' {
                    if self.bytes[self.pos] == b'\\' && self.pos + 1 < self.bytes.len() {
                        self.pos += 1;
                    }
                    out.push(self.bytes[self.pos]);
                    self.pos += 1;
                }
                self.pos += 1; // closing quote
                Some(Tok::Str(String::from_utf8_lossy(&out).into_owned()))
            }
            b'{' => {
                // {n}\r\n + n 字节
                let close = self.bytes[self.pos..].iter().position(|b| *b == b'}')? + self.pos;
                let n: usize = std::str::from_utf8(&self.bytes[self.pos + 1..close])
                    .ok()?
                    .parse()
                    .ok()?;
                // \r\n
                self.pos = close + 1;
                if self.pos + 1 < self.bytes.len() && self.bytes[self.pos] == b'\r' {
                    self.pos += 2;
                }
                let data = self.bytes.get(self.pos..self.pos + n)?;
                self.pos += n;
                Some(Tok::Str(String::from_utf8_lossy(data).into_owned()))
            }
            b')' => None,
            _ => {
                let start = self.pos;
                while self.pos < self.bytes.len() {
                    let b = self.bytes[self.pos];
                    if b == b' ' || b == b'(' || b == b')' || b == b'\r' || b == b'\n' {
                        break;
                    }
                    self.pos += 1;
                }
                if self.pos == start {
                    self.pos += 1; // 防死循环
                }
                Some(Tok::Atom(
                    String::from_utf8_lossy(&self.bytes[start..self.pos]).into_owned(),
                ))
            }
        }
    }
}

fn parse_tokens(raw: &[u8]) -> Vec<Tok> {
    let mut lexer = Lexer { bytes: raw, pos: 0 };
    let mut out = Vec::new();
    while let Some(t) = lexer.next_tok() {
        out.push(t);
    }
    out
}

fn tok_str(t: &Tok) -> Option<&str> {
    match t {
        Tok::Str(s) => Some(s),
        Tok::Atom(a) if !a.eq_ignore_ascii_case("NIL") => Some(a),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// RFC2047 编码字解码 + 文本规整
// ---------------------------------------------------------------------------

/// 解码 =?charset?B|Q?...?= 序列（imapflow 等价行为的最小实现）。
fn decode_rfc2047(input: &str) -> String {
    if !input.contains("=?") {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"=?") {
            if let Some((decoded, next)) = try_decode_encoded_word(&input[i..]) {
                out.push_str(&decoded);
                i += next;
                // 相邻编码字之间的纯空白被吞掉（RFC2047）；若下一个不是编码字则保留
                let rest = &input[i..];
                let trimmed_ws = rest.trim_start_matches([' ', '\t', '\r', '\n']);
                if trimmed_ws.starts_with("=?") {
                    i += rest.len() - trimmed_ws.len();
                }
                continue;
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn try_decode_encoded_word(s: &str) -> Option<(String, usize)> {
    // =?charset?enc?data?= —— 用前两个 '?' 定位头，再找数据尾的 "?="
    let rest = &s[2..];
    let q1 = rest.find('?')?;
    let charset = &rest[..q1];
    let after1 = &rest[q1 + 1..];
    let q2 = after1.find('?')?;
    let enc = &after1[..q2];
    let after2 = &after1[q2 + 1..];
    let close = after2.find("?=")?;
    let data = &after2[..close];
    if charset.is_empty() || enc.is_empty() {
        return None;
    }
    let decoded = match enc.to_ascii_uppercase().as_str() {
        "B" => {
            let cleaned: String = data.chars().filter(|c| !c.is_whitespace()).collect();
            String::from_utf8_lossy(&crate::crypto::b64_decode(&cleaned).ok()?).into_owned()
        }
        "Q" => decode_qp_word(data),
        _ => return None,
    };
    let consumed = 2 + q1 + 1 + q2 + 1 + close + 2;
    Some((decode_charset(&decoded, charset), consumed))
}

/// Q 编码：下划线=空格，=XX 十六进制。
fn decode_qp_word(data: &str) -> String {
    let bytes: &[u8] = data.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'_' => {
                out.push(b' ');
                i += 1;
            }
            b'=' if i + 2 < bytes.len() + 1 && i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&data[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// charset → UTF-8（utf-8 直通；latin 系手工映射；其余 lossy）。
fn decode_charset(s: &str, charset: &str) -> String {
    let cs = charset.to_ascii_lowercase();
    if cs.contains("utf-8") || cs.contains("utf8") {
        return s.to_string();
    }
    if cs.contains("1252")
        || cs.contains("iso-8859-1")
        || cs.contains("latin1")
        || cs.contains("latin-1")
    {
        return s.chars().map(cp1252_char).collect();
    }
    // gbk/gb2312/big5 等无内置表：按 lossy 处理（遗留项，见 REFACTOR-PLAN）
    s.to_string()
}

fn cp1252_char(c: char) -> char {
    match c as u32 {
        0x80 => '\u{20AC}',
        0x82 => '\u{201A}',
        0x83 => '\u{0192}',
        0x84 => '\u{201E}',
        0x85 => '\u{2026}',
        0x86 => '\u{2020}',
        0x87 => '\u{2021}',
        0x88 => '\u{02C6}',
        0x89 => '\u{2030}',
        0x8A => '\u{0160}',
        0x8B => '\u{2039}',
        0x8C => '\u{0152}',
        0x8E => '\u{017D}',
        0x91 => '\u{2018}',
        0x92 => '\u{2019}',
        0x93 => '\u{201C}',
        0x94 => '\u{201D}',
        0x95 => '\u{2022}',
        0x96 => '\u{2013}',
        0x97 => '\u{2014}',
        0x98 => '\u{02DC}',
        0x99 => '\u{2122}',
        0x9A => '\u{0161}',
        0x9B => '\u{203A}',
        0x9C => '\u{0153}',
        0x9E => '\u{017E}',
        0x9F => '\u{0178}',
        _ => c,
    }
}

/// normalizeMailText 近似：去 BOM/NUL，压平空白，去 \r，trim。
fn clean_text(value: &str) -> String {
    let no_nul: String = value
        .trim_start_matches('\u{FEFF}')
        .chars()
        .filter(|c| *c != '\0')
        .collect();
    no_nul
        .replace('\r', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// ENVELOPE / 地址
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct Envelope {
    date: Option<String>,
    subject: Option<String>,
    from: Vec<MailAddress>,
    to: Vec<MailAddress>,
    cc: Vec<MailAddress>,
}

fn parse_address_list(t: &Tok) -> Vec<MailAddress> {
    let items = match t {
        Tok::Group(g) => g,
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    for item in items {
        if let Tok::Group(fields) = item {
            // (name ADL mailbox host)
            let name = fields.first().and_then(tok_str);
            let mailbox = fields.get(2).and_then(tok_str);
            let host = fields.get(3).and_then(tok_str);
            let address = match (mailbox, host) {
                (Some(m), Some(h)) => Some(format!("{m}@{h}")),
                (Some(m), None) => Some(m.to_string()), // 组地址退化为裸值
                _ => None,
            };
            out.push(MailAddress {
                name: name
                    .map(|n| clean_text(&decode_rfc2047(n)))
                    .unwrap_or_default(),
                address: address.unwrap_or_default(),
            });
        }
    }
    out
}

fn parse_envelope(t: &Tok) -> Envelope {
    let mut env = Envelope::default();
    let fields = match t {
        Tok::Group(g) => g,
        _ => return env,
    };
    // (date subject from sender reply-to to cc bcc in-reply-to message-id)
    env.date = fields.first().and_then(tok_str).map(decode_rfc2047);
    env.subject = fields
        .get(1)
        .and_then(tok_str)
        .map(|s| clean_text(&decode_rfc2047(s)));
    env.from = fields.get(2).map(parse_address_list).unwrap_or_default();
    env.to = fields.get(5).map(parse_address_list).unwrap_or_default();
    env.cc = fields.get(6).map(parse_address_list).unwrap_or_default();
    env
}

/// headerAddress：name 非空 → `name <addr>`；否则裸 addr；都没有 → None。
fn header_address(addr: &MailAddress) -> MailRecipient {
    if addr.name.trim().is_empty() {
        MailRecipient {
            name: None,
            address: if addr.address.is_empty() {
                None
            } else {
                Some(addr.address.clone())
            },
        }
    } else {
        MailRecipient {
            name: Some(addr.name.clone()),
            address: if addr.address.is_empty() {
                None
            } else {
                Some(addr.address.clone())
            },
        }
    }
}

// ---------------------------------------------------------------------------
// BODYSTRUCTURE 走查（附件判定 + part 编号）
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct BodyPart {
    mime: String,
    part_no: String,
    children: Vec<BodyPart>,
    has_attachment_meta: bool,
}

/// BODYSTRUCTURE 树 → BodyPart 树（含 IMAP part 编号）。
/// multipart 节点首元素是子体 group；叶子节点首元素是类型原子。
fn parse_bodystructure(t: &Tok, prefix: &str) -> Option<BodyPart> {
    let group = match t {
        Tok::Group(g) => g,
        _ => return None,
    };
    if group.is_empty() {
        return None;
    }
    let is_multipart = matches!(group[0], Tok::Group(_));
    if is_multipart {
        let mut part = BodyPart {
            mime: "multipart/mixed".into(),
            part_no: prefix.to_string(),
            children: Vec::new(),
            has_attachment_meta: false,
        };
        let mut child_no = 1usize;
        let mut idx = 0usize;
        while idx < group.len() {
            match &group[idx] {
                Tok::Group(_) => {
                    let child_prefix = if prefix.is_empty() {
                        child_no.to_string()
                    } else {
                        format!("{prefix}.{child_no}")
                    };
                    if let Some(child) = parse_bodystructure(&group[idx], &child_prefix) {
                        part.children.push(child);
                    }
                    child_no += 1;
                    idx += 1;
                }
                Tok::Atom(_) => break, // 子体结束，进入扩展属性
                _ => idx += 1,
            }
        }
        // multipart 节点自身也可能带 disposition
        part.has_attachment_meta = group_has_disposition_attachment(group);
        return Some(part);
    }
    let type_atom = group.first().and_then(tok_str)?.to_ascii_lowercase();
    let subtype = group
        .get(1)
        .and_then(tok_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = format!("{type_atom}/{subtype}");
    let mut part = BodyPart {
        mime: mime.clone(),
        part_no: prefix.to_string(),
        children: Vec::new(),
        has_attachment_meta: false,
    };
    // message/rfc822：扩展区最后一个元素又是 bodystructure，不展开（附件判定已覆盖）
    part.has_attachment_meta = body_part_attachment_meta(group, &mime);
    Some(part)
}

/// 叶子节点附件特征：disposition=attachment / filename|name 参数 / message/rfc822。
fn body_part_attachment_meta(group: &[Tok], mime: &str) -> bool {
    if mime == "message/rfc822" {
        return true;
    }
    // 扩展区：id desc enc size [md5 [disposition [params]] ...]
    // 递归扫：找值为 "attachment" 的原子，或键为 filename/name 的参数。
    for (i, t) in group.iter().enumerate() {
        if let Tok::Atom(atom) = t {
            if atom.eq_ignore_ascii_case("attachment") {
                return true;
            }
        }
        if let Tok::Str(s) = t {
            if (s.eq_ignore_ascii_case("filename") || s.eq_ignore_ascii_case("name")) && i > 0 {
                // 参数名后面应有值（Str/Atom）
                return true;
            }
        }
        if let Tok::Group(sub) = t {
            if body_part_attachment_meta(sub, "") {
                return true;
            }
        }
    }
    false
}

fn group_has_disposition_attachment(group: &[Tok]) -> bool {
    group
        .iter()
        .any(|t| matches!(t, Tok::Atom(a) if a.eq_ignore_ascii_case("attachment")))
}

/// hasAttachment(root, nested) 语义。
fn has_attachment(root: &BodyPart, nested: bool) -> bool {
    let type_ = root.mime.as_str();
    if root.has_attachment_meta
        || (nested && !type_.starts_with("multipart/") && !type_.starts_with("text/"))
    {
        return true;
    }
    root.children.iter().any(|c| has_attachment(c, true))
}

/// preferredTextParts：multipart/alternative 内 html 优先、plain 次之；跳过附件节点。
fn preferred_text_parts<'a>(root: &'a BodyPart, out: &mut Vec<&'a BodyPart>) {
    if root.has_attachment_meta {
        return;
    }
    let type_ = root.mime.as_str();
    if (type_ == "text/html" || type_ == "text/plain")
        && (!root.part_no.is_empty() || root.children.is_empty())
    {
        out.push(root);
        return;
    }
    let mut branches: Vec<&BodyPart> = Vec::new();
    for child in &root.children {
        let mut sub = Vec::new();
        preferred_text_parts(child, &mut sub);
        branches.extend(sub);
    }
    if type_ == "multipart/alternative" {
        out.extend(branches.iter().filter(|b| b.mime == "text/html"));
        out.extend(branches.iter().filter(|b| b.mime == "text/plain"));
    } else if let Some(first) = branches.first() {
        out.push(first);
    }
}

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

/// INTERNALDATE "dd-Mon-yyyy HH:MM:SS +zzzz" → ISO8601（normalizeMailDate）。
fn normalize_internal_date(raw: &str) -> Option<String> {
    let s = raw.trim().trim_matches('"');
    chrono::DateTime::parse_from_str(s, "%d-%b-%Y %H:%M:%S %z")
        .ok()
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// RFC2822 日期（envelope date）→ ISO8601。
fn normalize_rfc2822(raw: &str) -> Option<String> {
    let s = clean_text(&decode_rfc2047(raw));
    chrono::DateTime::parse_from_rfc2822(&s)
        .ok()
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

pub fn list_folders(
    email: &str,
    access_token: &str,
    _proxy_url: &str,
    timeout: std::time::Duration,
) -> Result<Vec<MailFolder>, AppError> {
    let mut session = ImapSession::connect(email, access_token, timeout)?;
    let result = session.cmd(r#"LIST "" "*""#)?;
    session.logout();
    if !result.ok {
        return Err(ImapError(format!("LIST failed: {}", result.tagged.trim())).to_app_error());
    }
    let mut folders = Vec::new();
    for line in result.raw.split(|b| *b == b'\n') {
        let line = String::from_utf8_lossy(line);
        // * LIST (\Flags) "delimiter" path
        if !line.trim_start().starts_with("* LIST") {
            continue;
        }
        let path = parse_list_line_path(&line);
        if let Some(path) = path {
            if !path.trim().is_empty() {
                // id 保留原始编码（后续 SELECT 需要）；displayName 解码 Modified UTF-7（imapflow 行为）
                let display = decode_imap_utf7(&path);
                folders.push(MailFolder {
                    id: path.clone(),
                    display_name: display,
                    total_item_count: 0,
                    unread_item_count: 0,
                });
            }
        }
    }
    Ok(folders)
}

/// 从 LIST 行提取邮箱路径：`* LIST (flags) delim path`。
fn parse_list_line_path(line: &str) -> Option<String> {
    let tokens = parse_tokens(line.as_bytes());
    // 跳过 "*" 与 "LIST" 两枚原子
    let mut atoms = 0;
    let mut i = 0;
    while i < tokens.len() && atoms < 2 {
        if matches!(tokens[i], Tok::Atom(_)) {
            atoms += 1;
        }
        i += 1;
    }
    // flags 组（可无）
    if i < tokens.len() && matches!(tokens[i], Tok::Group(_)) {
        i += 1;
    }
    // 分隔符（quoted 串或 NIL）
    if i < tokens.len() {
        match &tokens[i] {
            Tok::Str(_) => i += 1,
            Tok::Atom(a) if a.eq_ignore_ascii_case("NIL") => i += 1,
            _ => {}
        }
    }
    // path
    match tokens.get(i) {
        Some(Tok::Str(s)) if !s.trim().is_empty() => Some(s.clone()),
        Some(Tok::Atom(a)) if !a.eq_ignore_ascii_case("NIL") && !a.trim().is_empty() => {
            Some(a.clone())
        }
        _ => None,
    }
}

pub struct ImapListResult {
    pub messages: Vec<MailListItem>,
    pub total_count: i64,
}

/// listImapMessages：窗口 + SEARCH + FETCH。
#[allow(clippy::too_many_arguments)] // 与原版 listImapMessages 参数一一对应
pub fn list_messages(
    email: &str,
    access_token: &str,
    folder_id: &str,
    top: usize,
    search: &str,
    cursor: &str,
    _proxy_url: &str,
    timeout: std::time::Duration,
) -> Result<ImapListResult, AppError> {
    let limit = top.clamp(1, 100);
    let mut session = ImapSession::connect(email, access_token, timeout)?;
    let select = session.cmd(&format!("SELECT {}", quote_string(folder_id)))?;
    if !select.ok {
        session.logout();
        return Err(ImapError(format!("SELECT failed: {}", select.tagged.trim())).to_app_error());
    }
    let exists = find_untagged_number(&select.raw, b"EXISTS").unwrap_or(0);
    let uid_next = find_uid_next(&select.raw).unwrap_or(exists.max(1) + 1);

    let query = search.trim();
    // 原版：beforeUid = cursor 或 uidNext；窗口 = max(limit*5,100)
    let before_uid: i64 = cursor.trim().parse().unwrap_or(uid_next);
    let matched: Option<Vec<i64>> = if query.is_empty() {
        None
    } else {
        let cmd = format!("UID SEARCH SUBJECT {}", literal_string(query));
        let resp = session.cmd(&cmd)?;
        if !resp.ok {
            // imapflow 在 SEARCH 被拒时抛错——同样报错，不静默
            session.logout();
            return Err(ImapError(format!("SEARCH failed: {}", resp.tagged.trim())).to_app_error());
        }
        Some(parse_search_uids(&resp.raw))
    };

    let fetch_range: Option<String> = match &matched {
        Some(uids) => {
            let selected: Vec<String> = uids
                .iter()
                .filter(|u| **u < before_uid)
                .rev()
                .take(limit)
                .map(|u| u.to_string())
                .collect();
            if selected.is_empty() {
                None
            } else {
                Some(selected.join(","))
            }
        }
        None => {
            let end = before_uid - 1;
            if end < 1 {
                None
            } else {
                let window = (limit as i64 * 5).max(100);
                let start = (end - window + 1).max(1);
                Some(format!("{start}:{end}"))
            }
        }
    };

    let mut messages: Vec<MailListItem> = Vec::new();
    if let Some(range) = fetch_range {
        let fetch = session.cmd(&format!(
            "UID FETCH {range} (UID FLAGS ENVELOPE INTERNALDATE BODYSTRUCTURE)"
        ))?;
        if !fetch.ok {
            session.logout();
            return Err(ImapError(format!("FETCH failed: {}", fetch.tagged.trim())).to_app_error());
        }
        messages = parse_fetch_list(&fetch.raw);
    }
    session.logout();

    // 按接收时间倒序，截 limit（原版同）
    messages.sort_by(|a, b| b.received_date_time.cmp(&a.received_date_time));
    messages.truncate(limit);
    Ok(ImapListResult {
        messages,
        total_count: exists,
    })
}

pub struct ImapDetailResult {
    pub detail: crate::contracts::MailDetail,
}

/// getImapMessage：单封详情 + 正文（返回 Graph 同型 MailDetail）。
pub fn get_message(
    email: &str,
    access_token: &str,
    folder_id: &str,
    message_id: &str,
    _proxy_url: &str,
    timeout: std::time::Duration,
) -> Result<crate::contracts::MailDetail, AppError> {
    let mut session = ImapSession::connect(email, access_token, timeout)?;
    let select = session.cmd(&format!("SELECT {}", quote_string(folder_id)))?;
    if !select.ok {
        session.logout();
        return Err(ImapError(format!("SELECT failed: {}", select.tagged.trim())).to_app_error());
    }
    let meta = session.cmd(&format!(
        "UID FETCH {} (UID FLAGS ENVELOPE INTERNALDATE RFC822.SIZE BODYSTRUCTURE)",
        message_id
    ))?;
    if !meta.ok {
        session.logout();
        return Err(ImapError(format!("FETCH failed: {}", meta.tagged.trim())).to_app_error());
    }
    let items = parse_fetch_list(&meta.raw);
    let item = items
        .first()
        .cloned()
        .ok_or_else(|| AppError::Unknown("邮件不存在".into()))?;

    // 正文：≤10MB 全文；否则首选文本 part
    let size = parse_fetch_items(&meta.raw)
        .first()
        .map(|i| i.rfc822_size)
        .unwrap_or(0);
    let (content, content_type) = if size > IMAP_FULL_SOURCE_MAX_BYTES as i64 {
        // 走 part 下载
        let structure = parse_fetch_bodystructure(&meta.raw)
            .ok_or_else(|| AppError::Unknown("BODYSTRUCTURE 解析失败".into()))?;
        let mut parts = Vec::new();
        preferred_text_parts(&structure, &mut parts);
        let part = parts
            .first()
            .ok_or_else(|| AppError::Unknown("无可下载文本".into()))?;
        let (content, ct) = download_part(&mut session, message_id, part)?;
        (content, ct)
    } else {
        let full = session.cmd(&format!("UID FETCH {message_id} (BODY.PEEK[])"))?;
        if !full.ok {
            session.logout();
            return Err(
                ImapError(format!("body fetch failed: {}", full.tagged.trim())).to_app_error(),
            );
        }
        let raw = extract_single_literal(&full.raw).unwrap_or_default();
        parse_mime_to_content(&raw)
    };
    session.logout();

    // preview：正文去标签前 180 字符（原版 bodyPreview 同源语义）
    let from_addr = item.from.clone().unwrap_or_default();
    let mut detail = crate::contracts::MailDetail {
        id: item.id,
        subject: item.subject,
        body: crate::contracts::MailBody {
            content_type,
            content,
        },
        from: from_addr,
        to_recipients: Vec::new(),
        cc_recipients: Vec::new(),
        received_date_time: item.received_date_time,
        sent_date_time: item.sent_date_time,
        is_read: item.is_read,
        has_attachments: item.has_attachments,
        attachments: Vec::new(),
        conversation_id: None,
        web_link: None,
        importance: "normal".into(),
        flag: crate::contracts::MailFlag {
            flag_status: "notFlagged".into(),
        },
    };
    // to/cc 需 ENVELOPE：重新解析（parse_fetch_list 不携带）——用 meta 里的 envelope
    if let Some(env_tok) = parse_fetch_envelope(&meta.raw) {
        let env = parse_envelope(&env_tok);
        detail.to_recipients = env
            .to
            .iter()
            .map(|a| MailRecipient {
                name: if a.name.is_empty() {
                    None
                } else {
                    Some(a.name.clone())
                },
                address: if a.address.is_empty() {
                    None
                } else {
                    Some(a.address.clone())
                },
            })
            .collect();
        detail.cc_recipients = env
            .cc
            .iter()
            .map(|a| MailRecipient {
                name: if a.name.is_empty() {
                    None
                } else {
                    Some(a.name.clone())
                },
                address: if a.address.is_empty() {
                    None
                } else {
                    Some(a.address.clone())
                },
            })
            .collect();
    }
    Ok(detail)
}

/// UID STORE ±FLAGS (\Seen)。
pub fn mark_read(
    email: &str,
    access_token: &str,
    folder_id: &str,
    message_id: &str,
    is_read: bool,
    timeout: std::time::Duration,
) -> Result<(), AppError> {
    let mut session = ImapSession::connect(email, access_token, timeout)?;
    let select = session.cmd(&format!("SELECT {}", quote_string(folder_id)))?;
    if !select.ok {
        session.logout();
        return Err(ImapError(format!("SELECT failed: {}", select.tagged.trim())).to_app_error());
    }
    let op = if is_read { "+FLAGS" } else { "-FLAGS" };
    let store = session.cmd(&format!("UID STORE {message_id} {op} (\\Seen)"))?;
    session.logout();
    if !store.ok {
        return Err(ImapError(format!("STORE failed: {}", store.tagged.trim())).to_app_error());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 一次性收件计数（保留原 API）
// ---------------------------------------------------------------------------

/// 一次性的收件计数查询（连接 → LOGIN → EXAMINE INBOX → SEARCH UNSEEN → LOGOUT）。
/// 返回 (未读数, 全部邮件数)。
pub fn fetch_inbox_counts(
    email: &str,
    access_token: &str,
    timeout: std::time::Duration,
) -> Result<(i64, i64), AppError> {
    let mut session = ImapSession::connect(email, access_token, timeout)?;

    let examine = session.cmd("EXAMINE INBOX")?;
    if !examine.ok {
        return Err(ImapError(format!("examine failed: {}", examine.tagged.trim())).to_app_error());
    }

    let unseen = session.cmd("SEARCH UNSEEN")?;
    let unseen_count = count_search_hits(&unseen.raw);

    let all = session.cmd("SEARCH ALL")?;
    let all_count = count_search_hits(&all.raw);

    session.logout();
    Ok((unseen_count, all_count))
}

fn count_search_hits(raw: &[u8]) -> i64 {
    // * SEARCH 2 5 9 → 数字个数
    let text = String::from_utf8_lossy(raw);
    text.lines()
        .filter(|l| l.trim_start().starts_with("* SEARCH"))
        .flat_map(|l| l.trim_start_matches("* SEARCH").split_whitespace())
        .filter(|t| t.parse::<i64>().is_ok())
        .count() as i64
}

// ---------------------------------------------------------------------------
// 解析辅助
// ---------------------------------------------------------------------------

/// 解码 IMAP Modified UTF-7（RFC3501 §5.1.3；imapflow 等价行为）。
fn decode_imap_utf7(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 1..];
        match after.find('-') {
            Some(end) => {
                let chunk = &after[..end];
                if chunk.is_empty() {
                    out.push('&'); // "&-" → 字面 &
                } else {
                    out.push_str(&decode_utf7_chunk(chunk));
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                out.push_str(after);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_utf7_chunk(chunk: &str) -> String {
    // Modified base64：',' 当 '/'，补 '=' 到 4 的倍数，UTF-16BE 解码
    let b64: String = chunk
        .chars()
        .map(|c| if c == ',' { '/' } else { c })
        .collect();
    let padded = match b64.len() % 4 {
        2 => format!("{b64}=="),
        3 => format!("{b64}="),
        _ => b64,
    };
    let Ok(bytes) = crate::crypto::b64_decode(&padded) else {
        return chunk.to_string();
    };
    let units: Vec<u16> = bytes
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

fn quote_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn literal_string(s: &str) -> String {
    format!("{{{}}}\r\n{}", s.len(), s)
}

/// 在 raw 中找 `* <n> <KEY>`。
fn find_untagged_number(raw: &[u8], key: &[u8]) -> Option<i64> {
    let text = String::from_utf8_lossy(raw);
    for line in text.lines() {
        let t = line.trim_start();
        if !t.starts_with("* ") {
            continue;
        }
        let rest = &t[2..];
        if key.is_empty() {
            // RFC822.SIZE 在 FETCH 响应里，走 parse 路径，这里不用
            continue;
        }
        let mut it = rest.split_whitespace();
        let n = it.next()?.parse::<i64>().ok()?;
        if let Some(k) = it.next() {
            if k.as_bytes() == key {
                return Some(n);
            }
        }
    }
    None
}

fn find_uid_next(raw: &[u8]) -> Option<i64> {
    let text = String::from_utf8_lossy(raw);
    for line in text.lines() {
        if let Some(idx) = line.find("[UIDNEXT ") {
            let rest = &line[idx + 9..];
            let n: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            return n.parse().ok();
        }
    }
    None
}

fn parse_search_uids(raw: &[u8]) -> Vec<i64> {
    let text = String::from_utf8_lossy(raw);
    text.lines()
        .filter(|l| l.trim_start().starts_with("* SEARCH"))
        .flat_map(|l| l.trim_start_matches("* SEARCH").split_whitespace())
        .filter_map(|t| t.parse().ok())
        .collect()
}

#[derive(Debug, Clone, Default)]
struct FetchItem {
    uid: String,
    flags: Vec<String>,
    envelope: Option<Tok>,
    internal_date: Option<String>,
    bodystructure: Option<Tok>,
    rfc822_size: i64,
}

/// 从 FETCH 响应解析每个 `* n FETCH (...)`。
fn parse_fetch_items(raw: &[u8]) -> Vec<FetchItem> {
    let mut items = Vec::new();
    let text = String::from_utf8_lossy(raw).into_owned();
    for line in text.lines() {
        let t = line.trim_start();
        if !(t.starts_with("* ") && t[2..].trim_start().to_uppercase().contains("FETCH")) {
            continue;
        }
        let tokens = parse_tokens(t.as_bytes());
        // tokens: *, n, FETCH, Group(attrs)
        let attrs = tokens.iter().find_map(|tok| match tok {
            Tok::Group(g) if !g.is_empty() => Some(g.clone()),
            _ => None,
        });
        let attrs = match attrs {
            Some(a) => a,
            None => continue,
        };
        let mut item = FetchItem::default();
        let mut i = 0;
        while i < attrs.len() {
            match &attrs[i] {
                Tok::Atom(key) if key.eq_ignore_ascii_case("UID") => {
                    item.uid = attrs.get(i + 1).and_then(tok_str).unwrap_or("").to_string();
                    i += 2;
                }
                Tok::Atom(key) if key.eq_ignore_ascii_case("FLAGS") => {
                    if let Some(Tok::Group(flags)) = attrs.get(i + 1) {
                        item.flags = flags
                            .iter()
                            .filter_map(|f| match f {
                                Tok::Atom(a) => Some(a.clone()),
                                _ => None,
                            })
                            .collect();
                    }
                    i += 2;
                }
                Tok::Atom(key) if key.eq_ignore_ascii_case("ENVELOPE") => {
                    item.envelope = attrs.get(i + 1).cloned();
                    i += 2;
                }
                Tok::Atom(key) if key.eq_ignore_ascii_case("INTERNALDATE") => {
                    item.internal_date = attrs.get(i + 1).and_then(tok_str).map(|s| s.to_string());
                    i += 2;
                }
                Tok::Atom(key) if key.eq_ignore_ascii_case("RFC822.SIZE") => {
                    item.rfc822_size = attrs
                        .get(i + 1)
                        .and_then(tok_str)
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    i += 2;
                }
                Tok::Atom(key) if key.eq_ignore_ascii_case("BODYSTRUCTURE") => {
                    item.bodystructure = attrs.get(i + 1).cloned();
                    i += 2;
                }
                _ => i += 1,
            }
        }
        if !item.uid.is_empty() {
            items.push(item);
        }
    }
    items
}

/// FetchItem → MailListItem。
fn parse_fetch_list(raw: &[u8]) -> Vec<MailListItem> {
    parse_fetch_items(raw)
        .into_iter()
        .map(|item| {
            let env = item
                .envelope
                .as_ref()
                .map(parse_envelope)
                .unwrap_or_default();
            let has_att = item
                .bodystructure
                .as_ref()
                .and_then(|bs| parse_bodystructure(bs, ""))
                .map(|root| has_attachment(&root, false))
                .unwrap_or(false);
            MailListItem {
                id: item.uid.clone(),
                subject: env.subject.clone().unwrap_or_else(|| "(无主题)".into()),
                from: env.from.first().map(header_address),
                received_date_time: item
                    .internal_date
                    .as_deref()
                    .and_then(normalize_internal_date),
                sent_date_time: env.date.as_deref().and_then(normalize_rfc2822),
                is_read: item.flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen")),
                importance: "normal".into(),
                has_attachments: has_att,
                body_preview: None,
                web_link: None,
            }
        })
        .collect()
}

fn parse_fetch_bodystructure(raw: &[u8]) -> Option<BodyPart> {
    let items = parse_fetch_items(raw);
    let bs = items.first()?.bodystructure.as_ref()?;
    parse_bodystructure(bs, "")
}

fn parse_fetch_envelope(raw: &[u8]) -> Option<Tok> {
    parse_fetch_items(raw).into_iter().next()?.envelope
}

/// 提取响应中唯一的字面量（BODY.PEEK[] 的正文）。
fn extract_single_literal(raw: &[u8]) -> Option<Vec<u8>> {
    // 在字节流中找 {n}\r\n 并取其后 n 字节（取最后一个，即正文）
    let mut found: Option<(usize, usize)> = None;
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'{' {
            let close = raw[i..].iter().position(|b| *b == b'}')? + i;
            if let Ok(n) = std::str::from_utf8(&raw[i + 1..close])
                .unwrap_or("")
                .parse::<usize>()
            {
                if close + 3 <= raw.len() && &raw[close + 1..close + 3] == b"\r\n" {
                    found = Some((close + 3, n));
                    i = close + 3 + n;
                    continue;
                }
            }
        }
        i += 1;
    }
    let (start, n) = found?;
    raw.get(start..start + n).map(|s| s.to_vec())
}

/// 下载单个 body part（BODY.PEEK[section]），按其 CTE 解码。
fn download_part(
    session: &mut ImapSession,
    uid: &str,
    part: &BodyPart,
) -> Result<(String, String), AppError> {
    let fetch = session.cmd(&format!("UID FETCH {} (BODY.PEEK[{}])", uid, part.part_no))?;
    if !fetch.ok {
        return Err(
            ImapError(format!("part fetch failed: {}", fetch.tagged.trim())).to_app_error(),
        );
    }
    let raw = extract_single_literal(&fetch.raw).unwrap_or_default();
    let content_type = if part.mime == "text/html" {
        "html"
    } else {
        "text"
    };
    // part 响应里没有独立 headers：BODYSTRUCTURE 里的编码信息未携带，
    // 对 part 内容按 MIME 二次解析（part 内容自带 headers）
    let (content, _) = parse_mime_to_content(&raw);
    Ok((content, content_type.to_string()))
}

// ---------------------------------------------------------------------------
// MIME 解析（全量源 → html/text 正文）
// ---------------------------------------------------------------------------

/// HTML → 纯文本（原版 bodyPreview 语义；当前 MailDetail 契约无 preview 字段，测试覆盖）。
#[allow(dead_code)]
fn strip_html(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut in_tag = false;
    for c in content.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    clean_text(&out)
}

/// 解析完整 RFC822：优先 text/html，其次 text/plain。
fn parse_mime_to_content(raw: &[u8]) -> (String, String) {
    let mut collector = MimeCollector::default();
    collect_mime(raw, &mut collector, 0);
    if let Some((_, content)) = collector.html.first() {
        return (content.clone(), "html".into());
    }
    if let Some((_, content)) = collector.plain.first() {
        return (content.clone(), "text".into());
    }
    (String::new(), "text".into())
}

#[derive(Default)]
struct MimeCollector {
    html: Vec<(String, String)>,
    plain: Vec<(String, String)>,
}

/// 递归收集文本 part（与 preferredTextParts 顺序语义近似：先深搜，html 优先在 selection 时体现）。
fn collect_mime(raw: &[u8], collector: &mut MimeCollector, depth: usize) {
    if depth > 8 || raw.len() > 64 * 1024 * 1024 {
        return;
    }
    let (headers_raw, body) = split_headers(raw);
    let headers = parse_mime_headers(headers_raw);
    let ctype = headers
        .get("content-type")
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let cte = headers
        .get("content-transfer-encoding")
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "7bit".into());
    let disposition = headers
        .get("content-disposition")
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    if ctype.starts_with("multipart/") {
        if let Some(boundary) =
            extract_boundary(&headers.get("content-type").cloned().unwrap_or_default())
        {
            for part in split_boundary(body, &boundary) {
                collect_mime(&part, collector, depth + 1);
            }
            return;
        }
    }
    if disposition.starts_with("attachment") {
        return;
    }
    let charset = headers
        .get("content-type")
        .map(|s| charset_of(s))
        .unwrap_or_else(|| "utf-8".to_string());
    let decoded = decode_cte(body, &cte);
    if ctype.starts_with("text/html") {
        let text = decode_charset(&String::from_utf8_lossy(&decoded), &charset);
        collector.html.push(("html".into(), text));
    } else if ctype.starts_with("text/plain") || ctype.is_empty() {
        let text = decode_charset(&String::from_utf8_lossy(&decoded), &charset);
        collector.plain.push(("text".into(), text));
    }
    // message/rfc822 等：不展开（正文取不到时退化空串，遗留项）
}

fn split_headers(raw: &[u8]) -> (&[u8], &[u8]) {
    for i in 0..raw.len().saturating_sub(3) {
        if &raw[i..i + 4] == b"\r\n\r\n" {
            return (&raw[..i], &raw[i + 4..]);
        }
    }
    for i in 0..raw.len().saturating_sub(1) {
        if &raw[i..i + 2] == b"\n\n" {
            return (&raw[..i], &raw[i + 2..]);
        }
    }
    (raw, &[])
}

fn parse_mime_headers(raw: &[u8]) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let text = String::from_utf8_lossy(raw);
    let mut last_key: Option<String> = None;
    for line in text.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(k) = &last_key {
                map.entry(k.clone())
                    .and_modify(|v: &mut String| v.push_str(line.trim()));
            }
            continue;
        }
        if let Some(idx) = line.find(':') {
            let key = line[..idx].trim().to_ascii_lowercase();
            let value = line[idx + 1..].trim().to_string();
            map.insert(key.clone(), value);
            last_key = Some(key);
        }
    }
    map
}

fn extract_boundary(content_type: &str) -> Option<String> {
    let lower = content_type.to_ascii_lowercase();
    let idx = lower.find("boundary=")?;
    let rest = content_type[idx + 9..].trim();
    let value = if let Some(stripped) = rest.strip_prefix('"') {
        stripped.split('"').next().unwrap_or("").to_string()
    } else {
        rest.split(';').next().unwrap_or("").trim().to_string()
    };
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn charset_of(content_type: &str) -> String {
    let lower = content_type.to_ascii_lowercase();
    if let Some(idx) = lower.find("charset=") {
        let rest = content_type[idx + 8..].trim();
        let value = if let Some(stripped) = rest.strip_prefix('"') {
            stripped.split('"').next().unwrap_or("").to_string()
        } else {
            rest.split(';').next().unwrap_or("").trim().to_string()
        };
        return value;
    }
    "utf-8".into()
}

fn split_boundary(body: &[u8], boundary: &str) -> Vec<Vec<u8>> {
    let marker = format!("--{boundary}");
    let text = String::from_utf8_lossy(body).into_owned();
    let mut parts = Vec::new();
    let mut current: Option<String> = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == marker || trimmed == format!("{marker}--") {
            if let Some(c) = current.take() {
                parts.push(c);
            }
            if trimmed.ends_with("--") {
                break;
            }
            current = Some(String::new());
        } else if let Some(c) = current.as_mut() {
            c.push_str(line);
        }
    }
    if let Some(c) = current {
        parts.push(c);
    }
    parts.into_iter().map(|s| s.into_bytes()).collect()
}

fn decode_cte(body: &[u8], cte: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(body);
    match cte.trim() {
        "base64" => crate::crypto::b64_decode(&text.replace(['\r', '\n'], ""))
            .unwrap_or_else(|_| body.to_vec()),
        "quoted-printable" => decode_qp_bytes(&text),
        _ => body.to_vec(),
    }
}

/// quoted-printable：=XX 解码，软换行 =\r\n 移除。
fn decode_qp_bytes(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'=' if i + 1 < bytes.len()
                && bytes[i + 1] == b'\r'
                && i + 2 < bytes.len()
                && bytes[i + 2] == b'\n' =>
            {
                i += 3; // 软换行
            }
            b'=' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => {
                i += 2;
            }
            b'=' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 兼容旧 API：ImapClient 结构保留（main.rs / 测试引用）
// ---------------------------------------------------------------------------

/// IMAP 客户端句柄（保留公开 API；实际会话走 ImapSession::connect）。
#[allow(dead_code)]
pub struct ImapClient {
    host: String,
    port: u16,
    timeout: std::time::Duration,
}

impl ImapClient {
    pub fn new(host: String, port: u16, timeout: std::time::Duration) -> Self {
        Self {
            host,
            port,
            timeout,
        }
    }

    pub fn new_default(timeout: std::time::Duration) -> Self {
        Self::new(IMAP_HOST.into(), IMAP_PORT, timeout)
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xoauth2_format() {
        let s = build_xoauth2("a@x.com", "tok-1");
        assert_eq!(s, "user=a@x.com\u{1}auth=Bearer tok-1\u{1}\u{1}");
    }

    #[test]
    fn imap_error_classification() {
        let auth = ImapError("AUTHENTICATE failed: AUTHNFAILED".into()).to_app_error();
        assert!(matches!(auth, AppError::ImapAuthFailed(_)));
        let net = ImapError("connect: timed out".into()).to_app_error();
        assert!(matches!(net, AppError::NetworkError(_)));
    }

    #[test]
    fn default_host() {
        assert_eq!(IMAP_HOST, "outlook.office365.com");
        assert_eq!(IMAP_PORT, 993);
    }

    #[test]
    fn literal_detection() {
        assert!(ends_with_literal(b"* 1 FETCH (BODY[] {123}\r\n"));
        assert!(!ends_with_literal(b"* 1 FETCH (FLAGS (\\Seen))\r\n"));
        assert_eq!(literal_size(b"* 1 FETCH (BODY[] {123}\r\n"), Some(123));
        assert_eq!(literal_size(b"* 1 OK done\r\n"), None);
    }

    #[test]
    fn lexer_parses_fetch_line() {
        let line =
            b"* 1 FETCH (UID 42 FLAGS (\\Seen) INTERNALDATE \"01-Apr-2024 10:00:00 +0800\")\r\n";
        let tokens = parse_tokens(line);
        assert!(matches!(tokens[0], Tok::Atom(ref a) if a == "*"));
        let group = tokens
            .iter()
            .find_map(|t| match t {
                Tok::Group(g) => Some(g),
                _ => None,
            })
            .unwrap();
        assert!(group
            .iter()
            .any(|t| matches!(t, Tok::Atom(a) if a == "UID")));
        assert!(group
            .iter()
            .any(|t| matches!(t, Tok::Str(s) if s.contains("01-Apr-2024"))));
    }

    #[test]
    fn lexer_parses_literals_in_envelope() {
        // 主题含字面量：ENVELOPE (... {6}\r\n主题 ... )
        let raw = b"* 3 FETCH (ENVELOPE (\"Mon, 01 Apr 2024 10:00:00 +0800\" {6}\r\n\xe4\xb8\xbb\xe9\xa2\x98 ((NIL NIL \"alice\" \"x.com\")) NIL NIL NIL NIL NIL NIL NIL))\r\n";
        let tokens = parse_tokens(raw);
        // 找 first==Atom(ENVELOPE) 的 attrs 组，再取其值组
        let attrs = tokens
            .iter()
            .find_map(|t| match t {
                Tok::Group(g) => Some(g),
                _ => None,
            })
            .expect("fetch attrs");
        let env_idx = attrs
            .iter()
            .position(|t| matches!(t, Tok::Atom(a) if a.eq_ignore_ascii_case("ENVELOPE")))
            .expect("envelope key");
        let env = &attrs[env_idx + 1];
        let parsed = parse_envelope(env);
        assert_eq!(parsed.subject.as_deref(), Some("主题"));
        assert_eq!(parsed.from.len(), 1);
        assert_eq!(parsed.from[0].address, "alice@x.com");
    }

    #[test]
    fn rfc2047_base64_and_qp() {
        // =?utf-8?B?...?= → "主题"
        let b64 = crate::crypto::b64_encode("主题".as_bytes());
        let s = format!("=?utf-8?B?{b64}?=");
        assert_eq!(decode_rfc2047(&s), "主题");
        // Q 编码
        assert_eq!(decode_rfc2047("=?utf-8?Q?Hello_World?="), "Hello World");
        // 混合
        assert_eq!(decode_rfc2047("a =?utf-8?Q?b?= c"), "a b c");
    }

    #[test]
    fn envelope_address_format() {
        let addr = MailAddress {
            name: "张三".into(),
            address: "z@x.com".into(),
        };
        let r = header_address(&addr);
        assert_eq!(r.name.as_deref(), Some("张三"));
        assert_eq!(r.address.as_deref(), Some("z@x.com"));
        let anon = MailAddress {
            name: String::new(),
            address: "a@b.c".into(),
        };
        let r2 = header_address(&anon);
        assert!(r2.name.is_none());
        assert_eq!(r2.address.as_deref(), Some("a@b.c"));
    }

    #[test]
    fn bodystructure_attachment_detection() {
        // 简单文本 → 无附件
        let simple = parse_tokens(b"(TEXT PLAIN (CHARSET utf-8) NIL NIL 7BIT 100 2)");
        let root = parse_bodystructure(&simple[0], "").unwrap();
        assert!(!has_attachment(&root, false));
        // 带 disposition attachment 的 pdf
        let with_pdf = parse_tokens(b"(APPLICATION PDF (NAME \"x.pdf\") NIL NIL BASE64 900 NIL (ATTACHMENT (FILENAME \"x.pdf\")) NIL)");
        let root2 = parse_bodystructure(&with_pdf[0], "").unwrap();
        assert!(has_attachment(&root2, false));
        // multipart/alternative 纯文本 → 无附件
        let multi = parse_tokens(b"((TEXT HTML (CHARSET utf-8) NIL NIL QUOTED-PRINTABLE 300 5 NIL NIL NIL NIL)(TEXT PLAIN (CHARSET utf-8) NIL NIL 7BIT 100 2 NIL NIL NIL NIL) ALTERNATIVE (BOUNDARY \"b\") NIL NIL NIL)");
        let root3 = parse_bodystructure(&multi[0], "").unwrap();
        assert!(root3.mime.starts_with("multipart/"));
        assert_eq!(root3.children.len(), 2);
        assert_eq!(root3.children[0].part_no, "1");
        assert_eq!(root3.children[1].part_no, "2");
        assert!(!has_attachment(&root3, false));
    }

    #[test]
    fn internal_date_parsing() {
        let iso = normalize_internal_date("01-Apr-2024 10:00:00 +0800");
        assert!(iso.is_some());
        assert!(iso.unwrap().starts_with("2024-04-01T10:00:00"));
        assert!(normalize_internal_date("garbage").is_none());
    }

    #[test]
    fn mime_full_source_html_preferred() {
        let raw = b"Content-Type: multipart/alternative; boundary=\"BOUND\"\r\n\r\n--BOUND\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nhello=\r\nworld\r\n--BOUND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>HTML \xe4\xb8\xbb\xe9\xa2\x98</p>\r\n--BOUND--\r\n";
        let (content, ct) = parse_mime_to_content(raw);
        assert_eq!(ct, "html");
        assert!(content.contains("HTML"));
    }

    #[test]
    fn mime_base64_plain_fallback() {
        let b64 = crate::crypto::b64_encode("纯文本".as_bytes());
        let raw = format!(
            "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{b64}\r\n"
        );
        let (content, ct) = parse_mime_to_content(raw.as_bytes());
        assert_eq!(ct, "text");
        assert_eq!(content, "纯文本");
    }

    #[test]
    fn qp_decode() {
        assert_eq!(String::from_utf8(decode_qp_bytes("a=\r\nb")).unwrap(), "ab");
        assert_eq!(
            String::from_utf8(decode_qp_bytes("caf=C3=a9")).unwrap(),
            "café"
        );
    }

    #[test]
    fn strip_html_preview() {
        assert_eq!(strip_html("<p>hello <b>world</b></p>"), "hello world");
    }

    #[test]
    fn boundary_split() {
        let body = b"--B\r\nA\r\n--B\r\nC\r\n--B--\r\n";
        let parts = split_boundary(body, "B");
        assert_eq!(parts.len(), 2);
        assert!(parts[0].starts_with(b"A"));
        assert!(parts[1].starts_with(b"C"));
    }

    #[test]
    fn imap_utf7_decode() {
        // &W1hoYw- → 中文文件夹名（Modified UTF-7）
        // 归档 = U+5F52 U+6863 → UTF-16BE 5F 52 68 63 → base64 X1JoYw== → &X1JoYw-
        assert_eq!(decode_imap_utf7("INBOX"), "INBOX");
        assert_eq!(decode_imap_utf7("&X1JoYw-"), "归档");
        assert_eq!(decode_imap_utf7("Sent&X1JoYw-"), "Sent归档");
        assert_eq!(decode_imap_utf7("&-"), "&");
    }

    #[test]
    fn list_line_path_parse() {
        assert_eq!(
            parse_list_line_path("* LIST (\\HasNoChildren) \"/\" INBOX\r\n"),
            Some("INBOX".into())
        );
        assert_eq!(
            parse_list_line_path("* LIST () \".\" \"Sent Items\"\r\n"),
            Some("Sent Items".into())
        );
        assert_eq!(
            parse_list_line_path("* LIST (\\Noselect) NIL \"\"\r\n"),
            None
        );
    }

    #[test]
    fn search_uids_parse() {
        assert_eq!(
            parse_search_uids(b"* SEARCH 2 5 9\r\na02 OK done\r\n"),
            vec![2, 5, 9]
        );
    }

    #[test]
    fn uidnext_parse() {
        assert_eq!(
            find_uid_next(b"* OK [UIDNEXT 123] UIDs valid\r\n"),
            Some(123)
        );
    }
}

//! Telegram Bot 支撑层：配置存储 + Bot HTTP API（长轮询）。
//!
//! 定位：桌面版进程内的**只读**查询出口。不新增服务、不占端口、不需要公网 IP，
//! 手机端通过 TG 主动查询某个账号的邮件，绕开「手机上一个个登录官方 App」的麻烦。
//! 边界（已与用户确认）：桌面版没运行时 Bot 无响应，此时明确回「桌面版未运行」。
//!
//! 配置放独立文件 `telegram.json` 而不是 settings.json：设置页保存时会整体重写
//! `settings` 节点，手写进去的字段会被静默丢弃。

use crate::crypto;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

/// 长轮询单次等待上限（秒）。Bot API 允许 0–50。
pub const POLL_TIMEOUT_SECS: u64 = 30;
/// HTTP 超时必须比轮询等待长，否则每轮都被自己的超时掐断。
const HTTP_TIMEOUT_SECS: u64 = POLL_TIMEOUT_SECS + 15;
/// 429 限流最多重试几次（重试次数不包含首次尝试）。
const RATE_LIMIT_RETRIES: usize = 3;
/// `retry_after` 的上限（秒）：Telegram 异常/恶意响应不该把我们卡死。
const RETRY_AFTER_CAP_SECS: u64 = 60;

/// 运行时配置（token 已解密为明文，只在内存里）。
#[derive(Debug, Clone)]
pub struct TelegramConfig {
    pub bot_token: String,
    pub chat_id: String,
}

impl TelegramConfig {
    /// 日志/报错里用的脱敏形态：`123456789:AAH...` -> `123456789:…`
    pub fn redacted_token(&self) -> String {
        let head: String = self.bot_token.chars().take_while(|c| *c != ':').collect();
        if head.is_empty() {
            "…".to_string()
        } else {
            format!("{head}:…")
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct TelegramFile {
    /// 可写 `dpapi:`/`sec:v1:` 前缀的密文，也可直接写明文（首次加载后自动加密回写）。
    bot_token: String,
    /// 只允许这一个 chat 使用 Bot；留空视为未配置。
    chat_id: String,
}

/// `%APPDATA%/maildeck/telegram.json`
pub fn config_path() -> PathBuf {
    crate::db::user_data_path().join("telegram.json")
}

/// `%APPDATA%/maildeck/telegram_offset`：已确认的 `update_id + 1`。
///
/// 不落盘的话，进程中途退出后重启会把 Telegram 保留期内（约 24h）未确认的
/// update 再执行一遍——表现为重复刷新、重复打开账号。
pub fn offset_path() -> PathBuf {
    crate::db::user_data_path().join("telegram_offset")
}

/// 读取上次确认的 offset；缺失/损坏都当作 0（从头收，不阻塞）。
pub fn load_offset() -> i64 {
    std::fs::read_to_string(offset_path())
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(0)
}

/// 记录 offset。写失败只告警：收消息比记录进度重要。
pub fn save_offset(offset: i64) {
    if let Err(err) = std::fs::write(offset_path(), offset.to_string()) {
        crate::logging::warn(format!("[telegram] 写 offset 失败：{err}"));
    }
}

/// 读取配置。文件不存在、字段为空、或内容非法都返回 `Ok(None)`（= Bot 不启动）。
pub fn load_config() -> Result<Option<TelegramConfig>, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    let file: TelegramFile =
        serde_json::from_str(&raw).map_err(|e| format!("解析 {} 失败：{e}", path.display()))?;
    if file.bot_token.trim().is_empty() || file.chat_id.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(TelegramConfig {
        bot_token: decode_secret(file.bot_token.trim())?,
        chat_id: file.chat_id.trim().to_string(),
    }))
}

/// 写配置（token 加密后落盘）。手填明文后调用一次即可转成密文。
pub fn save_config(config: &TelegramConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建 {} 失败：{e}", parent.display()))?;
    }
    let file = TelegramFile {
        bot_token: crypto::secret_encrypt_str(config.bot_token.trim())
            .map_err(|e| format!("加密 bot token 失败：{e}"))?,
        chat_id: config.chat_id.trim().to_string(),
    };
    let body = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化配置失败：{e}"))?;
    std::fs::write(&path, format!("{body}\n"))
        .map_err(|e| format!("写入 {} 失败：{e}", path.display()))
}

/// 能解密就解密；否则当作手填明文（首次 save 时会加密回写）。
fn decode_secret(stored: &str) -> Result<String, String> {
    match crypto::secret_decrypt_str(stored) {
        Ok(plain) => Ok(plain),
        Err(_) => Ok(stored.to_string()),
    }
}

/// Bot API 客户端。所有请求都走设置的 `proxyUrl`（国内直连 api.telegram.org 不通）。
///
/// `Clone` 是为了能把客户端移进后台线程（刷新/取正文不能堵住轮询循环）。
#[derive(Clone)]
pub struct BotApi {
    client: reqwest::blocking::Client,
    base: String,
}

/// `call_once` 的失败分类：429 要退避重试，其余直接报错。
enum CallError {
    /// 429：Telegram 要求至少等这么多秒再试。
    RateLimited(u64),
    Other(String),
}

impl BotApi {
    pub fn new(token: &str, proxy_url: &str) -> Result<Self, String> {
        let mut builder = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
            .user_agent("MailDeck-TelegramBot");
        if !proxy_url.trim().is_empty() {
            let proxy = reqwest::Proxy::all(proxy_url).map_err(|e| format!("代理配置无效：{e}"))?;
            builder = builder.proxy(proxy);
        }
        let client = builder
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;
        Ok(Self {
            client,
            base: format!("https://api.telegram.org/bot{token}"),
        })
    }

    /// 统一调用入口。**错误信息必须剔除 URL**——URL 里含 bot token。
    ///
    /// 429 限流会按 `retry_after` 退避重试（最多 [`RATE_LIMIT_RETRIES`] 次）：
    /// 连点按钮、短时间发多条消息时 Telegram 会限流，不重试就是静默丢消息。
    fn call(&self, method: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
        let mut attempt = 0;
        loop {
            match self.call_once(method, &body) {
                Ok(value) => return Ok(value),
                Err(CallError::Other(msg)) => return Err(msg),
                Err(CallError::RateLimited(wait)) => {
                    if attempt >= RATE_LIMIT_RETRIES {
                        return Err(format!(
                            "Telegram 限流：{method} 重试 {RATE_LIMIT_RETRIES} 次仍被拒"
                        ));
                    }
                    let wait = wait.clamp(1, RETRY_AFTER_CAP_SECS);
                    crate::logging::warn(format!(
                        "[telegram] {method} 触发限流，{wait}s 后重试（第 {} 次）",
                        attempt + 1
                    ));
                    std::thread::sleep(Duration::from_secs(wait));
                    attempt += 1;
                }
            }
        }
    }

    fn call_once(
        &self,
        method: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, CallError> {
        let url = format!("{}/{method}", self.base);
        let resp =
            self.client.post(&url).json(body).send().map_err(|e| {
                CallError::Other(format!("连接 Telegram 失败：{}", e.without_url()))
            })?;
        let status = resp.status().as_u16();
        let text = resp.text().map_err(|e| {
            CallError::Other(format!("读取 Telegram 响应失败：{}", e.without_url()))
        })?;
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| CallError::Other(format!("Telegram 返回非 JSON（HTTP {status}）")))?;
        if value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let code = value.get("error_code").and_then(|v| v.as_i64());
            let desc = value
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("未知错误");
            // 429 时 Telegram 在 parameters.retry_after 里给出等待秒数，缺失按 1s。
            if code == Some(429) {
                let wait = value
                    .pointer("/parameters/retry_after")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1);
                return Err(CallError::RateLimited(wait));
            }
            return Err(CallError::Other(format!("Telegram 返回错误：{desc}")));
        }
        Ok(value
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    /// 长轮询取更新。`offset` = 已确认的最大 update_id + 1。
    pub fn get_updates(&self, offset: i64) -> Result<Vec<serde_json::Value>, String> {
        let body = serde_json::json!({
            "offset": offset,
            "timeout": POLL_TIMEOUT_SECS,
            "allowed_updates": ["message", "callback_query"],
        });
        let result = self.call("getUpdates", body)?;
        Ok(result.as_array().cloned().unwrap_or_default())
    }

    /// 发消息，返回 message_id。
    pub fn send_message(
        &self,
        chat_id: &str,
        text: &str,
        keyboard: Option<serde_json::Value>,
    ) -> Result<i64, String> {
        let mut body = serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "disable_web_page_preview": true,
        });
        if let Some(markup) = keyboard {
            body["reply_markup"] = markup;
        }
        let result = self.call("sendMessage", body)?;
        Ok(result
            .get("message_id")
            .and_then(|v| v.as_i64())
            .unwrap_or(0))
    }

    /// 原地编辑（用于「正在获取…」→ 正文）。编辑失败不致命，调用方降级为重新发送。
    pub fn edit_message_text(
        &self,
        chat_id: &str,
        message_id: i64,
        text: &str,
        keyboard: Option<serde_json::Value>,
    ) -> Result<(), String> {
        let mut body = serde_json::json!({
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "disable_web_page_preview": true,
        });
        if let Some(markup) = keyboard {
            body["reply_markup"] = markup;
        }
        self.call("editMessageText", body).map(|_| ())
    }

    /// 回应按钮点击（不回应的话按钮会一直转圈）。
    pub fn answer_callback_query(&self, id: &str, text: Option<&str>) -> Result<(), String> {
        let mut body = serde_json::json!({ "callback_query_id": id });
        if let Some(t) = text {
            body["text"] = serde_json::json!(t);
        }
        self.call("answerCallbackQuery", body).map(|_| ())
    }

    /// 注册命令菜单：聊天框旁的菜单按钮，以及输入 `/` 时的自动补全。
    /// `commands` 是 `(命令名, 说明)`，命令名不带前导 `/`（Telegram 要求 1~32 个
    /// 小写字母/数字/下划线，说明 3~256 字）。重复调用是覆盖，幂等。
    pub fn set_my_commands(&self, commands: &[(&str, &str)]) -> Result<(), String> {
        let list: Vec<serde_json::Value> = commands
            .iter()
            .map(|(command, description)| {
                serde_json::json!({ "command": command, "description": description })
            })
            .collect();
        self.call("setMyCommands", serde_json::json!({ "commands": list }))
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_token() {
        let cfg = TelegramConfig {
            bot_token: "123456789:AAHsecretvalue".into(),
            chat_id: "1".into(),
        };
        assert_eq!(cfg.redacted_token(), "123456789:…");
    }

    #[test]
    fn plaintext_token_is_accepted() {
        // 手填明文时不能被当成损坏的密文拒绝。
        assert_eq!(decode_secret("123:plain").unwrap(), "123:plain");
    }

    /// 写文件，所以默认 ignore；需显式指定临时数据目录后手动跑：
    /// `MAILDECK_USER_DATA_DIR=... cargo test -p maildeck-core offset_roundtrip -- --ignored`
    #[test]
    #[ignore = "会写数据目录，需 MAILDECK_USER_DATA_DIR 指向临时目录"]
    fn offset_roundtrip() {
        let dir = crate::db::user_data_path();
        assert!(
            dir.to_string_lossy().to_lowercase().contains("mdtest"),
            "拒绝在真实数据目录跑：{}",
            dir.display()
        );
        let _ = std::fs::remove_file(offset_path());
        assert_eq!(load_offset(), 0, "文件不存在时应为 0");
        save_offset(4242);
        assert_eq!(load_offset(), 4242);
        // 损坏内容不能卡住轮询。
        std::fs::write(offset_path(), "not-a-number").unwrap();
        assert_eq!(load_offset(), 0);
        let _ = std::fs::remove_file(offset_path());
    }

    #[test]
    fn roundtrips_through_encryption() {
        let encrypted = crypto::secret_encrypt_str("123:plain").unwrap();
        assert_ne!(encrypted, "123:plain");
        assert_eq!(decode_secret(&encrypted).unwrap(), "123:plain");
    }

    /// 需要本机代理（127.0.0.1:10808）可用；验证「代理链路通」且「报错不泄露 token」。
    /// 手动跑：cargo test -p maildeck-core -- --ignored reaches_telegram
    #[test]
    #[ignore = "需要网络与代理"]
    fn reaches_telegram_through_proxy() {
        let api = BotApi::new("123456789:FAKE_TOKEN_VALUE", "http://127.0.0.1:10808").unwrap();
        let err = api.get_updates(0).expect_err("假 token 必须被拒绝");
        assert!(
            err.contains("Unauthorized"),
            "应拿到 Telegram 的 Unauthorized，实际：{err}"
        );
        assert!(
            !err.contains("FAKE_TOKEN_VALUE"),
            "错误信息泄露了 token：{err}"
        );
    }
}

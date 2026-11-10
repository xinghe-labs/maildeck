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
pub struct BotApi {
    client: reqwest::blocking::Client,
    base: String,
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
    fn call(&self, method: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
        let url = format!("{}/{method}", self.base);
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .map_err(|e| format!("连接 Telegram 失败：{}", e.without_url()))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .map_err(|e| format!("读取 Telegram 响应失败：{}", e.without_url()))?;
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| format!("Telegram 返回非 JSON（HTTP {status}）"))?;
        if value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let desc = value
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("未知错误");
            return Err(format!("Telegram 返回错误：{desc}"));
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

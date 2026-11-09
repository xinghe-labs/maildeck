//! 设置层：忠实移植原版 `electron/main/settings-model.ts` + `settings-store.ts`。
//!
//! 结构（与原版一一对应）：
//! - [`StoredAppSettings`]：settings.json v2 里 `settings` 节点的存储模型
//! - [`StoredProxy`]：`proxy` 节点（protocol/hostname/port/username/encryptedPassword）
//! - [`SettingsFileV2`]：`{ version: 2, settings, proxy }` 信封
//! - [`AppSettings`]：IPC 投影（public，proxyUrl 脱敏）
//! - [`RuntimeAppSettings`]：运行时投影（proxyUrl 带真实凭据，供 HTTP 客户端使用）
//!
//! 语义要点（原版注释的忠实保留）：
//! - `batchConcurrency` 1..=12，`autoRefreshIntervalMinutes` 1..=120（越界回落默认）
//! - `refreshScope` 只认 "recent"，其它一律 "all"（旧文件缺字段保持全量刷新）
//! - `hotmailFallbackEnabled` 兼容旧字段 `hotmailHelperFallbackEnabled`
//! - 关闭自动检查只影响启动行为，设置页手动检查始终可用
//! - `closeToTray`/`launchAtStartup` 默认关（不给用户意外的后台驻留）
//! - 代理更新：URL 与用户名/密码分离存储；直连不能带凭据；凭据必须走独立字段；
//!   端点或用户名变化时清除已存密码

use crate::db::user_data_path;
use crate::errors::AppError;
use crate::proxy_security::{
    format_proxy_url, format_public_proxy_url, parse_proxy_url, ParsedProxyUrl,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SETTINGS_FILE_MAX_BYTES: u64 = 1024 * 1024;

/// Electron safeStorage 写入的前缀（旧版迁移兼容）。
const SAFE_PREFIX: &str = "safe:";

// ---------------------------------------------------------------------------
// 存储模型
// ---------------------------------------------------------------------------

/// 刷新范围：all=全部可用账号；recent=最近 7 天收到过邮件的账号。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum SettingsRefreshScope {
    #[serde(rename = "all")]
    #[default]
    All,
    #[serde(rename = "recent")]
    Recent,
}

/// settings.json v2 的 `settings` 节点。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredAppSettings {
    pub cache_messages: bool,
    pub cache_bodies: bool,
    pub batch_concurrency: i64,
    pub hotmail_fallback_enabled: bool,
    pub auto_refresh_enabled: bool,
    pub auto_refresh_interval_minutes: i64,
    pub refresh_scope: SettingsRefreshScope,
    pub auto_update_check_enabled: bool,
    pub close_to_tray: bool,
    pub launch_at_startup: bool,
}

impl Default for StoredAppSettings {
    fn default() -> Self {
        StoredAppSettings {
            cache_messages: true,
            cache_bodies: true,
            batch_concurrency: 4,
            hotmail_fallback_enabled: true,
            auto_refresh_enabled: false,
            auto_refresh_interval_minutes: 10,
            refresh_scope: SettingsRefreshScope::All,
            auto_update_check_enabled: true,
            close_to_tray: false,
            launch_at_startup: false,
        }
    }
}

/// settings.json v2 的 `proxy` 节点（密码加密存储）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProxy {
    /// "http:" | "https:" | "socks:" | "socks4:" | "socks5:"
    pub protocol: String,
    pub hostname: String,
    pub port: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub encrypted_password: String,
}

/// `{ version: 2, settings, proxy }` 文件信封。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingsFileV2 {
    pub version: i64,
    #[serde(default)]
    pub settings: StoredAppSettings,
    #[serde(default)]
    pub proxy: Option<StoredProxy>,
}

// ---------------------------------------------------------------------------
// IPC 投影模型（与原版 shared/ipc-contracts.ts 完全一致）
// ---------------------------------------------------------------------------

/// `settings:get` 返回（public 投影，proxyUrl 脱敏）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub cache_messages: bool,
    pub cache_bodies: bool,
    pub proxy_url: String,
    pub proxy_username: String,
    pub proxy_has_password: bool,
    pub proxy_supported: bool,
    pub batch_concurrency: i64,
    pub hotmail_fallback_enabled: bool,
    pub auto_refresh_enabled: bool,
    pub auto_refresh_interval_minutes: i64,
    pub refresh_scope: SettingsRefreshScope,
    pub auto_update_check_enabled: bool,
    pub close_to_tray: bool,
    pub launch_at_startup: bool,
}

/// 运行时投影（getSettings / RuntimeAppSettings：proxyUrl 带真实凭据）。
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeAppSettings {
    pub cache_messages: bool,
    pub cache_bodies: bool,
    pub proxy_url: String,
    pub batch_concurrency: i64,
    pub hotmail_fallback_enabled: bool,
    pub auto_refresh_enabled: bool,
    pub auto_refresh_interval_minutes: i64,
    pub refresh_scope: SettingsRefreshScope,
    pub auto_update_check_enabled: bool,
    pub close_to_tray: bool,
    pub launch_at_startup: bool,
}

/// `settings:update` 载荷（AppSettingsUpdate，全部可选；strictObject：未知字段报错）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SettingsUpdate {
    pub cache_messages: Option<bool>,
    pub cache_bodies: Option<bool>,
    pub proxy_url: Option<String>,
    pub proxy_username: Option<String>,
    pub proxy_password: Option<String>,
    pub clear_proxy_password: Option<bool>,
    pub batch_concurrency: Option<i64>,
    pub hotmail_fallback_enabled: Option<bool>,
    pub auto_refresh_enabled: Option<bool>,
    pub auto_refresh_interval_minutes: Option<i64>,
    pub refresh_scope: Option<SettingsRefreshScope>,
    pub auto_update_check_enabled: Option<bool>,
    pub close_to_tray: Option<bool>,
    pub launch_at_startup: Option<bool>,
}

/// `settings:update` 返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsResult {
    pub settings: AppSettings,
    pub proxy_changed: bool,
}

// ---------------------------------------------------------------------------
// 归一化（normalizeStoredSettings / boundedInteger）
// ---------------------------------------------------------------------------

fn bounded_integer(value: Option<i64>, fallback: i64, minimum: i64, maximum: i64) -> i64 {
    match value {
        Some(v) => v.clamp(minimum, maximum),
        None => fallback,
    }
}

fn as_record(value: &serde_json::Value) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value.as_object()
}

/// normalizeStoredSettings：JSON → 存储模型（缺省回落默认，非法值夹取）。
fn normalize_stored_settings(value: &serde_json::Value) -> StoredAppSettings {
    let input = as_record(value).cloned().unwrap_or_default();
    let get_i64 = |key: &str| input.get(key).and_then(|v| v.as_i64());
    let get_bool = |key: &str| input.get(key).and_then(|v| v.as_bool());
    StoredAppSettings {
        // input.cacheMessages !== false：缺省/null 都视为开启
        cache_messages: get_bool("cacheMessages") != Some(false),
        cache_bodies: get_bool("cacheBodies") != Some(false),
        batch_concurrency: bounded_integer(get_i64("batchConcurrency"), 4, 1, 12),
        // 兼容旧字段 hotmailHelperFallbackEnabled
        hotmail_fallback_enabled: get_bool("hotmailFallbackEnabled")
            .or_else(|| Some(get_bool("hotmailHelperFallbackEnabled") != Some(false)))
            .unwrap_or(true),
        auto_refresh_enabled: get_bool("autoRefreshEnabled") == Some(true),
        auto_refresh_interval_minutes: bounded_integer(
            get_i64("autoRefreshIntervalMinutes"),
            10,
            1,
            120,
        ),
        // 只认 "recent"；旧文件没这个字段时保持全量刷新的历史行为
        refresh_scope: if input.get("refreshScope").and_then(|v| v.as_str()) == Some("recent") {
            SettingsRefreshScope::Recent
        } else {
            SettingsRefreshScope::All
        },
        // 关闭自动检查只影响启动时的自动行为，设置页里的手动检查始终可用
        auto_update_check_enabled: get_bool("autoUpdateCheckEnabled") != Some(false),
        // 两个开关都默认关：关窗行为和现在完全一样（直接退出），不给用户意外的后台驻留
        close_to_tray: get_bool("closeToTray") == Some(true),
        launch_at_startup: get_bool("launchAtStartup") == Some(true),
    }
}

fn proxy_descriptor(proxy: Option<&StoredProxy>) -> Option<ParsedProxyUrl> {
    proxy.map(|p| ParsedProxyUrl {
        protocol: p.protocol.clone(),
        hostname: p.hostname.clone(),
        port: p.port.clone(),
        username: p.username.clone(),
        password: String::new(),
        supported: p.protocol == "http:" || p.protocol == "https:",
    })
}

/// normalizeV2Proxy：存储 proxy 节点校验与归一化。
fn normalize_v2_proxy(value: Option<&serde_json::Value>) -> Result<Option<StoredProxy>, String> {
    let Some(v) = value else {
        return Ok(None);
    };
    if v.is_null() {
        return Ok(None);
    }
    let Some(input) = v.as_object() else {
        return Err("Settings proxy entry is invalid".into());
    };
    for key in input.keys() {
        if !matches!(
            key.as_str(),
            "protocol" | "hostname" | "port" | "username" | "encryptedPassword"
        ) {
            return Err("Settings proxy entry contains unsupported fields".into());
        }
    }
    let protocol = input
        .get("protocol")
        .and_then(|v| v.as_str())
        .ok_or("Settings proxy protocol is invalid")?;
    if !matches!(
        protocol,
        "http:" | "https:" | "socks:" | "socks4:" | "socks5:"
    ) {
        return Err("Settings proxy protocol is invalid".into());
    }
    let hostname = input
        .get("hostname")
        .and_then(|v| v.as_str())
        .ok_or("Settings proxy hostname is invalid")?;
    if hostname.trim().is_empty() || hostname.len() > 255 {
        return Err("Settings proxy hostname is invalid".into());
    }
    let port = input
        .get("port")
        .and_then(|v| v.as_str())
        .ok_or("Settings proxy port is invalid")?;
    if !port.chars().all(|c| c.is_ascii_digit()) || port.len() > 5 {
        return Err("Settings proxy port is invalid".into());
    }
    let username = input
        .get("username")
        .and_then(|v| v.as_str())
        .ok_or("Settings proxy username is invalid")?;
    if username.len() > 256 {
        return Err("Settings proxy username is invalid".into());
    }
    let encrypted_password = input
        .get("encryptedPassword")
        .and_then(|v| v.as_str())
        .ok_or("Settings proxy password entry is invalid")?;
    if encrypted_password.len() > 16_384 {
        return Err("Settings proxy password entry is invalid".into());
    }
    // 与原版一致：parseProxyUrl(protocol//host:port, true) 复检
    let endpoint = format!(
        "{protocol}//{}{port_part}",
        hostname.trim(),
        port_part = if port.is_empty() {
            String::new()
        } else {
            format!(":{port}")
        }
    );
    let parsed = parse_proxy_url(&endpoint, true)?
        .ok_or_else(|| "Settings proxy entry is invalid".to_string())?;
    Ok(Some(StoredProxy {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        username: username.to_string(),
        encrypted_password: encrypted_password.to_string(),
    }))
}

fn normalize_v2_file(value: &serde_json::Value) -> Result<SettingsFileV2, String> {
    let Some(input) = as_record(value) else {
        return Err("Settings file version 2 is invalid".into());
    };
    if input.get("version").and_then(|v| v.as_i64()) != Some(2) {
        return Err("Settings file version 2 is invalid".into());
    }
    Ok(SettingsFileV2 {
        version: 2,
        settings: normalize_stored_settings(
            input.get("settings").unwrap_or(&serde_json::Value::Null),
        ),
        proxy: normalize_v2_proxy(input.get("proxy"))?,
    })
}

/// v1/legacy 迁移：settings.proxyUrl 字符串代理 → v2 结构化节点。
fn migrate_legacy_file(
    value: &serde_json::Value,
    crypto: &dyn SettingsCrypto,
) -> Result<SettingsFileV2, String> {
    let Some(legacy) = as_record(value).and_then(|r| r.get("settings")) else {
        return Err("legacy settings missing".into());
    };
    let proxy = match legacy.get("proxyUrl").and_then(|v| v.as_str()) {
        Some(raw) => match parse_proxy_url(raw, true) {
            Ok(Some(parsed)) => {
                let encrypted_password = if parsed.password.is_empty() {
                    String::new()
                } else {
                    crypto.encrypt(&parsed.password)?
                };
                Some(StoredProxy {
                    protocol: parsed.protocol,
                    hostname: parsed.hostname,
                    port: parsed.port,
                    username: parsed.username,
                    encrypted_password,
                })
            }
            _ => None,
        },
        None => None,
    };
    Ok(SettingsFileV2 {
        version: 2,
        settings: normalize_stored_settings(legacy),
        proxy,
    })
}

// ---------------------------------------------------------------------------
// 加密接口（SettingsCrypto）
// ---------------------------------------------------------------------------

/// 密码加密/解密（原版 token-crypto.ts encryptSecret/decryptSecret 的 Rust 等价）。
pub trait SettingsCrypto {
    fn encrypt(&self, value: &str) -> Result<String, String>;
    fn decrypt(&self, value: &str) -> Result<String, String>;
}

/// 默认实现：平台安全层（Windows=DPAPI dpapi:v1:，macOS/Linux=钥匙串主密钥 sec:v1:）
/// + 旧版 Electron safeStorage（safe:）兼容读取。
pub struct DefaultSettingsCrypto;

impl SettingsCrypto for DefaultSettingsCrypto {
    fn encrypt(&self, value: &str) -> Result<String, String> {
        crate::crypto::secret_encrypt_str(value)
    }

    fn decrypt(&self, value: &str) -> Result<String, String> {
        if let Some(rest) = value.strip_prefix(crate::crypto::PREFIX_DPAPI) {
            let raw = crate::crypto::b64_decode(rest)?;
            let plain = crate::crypto::secret_decrypt_bytes(&raw)?;
            return String::from_utf8(plain).map_err(|e| format!("utf8: {e}"));
        }
        if let Some(rest) = value.strip_prefix(crate::crypto::PREFIX_SEC) {
            let raw = crate::crypto::b64_decode(rest)?;
            let plain = crate::crypto::secret_decrypt_bytes(&raw)?;
            return String::from_utf8(plain).map_err(|e| format!("utf8: {e}"));
        }
        if let Some(rest) = value.strip_prefix(SAFE_PREFIX) {
            // 旧版 Electron safeStorage（Windows = DPAPI 无熵）也能解；非 Windows 无此格式
            let raw = crate::crypto::b64_decode(rest)?;
            let plain = crate::crypto::secret_decrypt_bytes(&raw)?;
            return String::from_utf8(plain).map_err(|e| format!("utf8: {e}"));
        }
        Ok(value.to_string())
    }
}

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

/// projectPublicSettings：前端可见（proxyUrl 脱敏、不带密码）。
pub fn project_public_settings(file: &SettingsFileV2) -> Result<AppSettings, AppError> {
    let normalized = normalize_v2_file(
        &serde_json::to_value(file).map_err(|e| AppError::Serialization(e.to_string()))?,
    )
    .map_err(AppError::Unknown)?;
    let proxy = proxy_descriptor(normalized.proxy.as_ref());
    Ok(AppSettings {
        cache_messages: normalized.settings.cache_messages,
        cache_bodies: normalized.settings.cache_bodies,
        proxy_url: proxy
            .as_ref()
            .map(|p| format_public_proxy_url(p).unwrap_or_default())
            .unwrap_or_default(),
        proxy_username: normalized
            .proxy
            .as_ref()
            .map(|p| p.username.clone())
            .unwrap_or_default(),
        proxy_has_password: normalized
            .proxy
            .as_ref()
            .map(|p| !p.encrypted_password.is_empty())
            .unwrap_or(false),
        proxy_supported: proxy.as_ref().map(|p| p.supported).unwrap_or(true),
        batch_concurrency: normalized.settings.batch_concurrency,
        hotmail_fallback_enabled: normalized.settings.hotmail_fallback_enabled,
        auto_refresh_enabled: normalized.settings.auto_refresh_enabled,
        auto_refresh_interval_minutes: normalized.settings.auto_refresh_interval_minutes,
        refresh_scope: normalized.settings.refresh_scope,
        auto_update_check_enabled: normalized.settings.auto_update_check_enabled,
        close_to_tray: normalized.settings.close_to_tray,
        launch_at_startup: normalized.settings.launch_at_startup,
    })
}

/// projectRuntimeSettings：运行时（proxyUrl 带凭据；socks 等不受支持协议报错）。
pub fn project_runtime_settings(
    file: &SettingsFileV2,
    crypto: &dyn SettingsCrypto,
) -> Result<RuntimeAppSettings, AppError> {
    let normalized = normalize_v2_file(
        &serde_json::to_value(file).map_err(|e| AppError::Serialization(e.to_string()))?,
    )
    .map_err(AppError::Unknown)?;
    let proxy = proxy_descriptor(normalized.proxy.as_ref());
    let proxy_url = match &proxy {
        None => String::new(),
        Some(p) if !p.supported => {
            return Err(AppError::Unknown(
                "代理协议不受支持；仅支持 HTTP/HTTPS，请在设置中修正或清空代理。".into(),
            ));
        }
        Some(_) => {
            let password = normalized
                .proxy
                .as_ref()
                .filter(|p| !p.encrypted_password.is_empty())
                .map(|p| crypto.decrypt(&p.encrypted_password))
                .transpose()
                .map_err(AppError::Unknown)?
                .unwrap_or_default();
            format_proxy_url(proxy.as_ref().unwrap(), &password).unwrap_or_default()
        }
    };
    Ok(RuntimeAppSettings {
        cache_messages: normalized.settings.cache_messages,
        cache_bodies: normalized.settings.cache_bodies,
        proxy_url,
        batch_concurrency: normalized.settings.batch_concurrency,
        hotmail_fallback_enabled: normalized.settings.hotmail_fallback_enabled,
        auto_refresh_enabled: normalized.settings.auto_refresh_enabled,
        auto_refresh_interval_minutes: normalized.settings.auto_refresh_interval_minutes,
        refresh_scope: normalized.settings.refresh_scope,
        auto_update_check_enabled: normalized.settings.auto_update_check_enabled,
        close_to_tray: normalized.settings.close_to_tray,
        launch_at_startup: normalized.settings.launch_at_startup,
    })
}

// ---------------------------------------------------------------------------
// 更新应用（applySettingsUpdate）
// ---------------------------------------------------------------------------

fn same_endpoint(left: Option<&StoredProxy>, right: Option<&StoredProxy>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(l), Some(r)) => {
            l.protocol == r.protocol && l.hostname == r.hostname && l.port == r.port
        }
        _ => false,
    }
}

/// applySettingsUpdate：应用部分更新并返回新文件 + 代理是否变化。
pub fn apply_settings_update(
    file: &SettingsFileV2,
    update: &SettingsUpdate,
    crypto: &dyn SettingsCrypto,
) -> Result<(SettingsFileV2, bool), AppError> {
    let current = normalize_v2_file(
        &serde_json::to_value(file).map_err(|e| AppError::Serialization(e.to_string()))?,
    )
    .map_err(AppError::Unknown)?;

    // settings 合并后再整体归一化（与原版 normalizeStoredSettings({...current,...update}) 一致）
    let merged = serde_json::to_value(&current.settings)
        .map_err(|e| AppError::Serialization(e.to_string()))?;
    let mut merged = match merged {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    let patch = serde_json::to_value(update).map_err(|e| AppError::Serialization(e.to_string()))?;
    if let serde_json::Value::Object(patch_map) = patch {
        for (k, v) in patch_map {
            if !v.is_null() {
                merged.insert(k, v);
            }
        }
    }
    let settings = normalize_stored_settings(&serde_json::Value::Object(merged));

    // 仅当值为字符串（含空串=直连）时才视为"修改代理"，避免渲染层 spread 表单时
    // 意外清空已配置的代理和密码
    let has_proxy_url = update.proxy_url.is_some();
    let has_proxy_username = update.proxy_username.is_some();
    let has_proxy_password = update
        .proxy_password
        .as_ref()
        .map(|p| !p.is_empty())
        .unwrap_or(false);

    let mut next_proxy = current.proxy.clone();
    if has_proxy_url {
        let raw = update.proxy_url.as_deref().unwrap_or("");
        match parse_proxy_url(raw, false) {
            Ok(None) => {
                let wants_creds = update
                    .proxy_username
                    .as_ref()
                    .map(|u| !u.trim().is_empty())
                    .unwrap_or(false)
                    || update
                        .proxy_password
                        .as_ref()
                        .map(|p| !p.is_empty())
                        .unwrap_or(false);
                if wants_creds {
                    return Err(AppError::Unknown(
                        "Direct mode cannot store proxy credentials".into(),
                    ));
                }
                next_proxy = None;
            }
            Ok(Some(parsed)) => {
                if !parsed.username.is_empty() || !parsed.password.is_empty() {
                    return Err(AppError::Unknown(
                        "Proxy credentials must use the separate username and password fields"
                            .into(),
                    ));
                }
                next_proxy = Some(StoredProxy {
                    protocol: parsed.protocol,
                    hostname: parsed.hostname,
                    port: parsed.port,
                    username: if has_proxy_username {
                        update
                            .proxy_username
                            .as_deref()
                            .unwrap_or("")
                            .trim()
                            .to_string()
                    } else {
                        current
                            .proxy
                            .as_ref()
                            .map(|p| p.username.clone())
                            .unwrap_or_default()
                    },
                    encrypted_password: current
                        .proxy
                        .as_ref()
                        .map(|p| p.encrypted_password.clone())
                        .unwrap_or_default(),
                });
            }
            Err(e) => return Err(AppError::Unknown(e)),
        }
    } else if has_proxy_username {
        let trimmed = update
            .proxy_username
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        match &mut next_proxy {
            None => {
                if !trimmed.is_empty() {
                    return Err(AppError::Unknown(
                        "Proxy username requires a proxy endpoint".into(),
                    ));
                }
            }
            Some(p) => p.username = trimmed,
        }
    }

    let next_proxy = match next_proxy {
        None => {
            if has_proxy_password && !update.proxy_password.as_deref().unwrap_or("").is_empty() {
                return Err(AppError::Unknown(
                    "Proxy password requires a proxy endpoint".into(),
                ));
            }
            let next_file = SettingsFileV2 {
                version: 2,
                settings,
                proxy: None,
            };
            let proxy_changed = current.proxy.is_some();
            return Ok((next_file, proxy_changed));
        }
        Some(p) => p,
    };

    let endpoint_changed = !same_endpoint(current.proxy.as_ref(), Some(&next_proxy));
    let username_changed = current
        .proxy
        .as_ref()
        .map(|p| p.username.as_str())
        .unwrap_or("")
        != next_proxy.username;
    let mut password_changed = false;
    let mut next_proxy = next_proxy;
    if update.clear_proxy_password == Some(true) {
        password_changed = current
            .proxy
            .as_ref()
            .map(|p| !p.encrypted_password.is_empty())
            .unwrap_or(false);
        next_proxy.encrypted_password = String::new();
    } else if has_proxy_password {
        let proxy_password = update.proxy_password.as_deref().unwrap_or("");
        let current_password = current
            .proxy
            .as_ref()
            .filter(|p| !p.encrypted_password.is_empty())
            .map(|p| crypto.decrypt(&p.encrypted_password));
        let current_password = match current_password {
            Some(Ok(p)) => p,
            Some(Err(_)) => String::new(),
            None => String::new(),
        };
        password_changed = current_password != proxy_password;
        next_proxy.encrypted_password =
            crypto.encrypt(proxy_password).map_err(AppError::Unknown)?;
    } else if endpoint_changed || username_changed {
        next_proxy.encrypted_password = String::new();
    }

    let proxy_changed = endpoint_changed || username_changed || password_changed;
    Ok((
        SettingsFileV2 {
            version: 2,
            settings,
            proxy: Some(next_proxy),
        },
        proxy_changed,
    ))
}

// ---------------------------------------------------------------------------
// 磁盘存取（settings-store.ts）
// ---------------------------------------------------------------------------

fn settings_file_path(custom_dir: Option<&Path>) -> PathBuf {
    let dir = custom_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(user_data_path);
    dir.join("settings.json")
}

fn create_default_settings_file() -> SettingsFileV2 {
    SettingsFileV2 {
        version: 2,
        settings: StoredAppSettings::default(),
        proxy: None,
    }
}

/// recoverBrokenSettings：损坏文件改名 .broken-<ts>.bak 后回落默认。
fn recover_broken_settings(path: &Path) -> SettingsFileV2 {
    let backup = path.with_extension(format!(
        "json.broken-{}.bak",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let _ = std::fs::rename(path, &backup);
    create_default_settings_file()
}

/// readSettingsFile：读文件 + 版本检查 + 迁移（ENOENT → 默认；损坏 → 恢复；version>2 → 报错）。
pub fn read_settings_file(
    custom_dir: Option<&Path>,
    crypto: &dyn SettingsCrypto,
) -> Result<(SettingsFileV2, bool), AppError> {
    let path = settings_file_path(custom_dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => {
            if raw.len() as u64 > SETTINGS_FILE_MAX_BYTES {
                return Ok((recover_broken_settings(&path), true));
            }
            raw
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((create_default_settings_file(), false));
        }
        Err(e) => return Err(AppError::Io(e.to_string())),
    };

    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok((recover_broken_settings(&path), true)),
    };
    let Some(input) = as_record(&parsed) else {
        return Ok((recover_broken_settings(&path), true));
    };
    let has_version = input.contains_key("version");
    let version = input.get("version").and_then(|v| v.as_i64());
    if has_version {
        match version {
            Some(v) if v > 2 => {
                return Err(AppError::Unknown(format!(
                    "Settings file version {v} is newer than the supported version 2"
                )));
            }
            Some(1) | Some(2) => {}
            _ => return Ok((recover_broken_settings(&path), true)),
        }
    }
    if version != Some(2)
        && !input
            .get("settings")
            .map(as_record)
            .unwrap_or(None)
            .is_some()
    {
        return Ok((recover_broken_settings(&path), true));
    }

    match if version == Some(2) {
        normalize_v2_file(&parsed).map(|f| (f, false))
    } else {
        migrate_legacy_file(&parsed, crypto).map(|f| (f, true))
    } {
        Ok(result) => Ok(result),
        Err(_) if version == Some(2) => Ok((recover_broken_settings(&path), true)),
        Err(e) => Err(AppError::Unknown(e)),
    }
}

/// writeSettingsFile：tmp + rename 原子写（JSON.stringify(file, null, 2) + "\n"）。
pub fn write_settings_file(
    file: &SettingsFileV2,
    custom_dir: Option<&Path>,
) -> Result<(), AppError> {
    let path = settings_file_path(custom_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::Io(e.to_string()))?;
    }
    let mut raw =
        serde_json::to_string_pretty(file).map_err(|e| AppError::Serialization(e.to_string()))?;
    raw.push('\n');
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| AppError::Io(e.to_string()))?;
    std::fs::rename(&tmp, &path).map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

/// getPublicSettings（IPC settings:get）。
pub fn get_public_settings(
    custom_dir: Option<&Path>,
    crypto: &dyn SettingsCrypto,
) -> Result<AppSettings, AppError> {
    let (file, migrated) = read_settings_file(custom_dir, crypto)?;
    if migrated {
        write_settings_file(&file, custom_dir)?;
    }
    project_public_settings(&file)
}

/// getSettings（运行时投影，供 HTTP/IMAP 客户端取 proxyUrl）。
pub fn get_runtime_settings(
    custom_dir: Option<&Path>,
    crypto: &dyn SettingsCrypto,
) -> Result<RuntimeAppSettings, AppError> {
    let (file, migrated) = read_settings_file(custom_dir, crypto)?;
    if migrated {
        write_settings_file(&file, custom_dir)?;
    }
    project_runtime_settings(&file, crypto)
}

/// updateSettings（IPC settings:update）：应用更新 + 落盘，返回新投影与代理变化标记。
pub fn update_settings(
    update: &SettingsUpdate,
    custom_dir: Option<&Path>,
    crypto: &dyn SettingsCrypto,
) -> Result<UpdateSettingsResult, AppError> {
    let (file, _migrated) = read_settings_file(custom_dir, crypto)?;
    let (updated, proxy_changed) = apply_settings_update(&file, update, crypto)?;
    write_settings_file(&updated, custom_dir)?;
    Ok(UpdateSettingsResult {
        settings: project_public_settings(&updated)?,
        proxy_changed,
    })
}

/// IPC schema 里的 normalizeProxyUrl：空→""；带凭据→报错；否则转公开格式。
pub fn normalize_update_proxy_url(value: &str) -> Result<String, AppError> {
    match parse_proxy_url(value, false) {
        Ok(None) => Ok(String::new()),
        Ok(Some(parsed)) => {
            if !parsed.username.is_empty() || !parsed.password.is_empty() {
                return Err(AppError::InvalidRequest(
                    "credentials must use the separate proxy username and password fields".into(),
                ));
            }
            format_public_proxy_url(&parsed).map_err(AppError::InvalidRequest)
        }
        Err(_) => Err(AppError::InvalidRequest(
            "proxy URL must use HTTP or HTTPS without path, query, or fragment".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crypto() -> DefaultSettingsCrypto {
        DefaultSettingsCrypto
    }

    #[test]
    fn defaults_match_original() {
        let file = create_default_settings_file();
        let s = file.settings;
        assert!(s.cache_messages && s.cache_bodies);
        assert_eq!(s.batch_concurrency, 4);
        assert!(s.hotmail_fallback_enabled);
        assert!(!s.auto_refresh_enabled);
        assert_eq!(s.auto_refresh_interval_minutes, 10);
        assert_eq!(s.refresh_scope, SettingsRefreshScope::All);
        assert!(s.auto_update_check_enabled);
        assert!(!s.close_to_tray && !s.launch_at_startup);
    }

    #[test]
    fn legacy_v1_migrates_proxy() {
        let legacy = serde_json::json!({
            "version": 1,
            "settings": {
                "cacheMessages": false,
                "batchConcurrency": 8,
                "proxyUrl": "http://127.0.0.1:10808"
            }
        });
        let (file, migrated) = read_settings_file_into(&legacy, &crypto()).unwrap();
        assert!(migrated);
        assert!(!file.settings.cache_messages);
        assert_eq!(file.settings.batch_concurrency, 8);
        let proxy = file.proxy.unwrap();
        assert_eq!(proxy.protocol, "http:");
        assert_eq!(proxy.hostname, "127.0.0.1");
        assert_eq!(proxy.port, "10808");
    }

    fn read_settings_file_into(
        value: &serde_json::Value,
        crypto: &dyn SettingsCrypto,
    ) -> Result<(SettingsFileV2, bool), AppError> {
        let input = value;
        let version = input.get("version").and_then(|v| v.as_i64());
        Ok(if version == Some(2) {
            (normalize_v2_file(input).map_err(AppError::Unknown)?, false)
        } else {
            (
                migrate_legacy_file(input, crypto).map_err(AppError::Unknown)?,
                true,
            )
        })
    }

    #[test]
    fn normalize_clamps_and_defaults() {
        let raw = serde_json::json!({
            "batchConcurrency": 99,
            "autoRefreshIntervalMinutes": 0,
            "refreshScope": "recent",
            "hotmailHelperFallbackEnabled": false,
            "cacheMessages": null
        });
        let s = normalize_stored_settings(&raw);
        assert_eq!(s.batch_concurrency, 12); // clamp 上限
        assert_eq!(s.auto_refresh_interval_minutes, 1); // clamp 下限
        assert_eq!(s.refresh_scope, SettingsRefreshScope::Recent);
        assert!(!s.hotmail_fallback_enabled); // 旧字段兜底生效
        assert!(s.cache_messages); // null → 默认 true
    }

    #[test]
    fn project_public_masks_password() {
        let pw = crypto().encrypt("secret123").unwrap();
        let file = SettingsFileV2 {
            version: 2,
            settings: StoredAppSettings::default(),
            proxy: Some(StoredProxy {
                protocol: "http:".into(),
                hostname: "proxy.local".into(),
                port: "8080".into(),
                username: "alice".into(),
                encrypted_password: pw,
            }),
        };
        let public = project_public_settings(&file).unwrap();
        assert_eq!(public.proxy_url, "http://proxy.local:8080");
        assert_eq!(public.proxy_username, "alice");
        assert!(public.proxy_has_password);
        assert!(public.proxy_supported);
        let runtime = project_runtime_settings(&file, &crypto()).unwrap();
        assert_eq!(runtime.proxy_url, "http://alice:secret123@proxy.local:8080");
    }

    #[test]
    fn update_proxy_roundtrip_and_clear() {
        let file = create_default_settings_file();
        let update = SettingsUpdate {
            proxy_url: Some("http://127.0.0.1:7890".into()),
            ..Default::default()
        };
        let (updated, changed) = apply_settings_update(&file, &update, &crypto()).unwrap();
        assert!(changed);
        let proxy = updated.proxy.as_ref().unwrap();
        assert_eq!(proxy.hostname, "127.0.0.1");
        assert_eq!(proxy.port, "7890");
        // 清空：proxyUrl = ""
        let update2 = SettingsUpdate {
            proxy_url: Some(String::new()),
            ..Default::default()
        };
        let (updated2, changed2) = apply_settings_update(&updated, &update2, &crypto()).unwrap();
        assert!(changed2);
        assert!(updated2.proxy.is_none());
    }

    #[test]
    fn update_rejects_inline_credentials() {
        let file = create_default_settings_file();
        let update = SettingsUpdate {
            proxy_url: Some("http://alice:pw@proxy.local:8080".into()),
            ..Default::default()
        };
        let err = apply_settings_update(&file, &update, &crypto()).unwrap_err();
        assert!(err.to_string().contains("separate username and password"));
    }

    #[test]
    fn update_password_preserved_on_unrelated_change() {
        let crypto = crypto();
        let file = create_default_settings_file();
        let (f, _) = apply_settings_update(
            &file,
            &SettingsUpdate {
                proxy_url: Some("http://proxy.local:8080".into()),
                proxy_password: Some("pw1".into()),
                ..Default::default()
            },
            &crypto,
        )
        .unwrap();
        // 只改 batchConcurrency：密码保留
        let (f2, changed) = apply_settings_update(
            &f,
            &SettingsUpdate {
                batch_concurrency: Some(8),
                ..Default::default()
            },
            &crypto,
        )
        .unwrap();
        assert!(!changed);
        assert_eq!(
            f2.proxy.as_ref().unwrap().encrypted_password,
            f.proxy.as_ref().unwrap().encrypted_password
        );
        // 改端点：密码清除
        let (f3, changed3) = apply_settings_update(
            &f2,
            &SettingsUpdate {
                proxy_url: Some("http://other.local:9090".into()),
                ..Default::default()
            },
            &crypto,
        )
        .unwrap();
        assert!(changed3);
        assert_eq!(f3.proxy.as_ref().unwrap().encrypted_password, "");
    }

    #[test]
    fn update_settings_persists_and_projects() {
        let dir = std::env::temp_dir().join(format!("maildeck-settings-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let result = update_settings(
            &SettingsUpdate {
                batch_concurrency: Some(6),
                close_to_tray: Some(true),
                ..Default::default()
            },
            Some(&dir),
            &crypto(),
        )
        .unwrap();
        assert!(result.settings.batch_concurrency == 6);
        assert!(result.settings.close_to_tray);
        let public = get_public_settings(Some(&dir), &crypto()).unwrap();
        assert_eq!(public.batch_concurrency, 6);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_update_proxy_url_shapes() {
        assert_eq!(normalize_update_proxy_url("").unwrap(), "");
        assert_eq!(
            normalize_update_proxy_url("http://proxy.local:8080").unwrap(),
            "http://proxy.local:8080"
        );
        assert!(normalize_update_proxy_url("http://a:b@x.local").is_err());
    }
}

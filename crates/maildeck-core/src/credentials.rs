//! token 持久化（对应原 token-store.ts + credential-store.ts + secure-credential-store.ts）。
//! 四代兼容：v0 = Electron safeStorage（Windows = Chromium os_crypt，可经 DPAPI 解密），
//! v1 = DPAPI（自有格式），v2 = AES-256-GCM（当前默认写入口）。
//! 存储后端：keyring（Windows Credential Manager）优先，失败回退到 userData 下加密文件。

use crate::crypto::{b64_encode, derive_aes_key, PREFIX_AES, PREFIX_DPAPI, PREFIX_SEC};

/// v0 前缀（原 token-crypto.ts ENCRYPTED_PREFIX）。
pub const PREFIX_SAFE: &str = "safe:";
use crate::db::user_data_path;
use crate::errors::AppError;
use std::path::PathBuf;
use std::sync::Mutex;

pub const KEYRING_SERVICE: &str = "maildeck-refresh-tokens";
pub const LEGACY_KEYRING_SERVICE: &str = "outlook-manager-refresh-tokens";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialGeneration {
    /// v0：Electron safeStorage（Windows = Chromium os_crypt，可解密）。
    LegacySafeStorage,
    /// v1：DPAPI + keyring/文件。
    Dpapi,
    /// v2：AES-256-GCM（cfg 文件存储）。
    Aes256Gcm,
}

impl CredentialGeneration {
    pub fn as_i64(self) -> i64 {
        match self {
            CredentialGeneration::LegacySafeStorage => 0,
            CredentialGeneration::Dpapi => 1,
            CredentialGeneration::Aes256Gcm => 2,
        }
    }

    pub fn from_i64(v: i64) -> Option<Self> {
        match v {
            0 => Some(CredentialGeneration::LegacySafeStorage),
            1 => Some(CredentialGeneration::Dpapi),
            2 => Some(CredentialGeneration::Aes256Gcm),
            _ => None,
        }
    }
}

/// 存储后端抽象，便于测试替身。
pub trait TokenSink: Send + Sync {
    fn get(&self, account_id: &str) -> Option<String>;
    fn set(&self, account_id: &str, value: &str);
    fn delete(&self, account_id: &str);
}

/// Windows Credential Manager 后端（keyring crate）。
pub struct KeyringSink {
    service: String,
}

impl KeyringSink {
    pub fn new() -> Self {
        Self {
            service: KEYRING_SERVICE.to_string(),
        }
    }

    fn entry(&self, account_id: &str) -> Result<keyring::Entry, keyring::Error> {
        keyring::Entry::new(&self.service, account_id)
    }
}

impl Default for KeyringSink {
    fn default() -> Self {
        Self::new()
    }
}

impl TokenSink for KeyringSink {
    fn get(&self, account_id: &str) -> Option<String> {
        self.entry(account_id).ok()?.get_password().ok()
    }

    fn set(&self, account_id: &str, value: &str) {
        let entry = match self.entry(account_id) {
            Ok(e) => e,
            Err(_) => return,
        };
        if entry.set_password(value).is_err() {
            // 已存在时先删再设
            let _ = entry.delete_credential();
            let _ = entry.set_password(value);
        }
    }

    fn delete(&self, account_id: &str) {
        if let Ok(e) = self.entry(account_id) {
            let _ = e.delete_credential();
        }
    }
}

/// 加密文件回退后端：userData/credentials.json，AES-GCM 加密每条记录。
pub struct FileSink {
    path: PathBuf,
    cache: Mutex<std::collections::HashMap<String, String>>,
}

impl FileSink {
    pub fn new(path: PathBuf) -> Self {
        let cache = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| {
                serde_json::from_str::<std::collections::HashMap<String, String>>(&s).ok()
            })
            .unwrap_or_default();
        Self {
            path,
            cache: Mutex::new(cache),
        }
    }

    fn persist(&self, map: &std::collections::HashMap<String, String>) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl TokenSink for FileSink {
    fn get(&self, account_id: &str) -> Option<String> {
        self.cache.lock().ok()?.get(account_id).cloned()
    }

    fn set(&self, account_id: &str, value: &str) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(account_id.to_string(), value.to_string());
            let _ = self.persist(&cache);
        }
    }

    fn delete(&self, account_id: &str) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.remove(account_id);
            let _ = self.persist(&cache);
        }
    }
}

/// 内存 access-token 缓存（对应原 access_token_cache 表 v5 后改为内存态，进程生命周期内有效）。
struct AccessTokenEntry {
    token: String,
    expires_at: std::time::Instant,
    /// 原版 accessTokenManager 的 authMode（"graph" / "imap"）。
    auth_mode: &'static str,
}

/// 组合后端：keyring 优先，写失败时回退文件。读顺序 keyring → 文件。
pub struct TieredTokenStore {
    keyring: KeyringSink,
    file: Mutex<Option<std::sync::Arc<FileSink>>>,
    access_cache: Mutex<std::collections::HashMap<String, AccessTokenEntry>>,
}

impl TieredTokenStore {
    pub fn new() -> Self {
        Self {
            keyring: KeyringSink::new(),
            file: Mutex::new(None),
            access_cache: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// 取未过期的 access token（提前 60s 视为过期）。
    pub fn get_access_token(&self, account_id: &str) -> Option<String> {
        self.get_access_with_mode(account_id).map(|(t, _)| t)
    }

    /// 取 access token + authMode（原版 token.authMode 路由用）。
    pub fn get_access_with_mode(&self, account_id: &str) -> Option<(String, &'static str)> {
        let mut cache = self.access_cache.lock().ok()?;
        let now = std::time::Instant::now();
        match cache.get(account_id) {
            Some(entry) if entry.expires_at > now + std::time::Duration::from_secs(60) => {
                Some((entry.token.clone(), entry.auth_mode))
            }
            Some(_) => {
                cache.remove(account_id);
                None
            }
            None => None,
        }
    }

    pub fn set_access_token(
        &self,
        account_id: &str,
        token: &str,
        expires_in: i64,
        auth_mode: &'static str,
    ) {
        if let Ok(mut cache) = self.access_cache.lock() {
            cache.insert(
                account_id.to_string(),
                AccessTokenEntry {
                    token: token.to_string(),
                    expires_at: std::time::Instant::now()
                        + std::time::Duration::from_secs(expires_in.max(0) as u64),
                    auth_mode,
                },
            );
        }
    }

    pub fn clear_access_token(&self, account_id: &str) {
        if let Ok(mut cache) = self.access_cache.lock() {
            cache.remove(account_id);
        }
    }

    fn file_sink(&self) -> Option<std::sync::Arc<FileSink>> {
        let mut guard = self.file.lock().ok()?;
        if guard.is_none() {
            let path = user_data_path().join("credentials.json");
            *guard = Some(std::sync::Arc::new(FileSink::new(path)));
        }
        guard.as_ref().cloned()
    }
}

impl Default for TieredTokenStore {
    fn default() -> Self {
        Self::new()
    }
}

impl TokenSink for TieredTokenStore {
    fn get(&self, account_id: &str) -> Option<String> {
        if let Some(v) = self.keyring.get(account_id) {
            return Some(v);
        }
        self.file_sink().and_then(|f| f.get(account_id))
    }

    fn set(&self, account_id: &str, value: &str) {
        self.keyring.set(account_id, value);
        if self.keyring.get(account_id).is_none() {
            if let Some(f) = self.file_sink() {
                f.set(account_id, value);
            }
        } else if let Some(f) = self.file_sink() {
            f.delete(account_id); // keyring 恢复可用后清理文件残留
        }
    }

    fn delete(&self, account_id: &str) {
        self.keyring.delete(account_id);
        if let Some(f) = self.file_sink() {
            f.delete(account_id);
        }
    }
}

/// 加密 refresh token 为存储串（protectRefreshToken）。generation 指定密码学代。
pub fn protect_refresh_token(
    plaintext: &str,
    generation: CredentialGeneration,
) -> Result<String, String> {
    match generation {
        CredentialGeneration::Aes256Gcm => {
            let key = derive_aes_key(b"maildeck-credential", "maildeck");
            let ct = crate::crypto::aes_gcm_encrypt(&key, plaintext.as_bytes())?;
            Ok(format!("{PREFIX_AES}{}", b64_encode(&ct)))
        }
        CredentialGeneration::Dpapi => crate::crypto::secret_encrypt_str(plaintext),
        CredentialGeneration::LegacySafeStorage => {
            Err("cannot write legacy safeStorage from Rust".into())
        }
    }
}

/// 解密 refresh token。`safe:`（v0，Electron safeStorage）经 Chromium os_crypt + DPAPI 还原。
pub fn reveal_refresh_token(stored: &str) -> Result<String, AppError> {
    if let Some(rest) = stored.strip_prefix(PREFIX_SAFE) {
        return crate::crypto::decrypt_electron_v10(&crate::db::user_data_path(), rest)
            .map_err(AppError::CredentialUnreadable);
    }
    if stored.starts_with(PREFIX_DPAPI) || stored.starts_with(PREFIX_AES) {
        return crate::crypto::try_unprotect_text(stored).map_err(AppError::CredentialUnreadable);
    }
    // 未知格式
    Err(AppError::CredentialUnreadable(
        "token stored in unrecognized format; re-add this account".into(),
    ))
}

/// 判断存储串属于哪一代。dpapi:v1: 与 sec:v1: 同属“平台安全代”（跨平台等价实现）。
pub fn detect_generation(stored: &str) -> Option<CredentialGeneration> {
    if stored.starts_with(PREFIX_DPAPI) || stored.starts_with(PREFIX_SEC) {
        Some(CredentialGeneration::Dpapi)
    } else if stored.starts_with(PREFIX_AES) {
        Some(CredentialGeneration::Aes256Gcm)
    } else {
        Some(CredentialGeneration::LegacySafeStorage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_sink_roundtrip_and_tiers() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("credentials.json");
        {
            let sink = FileSink::new(path.clone());
            sink.set("a1", "v1");
            sink.set("a2", "v2");
        }
        let sink2 = FileSink::new(path);
        assert_eq!(sink2.get("a1").as_deref(), Some("v1"));
        sink2.delete("a1");
        assert_eq!(sink2.get("a1"), None);
    }

    #[test]
    fn protect_reveal_dpapi_roundtrip() {
        let stored = protect_refresh_token("secret-refresh", CredentialGeneration::Dpapi).unwrap();
        assert!(stored.starts_with(crate::crypto::secret_prefix()));
        assert_eq!(reveal_refresh_token(&stored).unwrap(), "secret-refresh");
        assert_eq!(
            detect_generation(&stored),
            Some(CredentialGeneration::Dpapi)
        );
    }

    #[test]
    fn protect_reveal_aes_roundtrip() {
        let stored =
            protect_refresh_token("secret-refresh", CredentialGeneration::Aes256Gcm).unwrap();
        assert!(stored.starts_with(PREFIX_AES));
        assert_eq!(reveal_refresh_token(&stored).unwrap(), "secret-refresh");
    }

    #[test]
    fn legacy_prefix_maps_to_stale() {
        let err = reveal_refresh_token("some-legacy-plainblob").unwrap_err();
        assert!(matches!(err, AppError::CredentialUnreadable(_)));
    }

    #[test]
    fn b64_roundtrip() {
        let enc = crate::crypto::b64_encode(&[1u8, 2, 3, 250]);
        assert_eq!(
            crate::crypto::b64_decode(&enc).unwrap(),
            vec![1u8, 2, 3, 250]
        );
    }
}

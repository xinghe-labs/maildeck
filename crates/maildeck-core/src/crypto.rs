//! 凭据加密层（对应原 credential-crypto.ts）。
//! Windows：DPAPI（CryptProtectData），密文格式（base64(NONCE||DPAPI blob)）与原版 node 实现互通。
//! macOS/Linux：系统钥匙串主密钥（keyring）+ AES-256-GCM，前缀 sec:v1:；
//! 无 keyring daemon（headless Linux）时回退 userData/master.key 文件。
//! 旧版兼容：safe:（Electron safeStorage，仅 Windows）、aes256gcm:v1:（固定密钥，全平台）。

#[cfg(windows)]
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

use aes_gcm::aead::{Aead, KeyInit};
use base64::Engine;
use rand::RngCore;

#[cfg(windows)]
pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let blob_in = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut blob_out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &blob_in,
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut blob_out,
        )
    };
    if ok == 0 {
        return Err("CryptProtectData failed".into());
    }
    let out =
        unsafe { std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec() };
    unsafe {
        windows_sys::Win32::Foundation::LocalFree(blob_out.pbData as *mut core::ffi::c_void);
    }
    Ok(out)
}

#[cfg(windows)]
pub fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    if ciphertext.is_empty() {
        return Err("empty ciphertext".into());
    }
    let blob_in = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let mut blob_out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &blob_in,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut blob_out,
        )
    };
    if ok == 0 {
        return Err("CryptUnprotectData failed".into());
    }
    let out =
        unsafe { std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec() };
    unsafe {
        windows_sys::Win32::Foundation::LocalFree(blob_out.pbData as *mut core::ffi::c_void);
    }
    Ok(out)
}

/// AES-256-GCM 随机 12 字节 nonce + 密文 + 16 字节 tag（Node crypto GCM 布局：iv||ciphertext+tag）。
pub fn aes_gcm_encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).map_err(|_| "invalid key")?;
    let nonce = aes_gcm::Nonce::from_slice(&nonce);
    let tag = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| "aes-gcm encrypt failed")?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&tag);
    Ok(out)
}

/// 输入布局：iv(12) || ciphertext+tag。
pub fn aes_gcm_decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 12 + 16 {
        return Err("ciphertext too short".into());
    }
    let (nonce, rest) = data.split_at(12);
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).map_err(|_| "invalid key")?;
    cipher
        .decrypt(aes_gcm::Nonce::from_slice(nonce), rest)
        .map_err(|_| "aes-gcm decrypt failed".into())
}

pub fn b64_encode(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| format!("base64 decode: {e}"))
}

/// deriveAesKey（原版）：sha256(salt || secret)。
pub fn derive_aes_key(salt: &[u8], secret: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(salt);
    h.update(secret.as_bytes());
    h.finalize().into()
}

pub const PREFIX_DPAPI: &str = "dpapi:v1:";
pub const PREFIX_AES: &str = "aes256gcm:v1:";
pub const PREFIX_SEC: &str = "sec:v1:";

// ---------------------------------------------------------------
// 平台安全层（secret_encrypt/secret_decrypt）
// Windows = DPAPI（与旧库互通）；其他平台 = 钥匙串主密钥 + AES-256-GCM。
// 输出格式：前缀 + base64(密文字节)。
// ---------------------------------------------------------------

/// 平台安全加密（返回带前缀完整串）。
pub fn secret_encrypt_str(plaintext: &str) -> Result<String, String> {
    let ct = secret_encrypt(plaintext.as_bytes())?;
    Ok(format!("{}{}", secret_prefix(), b64_encode(&ct)))
}

/// 平台安全解密（接受本平台前缀）。
pub fn secret_decrypt_str(stored: &str) -> Result<String, String> {
    let rest = stored
        .strip_prefix(secret_prefix())
        .ok_or("unknown cipher prefix")?;
    let raw = b64_decode(rest)?;
    let plain = secret_decrypt(&raw)?;
    String::from_utf8(plain).map_err(|e| format!("utf8: {e}"))
}

/// 当前平台安全层前缀。
pub fn secret_prefix() -> &'static str {
    #[cfg(windows)]
    {
        PREFIX_DPAPI
    }
    #[cfg(not(windows))]
    {
        PREFIX_SEC
    }
}

#[cfg(windows)]
fn secret_encrypt(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    protect(plaintext)
}

#[cfg(windows)]
fn secret_decrypt(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    unprotect(ciphertext)
}

/// 平台安全层原始字节解密（供 settings 等外部调用）。
pub fn secret_decrypt_bytes(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    secret_decrypt(ciphertext)
}

/// 非 Windows：AES-256-GCM + 钥匙串主密钥（无 keyring 时回退 userData/master.key）。
#[cfg(not(windows))]
fn secret_encrypt(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let key = master_key()?;
    aes_gcm_encrypt(&key, plaintext)
}

#[cfg(not(windows))]
fn secret_decrypt(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let key = master_key()?;
    aes_gcm_decrypt(&key, ciphertext)
}

/// 32 字节主密钥：keyring（服务 maildeck，用户 master-key）优先；
/// 无 keyring daemon（headless Linux）时回退 userData/master.key（随机生成后持久化）。
/// MAILDECK_NO_KEYRING=1 强制跳过 keyring（CI 无 GUI 环境，钥匙串授权弹窗会挂死测试）。
#[cfg(not(windows))]
fn master_key() -> Result<[u8; 32], String> {
    if std::env::var("MAILDECK_NO_KEYRING").is_ok() {
        return master_key_file();
    }
    if let Ok(entry) = keyring::Entry::new("maildeck", "master-key") {
        match entry.get_password() {
            Ok(hex) => {
                if let Some(key) = hex_to_key(&hex) {
                    return Ok(key);
                }
            }
            Err(keyring::Error::NoEntry) => {
                let key = random_key();
                if entry.set_password(&key_to_hex(&key)).is_ok() {
                    return Ok(key);
                }
            }
            Err(_) => {} // daemon 不可用 → 文件回退
        }
    }
    master_key_file()
}

#[cfg(not(windows))]
fn master_key_file() -> Result<[u8; 32], String> {
    let path = crate::db::user_data_path().join("master.key");
    if let Ok(hex) = std::fs::read_to_string(&path) {
        if let Some(key) = hex_to_key(hex.trim()) {
            return Ok(key);
        }
    }
    let key = random_key();
    std::fs::create_dir_all(path.parent().ok_or_else(|| "no parent dir".to_string())?)
        .map_err(|e| format!("create dir: {e}"))?;
    std::fs::write(&path, key_to_hex(&key)).map_err(|e| format!("write master.key: {e}"))?;
    Ok(key)
}

#[cfg(not(windows))]
fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    key
}

#[cfg(not(windows))]
fn key_to_hex(key: &[u8; 32]) -> String {
    key.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(not(windows))]
fn hex_to_key(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut key = [0u8; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(key)
}

/// Electron safeStorage（Windows = Chromium os_crypt）legacy 解密，仅 Windows。
pub fn decrypt_electron_v10(
    user_data_dir: &std::path::Path,
    stored_b64: &str,
) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _ = (user_data_dir, stored_b64);
        return Err("safe: is a Windows-only legacy format".into());
    }
    #[cfg(windows)]
    {
        let raw = b64_decode(stored_b64)?;
        if raw.len() < 3 + 12 + 16 || &raw[..3] != b"v10" {
            return Err("not a Chromium os_crypt v10 blob".into());
        }
        let key = load_chromium_oscrypt_key(user_data_dir)?;
        let plain = aes_gcm_decrypt(&key, &raw[3..])?;
        String::from_utf8(plain).map_err(|e| format!("utf8: {e}"))
    }
}

#[cfg(windows)]
fn load_chromium_oscrypt_key(user_data_dir: &std::path::Path) -> Result<[u8; 32], String> {
    let path = user_data_dir.join("Local State");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read Local State: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse Local State: {e}"))?;
    let enc = json
        .pointer("/os_crypt/encrypted_key")
        .and_then(|v| v.as_str())
        .ok_or("Local State missing os_crypt.encrypted_key")?;
    let mut raw = b64_decode(enc)?;
    if raw.starts_with(b"DPAPI") {
        raw.drain(..5);
    }
    let key = unprotect(&raw)?;
    let key: [u8; 32] = key
        .try_into()
        .map_err(|v: Vec<u8>| format!("os_crypt key length {}", v.len()))?;
    Ok(key)
}

pub fn try_unprotect_text(value: &str) -> Result<String, String> {
    if let Some(rest) = value.strip_prefix(PREFIX_DPAPI) {
        #[cfg(not(windows))]
        {
            let _ = rest;
            return Err("dpapi:v1: is a Windows-only legacy format".into());
        }
        #[cfg(windows)]
        {
            let raw = b64_decode(rest)?;
            let plain = unprotect(&raw)?;
            return String::from_utf8(plain).map_err(|e| format!("utf8: {e}"));
        }
    }
    if let Some(rest) = value.strip_prefix(PREFIX_SEC) {
        let raw = b64_decode(rest)?;
        let plain = secret_decrypt(&raw)?;
        return String::from_utf8(plain).map_err(|e| format!("utf8: {e}"));
    }
    if let Some(rest) = value.strip_prefix(PREFIX_AES) {
        let raw = b64_decode(rest)?;
        let plain = aes_gcm_decrypt(&derive_aes_key(b"maildeck-credential", "maildeck"), &raw)?;
        return String::from_utf8(plain).map_err(|e| format!("utf8: {e}"));
    }
    Err("unknown cipher prefix".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aes_roundtrip() {
        let key = derive_aes_key(b"test", "hello");
        let plain = b"refresh-token-secret";
        let ct = aes_gcm_encrypt(&key, plain).unwrap();
        let pt = aes_gcm_decrypt(&key, &ct).unwrap();
        assert_eq!(pt, plain);
    }

    #[test]
    fn aes_tamper_fails() {
        let key = derive_aes_key(b"test", "hello");
        let mut ct = aes_gcm_encrypt(&key, b"data").unwrap();
        let last = ct.len() - 1;
        ct[last] ^= 0xff;
        assert!(aes_gcm_decrypt(&key, &ct).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn electron_v10_roundtrip() {
        // 用真实 DPAPI 加密密钥 + 原版 blob 布局做端到端回环。
        let dir = std::env::temp_dir().join(format!("maildeck-v10-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key: [u8; 32] = derive_aes_key(b"v10-test", "electron");
        let dpapi_blob = protect(&key).unwrap();
        // 真实格式：encrypted_key = base64("DPAPI" || dpapi_blob)（前缀在解码后的字节里）。
        let mut key_raw = b"DPAPI".to_vec();
        key_raw.extend_from_slice(&dpapi_blob);
        let local_state = serde_json::json!({
            "os_crypt": { "encrypted_key": b64_encode(&key_raw) }
        });
        std::fs::write(dir.join("Local State"), local_state.to_string()).unwrap();

        let mut raw = b"v10".to_vec();
        raw.extend_from_slice(&aes_gcm_encrypt(&key, b"M.C561_BAY.TEST_TOKEN").unwrap());
        let stored = b64_encode(&raw);
        assert_eq!(
            decrypt_electron_v10(&dir, &stored).unwrap(),
            "M.C561_BAY.TEST_TOKEN"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

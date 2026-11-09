//! Windows DPAPI 凭据加密（对应原 credential-crypto.ts）。
//! 原版 node 实现用 node dpapi（Electron 内置）protectData 输出 base64。
//! Rust 侧用 windows-sys CryptProtectData，密文格式（base64(NONCE||DPAPI blob)）互通。

use aes_gcm::aead::{Aead, KeyInit};
use base64::Engine;
use rand::RngCore;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

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

/// Electron safeStorage（Windows = Chromium os_crypt）legacy 解密。
/// blob 布局：base64("v10" || nonce(12) || ciphertext+tag)，
/// AES-256 密钥 = CryptUnprotectData(user_data_dir/Local State 的 os_crypt.encrypted_key，剥 "DPAPI" 前缀)。
/// 实证：原版 v0.3.1 账号库内 `safe:` 密文可用此链路还原为 MS refresh token。
pub fn decrypt_electron_v10(
    user_data_dir: &std::path::Path,
    stored_b64: &str,
) -> Result<String, String> {
    let raw = b64_decode(stored_b64)?;
    if raw.len() < 3 + 12 + 16 || &raw[..3] != b"v10" {
        return Err("not a Chromium os_crypt v10 blob".into());
    }
    let key = load_chromium_oscrypt_key(user_data_dir)?;
    let plain = aes_gcm_decrypt(&key, &raw[3..])?;
    String::from_utf8(plain).map_err(|e| format!("utf8: {e}"))
}

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
        let raw = b64_decode(rest)?;
        let plain = unprotect(&raw)?;
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

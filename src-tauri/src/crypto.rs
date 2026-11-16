use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::rngs::OsRng;
use rand::RngCore;
use std::fs;
use std::path::PathBuf;

/// 密文前缀，用于区分历史明文数据
const CIPHER_PREFIX: &str = "enc:v1:";

const KEY_FILE: &str = "credential.key";
const NONCE_LEN: usize = 12;

/// 本机凭证加解密器
/// 密钥随机生成并保存在应用数据目录，仅当前机器可解密，
/// 避免凭证以明文形式落盘到 SQLite
pub struct CredentialCipher {
    key: [u8; 32],
}

impl CredentialCipher {
    pub fn new() -> Self {
        let key = Self::load_or_create_key();
        Self { key }
    }

    fn key_path() -> PathBuf {
        let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
        let dir = if base.join("tini-terminal").exists() {
            base.join("tini-terminal")
        } else if base.join("ai-terminal").exists() {
            base.join("ai-terminal")
        } else {
            base.join("tini-terminal")
        };
        let _ = fs::create_dir_all(&dir);
        dir.join(KEY_FILE)
    }

    fn load_or_create_key() -> [u8; 32] {
        let path = Self::key_path();

        if let Ok(bytes) = fs::read(&path) {
            if bytes.len() == 32 {
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                return key;
            }
        }

        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);

        if let Err(e) = fs::write(&path, key) {
            eprintln!("[Crypto] 无法写入凭证密钥文件: {}", e);
        } else {
            Self::restrict_permissions(&path);
        }

        key
    }

    #[cfg(unix)]
    fn restrict_permissions(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(path, perms);
        }
    }

    #[cfg(not(unix))]
    fn restrict_permissions(_path: &std::path::Path) {}

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new_from_slice(&self.key).expect("AES-256 密钥长度固定为 32 字节")
    }

    /// 加密凭证；空值原样返回，避免产生无意义密文
    pub fn encrypt(&self, plain: &str) -> String {
        if plain.is_empty() {
            return String::new();
        }
        if plain.starts_with(CIPHER_PREFIX) {
            return plain.to_string();
        }

        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        match self.cipher().encrypt(nonce, plain.as_bytes()) {
            Ok(cipher_bytes) => {
                let mut combined = Vec::with_capacity(NONCE_LEN + cipher_bytes.len());
                combined.extend_from_slice(&nonce_bytes);
                combined.extend_from_slice(&cipher_bytes);
                format!("{}{}", CIPHER_PREFIX, base64_encode(&combined))
            }
            Err(e) => {
                eprintln!("[Crypto] 凭证加密失败: {}", e);
                // 加密失败时不落明文，避免静默泄漏
                String::new()
            }
        }
    }

    /// 解密凭证；历史明文（无前缀）原样返回，保证平滑迁移
    pub fn decrypt(&self, stored: &str) -> String {
        if stored.is_empty() {
            return String::new();
        }
        let Some(payload) = stored.strip_prefix(CIPHER_PREFIX) else {
            return stored.to_string();
        };

        let Some(combined) = base64_decode(payload) else {
            eprintln!("[Crypto] 凭证密文格式非法，已忽略");
            return String::new();
        };
        if combined.len() <= NONCE_LEN {
            return String::new();
        }

        let (nonce_bytes, cipher_bytes) = combined.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);
        match self.cipher().decrypt(nonce, cipher_bytes) {
            Ok(plain) => String::from_utf8(plain).unwrap_or_default(),
            Err(e) => {
                eprintln!("[Crypto] 凭证解密失败（可能密钥文件已变更）: {}", e);
                String::new()
            }
        }
    }

    /// 判断字符串是否已被本方案加密
    pub fn is_encrypted(value: &str) -> bool {
        value.starts_with(CIPHER_PREFIX)
    }
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn base64_decode(data: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let cipher = CredentialCipher { key: [7u8; 32] };
        let plain = "p@ssw0rd-测试";
        let encrypted = cipher.encrypt(plain);
        assert!(CredentialCipher::is_encrypted(&encrypted));
        assert_ne!(encrypted, plain);
        assert_eq!(cipher.decrypt(&encrypted), plain);
    }

    #[test]
    fn test_legacy_plaintext_passthrough() {
        let cipher = CredentialCipher { key: [1u8; 32] };
        assert_eq!(cipher.decrypt("plain-password"), "plain-password");
        assert_eq!(cipher.encrypt(""), "");
        assert_eq!(cipher.decrypt(""), "");
    }

    #[test]
    fn test_encrypt_is_idempotent_and_randomized() {
        let cipher = CredentialCipher { key: [3u8; 32] };
        let plain = "secret-value";

        // 已加密内容再次加密应保持原样，避免二次加密
        let once = cipher.encrypt(plain);
        assert_eq!(cipher.encrypt(&once), once);

        // 同一明文两次加密应产生不同密文（随机 Nonce）
        let twice = cipher.encrypt(plain);
        assert_ne!(once, twice);
        assert_eq!(cipher.decrypt(&once), plain);
        assert_eq!(cipher.decrypt(&twice), plain);
    }

    #[test]
    fn test_wrong_key_cannot_decrypt() {
        let writer = CredentialCipher { key: [9u8; 32] };
        let reader = CredentialCipher { key: [8u8; 32] };
        let encrypted = writer.encrypt("top-secret");
        // 密钥不匹配时返回空值而非错误明文
        assert_eq!(reader.decrypt(&encrypted), "");
    }
}

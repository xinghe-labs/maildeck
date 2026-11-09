//! 凭据代际计数器（对应原 electron/main/credential-generations.ts）。
//!
//! 用于并发任务检测“凭据/代理在我执行期间被修改”：
//! 任务开始前 capture 快照，写库/发请求前 assertCurrent，失败抛 CredentialsChangedError。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 凭据/代际已变更错误（原 CredentialsChangedError）。
#[derive(Debug, Clone, thiserror::Error)]
#[error("账号凭据或代理已更新，请重试")]
pub struct CredentialsChangedError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialSnapshot {
    pub account_id: Arc<str>,
    pub account_generation: u64,
    pub proxy_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialInvalidation {
    Accounts(Vec<Arc<str>>),
    Proxy,
}

#[derive(Debug, Default)]
pub struct CredentialGenerations {
    inner: Mutex<GenerationsInner>,
}

#[derive(Debug, Default)]
struct GenerationsInner {
    account_generations: HashMap<Arc<str>, u64>,
    proxy_generation: u64,
}

impl CredentialGenerations {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn capture(&self, account_id: &str) -> CredentialSnapshot {
        let inner = self.inner.lock().unwrap();
        // 原版 capture 不写入 Map：读取即快照。
        let account_generation = inner
            .account_generations
            .get(account_id)
            .copied()
            .unwrap_or(0);
        CredentialSnapshot {
            account_id: Arc::from(account_id),
            account_generation,
            proxy_generation: inner.proxy_generation,
        }
    }

    pub fn is_current(&self, snapshot: &CredentialSnapshot) -> bool {
        let inner = self.inner.lock().unwrap();
        inner
            .account_generations
            .get(&snapshot.account_id)
            .copied()
            .unwrap_or(0)
            == snapshot.account_generation
            && inner.proxy_generation == snapshot.proxy_generation
    }

    pub fn assert_current(
        &self,
        snapshot: &CredentialSnapshot,
    ) -> Result<(), CredentialsChangedError> {
        if self.is_current(snapshot) {
            Ok(())
        } else {
            Err(CredentialsChangedError)
        }
    }

    pub fn invalidate_accounts<'a, I>(&self, account_ids: I) -> Vec<Arc<str>>
    where
        I: IntoIterator<Item = &'a str>,
    {
        let mut inner = self.inner.lock().unwrap();
        let mut unique: Vec<Arc<str>> = Vec::new();
        for id in account_ids {
            let key: Arc<str> = Arc::from(id);
            if unique.contains(&key) {
                continue;
            }
            let next = inner.account_generations.get(&key).copied().unwrap_or(0) + 1;
            inner.account_generations.insert(key.clone(), next);
            unique.push(key);
        }
        unique
    }

    pub fn invalidate_proxy(&self) {
        self.inner.lock().unwrap().proxy_generation += 1;
    }

    pub fn inner_proxy_generation(&self) -> u64 {
        self.inner.lock().unwrap().proxy_generation
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_roundtrip() {
        let gen = CredentialGenerations::new();
        let snap = gen.capture("a1");
        assert!(gen.assert_current(&snap).is_ok());
        gen.invalidate_accounts(["a1"]);
        assert!(gen.assert_current(&snap).is_err());
        let snap2 = gen.capture("a1");
        assert_eq!(snap2.account_generation, 1);
        gen.invalidate_proxy();
        assert!(gen.assert_current(&snap2).is_err());
    }

    #[test]
    fn dedupe_invalidate() {
        let gen = CredentialGenerations::new();
        gen.invalidate_accounts(["a1", "a1", "a1"]);
        assert_eq!(gen.capture("a1").account_generation, 1);
    }
}

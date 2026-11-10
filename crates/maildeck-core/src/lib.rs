//! maildeck-core：与 UI 无关的业务内核（账号、凭据、刷新、邮件缓存、导入、OAuth）。

pub mod account_store;
pub mod contracts;
pub mod credential_generations;
pub mod credentials;
pub mod crypto;
pub mod db;
pub mod errors;
pub mod import_module;
pub mod mail_cache;
pub mod mailbox;
pub mod mailbox_access;
pub mod oauth;
pub mod proxy_security;
pub mod refresh_state;
pub mod settings;
pub mod telegram;
pub mod transports;
pub mod updater;

pub use account_store::AccountStore;
pub use contracts::*;
pub use credentials::TieredTokenStore;
pub use errors::{normalize_error, AppError};

/// 初始化 userData 目录（含旧目录迁移），返回有效路径与是否发生过迁移。
pub fn init_user_data() -> (std::path::PathBuf, bool, Option<std::path::PathBuf>) {
    let default = db::user_data_path();
    if !default.exists() {
        let legacy_parent = default.parent().unwrap_or(std::path::Path::new("."));
        let legacy = legacy_parent.join(db::LEGACY_USER_DATA_DIR_NAME);
        if legacy.exists() {
            match std::fs::rename(&legacy, &default) {
                Ok(()) => return (default, true, None),
                Err(_) => return (legacy.clone(), false, Some(legacy)),
            }
        }
    }
    (default, false, None)
}

#[cfg(test)]
mod smoke_tests {
    use super::*;

    /// 端到端最小冒烟：导入 → 刷新失败路径（无效 token）→ 状态落库。
    /// 不打真实 API：refresh 会因无效 client 走到网络/无效请求错误，但状态机必须落 error。
    #[test]
    fn import_then_refresh_failure_updates_store() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AccountStore::open_at(&dir.path().join("t.db")).unwrap();
        let tokens = TieredTokenStore::new();
        let text = "a@x.com,01234567-89ab-cdef-0123-456789abcdef,not-a-real-token";
        let inputs = import_module::parse_account_import(text);
        let result = import_module::upsert_accounts(&store, &inputs).unwrap();
        assert_eq!(result.imported, 1);
        assert!(result.errors.is_empty());

        let accounts = store.list().unwrap();
        let options = refresh_state::RefreshOptions {
            timeout: std::time::Duration::from_secs(3),
            ..Default::default()
        };
        let ctx = refresh_state::RefreshContext::new(accounts.len());
        let graph = transports::graph_client::GraphClient::new(
            "https://graph.microsoft.com/v1.0".into(),
            options.timeout,
        );
        let report =
            refresh_state::refresh_accounts(&store, &tokens, &accounts, &options, &ctx, &graph);
        assert_eq!(report.total, 1);
        // 无效 client/token 必然失败且状态落 error（离线环境下是网络错误，同样落 error）
        assert_eq!(report.failed, 1, "outcomes: {:?}", report.outcomes);
        let rec = store.get(&report.outcomes[0].account_id).unwrap().unwrap();
        assert!(matches!(rec.status, contracts::AccountStatus::Invalid));
        assert!(rec.last_error.is_some());
    }
}

//! 手动验证：误标 invalid 的账号在修复后的 refresh 路由下恢复。
//! 运行：cargo test -p maildeck-core --test verify_imap_refresh -- --ignored --nocapture
//! 依赖 D:/AgentWork/tmp/verify_import.txt（email----clientId----refreshToken）。
//!
//! 断言 ≥5 而非 11/11：与原版对照（2026-11-08，CDP 驱动原版逐一 test）证明 11 个中
//! 有 6 个在原版同样失败（refresh_token 被微软拒绝，真失效）；其余 5 个应稳定恢复。
//! 微软对同一 IP 短时高频 IMAP 连接会限流（os error 10060），个别号会抖动，属正常。

use maildeck_core::account_store::AccountStore;
use maildeck_core::credentials::TieredTokenStore;
use maildeck_core::import_module;
use maildeck_core::mailbox_access::{test_connection, MailboxRuntime};
use maildeck_core::refresh_state::{refresh_accounts, RefreshContext, RefreshOptions};
use maildeck_core::transports::graph_client::GraphClient;
use std::time::Duration;

#[test]
#[ignore]
fn verify_mislabeled_accounts_recover() {
    let text =
        std::fs::read_to_string("D:/AgentWork/tmp/verify_import.txt").expect("import file");
    let dir = std::path::PathBuf::from("D:/AgentWork/tmp/maildeck-verify-core");
    let _ = std::fs::create_dir_all(&dir);
    let store = AccountStore::open(Some(dir.clone())).expect("store");
    let inputs = import_module::parse_account_import(&text);
    assert_eq!(inputs.len(), 11, "expect 11 accounts");
    let result = import_module::upsert_accounts(&store, &inputs).expect("upsert");
    println!(
        "imported={} updated={} skipped={}",
        result.imported, result.updated, result.skipped
    );

    let tokens = TieredTokenStore::new();
    let timeout = Duration::from_secs(30);
    let graph = GraphClient::new("https://graph.microsoft.com/v1.0".into(), timeout);
    let options = RefreshOptions {
        timeout,
        concurrency: 4,
        interval_ms: 100,
        proxy_url: String::new(),
        skip_cooldown: true,
    };
    let records = store.list().expect("list");
    assert_eq!(records.len(), 11);

    let ctx = RefreshContext::new(records.len());
    let report = refresh_accounts(&store, &tokens, &records, &options, &ctx, &graph);
    println!(
        "refresh: refreshed={} failed={} skipped={}",
        report.refreshed, report.failed, report.skipped
    );
    for o in &report.outcomes {
        println!(
            "  REFRESH {:30} status={:?} inbox={:?} err={:?}",
            o.email.chars().take(30).collect::<String>(),
            o.status,
            o.inbox_count,
            o.error.as_deref().map(|e| e.chars().take(60).collect::<String>())
        );
    }

    // 逐个 test_connection（含 IMAP 路由）
    let runtime = MailboxRuntime {
        graph,
        options: options.clone(),
        proxy_url: String::new(),
    };
    let mut ok_count = 0;
    for record in &store.list().expect("list") {
        let out = test_connection(&store, &tokens, record, &runtime);
        println!(
            "  TEST {:30} ok={} err={}",
            record.email.chars().take(30).collect::<String>(),
            out.ok,
            out.error
                .as_ref()
                .map(|e| e.to_string().chars().take(60).collect::<String>())
                .unwrap_or_default()
        );
        if out.ok {
            ok_count += 1;
        }
    }
    println!("RESULT: {ok_count}/11 valid（原版对照基线：5/11，其余 6 个 refresh_token 真失效）");
    assert!(ok_count >= 5, "至少 5 个误标账号应恢复（其余 6 个与原版同判真失效）");
}

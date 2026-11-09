//! 串行慢测当前真实库中 42 个 invalid 号（区分限流误伤 vs 真失效）。
//! 运行：cargo test -p maildeck-core --test retest_invalid_serial -- --ignored --nocapture
//! 成功的号由 test_connection 自动写回 valid；真失效保持 invalid。

use maildeck_core::account_store::AccountStore;
use maildeck_core::credentials::TieredTokenStore;
use maildeck_core::mailbox_access::{test_connection, MailboxRuntime};
use maildeck_core::refresh_state::RefreshOptions;
use maildeck_core::transports::graph_client::GraphClient;
use std::time::Duration;

#[test]
#[ignore]
fn retest_invalid_serial() {
    let store = AccountStore::open(None).expect("open real db");
    let records: Vec<_> = store
        .list()
        .expect("list")
        .into_iter()
        .filter(|a| a.status == maildeck_core::contracts::AccountStatus::Invalid)
        .collect();
    println!("invalid 总数: {}", records.len());
    assert!(!records.is_empty());

    let tokens = TieredTokenStore::new();
    let graph = GraphClient::new("https://graph.microsoft.com/v1.0".into(), Duration::from_secs(30));
    let runtime = MailboxRuntime {
        graph,
        options: RefreshOptions {
            timeout: Duration::from_secs(30),
            concurrency: 1,
            interval_ms: 0,
            proxy_url: String::new(),
            skip_cooldown: true,
        },
        proxy_url: String::new(),
    };

    let mut ok = 0;
    let mut still_failed = Vec::new();
    for (i, record) in records.iter().enumerate() {
        let out = test_connection(&store, &tokens, record, &runtime);
        let email: String = record.email.chars().take(34).collect();
        if out.ok {
            ok += 1;
            println!("[{}/{}] OK   {}", i + 1, records.len(), email);
        } else {
            still_failed.push(format!("{} :: {}", email, out.error.as_ref().map(|e| e.to_string().chars().take(60).collect::<String>()).unwrap_or_default()));
            println!("[{}/{}] FAIL {}", i + 1, records.len(), email);
        }
        std::thread::sleep(Duration::from_millis(4000));
    }
    println!("\nRESULT: 恢复 {}/{}；仍失败 {} 个：", ok, records.len(), still_failed.len());
    for f in &still_failed {
        println!("  {}", f);
    }
}

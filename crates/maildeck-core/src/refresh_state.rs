//! 刷新编排（对应原 refresh-state.ts + refresh-engine.ts）。
//! 状态机：cooldown 内跳过；token 刷新（graph/imap 双 scope）→ inbox 计数 → 状态回写；
//! 多账号并发（rayon）+ 进度回调 + 取消。账号级失败不中断整体（聚合结果）。

use crate::account_store::{now_iso, AccountStore};
use crate::contracts::{AccountRecord, InboxSource, RefreshAccountOutcome, RefreshReport};
use crate::credentials::{reveal_refresh_token, TieredTokenStore, TokenSink};
use crate::errors::AppError;
use crate::transports::graph_client::GraphClient;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone)]
pub struct RefreshOptions {
    pub timeout: Duration,
    pub concurrency: usize,
    pub interval_ms: u64,
    /// 令牌端点代理（原版 refreshAccessToken 第三参）。
    pub proxy_url: String,
    pub skip_cooldown: bool,
}

impl Default for RefreshOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(15),
            concurrency: 4,
            interval_ms: 0,
            proxy_url: String::new(),
            skip_cooldown: false,
        }
    }
}

/// 取消令牌 + 进度上报。
pub struct RefreshContext {
    pub cancel: Arc<AtomicBool>,
    #[allow(clippy::type_complexity)]
    pub progress: Mutex<Option<Box<dyn Fn(usize, usize, &str) + Send>>>,
    pub done: AtomicUsize,
    pub total: usize,
}

impl RefreshContext {
    pub fn new(total: usize) -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            progress: Mutex::new(None),
            done: AtomicUsize::new(0),
            total,
        }
    }

    pub fn report(&self, email: &str) {
        let done = self.done.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(guard) = self.progress.lock() {
            if let Some(f) = guard.as_ref() {
                f(done, self.total, email);
            }
        }
    }

    pub fn is_canceled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

fn is_cooldown_active(record: &AccountRecord, now: chrono::DateTime<chrono::Utc>) -> bool {
    record
        .refresh_cooldown_until
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|until| until > now)
        .unwrap_or(false)
}

/// 单账号刷新（refreshOneAccount 移植）。禁用冷却的跳过逻辑放在外层。
pub fn refresh_one_account(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    options: &RefreshOptions,
    ctx: &RefreshContext,
    graph_client: &GraphClient,
) -> RefreshAccountOutcome {
    let email = record.email.clone();
    if ctx.is_canceled() {
        return RefreshAccountOutcome {
            account_id: record.id.clone(),
            email,
            status: crate::contracts::RefreshStatusSummary::Skipped,
            inbox_count: None,
            error: Some("任务已取消".into()),
            cooldown_seconds: None,
        };
    }
    let now_utc = chrono::Utc::now();
    if !options.skip_cooldown && is_cooldown_active(record, now_utc) {
        let until = record
            .refresh_cooldown_until
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| {
                (t.with_timezone(&chrono::Utc) - now_utc)
                    .num_seconds()
                    .max(0)
            });
        return RefreshAccountOutcome {
            account_id: record.id.clone(),
            email,
            status: crate::contracts::RefreshStatusSummary::CooldownSkipped,
            inbox_count: None,
            error: None,
            cooldown_seconds: until,
        };
    }

    let outcome = do_refresh(store, tokens, record, options, ctx, graph_client);
    ctx.report(&email);
    outcome
}

fn do_refresh(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    record: &AccountRecord,
    options: &RefreshOptions,
    _ctx: &RefreshContext,
    graph_client: &GraphClient,
) -> RefreshAccountOutcome {
    let now = now_iso();
    let fail = |err: AppError, cooldown: Option<i64>| -> RefreshAccountOutcome {
        let cooldown_until = cooldown.map(|s| {
            (chrono::Utc::now() + chrono::Duration::seconds(s))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
        let _ = store.apply_refresh_failure(
            &record.id,
            &err.to_string(),
            &now,
            cooldown_until.as_deref(),
        );
        RefreshAccountOutcome {
            account_id: record.id.clone(),
            email: record.email.clone(),
            status: crate::contracts::RefreshStatusSummary::Failed,
            inbox_count: None,
            error: Some(err.to_string()),
            cooldown_seconds: cooldown,
        }
    };

    // 1) 取 refresh token
    let refresh_token = match reveal_refresh_token(&record.encrypted_refresh_token) {
        Ok(t) => t,
        Err(e) => return fail(e, Some(300)),
    };
    let stored_sink_token = tokens
        .get(&record.id)
        .unwrap_or_else(|| refresh_token.clone());

    // 2) 刷新（原版单次：表单无 scope，端点轮询在 refresh_token_grant 内）
    let graph_result = crate::oauth::refresh_token_grant(
        &record.client_id,
        &stored_sink_token,
        &options.proxy_url,
        options.timeout,
    );
    let graph_token = match graph_result {
        Ok(t) if !t.access_token.is_empty() => t,
        Ok(_) => {
            return fail(
                AppError::Unknown("token endpoint returned empty access_token".into()),
                None,
            )
        }
        Err(e) => return fail(e, Some(300)),
    };
    // 新 refresh token 落存储（轮换）
    if !graph_token.refresh_token.is_empty() {
        if let Ok(enc) = crate::credentials::protect_refresh_token(
            &graph_token.refresh_token,
            crate::credentials::CredentialGeneration::Dpapi,
        ) {
            let _ = store.bump_credential_generation(&record.id, 1, &enc);
            tokens.set(&record.id, &graph_token.refresh_token);
        }
    }

    // 3) inbox 计数：原版 refreshAccount 按 authMode 路由（mailbox-access.ts:840）——
    //    imap 账号用 IMAP 通道计数，graph 账号用 Graph endpoint。
    //    固定走 Graph 会让 IMAP scope 的 access token 打 Graph 得 401，
    //    账号被误标 invalid（2026-11 发现的 11 个“失效”号的根因）。
    let mode = crate::oauth::auth_mode_from_scope(&graph_token.scope);
    let inbox = if mode == "imap" {
        let imap = (|| {
            let (_unseen, all) = crate::transports::imap_client::fetch_inbox_counts(
                &record.email,
                &graph_token.access_token,
                options.timeout,
            )?;
            // 最新邮件时间与原版一致从摘要取（原版 refreshImapInbox 返回 messages 后取 latestMailTime）。
            let latest = crate::transports::imap_client::list_messages(
                &record.email,
                &graph_token.access_token,
                "INBOX",
                1,
                "",
                "",
                "",
                options.timeout,
            )
            .ok()
            .and_then(|page| {
                page.messages
                    .first()
                    .and_then(|m| m.received_date_time.clone())
            });
            Ok(crate::transports::graph_client::InboxCount {
                count: all,
                latest_mail_at: latest,
            })
        })();
        match imap {
            Ok(count) => count,
            Err(e) => return fail(e, None),
        }
    } else {
        match graph_client.inbox_unread_count(&graph_token.access_token, record) {
            Ok(count) => count,
            Err(e) => {
                return fail(crate::errors::normalize_error(e.as_ref()), None);
            }
        }
    };

    // 3) 应用刷新成功（原版无 IMAP 二次换发）
    let _ = store.apply_refresh_success(
        &record.id,
        inbox.count,
        inbox.latest_mail_at.as_deref(),
        &now,
    );
    RefreshAccountOutcome {
        account_id: record.id.clone(),
        email: record.email.clone(),
        status: crate::contracts::RefreshStatusSummary::Refreshed,
        inbox_count: Some(inbox.count),
        error: None,
        cooldown_seconds: None,
    }
}

/// 批量刷新（refreshAccounts：rayon 并发 + 间隔 + 取消）。
pub fn refresh_accounts(
    store: &AccountStore,
    tokens: &TieredTokenStore,
    accounts: &[AccountRecord],
    options: &RefreshOptions,
    ctx: &RefreshContext,
    graph_client: &GraphClient,
) -> RefreshReport {
    let started = std::time::Instant::now();
    let outcomes: Mutex<Vec<RefreshAccountOutcome>> = Mutex::new(Vec::new());
    let interval = options.interval_ms;
    let counter = AtomicUsize::new(0);

    rayon::scope(|s| {
        for record in accounts {
            if ctx.is_canceled() {
                break;
            }
            let outcomes = &outcomes;
            let ctx = &ctx;
            let options = &options;
            let store = &store;
            let tokens = &tokens;
            let graph_client = &graph_client;
            let counter = &counter;
            s.spawn(move |_| {
                // 间隔控制：按完成序号错峰
                let idx = counter.fetch_add(1, Ordering::SeqCst);
                if interval > 0 && idx > 0 {
                    std::thread::sleep(Duration::from_millis(interval * idx as u64));
                }
                let outcome =
                    refresh_one_account(store, tokens, record, options, ctx, graph_client);
                if let Ok(mut list) = outcomes.lock() {
                    list.push(outcome);
                }
            });
        }
    });

    let list = outcomes.into_inner().unwrap_or_default();
    let refreshed = list
        .iter()
        .filter(|o| o.status == crate::contracts::RefreshStatusSummary::Refreshed)
        .count();
    let failed = list
        .iter()
        .filter(|o| o.status == crate::contracts::RefreshStatusSummary::Failed)
        .count();
    let skipped = list.len() - refreshed - failed;
    let total_inbox: i64 = list.iter().filter_map(|o| o.inbox_count).sum();
    RefreshReport {
        total: accounts.len(),
        refreshed,
        failed,
        skipped,
        canceled: ctx.is_canceled(),
        duration_ms: started.elapsed().as_millis() as i64,
        total_inbox_count: total_inbox,
        outcomes: list,
        started_at: now_iso(),
    }
}

/// 来源标签（InboxSource）：graph 缓存优先，imap 兜底。
pub fn choose_inbox_source(_record: &AccountRecord) -> InboxSource {
    // 图为主源：graph delta / inbox folder 任一存在即 Graph，否则回退 Graph（IMAP 仅配置了 server 时启用）。
    InboxSource::Graph
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::AccountStatus;

    #[test]
    fn cooldown_detection() {
        let mut record = AccountRecord {
            id: "a".into(),
            email: "a@x.com".into(),
            client_id: "c".into(),
            encrypted_refresh_token: "e".into(),
            remark: "".into(),
            group_name: "".into(),
            status: AccountStatus::Invalid,
            last_checked_at: None,
            last_error: None,
            last_refreshed_at: None,
            last_inbox_count: 0,
            last_mail_at: None,
            inbox_folder_id: None,
            graph_delta_link: None,
            refresh_cooldown_until: None,
            credential_generation: 1,
            created_at: String::new(),
            updated_at: String::new(),
        };
        assert!(!is_cooldown_active(&record, chrono::Utc::now()));
        record.refresh_cooldown_until = Some(
            (chrono::Utc::now() + chrono::Duration::seconds(60))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        );
        assert!(is_cooldown_active(&record, chrono::Utc::now()));
    }

    #[test]
    fn context_progress_counts() {
        let ctx = RefreshContext::new(3);
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = hits.clone();
        *ctx.progress.lock().unwrap() = Some(Box::new(move |_d, _t, _e| {
            hits2.fetch_add(1, Ordering::SeqCst);
        }));
        ctx.report("a");
        ctx.report("b");
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        ctx.cancel.store(true, Ordering::SeqCst);
        assert!(ctx.is_canceled());
    }
}

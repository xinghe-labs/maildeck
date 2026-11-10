//! Telegram Bot 交互状态机：搜索账号 → 邮件列表 → 正文。
//!
//! **纯只读**：只调 `cmd_account_list` / `cmd_mail_list` / `cmd_mail_detail` /
//! `cmd_refresh_accounts`，不改任何账号状态或邮件已读标记。
//!
//! 按钮回调受 Telegram 的 `callback_data` 64 字节限制，所以回调里只放**索引**，
//! 真实 id 存在会话状态里。

use crate::AppContext;
use maildeck_core::contracts::{
    AccountStatus, MailSearchHit, MailboxMessageDetail, MailboxMessageListResult,
};
use maildeck_core::telegram::{BotApi, TelegramConfig};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// 搜索结果上限。超出时提示继续输入，避免一屏几十个按钮。
const MAX_RESULTS: usize = 10;
/// 一屏邮件条数。
const PAGE_SIZE: i64 = 10;
/// Telegram 单条消息字符上限。
const TG_TEXT_LIMIT: usize = 4096;
/// 默认文件夹。
const INBOX: &str = "INBOX";
/// 轮询失败后的重试退避（秒）。
const RETRY_DELAYS: [u64; 4] = [3, 5, 10, 30];

// ---------------------------------------------------------------------------
// 会话状态
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Session {
    /// 最近一次搜索命中的账号，`a:<idx>` 指向这里。
    accounts: Vec<AccountRef>,
    /// 当前打开的账号及其邮件列表，`m:<idx>` 指向这里。
    view: Option<AccountView>,
    /// 最近一次跨账号搜索的命中，`x:<idx>` 指向这里。
    hits: Vec<MailSearchHit>,
}

struct AccountRef {
    id: String,
    email: String,
    status: AccountStatus,
}

struct AccountView {
    account_id: String,
    email: String,
    folder_id: String,
    messages: Vec<MessageRef>,
    total: i64,
    /// 当前页（从 1 开始）。
    page: i64,
}

struct MessageRef {
    id: String,
    subject: String,
    from: String,
    time: String,
    is_read: bool,
    has_attachments: bool,
}

impl AccountView {
    fn new(result: MailboxMessageListResult, email: String, page: i64) -> Self {
        Self {
            account_id: result.account_id,
            email,
            folder_id: result.folder_id,
            messages: result
                .messages
                .into_iter()
                .map(|m| MessageRef {
                    id: m.id,
                    subject: m.subject,
                    from: m
                        .from
                        .and_then(|f| f.name.or(f.address))
                        .unwrap_or_else(|| "（未知发件人）".to_string()),
                    time: format_time(
                        m.received_date_time
                            .as_deref()
                            .or(m.sent_date_time.as_deref()),
                    ),
                    is_read: m.is_read,
                    has_attachments: m.has_attachments,
                })
                .collect(),
            total: result.total,
            page,
        }
    }

    /// 总页数（至少 1 页）。
    fn pages(&self) -> i64 {
        if self.total <= 0 {
            1
        } else {
            (self.total + PAGE_SIZE - 1) / PAGE_SIZE
        }
    }

    fn render(&self, note: &str) -> String {
        let mut out = format!("📬 {}\n", self.email);
        if !note.is_empty() {
            out.push_str(note);
            out.push('\n');
        }
        let pages = self.pages();
        if pages > 1 {
            out.push_str(&format!(
                "（第 {}/{} 页）\n",
                self.page.clamp(1, pages),
                pages
            ));
        }
        out.push('\n');
        if self.messages.is_empty() {
            out.push_str("（收件箱没有邮件）");
            return out;
        }
        for (i, m) in self.messages.iter().enumerate() {
            let flag = if m.is_read { "已读" } else { "未读" };
            let clip = if m.has_attachments { " 📎" } else { "" };
            out.push_str(&format!(
                "{}. [{}] {} · {}{} · {}\n",
                i + 1,
                flag,
                m.from,
                truncate(&m.subject, 40),
                clip,
                m.time
            ));
        }
        if self.total > self.messages.len() as i64 {
            out.push_str(&format!(
                "\n共 {} 封，这里显示最近 {} 封",
                self.total,
                self.messages.len()
            ));
        }
        out
    }

    fn keyboard(&self) -> serde_json::Value {
        let mut rows: Vec<serde_json::Value> = Vec::new();
        for (i, m) in self.messages.iter().enumerate() {
            let label = format!(
                "{}. {} · {}",
                i + 1,
                truncate(&m.from, 16),
                truncate(&m.subject, 26)
            );
            rows.push(json!([{ "text": label, "callback_data": format!("m:{i}") }]));
        }
        rows.push(json!([
            { "text": "🔄 刷新", "callback_data": "r" },
            { "text": "🔍 换账号", "callback_data": "h" }
        ]));
        let pages = self.pages();
        if pages > 1 {
            let mut nav: Vec<serde_json::Value> = Vec::new();
            if self.page > 1 {
                nav.push(json!({
                    "text": "◀ 上一页",
                    "callback_data": format!("p:{}", self.page - 1)
                }));
            }
            if self.page < pages {
                nav.push(json!({
                    "text": "下一页 ▶",
                    "callback_data": format!("p:{}", self.page + 1)
                }));
            }
            if !nav.is_empty() {
                rows.push(json!(nav));
            }
        }
        json!({ "inline_keyboard": rows })
    }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

/// 启动 Bot 主循环。配置非法/代理不可用时不 panic，只打印并退出线程。
pub fn run(ctx: Arc<AppContext>, config: TelegramConfig) {
    let mut offset: i64 = 0;
    let mut sessions: HashMap<String, Session> = HashMap::new();
    let mut failures = 0usize;

    maildeck_core::logging::info(format!(
        "[telegram] Bot 已启动（token {}，只响应 chat {}）",
        config.redacted_token(),
        config.chat_id
    ));
    let startup_proxy = ctx.refresh_options().proxy_url;
    maildeck_core::logging::info(format!(
        "[telegram] 代理：{}",
        if startup_proxy.trim().is_empty() {
            "未配置（直连 api.telegram.org，国内通常不通）".to_string()
        } else {
            maildeck_core::proxy_security::redact_proxy_credentials(&startup_proxy)
        }
    ));

    let mut api = match BotApi::new(&config.bot_token, &startup_proxy) {
        Ok(api) => api,
        Err(err) => {
            maildeck_core::logging::warn(format!("[telegram] 初始化失败：{err}"));
            return;
        }
    };

    // 注册命令菜单（聊天框旁的菜单按钮 + 输入 `/` 的自动补全）。
    // 失败只告警：菜单不影响主流程，token 权限异常时也能继续收消息。
    const COMMANDS: &[(&str, &str)] = &[
        ("find", "查邮箱账号（关键词模糊匹配）"),
        ("open", "直接打开某个完整邮箱"),
        ("unread", "看各账号未读数"),
        ("search", "跨账号搜邮件"),
        ("refresh", "刷新当前打开的账号"),
        ("help", "用法提示"),
    ];
    match api.set_my_commands(COMMANDS) {
        Ok(()) => {
            let names: Vec<String> = COMMANDS.iter().map(|(c, _)| format!("/{c}")).collect();
            maildeck_core::logging::info(format!(
                "[telegram] 命令菜单已注册（{}）",
                names.join(" ")
            ));
        }
        Err(err) => maildeck_core::logging::warn(format!("[telegram] 命令菜单注册失败：{err}")),
    }

    loop {
        match api.get_updates(offset) {
            Ok(updates) => {
                failures = 0;
                for update in &updates {
                    if let Some(id) = update.get("update_id").and_then(|v| v.as_i64()) {
                        offset = offset.max(id + 1);
                    }
                    dispatch(&api, &config, &ctx, &mut sessions, update);
                }
            }
            Err(err) => {
                let delay = RETRY_DELAYS[failures.min(RETRY_DELAYS.len() - 1)];
                failures += 1;
                maildeck_core::logging::warn(format!(
                    "[telegram] 轮询失败（{delay}s 后重试）：{err}"
                ));
                std::thread::sleep(Duration::from_secs(delay));
                // 重建客户端：代理设置可能已被用户改过。
                if let Ok(fresh) = BotApi::new(&config.bot_token, &ctx.refresh_options().proxy_url)
                {
                    api = fresh;
                }
            }
        }
    }
}

fn dispatch(
    api: &BotApi,
    config: &TelegramConfig,
    ctx: &AppContext,
    sessions: &mut HashMap<String, Session>,
    update: &serde_json::Value,
) {
    if let Some(cq) = update.get("callback_query") {
        let Some(chat_id) = cq.pointer("/message/chat/id").and_then(json_to_id) else {
            return;
        };
        // 白名单：非本人的点击一律静默丢弃（不回复，避免暴露 Bot 存在）。
        if chat_id != config.chat_id {
            return;
        }
        let callback_id = cq.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let _ = api.answer_callback_query(callback_id, None);
        let data = cq.get("data").and_then(|v| v.as_str()).unwrap_or_default();
        let message_id = cq
            .pointer("/message/message_id")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let session = sessions.entry(chat_id.clone()).or_default();
        handle_callback(api, ctx, session, &chat_id, message_id, data);
        return;
    }

    if let Some(msg) = update.get("message") {
        let Some(chat_id) = msg.pointer("/chat/id").and_then(json_to_id) else {
            return;
        };
        if chat_id != config.chat_id {
            return;
        }
        let text = msg.get("text").and_then(|v| v.as_str()).unwrap_or_default();
        let session = sessions.entry(chat_id.clone()).or_default();
        handle_text(api, ctx, session, &chat_id, text);
    }
}

// ---------------------------------------------------------------------------
// 文本消息：搜索账号
// ---------------------------------------------------------------------------

fn handle_text(api: &BotApi, ctx: &AppContext, session: &mut Session, chat_id: &str, text: &str) {
    let query = text.trim();
    if query.is_empty() {
        send_hint(api, chat_id);
        return;
    }
    if let Some((cmd, arg)) = parse_command(query) {
        match cmd.as_str() {
            "find" | "f" => {
                if arg.is_empty() {
                    let _ = api.send_message(
                        chat_id,
                        "用法：`/find 邮箱关键词`（至少 2 个字符）\n例如 `/find hotmail`",
                        None,
                    );
                } else {
                    account_search(api, ctx, session, chat_id, &arg);
                }
            }
            "open" | "o" => open_account(api, ctx, session, chat_id, &arg),
            "unread" | "u" => unread_overview(api, ctx, session, chat_id),
            "search" | "s" => search_mail(api, ctx, session, chat_id, &arg),
            "refresh" | "r" => refresh_current(api, ctx, session, chat_id),
            _ => send_hint(api, chat_id),
        }
        return;
    }
    // 不带斜杠时按「查邮箱」处理，和 /find 等价。
    account_search(api, ctx, session, chat_id, query);
}

/// 解析 `/命令 参数`：返回 `(命令名, 参数)`；不是命令时返回 `None`。
/// 兼容群里的 `/cmd@BotName` 形式（Telegram 在群里会追加 bot 名）。
fn parse_command(text: &str) -> Option<(String, String)> {
    let rest = text.trim().strip_prefix('/')?;
    let (cmd, arg) = match rest.split_once(char::is_whitespace) {
        Some((c, a)) => (c, a.trim()),
        None => (rest, ""),
    };
    let cmd = cmd.split('@').next().unwrap_or(cmd);
    Some((cmd.to_string(), arg.to_string()))
}

/// 按邮箱关键词模糊搜账号，列成按钮。`/find xxx` 与直接发文字都走这里。
fn account_search(
    api: &BotApi,
    ctx: &AppContext,
    session: &mut Session,
    chat_id: &str,
    query: &str,
) {
    let query = query.trim();
    if query.chars().count() < 2 {
        let _ = api.send_message(chat_id, "至少输入 2 个字符再搜。", None);
        return;
    }

    let accounts = match crate::cmd_account_list(ctx) {
        Ok(list) => list,
        Err(err) => {
            let _ = api.send_message(chat_id, &format!("❌ 读取账号失败：{err}"), None);
            return;
        }
    };
    let needle = query.to_lowercase();
    let matched: Vec<_> = accounts
        .into_iter()
        .filter(|a| a.email.to_lowercase().contains(&needle))
        .collect();

    if matched.is_empty() {
        let _ = api.send_message(chat_id, &format!("没有匹配「{query}」的账号。"), None);
        return;
    }

    session.accounts = matched
        .iter()
        .take(MAX_RESULTS)
        .map(|a| AccountRef {
            id: a.id.clone(),
            email: a.email.clone(),
            status: a.status,
        })
        .collect();
    session.view = None;
    session.hits.clear();
    maildeck_core::logging::info(format!(
        "[telegram] 搜索「{query}」→ {} 个匹配（展示 {}）",
        matched.len(),
        session.accounts.len()
    ));

    let mut rows: Vec<serde_json::Value> = Vec::new();
    for (i, account) in session.accounts.iter().enumerate() {
        let mark = if account.status == AccountStatus::Invalid {
            "⚠️ "
        } else {
            ""
        };
        rows.push(json!([{
            "text": format!("{mark}{}", account.email),
            "callback_data": format!("a:{i}")
        }]));
    }

    let header = if matched.len() > MAX_RESULTS {
        format!(
            "匹配到 {} 个，显示前 {} 个。多输几个字符可缩小范围：",
            matched.len(),
            MAX_RESULTS
        )
    } else {
        format!("匹配到 {} 个：", matched.len())
    };
    let _ = api.send_message(chat_id, &header, Some(json!({ "inline_keyboard": rows })));
}

/// `/open 完整邮箱`：精确匹配直接进账号视图；没命中就退回模糊搜索。
fn open_account(api: &BotApi, ctx: &AppContext, session: &mut Session, chat_id: &str, arg: &str) {
    let needle = arg.trim().to_lowercase();
    if needle.is_empty() {
        let _ = api.send_message(
            chat_id,
            "用法：`/open 完整邮箱`\n例如 `/open abc123@hotmail.com`",
            None,
        );
        return;
    }
    let accounts = match crate::cmd_account_list(ctx) {
        Ok(list) => list,
        Err(err) => {
            let _ = api.send_message(chat_id, &format!("❌ 读取账号失败：{err}"), None);
            return;
        }
    };
    let Some(acc) = accounts.iter().find(|a| a.email.to_lowercase() == needle) else {
        // 没精确命中就退回模糊搜索，避免「少打一个字符就什么都看不到」
        account_search(api, ctx, session, chat_id, arg);
        return;
    };
    session.accounts = vec![AccountRef {
        id: acc.id.clone(),
        email: acc.email.clone(),
        status: acc.status,
    }];
    session.view = None;
    session.hits.clear();
    let Ok(pending) = api.send_message(chat_id, "⏳ 正在读取缓存…", None) else {
        return;
    };
    select_account(api, ctx, session, chat_id, pending, "0");
}

/// `/refresh`：刷新当前打开的账号（没打开账号时给提示，不默默无事）。
fn refresh_current(api: &BotApi, ctx: &AppContext, session: &mut Session, chat_id: &str) {
    if session.view.is_none() {
        let _ = api.send_message(
            chat_id,
            "现在没有打开的账号。先用 `/find 关键词` 或 `/open 邮箱` 打开一个。",
            None,
        );
        return;
    }
    let Ok(msg) = api.send_message(chat_id, "🔄 正在刷新…", None) else {
        return;
    };
    refresh_view(api, ctx, session, chat_id, msg);
}

fn send_hint(api: &BotApi, chat_id: &str) {
    let text = "🔍 输入邮箱前缀（至少 2 个字符）来搜账号，例如发 `milio`。\n\
                点选账号看邮件列表，再点邮件看正文。\n\n\
                命令：\n\
                `/find 关键词` — 查邮箱账号\n\
                `/open 完整邮箱` — 直接打开\n\
                `/unread` — 看各账号未读数\n\
                `/search 关键词` — 跨账号搜邮件\n\
                `/refresh` — 刷新当前账号\n\n\
                （只能读，不会改动任何邮件状态）";
    let _ = api.send_message(chat_id, text, None);
}

/// `/unread`：按未读数列出账号，点一下直接进账号视图。
fn unread_overview(api: &BotApi, ctx: &AppContext, session: &mut Session, chat_id: &str) {
    // 取足够大的上限：头部要报真实总数（如 372 个账号 715 封），
    // 按钮只展示前 MAX_RESULTS 个。
    let rows = match crate::cmd_mail_unread_summary(ctx, 5000) {
        Ok(v) => v,
        Err(err) => {
            let _ = api.send_message(chat_id, &format!("❌ 读取未读统计失败：{err}"), None);
            return;
        }
    };
    if rows.is_empty() {
        let _ = api.send_message(
            chat_id,
            "📭 缓存里没有未读邮件。\n（统计来自最近一次刷新；先点账号刷新一次再试）",
            None,
        );
        return;
    }

    let accounts = match crate::cmd_account_list(ctx) {
        Ok(list) => list,
        Err(err) => {
            let _ = api.send_message(chat_id, &format!("❌ 读取账号失败：{err}"), None);
            return;
        }
    };
    let by_id: HashMap<&str, &_> = accounts.iter().map(|a| (a.id.as_str(), a)).collect();

    let total: i64 = rows.iter().map(|(_, n)| *n).sum();
    let involved = rows.len();

    session.accounts.clear();
    session.view = None;
    let mut buttons: Vec<serde_json::Value> = Vec::new();
    for (account_id, count) in rows.iter() {
        if session.accounts.len() >= MAX_RESULTS {
            break;
        }
        let Some(acc) = by_id.get(account_id.as_str()) else {
            continue;
        };
        let idx = session.accounts.len();
        session.accounts.push(AccountRef {
            id: acc.id.clone(),
            email: acc.email.clone(),
            status: acc.status,
        });
        buttons.push(json!([{
            "text": format!("{} · {} 封", acc.email, count),
            "callback_data": format!("a:{idx}")
        }]));
    }

    let header = if involved > session.accounts.len() {
        format!(
            "📬 共 {total} 封未读，涉及 {involved} 个账号（先显示 {} 个）：",
            session.accounts.len()
        )
    } else {
        format!("📬 共 {total} 封未读，涉及 {involved} 个账号：")
    };
    let _ = api.send_message(
        chat_id,
        &header,
        Some(json!({ "inline_keyboard": buttons })),
    );
}

/// `/search 关键词`：在缓存里跨账号搜主题/发件人。
fn search_mail(api: &BotApi, ctx: &AppContext, session: &mut Session, chat_id: &str, arg: &str) {
    let needle = arg.trim();
    if needle.chars().count() < 2 {
        let _ = api.send_message(
            chat_id,
            "用法：`/search 关键词`（至少 2 个字符）\n搜的是本地缓存的主题和发件人。",
            None,
        );
        return;
    }

    let hits = match crate::cmd_mail_search(ctx, needle, MAX_RESULTS as i64) {
        Ok(v) => v,
        Err(err) => {
            let _ = api.send_message(chat_id, &format!("❌ 搜索失败：{err}"), None);
            return;
        }
    };
    if hits.is_empty() {
        let _ = api.send_message(
            chat_id,
            &format!("没有在缓存里找到「{needle}」。\n先刷新对应账号，缓存里才有邮件。"),
            None,
        );
        return;
    }

    let accounts = match crate::cmd_account_list(ctx) {
        Ok(list) => list,
        Err(err) => {
            let _ = api.send_message(chat_id, &format!("❌ 读取账号失败：{err}"), None);
            return;
        }
    };
    let by_id: HashMap<&str, &_> = accounts.iter().map(|a| (a.id.as_str(), a)).collect();

    let mut lines = format!("🔍 「{needle}」命中 {} 封（缓存）：\n\n", hits.len());
    let mut buttons: Vec<serde_json::Value> = Vec::new();
    for (i, hit) in hits.iter().enumerate() {
        let email = by_id
            .get(hit.account_id.as_str())
            .map(|a| a.email.as_str())
            .unwrap_or("?");
        let from = hit
            .from_name
            .clone()
            .or_else(|| hit.from_address.clone())
            .unwrap_or_else(|| "(未知)".into());
        lines.push_str(&format!(
            "{}. {}\n   {} · {} · {}\n",
            i + 1,
            truncate(&hit.subject, 40),
            truncate(&from, 24),
            format_time(hit.received_date_time.as_deref()),
            truncate(email, 32)
        ));
    }
    for chunk_start in (0..hits.len()).step_by(5) {
        let mut row: Vec<serde_json::Value> = Vec::new();
        for i in chunk_start..(chunk_start + 5).min(hits.len()) {
            row.push(json!({
                "text": (i + 1).to_string(),
                "callback_data": format!("x:{i}")
            }));
        }
        buttons.push(json!(row));
    }

    session.hits = hits;
    session.view = None;
    session.accounts.clear();
    maildeck_core::logging::info(format!(
        "[telegram] 跨账号搜索「{needle}」→ {} 封",
        session.hits.len()
    ));
    let _ = api.send_message(chat_id, &lines, Some(json!({ "inline_keyboard": buttons })));
}

// ---------------------------------------------------------------------------
// 按钮回调
// ---------------------------------------------------------------------------

fn handle_callback(
    api: &BotApi,
    ctx: &AppContext,
    session: &mut Session,
    chat_id: &str,
    message_id: i64,
    data: &str,
) {
    let mut parts = data.splitn(2, ':');
    let action = parts.next().unwrap_or_default();
    let arg = parts.next().unwrap_or_default();
    match action {
        "a" => select_account(api, ctx, session, chat_id, message_id, arg),
        "m" => show_message(api, ctx, session, chat_id, arg),
        "r" => refresh_view(api, ctx, session, chat_id, message_id),
        "p" => goto_page(api, ctx, session, chat_id, message_id, arg),
        "x" => show_hit(api, ctx, session, chat_id, arg),
        "h" => {
            session.view = None;
            let _ = api.edit_message_text(
                chat_id,
                message_id,
                "🔍 输入邮箱前缀（至少 2 个字符）重新搜索。",
                None,
            );
        }
        _ => {}
    }
}

/// 选中账号：先渲染缓存（有反馈），再刷新，最后原地更新。
fn select_account(
    api: &BotApi,
    ctx: &AppContext,
    session: &mut Session,
    chat_id: &str,
    message_id: i64,
    arg: &str,
) {
    let Ok(idx) = arg.parse::<usize>() else {
        return;
    };
    let Some(account) = session.accounts.get(idx) else {
        return;
    };
    let account_id = account.id.clone();
    let email = account.email.clone();
    maildeck_core::logging::info(format!("[telegram] 打开账号 {email}"));
    let _ = api.edit_message_text(chat_id, message_id, "⏳ 正在读取缓存…", None);

    match crate::cmd_mail_list(ctx, &account_id, INBOX, 1, PAGE_SIZE, false) {
        Ok(result) => {
            session.view = Some(AccountView::new(result, email.clone(), 1));
            render_view(api, session, chat_id, message_id, "⏳ 缓存 · 正在刷新…");
        }
        Err(err) => {
            let _ = api.edit_message_text(
                chat_id,
                message_id,
                &format!("❌ 读取缓存失败：{err}"),
                None,
            );
            return;
        }
    }

    // 刷新失败不假装成功：明确标注显示的是缓存。
    let note = match crate::cmd_refresh_accounts_owned(
        ctx,
        Some(vec![account_id.clone()]),
        crate::REFRESH_OWNER_TELEGRAM,
    ) {
        Ok(report) => {
            let failed = report
                .outcomes
                .iter()
                .any(|o| o.status == maildeck_core::contracts::RefreshStatusSummary::Failed);
            if failed {
                "⚠️ 刷新失败，下面是缓存".to_string()
            } else {
                "✅ 已刷新".to_string()
            }
        }
        Err(_) => "⚠️ 刷新失败，下面是缓存".to_string(),
    };

    if let Ok(result) = crate::cmd_mail_list(ctx, &account_id, INBOX, 1, PAGE_SIZE, false) {
        session.view = Some(AccountView::new(result, email.clone(), 1));
    }
    maildeck_core::logging::info(format!("[telegram] 账号 {email} → {note}"));
    render_view(api, session, chat_id, message_id, &note);
}

fn refresh_view(
    api: &BotApi,
    ctx: &AppContext,
    session: &mut Session,
    chat_id: &str,
    message_id: i64,
) {
    let Some((account_id, email, folder_id, page)) = session.view.as_ref().map(|v| {
        (
            v.account_id.clone(),
            v.email.clone(),
            v.folder_id.clone(),
            v.page,
        )
    }) else {
        return;
    };
    let _ = api.edit_message_text(chat_id, message_id, "🔄 正在刷新…", None);
    let note = match crate::cmd_refresh_accounts_owned(
        ctx,
        Some(vec![account_id.clone()]),
        crate::REFRESH_OWNER_TELEGRAM,
    ) {
        Ok(report) => {
            let failed = report
                .outcomes
                .iter()
                .any(|o| o.status == maildeck_core::contracts::RefreshStatusSummary::Failed);
            if failed {
                "⚠️ 刷新失败，下面是缓存".to_string()
            } else {
                "✅ 已刷新".to_string()
            }
        }
        Err(_) => "⚠️ 刷新失败，下面是缓存".to_string(),
    };
    if let Ok(result) = crate::cmd_mail_list(ctx, &account_id, &folder_id, page, PAGE_SIZE, false) {
        session.view = Some(AccountView::new(result, email, page));
    }
    render_view(api, session, chat_id, message_id, &note);
}

/// 翻页：不刷新，只换页读缓存。
fn goto_page(
    api: &BotApi,
    ctx: &AppContext,
    session: &mut Session,
    chat_id: &str,
    message_id: i64,
    arg: &str,
) {
    let Ok(page) = arg.parse::<i64>() else {
        return;
    };
    if page < 1 {
        return;
    }
    let Some((account_id, email, folder_id)) = session
        .view
        .as_ref()
        .map(|v| (v.account_id.clone(), v.email.clone(), v.folder_id.clone()))
    else {
        return;
    };
    match crate::cmd_mail_list(ctx, &account_id, &folder_id, page, PAGE_SIZE, false) {
        Ok(result) => {
            session.view = Some(AccountView::new(result, email, page));
            render_view(api, session, chat_id, message_id, "");
        }
        Err(err) => {
            let _ = api.edit_message_text(
                chat_id,
                message_id,
                &format!("❌ 读取第 {page} 页失败：{err}"),
                None,
            );
        }
    }
}

fn render_view(api: &BotApi, session: &Session, chat_id: &str, message_id: i64, note: &str) {
    let Some(view) = session.view.as_ref() else {
        return;
    };
    let _ = api.edit_message_text(
        chat_id,
        message_id,
        &view.render(note),
        Some(view.keyboard()),
    );
}

/// 看正文：列表消息保留，正文另发一条（原地编辑「正在获取」）。
fn show_message(api: &BotApi, ctx: &AppContext, session: &Session, chat_id: &str, arg: &str) {
    let Ok(idx) = arg.parse::<usize>() else {
        return;
    };
    let Some((account_id, folder_id, message_id)) = session.view.as_ref().and_then(|v| {
        v.messages
            .get(idx)
            .map(|m| (v.account_id.clone(), v.folder_id.clone(), m.id.clone()))
    }) else {
        return;
    };
    send_detail(api, ctx, chat_id, &account_id, &folder_id, &message_id);
}

/// 跨账号搜索结果的详情（命中里已带 account_id）。
fn show_hit(api: &BotApi, ctx: &AppContext, session: &Session, chat_id: &str, arg: &str) {
    let Ok(idx) = arg.parse::<usize>() else {
        return;
    };
    let Some(hit) = session.hits.get(idx) else {
        return;
    };
    send_detail(api, ctx, chat_id, &hit.account_id, INBOX, &hit.message_id);
}

/// 发一条「正在获取」占位消息，再把它改成正文（过长时分段发送）。
fn send_detail(
    api: &BotApi,
    ctx: &AppContext,
    chat_id: &str,
    account_id: &str,
    folder_id: &str,
    message_id: &str,
) {
    let Ok(pending_id) = api.send_message(chat_id, "⏳ 正在获取…", None) else {
        return;
    };
    maildeck_core::logging::info(format!("[telegram] 取正文 message={message_id}"));
    match crate::cmd_mail_detail(ctx, account_id, folder_id, message_id) {
        Ok(detail) => {
            let body = render_detail(&detail);
            let parts = split_message(&body);
            maildeck_core::logging::info(format!(
                "[telegram] 正文 {} 字（{} 段，source={}）",
                body.chars().count(),
                parts.len(),
                detail.source
            ));
            let back = json!({
                "inline_keyboard": [[{ "text": "← 返回列表", "callback_data": "b" }]]
            });
            let first_keyboard = if parts.len() == 1 {
                Some(back.clone())
            } else {
                None
            };
            let _ = api.edit_message_text(chat_id, pending_id, &parts[0], first_keyboard);
            for part in &parts[1..] {
                let _ = api.send_message(chat_id, part, None);
            }
            if parts.len() > 1 {
                let _ = api.send_message(
                    chat_id,
                    &format!("（正文共 {} 段，以上为全部内容）", parts.len()),
                    Some(back),
                );
            }
        }
        Err(err) => {
            let _ = api.edit_message_text(
                chat_id,
                pending_id,
                &format!("❌ 获取正文失败：{err}"),
                None,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 渲染工具
// ---------------------------------------------------------------------------

fn render_detail(detail: &MailboxMessageDetail) -> String {
    let d = &detail.detail;
    let from_name = d
        .from
        .name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| d.from.address.clone())
        .unwrap_or_else(|| "（未知发件人）".to_string());
    let from_addr = d.from.address.clone().unwrap_or_default();
    let time = format_time(
        d.received_date_time
            .as_deref()
            .or(d.sent_date_time.as_deref()),
    );

    let raw_body = if d.body.content_type.eq_ignore_ascii_case("html") {
        html_to_text(&d.body.content)
    } else {
        d.body.content.clone()
    };
    let body = raw_body.trim();

    let mut out = String::new();
    out.push_str(&format!("── {from_name} ──\n"));
    if !from_addr.is_empty() && !from_addr.eq_ignore_ascii_case(&from_name) {
        out.push_str(&format!("{from_addr}\n"));
    }
    if !d.subject.trim().is_empty() {
        out.push_str(&format!("{}\n", d.subject.trim()));
    }
    if !time.is_empty() {
        out.push_str(&format!("{time}\n"));
    }
    out.push('\n');
    if body.is_empty() {
        out.push_str("（正文为空）");
    } else {
        out.push_str(body);
    }
    if d.has_attachments {
        out.push_str(&format!("\n\n📎 {} 个附件", d.attachments.len()));
    }
    out
}

/// `2025-11-07T06:32:11Z` -> 本地 `11-07 14:32`
fn format_time(raw: Option<&str>) -> String {
    let Some(raw) = raw.filter(|s| !s.trim().is_empty()) else {
        return String::new();
    };
    match chrono::DateTime::parse_from_rfc3339(raw) {
        Ok(dt) => dt
            .with_timezone(&chrono::Local)
            .format("%m-%d %H:%M")
            .to_string(),
        Err(_) => raw.chars().take(16).collect(),
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 超过 Telegram 单条上限时按段切分（不截断内容）。
fn split_message(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= TG_TEXT_LIMIT {
        return vec![text.to_string()];
    }
    let mut parts = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let hard_end = (start + TG_TEXT_LIMIT).min(chars.len());
        let mut cut = hard_end;
        if hard_end < chars.len() {
            // 尽量在换行处断开，避免把句子劈成两半。
            let floor = start + TG_TEXT_LIMIT * 3 / 4;
            if let Some(offset) = chars[floor..hard_end].iter().position(|c| *c == '\n') {
                cut = floor + offset + 1;
            }
        }
        parts.push(chars[start..cut].iter().collect());
        start = cut;
    }
    parts
}

/// 极简 HTML → 纯文本：去标签、块级标签转换行、解常见实体。
/// 不追求还原排版，只求「手机上能读懂」。
fn html_to_text(html: &str) -> String {
    const BLOCK_TAGS: [&str; 14] = [
        "br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section",
        "article",
    ];
    const SKIP_TAGS: [&str; 2] = ["script", "style"];

    let mut out = String::with_capacity(html.len());
    let mut tag = String::new();
    let mut in_tag = false;
    let mut skip_depth: usize = 0;
    let mut chars = html.chars().peekable();

    while let Some(c) = chars.next() {
        if in_tag {
            if c == '>' {
                in_tag = false;
                let name = tag
                    .trim()
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_lowercase();
                let is_close = tag.trim_start().starts_with('/');
                if SKIP_TAGS.contains(&name.as_str()) {
                    if is_close {
                        skip_depth = skip_depth.saturating_sub(1);
                    } else if !tag.trim().ends_with('/') {
                        skip_depth += 1;
                    }
                } else if skip_depth == 0 {
                    if BLOCK_TAGS.contains(&name.as_str()) {
                        out.push('\n');
                    } else {
                        out.push(' ');
                    }
                }
                tag.clear();
            } else {
                tag.push(c);
            }
            continue;
        }

        match c {
            '<' => in_tag = true,
            '&' => {
                let mut entity = String::new();
                while let Some(&next) = chars.peek() {
                    if next == ';' || entity.len() >= 10 {
                        break;
                    }
                    entity.push(next);
                    chars.next();
                }
                if chars.peek() == Some(&';') {
                    chars.next();
                }
                if skip_depth == 0 {
                    out.push_str(&decode_entity(&entity));
                }
            }
            _ if skip_depth > 0 => {}
            '\r' => {}
            _ => out.push(c),
        }
    }

    tidy_whitespace(&out)
}

fn decode_entity(entity: &str) -> String {
    match entity.to_lowercase().as_str() {
        "amp" => "&".to_string(),
        "lt" => "<".to_string(),
        "gt" => ">".to_string(),
        "quot" => "\"".to_string(),
        "apos" | "#39" => "'".to_string(),
        "nbsp" => " ".to_string(),
        "mdash" => "—".to_string(),
        "ndash" => "–".to_string(),
        "hellip" => "…".to_string(),
        "ldquo" => "\u{201c}".to_string(),
        "rdquo" => "\u{201d}".to_string(),
        other => {
            if let Some(num) = other.strip_prefix('#') {
                if let Ok(code) = num.parse::<u32>() {
                    if let Some(ch) = char::from_u32(code) {
                        return ch.to_string();
                    }
                }
            }
            format!("&{entity};")
        }
    }
}

/// 压掉水平空白、把 3 个以上连续空行收成 1 个空行。
fn tidy_whitespace(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let mut line = String::new();
        let mut prev_space = false;
        for c in raw.chars() {
            if c.is_whitespace() {
                if !prev_space {
                    line.push(' ');
                }
                prev_space = true;
            } else {
                line.push(c);
                prev_space = false;
            }
        }
        lines.push(line.trim_end().to_string());
    }

    let mut out = String::new();
    let mut blank_run = 0usize;
    for line in lines {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
            out.push('\n');
        } else {
            blank_run = 0;
            out.push_str(&line);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

fn json_to_id(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_html_and_keeps_paragraphs() {
        let html = "<p>Hello&nbsp;<b>world</b></p><p>Line&nbsp;2 &amp; more</p>";
        let text = html_to_text(html);
        assert!(text.contains("Hello world"), "got: {text}");
        assert!(text.contains("Line 2 & more"), "got: {text}");
        assert!(text.contains('\n'), "段落应保留换行，got: {text}");
    }

    #[test]
    fn drops_script_and_style() {
        let html = "<style>p{color:red}</style><p>可见</p><script>alert(1)</script>";
        let text = html_to_text(html);
        assert!(text.contains("可见"));
        assert!(!text.contains("color"));
        assert!(!text.contains("alert"));
    }

    #[test]
    fn splits_long_body_without_losing_content() {
        let body = "字".repeat(TG_TEXT_LIMIT + 500);
        let parts = split_message(&body);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts.concat().chars().count(), body.chars().count());
        assert!(parts.iter().all(|p| p.chars().count() <= TG_TEXT_LIMIT));
    }

    #[test]
    fn truncates_with_ellipsis() {
        assert_eq!(truncate("abcdef", 10), "abcdef");
        assert_eq!(truncate("abcdef", 4), "abc…");
    }

    #[test]
    fn formats_rfc3339_time() {
        let out = format_time(Some("2025-11-07T06:32:11Z"));
        assert_eq!(out.len(), 11, "MM-DD HH:MM，got: {out}");
    }

    #[test]
    fn parses_command_with_and_without_args() {
        assert_eq!(
            parse_command("/find hotmail"),
            Some(("find".into(), "hotmail".into()))
        );
        assert_eq!(parse_command("/unread"), Some(("unread".into(), "".into())));
        assert_eq!(
            parse_command("  /open a@b.com  "),
            Some(("open".into(), "a@b.com".into()))
        );
        // 群里 Telegram 会追加 @BotName
        assert_eq!(
            parse_command("/search@MyBot 发票 2024"),
            Some(("search".into(), "发票 2024".into()))
        );
        // 参数里的空格要保留（多词搜索）
        assert_eq!(
            parse_command("/search new sign-in"),
            Some(("search".into(), "new sign-in".into()))
        );
        // 不是命令
        assert_eq!(parse_command("hotmail"), None);
        assert_eq!(parse_command(""), None);
    }

    fn make_view(total: i64, page: i64, count: usize) -> AccountView {
        let messages = (0..count)
            .map(|i| maildeck_core::contracts::MailListItem {
                id: format!("m{i}"),
                subject: format!("主题{i}"),
                from: None,
                received_date_time: None,
                sent_date_time: None,
                is_read: false,
                importance: "normal".into(),
                has_attachments: false,
                body_preview: None,
                web_link: None,
            })
            .collect();
        AccountView::new(
            MailboxMessageListResult {
                account_id: "acc".into(),
                folder_id: "INBOX".into(),
                page,
                page_size: PAGE_SIZE,
                total,
                messages,
                source: "cache".into(),
            },
            "a@x.com".into(),
            page,
        )
    }

    #[test]
    fn page_count_rounds_up_and_never_below_one() {
        assert_eq!(make_view(25, 1, 10).pages(), 3);
        assert_eq!(make_view(20, 1, 10).pages(), 2);
        assert_eq!(make_view(1, 1, 1).pages(), 1);
        assert_eq!(make_view(0, 1, 0).pages(), 1);
    }

    #[test]
    fn nav_buttons_follow_the_current_page() {
        // 首页：只有「下一页」
        let kb = make_view(25, 1, 10).keyboard().to_string();
        assert!(kb.contains("下一页"), "首页应有下一页：{kb}");
        assert!(!kb.contains("上一页"), "首页不该有上一页：{kb}");

        // 中间页：两边都有
        let kb = make_view(25, 2, 10).keyboard().to_string();
        assert!(
            kb.contains("下一页") && kb.contains("上一页"),
            "中间页：{kb}"
        );

        // 末页：只有「上一页」
        let kb = make_view(25, 3, 5).keyboard().to_string();
        assert!(kb.contains("上一页"), "末页应有上一页：{kb}");
        assert!(!kb.contains("下一页"), "末页不该有下一页：{kb}");

        // 只有一页：不出导航
        let kb = make_view(5, 1, 5).keyboard().to_string();
        assert!(
            !kb.contains("下一页") && !kb.contains("上一页"),
            "单页：{kb}"
        );
    }

    #[test]
    fn nav_callback_targets_adjacent_page() {
        let kb = make_view(25, 2, 10).keyboard().to_string();
        assert!(kb.contains("p:1"), "上一页应指向 p:1：{kb}");
        assert!(kb.contains("p:3"), "下一页应指向 p:3：{kb}");
    }

    #[test]
    fn render_shows_page_indicator_only_when_needed() {
        assert!(make_view(25, 2, 10).render("").contains("第 2/3 页"));
        assert!(!make_view(5, 1, 5).render("").contains("页"));
    }

    #[test]
    fn empty_note_does_not_leave_blank_line() {
        let text = make_view(5, 1, 5).render("");
        let first_two: Vec<&str> = text.lines().take(2).collect();
        assert_eq!(first_two[0], "📬 a@x.com");
        assert_eq!(
            first_two[1], "",
            "空 note 后面应直接是空行分隔，got: {first_two:?}"
        );
    }
}

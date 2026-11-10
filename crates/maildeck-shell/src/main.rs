//! maildeck-shell：Tauri 桌面壳。每个 invoke 命令只做参数/状态提取与事件发射，
//! 业务全部委托 maildeck-app 门面。命令通道名与原版 electron IPC 一一对应。
// release 构建标记为 GUI 子系统，避免启动时弹出命令行窗口（debug 保留 console 看日志）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use maildeck_app::AppContext;
use maildeck_core::contracts::{
    AccountUpdateInput, DeviceCodeStart, MailboxMessageDetail, MailboxMessageListResult,
    RefreshReport,
};
use maildeck_core::errors::AppError;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager};

type CmdResult = Result<Value, Value>;

/// 共享上下文句柄：state 里放 Arc，阻塞命令才能把副本 move 进后台线程。
type Ctx = Arc<AppContext>;

const TRAY_ID: &str = "main";
const RELEASES_PAGE_URL: &str = "https://github.com/xinghe-labs/maildeck/releases/latest";
const UPDATE_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// 与原版一致：启动 8 秒后才真正联网检查，不抢首屏。
const UPDATE_CHECK_DELAY: std::time::Duration = std::time::Duration::from_secs(8);

/// 壳层运行时状态：真实退出标记 + 更新器状态投影。
struct ShellState {
    quitting: AtomicBool,
    update: Mutex<Value>,
}

impl ShellState {
    fn new() -> Self {
        Self {
            quitting: AtomicBool::new(false),
            update: Mutex::new(json!({ "phase": "idle", "releaseUrl": RELEASES_PAGE_URL })),
        }
    }

    fn update_state(&self) -> Value {
        self.update.lock().expect("update state lock").clone()
    }

    /// 记录新状态并广播 `update:state`（前端 onState 订阅）。
    fn set_update_state(&self, app: &tauri::AppHandle, next: Value) {
        *self.update.lock().expect("update state lock") = next.clone();
        let _ = app.emit("update:state", next);
    }
}

/// 把阻塞任务丢到 blocking 线程池执行。
/// 同步命令跑在主线程，一次网络请求就让窗口「未响应」：实测启动时
/// mail.listFolders 3.1s、mail.listMessages 2.9s 全程卡住窗口消息泵。
async fn offload<F>(task: F) -> CmdResult
where
    F: FnOnce() -> CmdResult + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(task).await {
        Ok(result) => result,
        Err(err) => Err(fail(AppError::Unknown(format!("后台任务执行失败：{err}")))),
    }
}

fn runtime_settings() -> Option<maildeck_core::settings::RuntimeAppSettings> {
    maildeck_core::settings::get_runtime_settings(
        None,
        &maildeck_core::settings::DefaultSettingsCrypto,
    )
    .ok()
}

fn close_to_tray_enabled() -> bool {
    runtime_settings().map(|s| s.close_to_tray).unwrap_or(false)
}

fn tray_active(app: &tauri::AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 按设置创建/销毁托盘（原版 syncTray：关掉 closeToTray 就真的没有托盘图标）。
fn sync_tray(app: &tauri::AppHandle, enabled: bool) {
    if enabled {
        if let Err(err) = build_tray(app) {
            eprintln!("创建托盘失败：{err}");
        }
    } else if tray_active(app) {
        let _ = app.remove_tray_by_id(TRAY_ID);
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{TrayIconBuilder, TrayIconEvent};
    if tray_active(app) {
        return Ok(());
    }
    let show = MenuItem::with_id(app, "show", "打开 MailDeck", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "立即收信", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &refresh, &separator, &quit])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("MailDeck")
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_tray_icon_event(|tray, event| {
        // 设置页承诺的交互：双击托盘图标恢复窗口。
        if matches!(event, TrayIconEvent::DoubleClick { .. }) {
            show_main_window(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

fn apply_launch_at_startup(app: &tauri::AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    if let Err(err) = result {
        eprintln!("应用开机自启设置失败：{err}");
    }
}

/// 主窗口由壳层创建（tauri.conf.json 里没有 windows 条目）：
/// 只有 builder 能挂 initialization_script，用它把真实版本号注入前端。
fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let version = serde_json::to_string(&app.package_info().version.to_string())
        .unwrap_or_else(|_| "\"0.0.0\"".to_string());
    let script = format!("window.__MAILDECK_VERSION__ = {version};");
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("MailDeck")
        .inner_size(1280.0, 800.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .initialization_script(&script)
        .build()
}

fn attach_window_handlers(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let app_handle = app.clone();
    let window_handle = window.clone();
    window.on_window_event(move |event| match event {
        // 关闭 = 隐藏到托盘；真实退出由 quitting 标记放行。
        tauri::WindowEvent::CloseRequested { api, .. } => {
            let quitting = app_handle
                .state::<ShellState>()
                .quitting
                .load(Ordering::SeqCst);
            if !quitting && close_to_tray_enabled() && tray_active(&app_handle) {
                api.prevent_close();
                let _ = window_handle.hide();
            }
        }
        // 最小化 = 隐藏到托盘（原版 window.on("minimize")）。
        tauri::WindowEvent::Resized(_)
            if window_handle.is_minimized().unwrap_or(false)
                && close_to_tray_enabled()
                && tray_active(&app_handle) =>
        {
            let _ = window_handle.hide();
        }
        _ => {}
    });
}

/// 刷新前的账号快照：id -> (邮箱, 上次收件数)，用来算「新邮件」数量。
fn inbox_snapshot(ctx: &AppContext) -> std::collections::HashMap<String, (String, i64)> {
    match maildeck_app::cmd_account_list(ctx) {
        Ok(records) => records
            .into_iter()
            .map(|record| (record.id, (record.email, record.last_inbox_count)))
            .collect(),
        Err(_) => std::collections::HashMap::new(),
    }
}

/// 有新邮件时弹托盘气泡（原版 notifyNewMail：只在托盘存在时提醒）。
fn notify_new_mail(
    app: &tauri::AppHandle,
    report: &RefreshReport,
    before: &std::collections::HashMap<String, (String, i64)>,
) {
    use maildeck_core::contracts::RefreshStatusSummary;
    use tauri_plugin_notification::NotificationExt;
    if !tray_active(app) {
        return;
    }
    for outcome in &report.outcomes {
        if outcome.status == RefreshStatusSummary::Failed {
            continue;
        }
        let Some(after) = outcome.inbox_count else {
            continue;
        };
        let Some((email, previous)) = before.get(&outcome.account_id) else {
            continue;
        };
        let new_count = after - *previous;
        if new_count <= 0 {
            continue;
        }
        let result = app
            .notification()
            .builder()
            .title("MailDeck 有新邮件")
            .body(format!("{email} 收到 {new_count} 封新邮件"))
            .show();
        if let Err(err) = result {
            eprintln!("托盘气泡提醒失败：{err}");
        }
    }
}

/// 托盘「立即收信」：后台线程刷新所有未失效账号（不能在菜单线程里跑网络）。
fn refresh_all_in_background(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<Ctx>() else {
        return;
    };
    let ctx = state.inner().clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let ids: Vec<String> = match maildeck_app::cmd_account_list(&ctx) {
            Ok(records) => records
                .into_iter()
                .filter(|account| {
                    account.status != maildeck_core::contracts::AccountStatus::Invalid
                })
                .map(|account| account.id)
                .collect(),
            Err(err) => {
                eprintln!("读取账号失败：{err}");
                return;
            }
        };
        if ids.is_empty() {
            return;
        }
        let before = inbox_snapshot(&ctx);
        match maildeck_app::cmd_refresh_accounts(&ctx, Some(ids.clone())) {
            Ok(report) => {
                emit_refresh_progress(&app, "refreshBackground", &ids, &report);
                notify_new_mail(&app, &report, &before);
            }
            Err(err) => eprintln!("托盘立即收信失败：{err}"),
        }
    });
}

/// 真正联网检查最新发布版本（绿色版：能查、能提示，装不了）。
fn perform_update_check(app: &tauri::AppHandle, quiet_when_current: bool) -> Value {
    let current = app.package_info().version.to_string();
    let proxy_url = runtime_settings().map(|s| s.proxy_url).unwrap_or_default();
    let next = match maildeck_core::updater::fetch_latest_release(&proxy_url, UPDATE_CHECK_TIMEOUT) {
        Ok(latest) if maildeck_core::updater::is_newer(&current, &latest.version) => json!({
            // 绿色版没有安装器：查得到新版，但只能引导到发布页手动下载。
            "phase": "unsupported",
            "reason": "portable",
            "version": latest.version,
            "currentVersion": current,
            "releaseUrl": latest.page_url,
        }),
        Ok(latest) => json!({
            "phase": "not-available",
            "version": current,
            "releaseUrl": latest.page_url,
        }),
        Err(err) => json!({
            "phase": "error",
            "message": err.to_string(),
            "releaseUrl": RELEASES_PAGE_URL,
        }),
    };
    // 启动时的自动检查：已是最新就静默，别把设置页的「检查更新」换成「打开发布页」。
    let up_to_date = next.get("phase").and_then(|v| v.as_str()) == Some("not-available");
    if up_to_date && quiet_when_current {
        eprintln!("启动自动检查更新：已是最新 v{current}");
        return next;
    }
    eprintln!(
        "检查更新：{}（当前 v{current}）",
        next.get("phase").and_then(|v| v.as_str()).unwrap_or("?")
    );
    if let Some(state) = app.try_state::<ShellState>() {
        state.set_update_state(app, next.clone());
    }
    next
}

fn ser<T: serde::Serialize>(value: T) -> Result<Value, Value> {
    serde_json::to_value(value).map_err(|e| fail(AppError::Serialization(e.to_string())))
}

fn fail(err: AppError) -> Value {
    json!(err.payload())
}

macro_rules! cmd_body {
    ($state:expr, $call:expr) => {
        match $call {
            Ok(v) => ser(v),
            Err(e) => Err(fail(e)),
        }
    };
}

// ---------- app ----------

#[tauri::command]
fn app_open_external(app: tauri::AppHandle, url: String) -> CmdResult {
    let target = match maildeck_app::cmd_app_validate_external_url(&url) {
        Ok(v) => v,
        Err(e) => return Err(fail(e)),
    };
    use tauri_plugin_opener::OpenerExt;
    match app.opener().open_url(target, None::<&str>) {
        Ok(()) => Ok(json!({ "opened": true })),
        Err(e) => Err(fail(AppError::Unknown(e.to_string()))),
    }
}

// ---------- accounts ----------

#[tauri::command]
async fn accounts_list(state: tauri::State<'_, Ctx>) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || {
        cmd_body!(
            ctx,
            maildeck_app::cmd_account_list(&ctx).map(|records| records
                .iter()
                .map(maildeck_core::import_module::to_view)
                .collect::<Vec<_>>())
        )
    })
    .await
}

#[tauri::command]
async fn accounts_preview_import_text(state: tauri::State<'_, Ctx>, text: String) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || {
        cmd_body!(
            ctx,
            maildeck_app::cmd_accounts_preview_import_text(&ctx, &text)
        )
    })
    .await
}

#[tauri::command]
async fn accounts_import_text(state: tauri::State<'_, Ctx>, text: String) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || {
        cmd_body!(ctx, maildeck_app::cmd_accounts_import_text(&ctx, &text))
    })
    .await
}

#[tauri::command]
async fn accounts_import_file(app: tauri::AppHandle, state: tauri::State<'_, Ctx>) -> CmdResult {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter("Account files", &["csv", "txt"])
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    let Some(path) = picked else {
        return Ok(json!(null));
    };
    let path = path
        .into_path()
        .map_err(|e| fail(AppError::Unknown(e.to_string())))?;
    let ctx = state.inner().clone();
    offload(move || {
        let bytes = std::fs::read(&path).map_err(|e| fail(AppError::Unknown(e.to_string())))?;
        if bytes.len() > maildeck_core::import_module::IMPORT_TEXT_MAX_BYTES {
            return Err(fail(AppError::Unknown(format!(
                "导入文件不能超过 {} 字节",
                maildeck_core::import_module::IMPORT_TEXT_MAX_BYTES
            ))));
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        cmd_body!(ctx, maildeck_app::cmd_accounts_import_text(&ctx, &text))
    })
    .await
}

#[tauri::command]
async fn accounts_upsert(
    state: tauri::State<'_, Ctx>,
    input: maildeck_core::import_module::AccountInput,
) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || cmd_body!(ctx, maildeck_app::cmd_accounts_upsert(&ctx, input))).await
}

#[tauri::command]
async fn accounts_update(state: tauri::State<'_, Ctx>, input: AccountUpdateInput) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || {
        cmd_body!(
            ctx,
            maildeck_app::cmd_accounts_update_input(&ctx, input)
        )
    })
    .await
}

#[tauri::command]
async fn accounts_delete(state: tauri::State<'_, Ctx>, account_id: String) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || match maildeck_app::cmd_account_delete(&ctx, &account_id) {
        Ok(()) => cmd_body!(
            ctx,
            maildeck_app::cmd_account_list(&ctx).map(|records| records
                .iter()
                .map(maildeck_core::import_module::to_view)
                .collect::<Vec<_>>())
        ),
        Err(e) => Err(fail(e)),
    })
    .await
}

#[tauri::command]
async fn accounts_test(state: tauri::State<'_, Ctx>, account_id: String) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || cmd_body!(ctx, maildeck_app::cmd_account_test(&ctx, &account_id))).await
}

#[tauri::command]
async fn accounts_test_fallback(
    state: tauri::State<'_, Ctx>,
    account_id: String,
) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || {
        cmd_body!(
            ctx,
            maildeck_app::cmd_account_test_fallback(&ctx, &account_id)
        )
    })
    .await
}

#[tauri::command]
async fn accounts_test_many(
    app: tauri::AppHandle,
    state: tauri::State<'_, Ctx>,
    account_ids: Vec<String>,
) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || {
        // 原版 runLimited 的同步近似：按并发数分批，每批内多线程，每条完成即发进度事件。
        let concurrency = ctx.refresh_options().concurrency.max(1);
        let job_id = uuid::Uuid::new_v4().to_string();
        let progress: Mutex<(usize, usize, usize)> = Mutex::new((0, 0, 0)); // completed/ok/failed
        let total = account_ids.len();
        let mut results = Vec::with_capacity(total);
        let mut chunks = account_ids.chunks(concurrency).peekable();
        while let Some(chunk) = chunks.next() {
            let is_last = chunks.peek().is_none();
            let mut results_chunk = Vec::new();
            std::thread::scope(|scope| {
                let mut handles = Vec::new();
                for id in chunk {
                    let app = &app;
                    let state = &ctx;
                    let progress = &progress;
                    let job_id = job_id.clone();
                    let id = id.clone();
                    handles.push(scope.spawn(move || {
                        let result = maildeck_app::cmd_account_test(state, &id).unwrap_or_else(|e| {
                            maildeck_core::contracts::TestManyResult {
                                account_id: id.clone(),
                                account: None,
                                ok: false,
                                message: None,
                                error: Some(e.payload()),
                            }
                        });
                        let mut p = progress.lock().expect("progress lock");
                        p.0 += 1;
                        if result.ok {
                            p.1 += 1;
                        } else {
                            p.2 += 1;
                        }
                        let completed = p.0;
                        let ok = p.1;
                        let failed = p.2;
                        drop(p);
                        // 完成才累计最终结果；进度事件在每个账号完成时都发（原版 onProgress）。
                        let _ = app.emit(
                            "accounts:testProgress",
                            json!({
                                "jobId": job_id,
                                "kind": "test",
                                "completed": completed,
                                "total": total,
                                "ok": ok,
                                "failed": failed,
                                "accountId": id,
                                "error": result.error,
                                "final": is_last && completed == total,
                            }),
                        );
                        result
                    }));
                }
                for handle in handles {
                    if let Ok(r) = handle.join() {
                        results_chunk.push(r);
                    }
                }
            });
            results.append(&mut results_chunk);
        }
        ser(results)
    })
    .await
}

// ---------- refresh / jobs ----------

#[tauri::command]
async fn mail_refresh_many(
    app: tauri::AppHandle,
    state: tauri::State<'_, Ctx>,
    request: Value,
) -> CmdResult {
    // 原版契约（mailbox.ts handleAccountsRefreshMany）：accountIds 为 string[] | "all"。
    let raw_ids = request.get("accountIds");
    let account_ids_opt: Option<Vec<String>> = if raw_ids.and_then(|v| v.as_str()) == Some("all") {
        None
    } else {
        Some(
            raw_ids
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
        )
    };
    let job_kind = request
        .get("jobKind")
        .and_then(|v| v.as_str())
        .unwrap_or("refresh")
        .to_string();
    let account_ids_for_event = account_ids_opt.clone().unwrap_or_default();
    let ctx = state.inner().clone();
    offload(move || {
        let before = inbox_snapshot(&ctx);
        match maildeck_app::cmd_refresh_accounts(&ctx, account_ids_opt) {
            Ok(report) => {
                emit_refresh_progress(&app, &job_kind, &account_ids_for_event, &report);
                notify_new_mail(&app, &report, &before);
                ser(report_to_refresh_many(&report))
            }
            Err(e) => Err(fail(e)),
        }
    })
    .await
}

fn report_to_refresh_many(report: &RefreshReport) -> Vec<Value> {
    use maildeck_core::contracts::RefreshStatusSummary;
    report
        .outcomes
        .iter()
        .map(|o| {
            let skipped = matches!(
                o.status,
                RefreshStatusSummary::Skipped | RefreshStatusSummary::CooldownSkipped
            );
            json!({
                "accountId": o.account_id,
                "ok": o.status != RefreshStatusSummary::Failed,
                "count": o.inbox_count.unwrap_or(0),
                "skipped": skipped,
                "error": o.error.as_ref().map(|msg| json!({
                    "code": "UNKNOWN",
                    "message": msg,
                    "retryable": true,
                })),
            })
        })
        .collect()
}

fn emit_refresh_progress(
    app: &tauri::AppHandle,
    job_kind: &str,
    ids: &[String],
    report: &RefreshReport,
) {
    use maildeck_core::contracts::RefreshStatusSummary;
    let total = ids.len();
    let job_id = uuid::Uuid::new_v4().to_string();
    let mut completed = 0usize;
    let mut ok = 0usize;
    let mut failed = 0usize;
    for outcome in &report.outcomes {
        completed += 1;
        if outcome.status != RefreshStatusSummary::Failed {
            ok += 1;
        } else {
            failed += 1;
        }
        let _ = app.emit(
            "mail:refreshProgress",
            json!({
                "jobId": job_id,
                "kind": job_kind,
                "completed": completed,
                "total": total,
                "ok": ok,
                "failed": failed,
                "accountId": outcome.account_id,
                "error": outcome.error.as_ref().map(|msg| json!({
                    "code": "UNKNOWN",
                    "message": msg,
                    "retryable": true,
                })),
            }),
        );
    }
}

#[tauri::command]
fn jobs_cancel(state: tauri::State<'_, AppContext>, job: String) -> CmdResult {
    let count = match job.as_str() {
        "refresh" | "refreshSingle" | "refreshBackground" => {
            let _ = maildeck_app::cmd_refresh_cancel(&state);
            1
        }
        _ => 0,
    };
    Ok(json!({ "canceled": job, "count": count }))
}

#[tauri::command]
async fn refresh_accounts(
    app: tauri::AppHandle,
    state: tauri::State<'_, Ctx>,
    account_ids: Option<Vec<String>>,
) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || {
        let before = inbox_snapshot(&ctx);
        match maildeck_app::cmd_refresh_accounts(&ctx, account_ids) {
            Ok(report) => {
                // 保持原有契约：refresh_accounts 不发进度事件（那是 mail_refresh_many 的职责）。
                notify_new_mail(&app, &report, &before);
                ser(report)
            }
            Err(e) => Err(fail(e)),
        }
    })
    .await
}

#[tauri::command]
fn refresh_cancel(state: tauri::State<'_, AppContext>) -> CmdResult {
    match maildeck_app::cmd_refresh_cancel(&state) {
        Ok(()) => Ok(json!(null)),
        Err(e) => Err(fail(e)),
    }
}

// ---------- mail ----------

#[tauri::command]
async fn mail_list_folders(state: tauri::State<'_, Ctx>, account_id: String) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || cmd_body!(ctx, maildeck_app::cmd_mail_folders(&ctx, &account_id))).await
}

#[tauri::command]
async fn mail_list_messages(state: tauri::State<'_, Ctx>, options: Value) -> CmdResult {
    // ListMessagesOptions：{accountId, top?, skip?, forceRefresh?, folderId?}
    let account_id = options
        .get("accountId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let top = options
        .get("top")
        .and_then(|v| v.as_i64())
        .unwrap_or(25)
        .clamp(1, 100);
    let skip = options
        .get("skip")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .max(0);
    let force_refresh = options
        .get("forceRefresh")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let folder_id = options
        .get("folderId")
        .and_then(|v| v.as_str())
        .unwrap_or("INBOX")
        .to_string();
    let page = if skip == 0 { 1 } else { skip / top + 1 };
    let ctx = state.inner().clone();
    offload(move || {
        let result: Result<MailboxMessageListResult, AppError> =
            maildeck_app::cmd_mail_list(&ctx, &account_id, &folder_id, page, top, force_refresh);
        cmd_body!(
            ctx,
            result.map(|r| {
                json!({
                    "messages": r.messages,
                    "nextCursor": Value::Null,
                    "totalCount": r.total,
                })
            })
        )
    })
    .await
}

#[tauri::command]
async fn mail_get_message(state: tauri::State<'_, Ctx>, options: Value) -> CmdResult {
    let account_id = options
        .get("accountId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let message_id = options
        .get("messageId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let folder_id = options
        .get("folderId")
        .and_then(|v| v.as_str())
        .unwrap_or("INBOX")
        .to_string();
    // 原版契约：mail:getMessage 返回裸 MailMessageDetail（不含 account/folder/source 包装）。
    let ctx = state.inner().clone();
    offload(move || {
        let result: Result<MailboxMessageDetail, AppError> =
            maildeck_app::cmd_mail_detail(&ctx, &account_id, &folder_id, &message_id);
        cmd_body!(ctx, result.map(|wrapped| wrapped.detail))
    })
    .await
}

#[tauri::command]
async fn mail_list_attachments(state: tauri::State<'_, Ctx>, options: Value) -> CmdResult {
    let account_id = options
        .get("accountId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let message_id = options
        .get("messageId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let ctx = state.inner().clone();
    offload(move || {
        cmd_body!(
            ctx,
            maildeck_app::cmd_mail_attachments(&ctx, &account_id, &message_id)
        )
    })
    .await
}

#[tauri::command]
async fn mail_save_attachment(
    app: tauri::AppHandle,
    state: tauri::State<'_, Ctx>,
    options: Value,
) -> CmdResult {
    let account_id = options
        .get("accountId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let message_id = options
        .get("messageId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let attachment_id = options
        .get("attachmentId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 先拿字节再弹对话框（下载失败时用户不会先选一个空目录）。下载走后台线程，不卡窗口。
    let ctx = state.inner().clone();
    let downloaded = {
        let ctx = ctx.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            maildeck_app::cmd_mail_attachment_bytes(&ctx, &account_id, &message_id, &attachment_id)
        })
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(e)) => return Err(fail(e)),
            Err(err) => {
                return Err(fail(AppError::Unknown(format!(
                    "后台任务执行失败：{err}"
                ))))
            }
        }
    };
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_file_name(safe_attachment_file_name(&downloaded.name))
        .blocking_save_file();
    let Some(path) = picked else {
        return Ok(json!({ "saved": false, "canceled": true, "path": Value::Null }));
    };
    let path = path
        .into_path()
        .map_err(|e| fail(AppError::Unknown(e.to_string())))?;
    std::fs::write(&path, &downloaded.bytes).map_err(|e| fail(AppError::Unknown(e.to_string())))?;
    Ok(json!({ "saved": true, "canceled": false, "path": path.to_string_lossy() }))
}

/// safeAttachmentFileName 移植：去掉路径分隔与非法字符，空则回退 attachment。
fn safe_attachment_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "attachment".into()
    } else {
        cleaned.to_string()
    }
}

#[tauri::command]
async fn mail_cache_stats(state: tauri::State<'_, Ctx>) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || cmd_body!(ctx, maildeck_app::cmd_mail_cache_stats(&ctx))).await
}

#[tauri::command]
async fn mail_clear_cache(
    state: tauri::State<'_, Ctx>,
    account_id: Option<String>,
) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || {
        cmd_body!(
            ctx,
            maildeck_app::cmd_mail_clear_cache(&ctx, account_id.as_deref())
        )
    })
    .await
}

// ---------- oauth / auth ----------

const DEFAULT_DEVICE_CODE_CLIENT_ID: &str = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const DEFAULT_DEVICE_CODE_SCOPE: &str = "https://graph.microsoft.com/Mail.Read offline_access";

#[tauri::command]
async fn auth_start_device_code(
    app: tauri::AppHandle,
    state: tauri::State<'_, DeviceCodeSession>,
    client_id: Option<String>,
) -> CmdResult {
    // 新会话顶掉旧会话（abort 旧轮询线程）。
    let cancel = {
        let mut current = state.cancel.lock().expect("device session lock");
        current.store(true, Ordering::SeqCst);
        *current = Arc::new(AtomicBool::new(false));
        current.clone()
    };
    let client_id = match client_id {
        Some(id) if !id.trim().is_empty() => id,
        _ => DEFAULT_DEVICE_CODE_CLIENT_ID.to_string(),
    };
    let scope = DEFAULT_DEVICE_CODE_SCOPE.to_string();
    let timeout = state.timeout;
    // 申请设备代码是网络请求，必须离开主线程，否则点「登录」窗口会卡住。
    let session: DeviceCodeStart = {
        let scope = scope.clone();
        let client_id = client_id.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            maildeck_core::oauth::device_code_start(&client_id, "common", &scope, timeout)
        })
        .await
        {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(fail(e)),
            Err(err) => {
                return Err(fail(AppError::Unknown(format!(
                    "后台任务执行失败：{err}"
                ))))
            }
        }
    };
    let _ = app.emit(
        "auth:deviceCodeState",
        json!({
            "phase": "waiting",
            "userCode": session.user_code,
            "verificationUri": session.verification_uri,
            "expiresInSec": session.expires_in,
            "clientId": client_id,
        }),
    );
    // 后台轮询：用户可能要在浏览器里登录一分钟以上，不能把 invoke 挂住。
    let poll_client_id = client_id.clone();
    let poll_session = session.clone();
    let app2 = app.clone();
    let timeout = state.timeout;
    std::thread::spawn(move || {
        let interval = std::time::Duration::from_secs(poll_session.interval.max(1) as u64);
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(poll_session.expires_in.max(0) as u64);
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = app2.emit("auth:deviceCodeState", json!({ "phase": "canceled" }));
                return;
            }
            if std::time::Instant::now() > deadline {
                let _ = app2.emit(
                    "auth:deviceCodeState",
                    json!({ "phase": "failed", "code": "DEVICE_CODE_EXPIRED", "message": "设备代码已过期，请重新开始登录" }),
                );
                return;
            }
            std::thread::sleep(interval);
            match maildeck_core::oauth::device_code_poll(
                &poll_client_id,
                "common",
                &poll_session.device_code,
                &scope,
                timeout,
            ) {
                Ok(maildeck_core::contracts::DeviceCodePoll::Completed(grant)) => {
                    let email = maildeck_core::transports::graph_client::GraphClient::new(
                        maildeck_core::contracts::GRAPH_ENDPOINT_V1.to_string(),
                        timeout,
                    )
                    .get_me_email(&grant.access_token)
                    .ok();
                    let _ = app2.emit(
                        "auth:deviceCodeState",
                        json!({
                            "phase": "authorized",
                            "clientId": poll_client_id,
                            "refreshToken": grant.refresh_token,
                            "email": email,
                            "scope": grant.scope,
                        }),
                    );
                    return;
                }
                Ok(_) => continue, // authorization_pending / slow_down
                Err(AppError::DeviceCodeExpired) => {
                    let _ = app2.emit(
                        "auth:deviceCodeState",
                        json!({ "phase": "failed", "code": "DEVICE_CODE_EXPIRED", "message": "设备代码已过期，请重新开始登录" }),
                    );
                    return;
                }
                Err(AppError::DeviceCodeDeclined) => {
                    let _ = app2.emit(
                        "auth:deviceCodeState",
                        json!({ "phase": "failed", "code": "DEVICE_CODE_DECLINED", "message": "登录被拒绝" }),
                    );
                    return;
                }
                Err(e) => {
                    let _ = app2.emit(
                        "auth:deviceCodeState",
                        json!({ "phase": "failed", "code": "NETWORK_ERROR", "message": e.to_string() }),
                    );
                    return;
                }
            }
        }
    });
    Ok(json!({
        "userCode": session.user_code,
        "verificationUri": session.verification_uri,
        "expiresInSec": session.expires_in,
        "clientId": client_id,
    }))
}

#[tauri::command]
fn auth_cancel_device_code(state: tauri::State<'_, DeviceCodeSession>) -> CmdResult {
    state
        .cancel
        .lock()
        .expect("device session lock")
        .store(true, Ordering::SeqCst);
    Ok(json!({ "canceled": true }))
}

/// 设备代码轮询会话状态（当前取消令牌）。
struct DeviceCodeSession {
    cancel: Mutex<Arc<AtomicBool>>,
    timeout: std::time::Duration,
}

// ---------- oauth（交互式 PKCE，保留） ----------

#[tauri::command]
async fn oauth_device_start(
    state: tauri::State<'_, Ctx>,
    client_id: String,
    scope: String,
) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || {
        cmd_body!(
            ctx,
            maildeck_app::cmd_oauth_device_start(&ctx, &client_id, &scope)
        )
    })
    .await
}

#[tauri::command]
async fn oauth_device_poll(
    state: tauri::State<'_, Ctx>,
    client_id: String,
    device_code: String,
    scope: String,
) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || {
        cmd_body!(
            ctx,
            maildeck_app::cmd_oauth_device_poll(&ctx, &client_id, &device_code, &scope)
        )
    })
    .await
}

#[tauri::command]
async fn oauth_interactive_start(
    state: tauri::State<'_, Ctx>,
    client_id: String,
    scope: String,
    port: u16,
) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || {
        cmd_body!(
            ctx,
            maildeck_app::cmd_oauth_interactive_start(&ctx, &client_id, &scope, port)
        )
    })
    .await
}

// ---------- settings ----------

#[tauri::command]
async fn settings_get(state: tauri::State<'_, Ctx>) -> CmdResult {
    let ctx = state.inner().clone();
    offload(move || cmd_body!(ctx, maildeck_app::cmd_settings_get(&ctx))).await
}

#[tauri::command]
async fn settings_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, Ctx>,
    patch: Value,
) -> CmdResult {
    let ctx = state.inner().clone();
    let result = offload(move || cmd_body!(ctx, maildeck_app::cmd_settings_set(&ctx, patch))).await?;
    // 设置项的壳层副作用（原版 applySettings）：托盘开关、开机自启必须真的生效。
    // cmd_settings_set 返回的就是扁平的 AppSettings（没有外层 settings 键）。
    let close_to_tray = result
        .get("closeToTray")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let launch_at_startup = result
        .get("launchAtStartup")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        sync_tray(&app_for_main, close_to_tray);
        // 关掉「隐藏到托盘」后，如果窗口正藏在托盘里必须拉回来，否则用户找不到入口。
        if !close_to_tray {
            if let Some(window) = app_for_main.get_webview_window("main") {
                if !window.is_visible().unwrap_or(true) {
                    show_main_window(&app_for_main);
                }
            }
        }
    });
    apply_launch_at_startup(&app, launch_at_startup);
    Ok(result)
}

// 原版仅 settings:get / settings:update 两个命令，无 reset。

// ---------- update（绿色版：真实检查版本，但不装安装包） ----------

#[tauri::command]
fn update_get_state(state: tauri::State<'_, ShellState>) -> CmdResult {
    Ok(state.update_state())
}

#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> CmdResult {
    let handle = app.clone();
    match tauri::async_runtime::spawn_blocking(move || perform_update_check(&handle, false)).await {
        Ok(next) => Ok(next),
        Err(err) => Err(fail(AppError::Unknown(format!(
            "后台任务执行失败：{err}"
        )))),
    }
}

#[tauri::command]
fn update_install(state: tauri::State<'_, ShellState>) -> CmdResult {
    // 绿色版没有安装器：不假装下载，直接回报当前状态（unsupported + releaseUrl）。
    Ok(json!({ "started": false, "state": state.update_state() }))
}

/// 启动参数带 --hidden（开机自启）：窗口建好但不显示，安静驻在托盘里。
fn launch_hidden() -> bool {
    std::env::args().any(|arg| arg == "--hidden")
}

fn main() {
    let ctx: Ctx = Arc::new(AppContext::open().expect("初始化 MailDeck 数据目录失败"));
    let device_session = DeviceCodeSession {
        cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
        timeout: std::time::Duration::from_secs(30),
    };
    tauri::Builder::default()
        .manage(ctx)
        .manage(device_session)
        .manage(ShellState::new())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 再次启动：把已有窗口叫回前台（原版 second-instance）。
            show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            // 立即收信：网络请求必须在后台线程，菜单事件线程不能阻塞。
            "refresh" => refresh_all_in_background(app),
            "quit" => {
                if let Some(state) = app.try_state::<ShellState>() {
                    state.quitting.store(true, Ordering::SeqCst);
                }
                app.exit(0);
            }
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let hidden = launch_hidden();
            let window = create_main_window(&handle)?;
            attach_window_handlers(&handle);
            let settings = runtime_settings();
            // 托盘与开机自启跟随设置（不再无条件常驻）。
            let close_to_tray = settings.as_ref().map(|s| s.close_to_tray).unwrap_or(false);
            sync_tray(&handle, close_to_tray);
            let launch_at_startup = settings
                .as_ref()
                .map(|s| s.launch_at_startup)
                .unwrap_or(false);
            apply_launch_at_startup(&handle, launch_at_startup);
            if hidden && close_to_tray {
                let _ = window.hide();
            } else {
                let _ = window.show();
            }
            // 启动时自动检查更新：延时 8 秒、后台线程，不抢首屏。
            let auto_update = settings
                .as_ref()
                .map(|s| s.auto_update_check_enabled)
                .unwrap_or(false);
            if auto_update {
                let handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(UPDATE_CHECK_DELAY);
                    let _ = perform_update_check(&handle, true);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_open_external,
            accounts_list,
            accounts_preview_import_text,
            accounts_import_text,
            accounts_import_file,
            accounts_upsert,
            accounts_update,
            accounts_delete,
            accounts_test,
            accounts_test_fallback,
            accounts_test_many,
            mail_refresh_many,
            jobs_cancel,
            refresh_accounts,
            refresh_cancel,
            mail_list_folders,
            mail_list_messages,
            mail_get_message,
            mail_list_attachments,
            mail_save_attachment,
            mail_cache_stats,
            mail_clear_cache,
            auth_start_device_code,
            auth_cancel_device_code,
            oauth_device_start,
            oauth_device_poll,
            oauth_interactive_start,
            settings_get,
            settings_set,
            update_get_state,
            update_check,
            update_install,
        ])
        .run(tauri::generate_context!())
        .expect("MailDeck 运行失败");
}

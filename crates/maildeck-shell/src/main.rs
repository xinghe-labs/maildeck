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
use tauri::Emitter;

type CmdResult = Result<Value, Value>;

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
fn accounts_list(state: tauri::State<'_, AppContext>) -> CmdResult {
    cmd_body!(
        state,
        maildeck_app::cmd_account_list(&state).map(|records| records
            .iter()
            .map(maildeck_core::import_module::to_view)
            .collect::<Vec<_>>())
    )
}

#[tauri::command]
fn accounts_preview_import_text(state: tauri::State<'_, AppContext>, text: String) -> CmdResult {
    cmd_body!(
        state,
        maildeck_app::cmd_accounts_preview_import_text(&state, &text)
    )
}

#[tauri::command]
fn accounts_import_text(state: tauri::State<'_, AppContext>, text: String) -> CmdResult {
    cmd_body!(state, maildeck_app::cmd_accounts_import_text(&state, &text))
}

#[tauri::command]
fn accounts_import_file(app: tauri::AppHandle, state: tauri::State<'_, AppContext>) -> CmdResult {
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
    let bytes = std::fs::read(&path).map_err(|e| fail(AppError::Unknown(e.to_string())))?;
    if bytes.len() > maildeck_core::import_module::IMPORT_TEXT_MAX_BYTES {
        return Err(fail(AppError::Unknown(format!(
            "导入文件不能超过 {} 字节",
            maildeck_core::import_module::IMPORT_TEXT_MAX_BYTES
        ))));
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    cmd_body!(state, maildeck_app::cmd_accounts_import_text(&state, &text))
}

#[tauri::command]
fn accounts_upsert(
    state: tauri::State<'_, AppContext>,
    input: maildeck_core::import_module::AccountInput,
) -> CmdResult {
    cmd_body!(state, maildeck_app::cmd_accounts_upsert(&state, input))
}

#[tauri::command]
fn accounts_update(state: tauri::State<'_, AppContext>, input: AccountUpdateInput) -> CmdResult {
    cmd_body!(
        state,
        maildeck_app::cmd_accounts_update_input(&state, input)
    )
}

#[tauri::command]
fn accounts_delete(state: tauri::State<'_, AppContext>, account_id: String) -> CmdResult {
    match maildeck_app::cmd_account_delete(&state, &account_id) {
        Ok(()) => cmd_body!(
            state,
            maildeck_app::cmd_account_list(&state).map(|records| records
                .iter()
                .map(maildeck_core::import_module::to_view)
                .collect::<Vec<_>>())
        ),
        Err(e) => Err(fail(e)),
    }
}

#[tauri::command]
fn accounts_test(state: tauri::State<'_, AppContext>, account_id: String) -> CmdResult {
    cmd_body!(state, maildeck_app::cmd_account_test(&state, &account_id))
}

#[tauri::command]
fn accounts_test_fallback(state: tauri::State<'_, AppContext>, account_id: String) -> CmdResult {
    cmd_body!(
        state,
        maildeck_app::cmd_account_test_fallback(&state, &account_id)
    )
}

#[tauri::command]
fn accounts_test_many(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppContext>,
    account_ids: Vec<String>,
) -> CmdResult {
    // 原版 runLimited 的同步近似：按并发数分批，每批内多线程，每条完成即发进度事件。
    let concurrency = state.refresh_options().concurrency.max(1);
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
                let state = &state;
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
}

// ---------- refresh / jobs ----------

#[tauri::command]
fn mail_refresh_many(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppContext>,
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
    match maildeck_app::cmd_refresh_accounts(&state, account_ids_opt) {
        Ok(report) => {
            emit_refresh_progress(&app, &job_kind, &account_ids_for_event, &report);
            ser(report_to_refresh_many(&report))
        }
        Err(e) => Err(fail(e)),
    }
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
fn refresh_accounts(
    state: tauri::State<'_, AppContext>,
    account_ids: Option<Vec<String>>,
) -> CmdResult {
    cmd_body!(
        state,
        maildeck_app::cmd_refresh_accounts(&state, account_ids)
    )
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
fn mail_list_folders(state: tauri::State<'_, AppContext>, account_id: String) -> CmdResult {
    cmd_body!(state, maildeck_app::cmd_mail_folders(&state, &account_id))
}

#[tauri::command]
fn mail_list_messages(state: tauri::State<'_, AppContext>, options: Value) -> CmdResult {
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
    let result: Result<MailboxMessageListResult, AppError> =
        maildeck_app::cmd_mail_list(&state, &account_id, &folder_id, page, top, force_refresh);
    cmd_body!(
        state,
        result.map(|r| {
            json!({
                "messages": r.messages,
                "nextCursor": Value::Null,
                "totalCount": r.total,
            })
        })
    )
}

#[tauri::command]
fn mail_get_message(state: tauri::State<'_, AppContext>, options: Value) -> CmdResult {
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
    let result: Result<MailboxMessageDetail, AppError> =
        maildeck_app::cmd_mail_detail(&state, &account_id, &folder_id, &message_id);
    cmd_body!(state, result.map(|wrapped| wrapped.detail))
}

#[tauri::command]
fn mail_list_attachments(state: tauri::State<'_, AppContext>, options: Value) -> CmdResult {
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
    cmd_body!(
        state,
        maildeck_app::cmd_mail_attachments(&state, &account_id, &message_id)
    )
}

#[tauri::command]
fn mail_save_attachment(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppContext>,
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
    // 先拿字节再弹对话框（下载失败时用户不会先选一个空目录）。
    let downloaded = match maildeck_app::cmd_mail_attachment_bytes(
        &state,
        &account_id,
        &message_id,
        &attachment_id,
    ) {
        Ok(v) => v,
        Err(e) => return Err(fail(e)),
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
fn mail_cache_stats(state: tauri::State<'_, AppContext>) -> CmdResult {
    cmd_body!(state, maildeck_app::cmd_mail_cache_stats(&state))
}

#[tauri::command]
fn mail_clear_cache(state: tauri::State<'_, AppContext>, account_id: Option<String>) -> CmdResult {
    cmd_body!(
        state,
        maildeck_app::cmd_mail_clear_cache(&state, account_id.as_deref())
    )
}

// ---------- oauth / auth ----------

const DEFAULT_DEVICE_CODE_CLIENT_ID: &str = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const DEFAULT_DEVICE_CODE_SCOPE: &str = "https://graph.microsoft.com/Mail.Read offline_access";

#[tauri::command]
fn auth_start_device_code(
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
    let session: DeviceCodeStart = match maildeck_core::oauth::device_code_start(
        &client_id,
        "common",
        &scope,
        state.timeout,
    ) {
        Ok(v) => v,
        Err(e) => return Err(fail(e)),
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
fn oauth_device_start(
    state: tauri::State<'_, AppContext>,
    client_id: String,
    scope: String,
) -> CmdResult {
    cmd_body!(
        state,
        maildeck_app::cmd_oauth_device_start(&state, &client_id, &scope)
    )
}

#[tauri::command]
fn oauth_device_poll(
    state: tauri::State<'_, AppContext>,
    client_id: String,
    device_code: String,
    scope: String,
) -> CmdResult {
    cmd_body!(
        state,
        maildeck_app::cmd_oauth_device_poll(&state, &client_id, &device_code, &scope)
    )
}

#[tauri::command]
fn oauth_interactive_start(
    state: tauri::State<'_, AppContext>,
    client_id: String,
    scope: String,
    port: u16,
) -> CmdResult {
    cmd_body!(
        state,
        maildeck_app::cmd_oauth_interactive_start(&state, &client_id, &scope, port)
    )
}

// ---------- settings ----------

#[tauri::command]
fn settings_get(state: tauri::State<'_, AppContext>) -> CmdResult {
    cmd_body!(state, maildeck_app::cmd_settings_get(&state))
}

#[tauri::command]
fn settings_set(state: tauri::State<'_, AppContext>, patch: Value) -> CmdResult {
    cmd_body!(state, maildeck_app::cmd_settings_set(&state, patch))
}

// 原版仅 settings:get / settings:update 两个命令，无 reset。

// ---------- update（自更新：NSIS 安装版接入 updater，绿色版回报 unsupported） ----------

const RELEASES_URL: &str = "https://github.com/xinghe-labs/maildeck/releases/latest";

#[tauri::command]
fn update_get_state() -> CmdResult {
    // 无签名密钥时 updater 无法工作：诚实回报 unsupported，引导手动下载。
    Ok(json!({ "phase": "unsupported", "reason": "portable", "releaseUrl": RELEASES_URL }))
}

#[tauri::command]
fn update_check() -> CmdResult {
    Ok(json!({ "phase": "unsupported", "reason": "portable", "releaseUrl": RELEASES_URL }))
}

#[tauri::command]
fn update_install() -> CmdResult {
    Ok(json!({
        "started": false,
        "state": { "phase": "unsupported", "reason": "portable", "releaseUrl": RELEASES_URL }
    }))
}

fn main() {
    let ctx = AppContext::open().expect("初始化 MailDeck 数据目录失败");
    let device_session = DeviceCodeSession {
        cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
        timeout: std::time::Duration::from_secs(30),
    };
    tauri::Builder::default()
        .manage(ctx)
        .manage(device_session)
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 托盘：显示窗口 / 立即收信 / 退出（对应原版 close-to-tray 交互）。
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;
            use tauri::Manager;
            let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "立即收信", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &refresh, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .tooltip("MailDeck");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            app.on_menu_event(|app, event| match event.id.as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "refresh" => {
                    // 立即收信：刷新所有未失效账号（trayRefreshAll 语义）。
                    if let Some(state) = app.try_state::<AppContext>() {
                        let accounts = match maildeck_app::cmd_account_list(&state) {
                            Ok(list) => list,
                            Err(_) => return,
                        };
                        let ids: Vec<String> = accounts
                            .iter()
                            .filter(|a| {
                                a.status != maildeck_core::contracts::AccountStatus::Invalid
                            })
                            .map(|a| a.id.clone())
                            .collect();
                        if !ids.is_empty() {
                            let _ = maildeck_app::cmd_refresh_accounts(&state, Some(ids));
                        }
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            });
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

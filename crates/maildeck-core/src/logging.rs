//! 极简日志：写文件 + 尽力写 stderr，任何写失败都不 panic。
//!
//! 为什么不用 `eprintln!`：它内部走 `io::_eprint`，写失败时**直接 panic**。
//! GUI 双击启动时 stderr 指向 NUL（写入总是成功，无害），但「从终端启动后关掉终端」
//! 会让 stderr 句柄失效，之后任何一次 `eprintln!` 都会把进程带崩。
//! 这里用 `writeln!` 并丢弃错误，同时落盘到 `<数据目录>/logs/maildeck.log`。

use chrono::{SecondsFormat, Utc};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 单个日志文件的上限，超过后轮转成 `maildeck.log.1`（只保留一份旧档）。
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const LOG_DIR: &str = "logs";
const LOG_FILE: &str = "maildeck.log";

static LOG_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<PathBuf>> {
    LOG_PATH.get_or_init(|| Mutex::new(None))
}

/// 指定数据目录：日志写到 `<data_dir>/logs/maildeck.log`。重复调用以最后一次为准。
pub fn init(data_dir: &Path) {
    let path = data_dir.join(LOG_DIR).join(LOG_FILE);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut guard) = slot().lock() {
        *guard = Some(path);
    }
}

/// 用平台默认数据目录（尊重 `MAILDECK_USER_DATA_DIR` 覆盖）。
pub fn init_default() {
    init(&crate::db::user_data_path());
}

/// 当前日志文件路径；未初始化时为 `None`。
pub fn log_path() -> Option<PathBuf> {
    slot().lock().ok().and_then(|guard| guard.clone())
}

pub fn info(msg: impl AsRef<str>) {
    write("INFO", msg.as_ref());
}

pub fn warn(msg: impl AsRef<str>) {
    write("WARN", msg.as_ref());
}

pub fn error(msg: impl AsRef<str>) {
    write("ERROR", msg.as_ref());
}

fn write(level: &str, msg: &str) {
    // 尽力而为：句柄失效时 writeln! 返回 Err，忽略即可（eprintln! 会 panic）。
    let _ = writeln!(std::io::stderr(), "[{level}] {msg}");

    let Ok(guard) = slot().lock() else {
        return;
    };
    let Some(path) = guard.as_ref() else {
        return;
    };
    let _ = append(path, level, msg);
}

fn append(path: &Path, level: &str, msg: &str) -> std::io::Result<()> {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() >= MAX_BYTES {
            let rotated = path.with_file_name(format!("{LOG_FILE}.1"));
            let _ = std::fs::remove_file(&rotated);
            let _ = std::fs::rename(path, &rotated);
        }
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(
        file,
        "[{}] [{level}] {msg}",
        Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 独立目录，避免与其它测试共享全局 LOG_PATH。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "maildeck-log-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_appends_and_rotates() {
        let dir = temp_dir("main");
        init(&dir);

        // 1) 写入带级别与时间戳
        info("hello 日志");
        warn("小心");
        let path = log_path().expect("log path set");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[INFO] hello 日志"), "实际内容：{text}");
        assert!(text.contains("[WARN] 小心"), "实际内容：{text}");
        assert!(text.contains("Z] [INFO]"), "时间戳格式不对：{text}");

        // 2) 追加而非覆盖
        info("第三条");
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches("[INFO]").count(), 2, "实际内容：{text}");
        assert_eq!(text.matches("[WARN]").count(), 1, "实际内容：{text}");

        // 3) 超限轮转（直接写超限内容，避免循环写 2MB）
        std::fs::write(&path, vec![b'x'; (MAX_BYTES + 16) as usize]).unwrap();
        info("轮转后这一条");
        let rotated = path.with_file_name(format!("{LOG_FILE}.1"));
        assert!(rotated.exists(), "旧档没有生成");
        let fresh = std::fs::read_to_string(&path).unwrap();
        assert!(fresh.contains("轮转后这一条"), "新档内容：{fresh}");
        assert!(!fresh.contains('x'), "新档混进了旧内容");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_init_does_not_panic() {
        // 未初始化时写日志必须静默跳过，不能 panic。
        // （不碰文件：与其它测试并行时 LOG_PATH 可能已被它们设置，写入也无害。）
        let _ = log_path();
        error("这条只进 stderr");
    }
}

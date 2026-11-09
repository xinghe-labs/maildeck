//! SQLite 打开/迁移：逐字移植原 database.ts + database-migrations.ts（schema v6）。
//! 库文件必须与原 Electron 版（node:sqlite）互通。

use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub const CURRENT_SCHEMA_VERSION: i64 = 6;
pub const DATABASE_FILE_NAME: &str = "maildeck.db";
pub const LEGACY_DATABASE_FILE_NAME: &str = "outlook-manager.db";
pub const SQLITE_SIDECAR_SUFFIXES: [&str; 2] = ["-wal", "-shm"];

pub const USER_DATA_ENV_KEYS: [&str; 2] =
    ["MAILDECK_USER_DATA_DIR", "OUTLOOK_MANAGER_USER_DATA_DIR"];
pub const LEGACY_USER_DATA_DIR_NAME: &str = "outlook-manager";
pub const USER_DATA_DIR_NAME: &str = "maildeck";

/// 用户数据目录：Windows=%APPDATA%/maildeck；macOS=~/Library/Application Support/maildeck；
/// Linux=$XDG_DATA_HOME/maildeck（缺省 ~/.local/share/maildeck）。
/// 可被 MAILDECK_USER_DATA_DIR / OUTLOOK_MANAGER_USER_DATA_DIR 覆盖。
pub fn user_data_path() -> PathBuf {
    if let Some(p) = read_user_data_override(&|key| std::env::var(key).ok()) {
        return p;
    }
    #[cfg(windows)]
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .or_else(|_| dirs::data_dir().ok_or(()))
        .unwrap_or_else(|_| PathBuf::from("."));
    #[cfg(not(windows))]
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(USER_DATA_DIR_NAME)
}

/// 主数据库文件路径（database.ts dbPath）。
pub fn database_path() -> PathBuf {
    user_data_path().join(DATABASE_FILE_NAME)
}

/// 解析 userData 目录（user-data-path.ts readUserDataOverride）。
pub fn read_user_data_override(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    for key in USER_DATA_ENV_KEYS {
        if let Some(value) = env(key) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

/// 新目录不存在、旧目录存在时，把旧目录整体改名过来（migrateLegacyUserDataDirectory）。
/// 返回 (有效目录, 是否已迁移, 改名失败时的旧目录)。
pub fn migrate_legacy_user_data_directory(default_path: &Path) -> (PathBuf, bool, Option<PathBuf>) {
    if default_path.exists() {
        return (default_path.to_path_buf(), false, None);
    }
    let legacy = default_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(LEGACY_USER_DATA_DIR_NAME);
    if !legacy.exists() {
        return (default_path.to_path_buf(), false, None);
    }
    match std::fs::rename(&legacy, default_path) {
        Ok(()) => (default_path.to_path_buf(), true, None),
        Err(_) => (legacy.clone(), false, Some(legacy)),
    }
}

/// 解析数据库文件路径，必要时把旧文件名连 -wal/-shm 一起改过来（resolveDatabaseFilePath）。
pub fn resolve_database_file_path(user_data_path: &Path) -> PathBuf {
    let target = user_data_path.join(DATABASE_FILE_NAME);
    let legacy = user_data_path.join(LEGACY_DATABASE_FILE_NAME);
    if target.exists() || !legacy.exists() {
        return target;
    }
    match std::fs::rename(&legacy, &target) {
        Ok(()) => {
            for suffix in SQLITE_SIDECAR_SUFFIXES {
                let from = user_data_path.join(format!("{LEGACY_DATABASE_FILE_NAME}{suffix}"));
                if from.exists() {
                    let _ = std::fs::rename(
                        &from,
                        user_data_path.join(format!("{DATABASE_FILE_NAME}{suffix}")),
                    );
                }
            }
            target
        }
        Err(_) => legacy, // 改不动就继续用旧文件名，保证老用户还能打开自己的库
    }
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn index_exists(conn: &Connection, index: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
        [index],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn table_columns(conn: &Connection, table: &str) -> Vec<(String, i64)> {
    // PRAGMA 不能参数化；表名由本文件字面量提供，无注入面。
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = match conn.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
        })
        .expect("PRAGMA table_info query");
    rows.filter_map(|r| r.ok()).collect()
}

fn account_columns(conn: &Connection) -> std::collections::HashSet<String> {
    if !table_exists(conn, "accounts") {
        return Default::default();
    }
    table_columns(conn, "accounts")
        .into_iter()
        .map(|(n, _)| n)
        .collect()
}

fn add_account_column_if_missing(
    conn: &Connection,
    name: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    if !account_columns(conn).contains(name) {
        conn.execute_batch(&format!(
            "ALTER TABLE accounts ADD COLUMN {name} {definition}"
        ))?;
    }
    Ok(())
}

fn assert_tables(conn: &Connection, tables: &[&str]) -> Result<(), String> {
    for t in tables {
        if !table_exists(conn, t) {
            return Err(format!(
                "Database migration verification failed: missing table {t}"
            ));
        }
    }
    Ok(())
}

fn assert_account_columns(conn: &Connection, cols: &[&str]) -> Result<(), String> {
    let set = account_columns(conn);
    for c in cols {
        if !set.contains(*c) {
            return Err(format!(
                "Database migration verification failed: missing accounts.{c}"
            ));
        }
    }
    Ok(())
}

fn assert_table_columns(conn: &Connection, table: &str, cols: &[&str]) -> Result<(), String> {
    let set: std::collections::HashSet<String> = table_columns(conn, table)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    for c in cols {
        if !set.contains(*c) {
            return Err(format!(
                "Database migration verification failed: missing {table}.{c}"
            ));
        }
    }
    Ok(())
}

fn assert_primary_key(conn: &Connection, table: &str, expected: &[&str]) -> Result<(), String> {
    let mut pk: Vec<(String, i64)> = table_columns(conn, table)
        .into_iter()
        .filter(|(_, pk)| *pk > 0)
        .collect::<Vec<_>>();
    pk.sort_by_key(|(_, pk)| *pk);
    let pk: Vec<String> = pk.into_iter().map(|(n, _)| n).collect();
    let expected: Vec<&str> = expected.to_vec();
    if pk.iter().map(String::as_str).ne(expected.iter().copied()) {
        return Err(format!(
            "Database migration verification failed: invalid primary key for {table}"
        ));
    }
    Ok(())
}

fn assert_indexes(conn: &Connection, indexes: &[&str]) -> Result<(), String> {
    for i in indexes {
        if !index_exists(conn, i) {
            return Err(format!(
                "Database migration verification failed: missing index {i}"
            ));
        }
    }
    Ok(())
}

const BASE_ACCOUNT_COLUMNS: [&str; 15] = [
    "id",
    "email",
    "client_id",
    "encrypted_refresh_token",
    "remark",
    "group_name",
    "status",
    "last_checked_at",
    "last_error",
    "last_refreshed_at",
    "last_inbox_count",
    "last_mail_at",
    "last_mail_cursor",
    "created_at",
    "updated_at",
];

fn verify_schema_for_version(
    conn: &Connection,
    version: i64,
    allow_missing_legacy_token_cache: bool,
) -> Result<(), String> {
    assert_tables(
        conn,
        &[
            "accounts",
            "mail_cache_meta",
            "mail_messages",
            "mail_details",
            "schema_migrations",
        ],
    )?;
    assert_account_columns(conn, &BASE_ACCOUNT_COLUMNS)?;
    assert_table_columns(
        conn,
        "mail_cache_meta",
        &["account_id", "next_cursor", "updated_at"],
    )?;
    assert_table_columns(
        conn,
        "mail_messages",
        &[
            "account_id",
            "message_id",
            "subject",
            "from_name",
            "from_address",
            "received_date_time",
            "sent_date_time",
            "is_read",
            "importance",
            "has_attachments",
            "body_preview",
            "web_link",
            "updated_at",
        ],
    )?;
    assert_table_columns(
        conn,
        "mail_details",
        &["account_id", "message_id", "detail_json", "updated_at"],
    )?;
    assert_table_columns(conn, "schema_migrations", &["id", "version", "updated_at"])?;
    assert_primary_key(conn, "accounts", &["id"])?;
    assert_primary_key(conn, "schema_migrations", &["id"])?;
    assert_indexes(
        conn,
        &[
            "idx_accounts_email",
            "idx_accounts_status",
            "idx_accounts_group_name",
        ],
    )?;

    if version <= 5 {
        assert_primary_key(conn, "mail_cache_meta", &["account_id"])?;
        assert_primary_key(conn, "mail_messages", &["account_id", "message_id"])?;
        assert_primary_key(conn, "mail_details", &["account_id", "message_id"])?;
        assert_indexes(
            conn,
            &[
                "idx_mail_messages_account_updated",
                "idx_mail_messages_account_received",
            ],
        )?;
    }
    if version >= 2 {
        assert_account_columns(conn, &["inbox_folder_id", "refresh_cooldown_until"])?;
    }
    if version >= 3 {
        assert_account_columns(conn, &["graph_delta_link"])?;
    }
    if version == 4 {
        if table_exists(conn, "access_token_cache") {
            assert_table_columns(
                conn,
                "access_token_cache",
                &[
                    "account_id",
                    "encrypted_access_token",
                    "expires_at",
                    "scope",
                    "auth_mode",
                    "updated_at",
                ],
            )?;
            assert_primary_key(conn, "access_token_cache", &["account_id"])?;
        } else if !allow_missing_legacy_token_cache {
            return Err(
                "Database migration verification failed: missing table access_token_cache".into(),
            );
        }
    }
    if version >= 5 {
        assert_account_columns(conn, &["credential_generation"])?;
        if table_exists(conn, "access_token_cache") {
            return Err(
                "Database migration verification failed: access_token_cache still exists".into(),
            );
        }
    }
    if version >= 6 {
        assert_table_columns(
            conn,
            "mail_cache_meta",
            &["account_id", "folder_id", "next_cursor", "updated_at"],
        )?;
        assert_table_columns(
            conn,
            "mail_messages",
            &["account_id", "folder_id", "message_id"],
        )?;
        assert_table_columns(
            conn,
            "mail_details",
            &["account_id", "folder_id", "message_id"],
        )?;
        assert_primary_key(conn, "mail_cache_meta", &["account_id", "folder_id"])?;
        assert_primary_key(
            conn,
            "mail_messages",
            &["account_id", "folder_id", "message_id"],
        )?;
        assert_primary_key(
            conn,
            "mail_details",
            &["account_id", "folder_id", "message_id"],
        )?;
    }
    Ok(())
}

pub fn read_schema_version(conn: &Connection) -> Result<i64, String> {
    if !table_exists(conn, "schema_migrations") {
        return Ok(0);
    }
    let version: Option<i64> = conn
        .query_row(
            "SELECT version FROM schema_migrations WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })?;
    let version = version.unwrap_or(0);
    if version < 0 {
        return Err(format!("Invalid database schema version: {version}"));
    }
    Ok(version)
}

fn write_schema_version(conn: &Connection, version: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO schema_migrations (id, version, updated_at) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at",
        rusqlite::params![version, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

fn up_v1(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          client_id TEXT NOT NULL,
          encrypted_refresh_token TEXT NOT NULL,
          remark TEXT NOT NULL DEFAULT '',
          group_name TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'untested',
          last_checked_at TEXT,
          last_error TEXT,
          last_refreshed_at TEXT,
          last_inbox_count INTEGER NOT NULL DEFAULT 0,
          last_mail_at TEXT,
          last_mail_cursor TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
        CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
        CREATE INDEX IF NOT EXISTS idx_accounts_group_name ON accounts(group_name);

        CREATE TABLE IF NOT EXISTS mail_cache_meta (
          account_id TEXT PRIMARY KEY,
          next_cursor TEXT,
          updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS mail_messages (
          account_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          subject TEXT NOT NULL,
          from_name TEXT,
          from_address TEXT,
          received_date_time TEXT,
          sent_date_time TEXT,
          is_read INTEGER NOT NULL DEFAULT 0,
          importance TEXT NOT NULL DEFAULT 'normal',
          has_attachments INTEGER NOT NULL DEFAULT 0,
          body_preview TEXT,
          web_link TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account_id, message_id)
        );

        CREATE INDEX IF NOT EXISTS idx_mail_messages_account_updated ON mail_messages(account_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_mail_messages_account_received ON mail_messages(account_id, received_date_time);

        CREATE TABLE IF NOT EXISTS mail_details (
          account_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account_id, message_id)
        );

        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        "#,
    )
}

fn up_v2(conn: &Connection) -> rusqlite::Result<()> {
    add_account_column_if_missing(conn, "inbox_folder_id", "TEXT")?;
    add_account_column_if_missing(conn, "refresh_cooldown_until", "TEXT")?;
    Ok(())
}

fn up_v3(conn: &Connection) -> rusqlite::Result<()> {
    add_account_column_if_missing(conn, "graph_delta_link", "TEXT")?;
    Ok(())
}

fn up_v4(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS access_token_cache (
          account_id TEXT PRIMARY KEY,
          encrypted_access_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL DEFAULT '',
          auth_mode TEXT NOT NULL DEFAULT 'graph',
          updated_at TEXT NOT NULL
        );
        "#,
    )
}

fn up_v5(conn: &Connection) -> rusqlite::Result<()> {
    add_account_column_if_missing(conn, "inbox_folder_id", "TEXT")?;
    add_account_column_if_missing(conn, "graph_delta_link", "TEXT")?;
    add_account_column_if_missing(conn, "refresh_cooldown_until", "TEXT")?;
    add_account_column_if_missing(conn, "credential_generation", "INTEGER NOT NULL DEFAULT 0")?;
    conn.execute_batch("DROP TABLE IF EXISTS access_token_cache;")
}

/// v6：邮件缓存加 folder 维度。SQLite 不能修改主键，需重建表后回填。
/// 旧数据全部归入 'INBOX'：历史缓存只可能来自收件箱读取路径。
fn up_v6(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE mail_cache_meta_v6 (
          account_id TEXT NOT NULL,
          folder_id TEXT NOT NULL DEFAULT 'INBOX',
          next_cursor TEXT,
          updated_at TEXT,
          PRIMARY KEY (account_id, folder_id)
        );
        INSERT INTO mail_cache_meta_v6 (account_id, folder_id, next_cursor, updated_at)
          SELECT account_id, 'INBOX', next_cursor, updated_at FROM mail_cache_meta;
        DROP TABLE mail_cache_meta;
        ALTER TABLE mail_cache_meta_v6 RENAME TO mail_cache_meta;

        CREATE TABLE mail_messages_v6 (
          account_id TEXT NOT NULL,
          folder_id TEXT NOT NULL DEFAULT 'INBOX',
          message_id TEXT NOT NULL,
          subject TEXT NOT NULL,
          from_name TEXT,
          from_address TEXT,
          received_date_time TEXT,
          sent_date_time TEXT,
          is_read INTEGER NOT NULL DEFAULT 0,
          importance TEXT NOT NULL DEFAULT 'normal',
          has_attachments INTEGER NOT NULL DEFAULT 0,
          body_preview TEXT,
          web_link TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account_id, folder_id, message_id)
        );
        INSERT INTO mail_messages_v6 (
          account_id, folder_id, message_id, subject, from_name, from_address,
          received_date_time, sent_date_time, is_read, importance,
          has_attachments, body_preview, web_link, updated_at
        )
          SELECT account_id, 'INBOX', message_id, subject, from_name, from_address,
          received_date_time, sent_date_time, is_read, importance,
          has_attachments, body_preview, web_link, updated_at FROM mail_messages;
        DROP TABLE mail_messages;
        ALTER TABLE mail_messages_v6 RENAME TO mail_messages;
        CREATE INDEX IF NOT EXISTS idx_mail_messages_account_updated
          ON mail_messages(account_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_mail_messages_account_received
          ON mail_messages(account_id, received_date_time);

        CREATE TABLE mail_details_v6 (
          account_id TEXT NOT NULL,
          folder_id TEXT NOT NULL DEFAULT 'INBOX',
          message_id TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account_id, folder_id, message_id)
        );
        INSERT INTO mail_details_v6 (account_id, folder_id, message_id, detail_json, updated_at)
          SELECT account_id, 'INBOX', message_id, detail_json, updated_at FROM mail_details;
        DROP TABLE mail_details;
        ALTER TABLE mail_details_v6 RENAME TO mail_details;
        "#,
    )
}

/// 逐版本迁移（applyDatabaseMigrations 移植）。错误统一为 String。
pub fn apply_database_migrations(conn: &mut Connection) -> Result<i64, String> {
    let mut current = read_schema_version(conn)?;
    let latest = CURRENT_SCHEMA_VERSION;
    if current > latest {
        return Err(format!(
            "Database schema version {current} is newer than the supported version {latest}"
        ));
    }
    if current == latest {
        verify_schema_for_version(conn, current, false)?;
        return Ok(current);
    }

    // 迁移前 VACUUM INTO 备份（database.ts createMigrationBackup）。
    let backup = make_migration_backup(conn)?;

    let expected_from = current;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut run = |tx: &rusqlite::Transaction| -> Result<i64, String> {
        let mut expected = current + 1;
        while expected <= latest {
            match expected {
                1 => up_v1(tx).map_err(|e| e.to_string())?,
                2 => up_v2(tx).map_err(|e| e.to_string())?,
                3 => up_v3(tx).map_err(|e| e.to_string())?,
                4 => up_v4(tx).map_err(|e| e.to_string())?,
                5 => up_v5(tx).map_err(|e| e.to_string())?,
                6 => up_v6(tx).map_err(|e| e.to_string())?,
                v => return Err(format!("Database migration {v} is missing")),
            }
            verify_schema_for_version(tx, expected, false)?;
            write_schema_version(tx, expected).map_err(|e| e.to_string())?;
            current = expected;
            expected += 1;
        }
        Ok(current)
    };
    match run(&tx) {
        Ok(version) => {
            tx.commit().map_err(|e| e.to_string())?;
            Ok(version)
        }
        Err(e) => Err(format!(
            "{e}; backup at {backup}; start version {expected_from}"
        )),
    }
}

fn make_migration_backup(conn: &Connection) -> Result<String, String> {
    let dir = std::env::temp_dir().join("maildeck-backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let backup_path = dir.join(format!(
        "{}.pre-v{CURRENT_SCHEMA_VERSION}.{}.db.bak",
        DATABASE_FILE_NAME,
        uuid::Uuid::new_v4(),
    ));
    let backup_path = backup_path.display().to_string();
    conn.execute("VACUUM INTO ?1", rusqlite::params![backup_path])
        .map_err(|e| e.to_string())?;
    Ok(backup_path)
}

/// 打开数据库：PRAGMA 与原版一致（busy_timeout 5000 / foreign_keys ON），并跑迁移。
/// 返回 (连接, 迁移备份路径)。
pub fn open_database(path: &Path) -> Result<(Connection, Option<String>), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create userData dir failed: {e}"))?;
    }
    let mut conn = Connection::open(path).map_err(|e| format!("open database failed: {e}"))?;
    conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    let version_before = read_schema_version(&conn)?;
    let backup = (version_before > 0 && version_before < CURRENT_SCHEMA_VERSION)
        .then(|| make_migration_backup(&conn).ok())
        .flatten();
    let _version = apply_database_migrations(&mut conn)?;
    Ok((conn, backup))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh_db() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let conn = Connection::open(dir.path().join("test.db")).unwrap();
        conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")
            .unwrap();
        (dir, conn)
    }

    #[test]
    fn fresh_db_migrates_to_v6_and_verifies() {
        let (_dir, mut conn) = fresh_db();
        let v = apply_database_migrations(&mut conn).unwrap();
        assert_eq!(v, 6);
        assert_eq!(read_schema_version(&conn).unwrap(), 6);
        // 幂等：再跑一遍仍是 6
        let v2 = apply_database_migrations(&mut conn).unwrap();
        assert_eq!(v2, 6);
    }

    #[test]
    fn v5_database_migrates_to_v6_backfills_inbox() {
        let (_dir, mut conn) = fresh_db();
        // 手动建 v5 schema
        conn.execute_batch(
            r#"
            CREATE TABLE accounts (
              id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
              encrypted_refresh_token TEXT NOT NULL, remark TEXT NOT NULL DEFAULT '',
              group_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'untested',
              last_checked_at TEXT, last_error TEXT, last_refreshed_at TEXT,
              last_inbox_count INTEGER NOT NULL DEFAULT 0, last_mail_at TEXT, last_mail_cursor TEXT,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              inbox_folder_id TEXT, refresh_cooldown_until TEXT, graph_delta_link TEXT,
              credential_generation INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_accounts_email ON accounts(email);
            CREATE INDEX idx_accounts_status ON accounts(status);
            CREATE INDEX idx_accounts_group_name ON accounts(group_name);
            CREATE TABLE mail_cache_meta (account_id TEXT PRIMARY KEY, next_cursor TEXT, updated_at TEXT);
            CREATE TABLE mail_messages (
              account_id TEXT NOT NULL, message_id TEXT NOT NULL, subject TEXT NOT NULL,
              from_name TEXT, from_address TEXT, received_date_time TEXT, sent_date_time TEXT,
              is_read INTEGER NOT NULL DEFAULT 0, importance TEXT NOT NULL DEFAULT 'normal',
              has_attachments INTEGER NOT NULL DEFAULT 0, body_preview TEXT, web_link TEXT,
              updated_at TEXT NOT NULL, PRIMARY KEY (account_id, message_id)
            );
            CREATE INDEX idx_mail_messages_account_updated ON mail_messages(account_id, updated_at);
            CREATE INDEX idx_mail_messages_account_received ON mail_messages(account_id, received_date_time);
            CREATE TABLE mail_details (
              account_id TEXT NOT NULL, message_id TEXT NOT NULL, detail_json TEXT NOT NULL,
              updated_at TEXT NOT NULL, PRIMARY KEY (account_id, message_id)
            );
            CREATE TABLE schema_migrations (
              id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, updated_at TEXT NOT NULL
            );
            INSERT INTO schema_migrations VALUES (1, 5, '2024-01-01T00:00:00Z');
            INSERT INTO accounts (id, email, client_id, encrypted_refresh_token, created_at, updated_at)
              VALUES ('a1', 'x@y.com', 'cid', 'enc', '2024-01-01', '2024-01-01');
            INSERT INTO mail_cache_meta VALUES ('a1', 'cursor-1', '2024-01-01');
            INSERT INTO mail_messages (account_id, message_id, subject, updated_at) VALUES ('a1', 'm1', 'hello', '2024-01-01');
            INSERT INTO mail_details VALUES ('a1', 'm1', '{}', '2024-01-01');
            "#,
        )
        .unwrap();
        let v = apply_database_migrations(&mut conn).unwrap();
        assert_eq!(v, 6);
        // 回填到 INBOX
        let (aid, folder): (String, String) = conn
            .query_row(
                "SELECT account_id, folder_id FROM mail_messages LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((aid.as_str(), folder.as_str()), ("a1", "INBOX"));
        let cursor: Option<String> = conn
            .query_row("SELECT next_cursor FROM mail_cache_meta WHERE account_id='a1' AND folder_id='INBOX'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cursor.as_deref(), Some("cursor-1"));
    }

    #[test]
    fn newer_schema_is_rejected() {
        let (_dir, mut conn) = fresh_db();
        up_v1(&conn).unwrap();
        up_v2(&conn).unwrap();
        up_v3(&conn).unwrap();
        up_v5(&conn).unwrap();
        up_v6(&conn).unwrap();
        write_schema_version(&conn, 7).unwrap();
        let err = apply_database_migrations(&mut conn).unwrap_err();
        assert!(err.contains("newer than the supported version"), "{err}");
    }

    #[test]
    fn resolve_database_file_renames_legacy_with_sidecars() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("outlook-manager.db"), "x").unwrap();
        std::fs::write(dir.path().join("outlook-manager.db-wal"), "w").unwrap();
        let target = resolve_database_file_path(dir.path());
        assert_eq!(target.file_name().unwrap(), "maildeck.db");
        assert!(target.exists());
        assert!(dir.path().join("maildeck.db-wal").exists());
    }
}

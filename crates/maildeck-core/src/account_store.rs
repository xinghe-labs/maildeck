//! 账号 CRUD（对应原 account-store.ts，含 v6 字段与 credential_generation）。

use crate::contracts::{AccountRecord, AccountStatus};
use crate::db;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct AccountStore {
    conn: Mutex<Connection>,
}

fn row_to_account(row: &rusqlite::Row<'_>) -> rusqlite::Result<AccountRecord> {
    Ok(AccountRecord {
        id: row.get("id")?,
        email: row.get("email")?,
        client_id: row.get("client_id")?,
        encrypted_refresh_token: row.get("encrypted_refresh_token")?,
        remark: row.get("remark")?,
        group_name: row.get("group_name")?,
        status: AccountStatus::from(row.get::<_, String>("status")?.as_str()),
        last_checked_at: row.get("last_checked_at")?,
        last_error: row.get("last_error")?,
        last_refreshed_at: row.get("last_refreshed_at")?,
        last_inbox_count: row.get("last_inbox_count")?,
        last_mail_at: row.get("last_mail_at")?,
        inbox_folder_id: row.get("inbox_folder_id")?,
        graph_delta_link: row.get("graph_delta_link")?,
        refresh_cooldown_until: row.get("refresh_cooldown_until")?,
        credential_generation: row.get("credential_generation")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl AccountStore {
    pub fn open(user_data: Option<PathBuf>) -> Result<Self, String> {
        let dir = user_data.unwrap_or_else(db::user_data_path);
        let path = db::resolve_database_file_path(&dir);
        let (conn, backup) = db::open_database(&path)?;
        if let Some(b) = backup {
            eprintln!("[maildeck] migration backup: {b}");
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_at(path: &Path) -> Result<Self, String> {
        let (conn, backup) = db::open_database(path)?;
        if let Some(b) = backup {
            eprintln!("[maildeck] migration backup: {b}");
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list(&self) -> Result<Vec<AccountRecord>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT * FROM accounts ORDER BY created_at ASC, email ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], row_to_account)
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
    }

    pub fn get(&self, id: &str) -> Result<Option<AccountRecord>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT * FROM accounts WHERE id = ?1", [id], row_to_account)
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other.to_string()),
            })
    }

    pub fn get_by_email(&self, email: &str) -> Result<Option<AccountRecord>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT * FROM accounts WHERE email = ?1",
            [email],
            row_to_account,
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
    }

    pub fn insert(&self, record: &AccountRecord) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO accounts (id, email, client_id, encrypted_refresh_token, remark, group_name, status, last_checked_at, last_error, last_refreshed_at, last_inbox_count, last_mail_at, inbox_folder_id, graph_delta_link, refresh_cooldown_until, credential_generation, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            rusqlite::params![
                record.id,
                record.email,
                record.client_id,
                record.encrypted_refresh_token,
                record.remark,
                record.group_name,
                record.status.as_str(),
                record.last_checked_at,
                record.last_error,
                record.last_refreshed_at,
                record.last_inbox_count,
                record.last_mail_at,
                record.inbox_folder_id,
                record.graph_delta_link,
                record.refresh_cooldown_until,
                record.credential_generation,
                record.created_at,
                record.updated_at,
            ],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    pub fn update(&self, record: &AccountRecord) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET email=?2, client_id=?3, encrypted_refresh_token=?4, remark=?5, group_name=?6, status=?7, last_checked_at=?8, last_error=?9, last_refreshed_at=?10, last_inbox_count=?11, last_mail_at=?12, inbox_folder_id=?13, graph_delta_link=?14, refresh_cooldown_until=?15, credential_generation=?16, updated_at=?17 WHERE id=?1",
            rusqlite::params![
                record.id,
                record.email,
                record.client_id,
                record.encrypted_refresh_token,
                record.remark,
                record.group_name,
                record.status.as_str(),
                record.last_checked_at,
                record.last_error,
                record.last_refreshed_at,
                record.last_inbox_count,
                record.last_mail_at,
                record.inbox_folder_id,
                record.graph_delta_link,
                record.refresh_cooldown_until,
                record.credential_generation,
                record.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM accounts WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_status(
        &self,
        id: &str,
        status: AccountStatus,
        last_error: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET status=?2, last_error=?3, last_checked_at=?4, updated_at=?4 WHERE id=?1",
            rusqlite::params![id, status.as_str(), last_error, now_iso()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 刷新成功回写（refresh-state.applyRefreshSuccess）。
    pub fn apply_refresh_success(
        &self,
        id: &str,
        inbox_count: i64,
        latest_mail_at: Option<&str>,
        now: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET status='valid', last_error=NULL, last_refreshed_at=?2, last_checked_at=?2, last_inbox_count=?3, last_mail_at=?4, refresh_cooldown_until=NULL, updated_at=?2 WHERE id=?1",
            rusqlite::params![id, now, inbox_count, latest_mail_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 刷新失败回写（refresh-state.applyRefreshFailure）。
    pub fn apply_refresh_failure(
        &self,
        id: &str,
        error: &str,
        now: &str,
        cooldown_until: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET status='invalid', last_error=?2, last_checked_at=?3, refresh_cooldown_until=?4, updated_at=?3 WHERE id=?1",
            rusqlite::params![id, error, now, cooldown_until],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// token 代际升级（登录/换发后落新代）。
    pub fn bump_credential_generation(
        &self,
        id: &str,
        generation: i64,
        encrypted_token: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET credential_generation=?2, encrypted_refresh_token=?3, updated_at=?4 WHERE id=?1",
            rusqlite::params![id, generation, encrypted_token, now_iso()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_login_fields(
        &self,
        id: &str,
        email: &str,
        client_id: &str,
        encrypted_token: &str,
        generation: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET email=?2, client_id=?3, encrypted_refresh_token=?4, credential_generation=?5, status='valid', last_error=NULL, updated_at=?6 WHERE id=?1",
            rusqlite::params![id, email, client_id, encrypted_token, generation, now_iso()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_graph_delta_link(&self, id: &str, link: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET graph_delta_link=?2, updated_at=?3 WHERE id=?1",
            rusqlite::params![id, link, now_iso()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_inbox_folder_id(&self, id: &str, folder_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET inbox_folder_id=?2, updated_at=?3 WHERE id=?1",
            rusqlite::params![id, folder_id, now_iso()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 供 IPC 层取互斥连接做批量导入等复杂事务。
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        f(&conn)
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

trait Pipe {
    fn pipe(
        self,
        f: impl FnOnce(Vec<AccountRecord>) -> Result<Vec<AccountRecord>, String>,
    ) -> Result<Vec<AccountRecord>, String>;
}
impl Pipe for Vec<AccountRecord> {
    fn pipe(
        self,
        f: impl FnOnce(Vec<AccountRecord>) -> Result<Vec<AccountRecord>, String>,
    ) -> Result<Vec<AccountRecord>, String> {
        f(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::AccountStatus;
    use crate::credentials::CredentialGeneration;

    fn sample(id: &str, email: &str) -> AccountRecord {
        AccountRecord {
            id: id.into(),
            email: email.into(),
            client_id: "client-1".into(),
            encrypted_refresh_token: "enc".into(),
            remark: "".into(),
            group_name: "g".into(),
            status: AccountStatus::Untested,
            last_checked_at: None,
            last_error: None,
            last_refreshed_at: None,
            last_inbox_count: 0,
            last_mail_at: None,
            inbox_folder_id: None,
            graph_delta_link: None,
            refresh_cooldown_until: None,
            credential_generation: CredentialGeneration::Dpapi.as_i64(),
            created_at: "2024-01-01T00:00:00.000Z".into(),
            updated_at: "2024-01-01T00:00:00.000Z".into(),
        }
    }

    fn temp_store() -> (tempfile::TempDir, AccountStore) {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AccountStore::open_at(&dir.path().join("test.db")).unwrap();
        (dir, store)
    }

    #[test]
    fn crud_roundtrip() {
        let (_dir, store) = temp_store();
        let a = sample("a1", "one@x.com");
        store.insert(&a).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        let got = store.get("a1").unwrap().unwrap();
        assert_eq!(got.email, "one@x.com");
        assert_eq!(got.status, AccountStatus::Untested);
        assert_eq!(got.credential_generation, 1);

        let mut b = sample("a2", "two@x.com");
        b.group_name = "g2".into();
        store.insert(&b).unwrap();
        let by_email = store.get_by_email("two@x.com").unwrap().unwrap();
        assert_eq!(by_email.id, "a2");

        let mut a_upd = store.get("a1").unwrap().unwrap();
        a_upd.remark = "changed".into();
        a_upd.status = AccountStatus::Valid;
        store.update(&a_upd).unwrap();
        assert_eq!(store.get("a1").unwrap().unwrap().remark, "changed");
        assert_eq!(
            store.get("a1").unwrap().unwrap().status,
            AccountStatus::Valid
        );

        store.delete("a2").unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn refresh_success_and_failure_writes() {
        let (_dir, store) = temp_store();
        store.insert(&sample("a1", "one@x.com")).unwrap();
        store
            .apply_refresh_success("a1", 42, Some("2024-05-01"), "2024-05-02")
            .unwrap();
        let a = store.get("a1").unwrap().unwrap();
        assert_eq!(a.status, AccountStatus::Valid);
        assert_eq!(a.last_inbox_count, 42);
        assert!(a.refresh_cooldown_until.is_none());

        store
            .apply_refresh_failure("a1", "boom", "2024-05-03", Some("2024-05-04"))
            .unwrap();
        let a = store.get("a1").unwrap().unwrap();
        assert_eq!(a.status, AccountStatus::Invalid);
        assert_eq!(a.last_error.as_deref(), Some("boom"));
        assert_eq!(a.refresh_cooldown_until.as_deref(), Some("2024-05-04"));
    }

    #[test]
    fn dup_email_rejected() {
        let (_dir, store) = temp_store();
        store.insert(&sample("a1", "dup@x.com")).unwrap();
        assert!(store.insert(&sample("a2", "dup@x.com")).is_err());
    }
}

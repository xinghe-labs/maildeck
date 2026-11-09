//! 邮件缓存读写（对应原 mail-cache.ts，v6 加 folder 维度）。

use crate::account_store::now_iso;
use crate::contracts::{MailDetail, MailListItem};
use rusqlite::Connection;

const DEFAULT_FOLDER: &str = "INBOX";

pub fn read_mail_list(
    conn: &Connection,
    account_id: &str,
    folder_id: &str,
    page: i64,
    page_size: i64,
) -> Result<(Vec<MailListItem>, i64), String> {
    let folder = if folder_id.is_empty() {
        DEFAULT_FOLDER
    } else {
        folder_id
    };
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mail_messages WHERE account_id=?1 AND folder_id=?2",
            rusqlite::params![account_id, folder],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if total == 0 {
        return Ok((Vec::new(), 0));
    }
    let page = page.max(1);
    let page_size = page_size.clamp(1, 200);
    let offset = (page - 1) * page_size;
    let mut stmt = conn
        .prepare(
            "SELECT * FROM mail_messages WHERE account_id=?1 AND folder_id=?2
             ORDER BY received_date_time DESC LIMIT ?3 OFFSET ?4",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params![account_id, folder, page_size, offset],
            |row| {
                Ok(MailListItem {
                    id: row.get("message_id")?,
                    subject: row.get("subject")?,
                    from: {
                        let name: Option<String> = row.get("from_name")?;
                        let address: Option<String> = row.get("from_address")?;
                        if name.is_none() && address.is_none() {
                            None
                        } else {
                            Some(crate::contracts::MailRecipient { name, address })
                        }
                    },
                    received_date_time: row.get("received_date_time")?,
                    sent_date_time: row.get("sent_date_time")?,
                    is_read: row.get::<_, i64>("is_read")? != 0,
                    importance: row.get("importance")?,
                    has_attachments: row.get::<_, i64>("has_attachments")? != 0,
                    body_preview: row.get("body_preview")?,
                    web_link: row.get("web_link")?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let items: Vec<MailListItem> = rows.filter_map(|r| r.ok()).collect();
    Ok((items, total))
}

pub fn read_mail_detail(
    conn: &Connection,
    account_id: &str,
    folder_id: &str,
    message_id: &str,
) -> Result<Option<MailDetail>, String> {
    let folder = if folder_id.is_empty() {
        DEFAULT_FOLDER
    } else {
        folder_id
    };
    let json: Option<String> = conn
        .query_row(
            "SELECT detail_json FROM mail_details WHERE account_id=?1 AND folder_id=?2 AND message_id=?3",
            rusqlite::params![account_id, folder, message_id],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })?;
    json.map(|s| parse_detail_json(&s)).transpose()
}

/// 详情 JSON 信封（原版 mail-cache.ts v2 格式：{"version":2,"detail":{…}}）。
#[derive(serde::Serialize, serde::Deserialize)]
struct CacheDetailEnvelope {
    #[allow(dead_code)]
    version: i64,
    detail: MailDetail,
}

/// 详情 JSON 序列化（带 v2 信封，与原版缓存格式字节兼容）。
fn serialize_detail(detail: &MailDetail) -> Result<String, String> {
    serde_json::to_string(&CacheDetailEnvelope {
        version: 2,
        detail: detail.clone(),
    })
    .map_err(|e| e.to_string())
}

/// 解析详情 JSON：兼容 v2 信封与裸 MailDetail 两种形态。
fn parse_detail_json(s: &str) -> Result<MailDetail, String> {
    if let Ok(envelope) = serde_json::from_str::<CacheDetailEnvelope>(s) {
        return Ok(envelope.detail);
    }
    serde_json::from_str::<MailDetail>(s).map_err(|e| e.to_string())
}

/// 列表 + 详情原子替换（replaceAccountMailCache）。同一事务内删旧插新。
pub fn replace_account_mail_cache(
    conn: &Connection,
    account_id: &str,
    folder_id: &str,
    items: &[MailListItem],
    details: &[(String, MailDetail)],
    next_cursor: Option<&str>,
) -> Result<(), String> {
    let folder = if folder_id.is_empty() {
        DEFAULT_FOLDER
    } else {
        folder_id
    };
    let now = now_iso();
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        conn.execute(
            "DELETE FROM mail_messages WHERE account_id=?1 AND folder_id=?2",
            rusqlite::params![account_id, folder],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM mail_details WHERE account_id=?1 AND folder_id=?2",
            rusqlite::params![account_id, folder],
        )
        .map_err(|e| e.to_string())?;
        {
            let mut stmt = conn
                .prepare(
                    "INSERT INTO mail_messages (account_id, folder_id, message_id, subject, from_name, from_address, received_date_time, sent_date_time, is_read, importance, has_attachments, body_preview, web_link, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                )
                .map_err(|e| e.to_string())?;
            for item in items {
                stmt.execute(rusqlite::params![
                    account_id,
                    folder,
                    item.id,
                    item.subject,
                    item.from.as_ref().and_then(|f| f.name.clone()),
                    item.from.as_ref().and_then(|f| f.address.clone()),
                    item.received_date_time,
                    item.sent_date_time,
                    item.is_read as i64,
                    item.importance,
                    item.has_attachments as i64,
                    item.body_preview,
                    item.web_link,
                    now,
                ])
                .map_err(|e| e.to_string())?;
            }
        }
        {
            let mut stmt = conn
                .prepare(
                    "INSERT INTO mail_details (account_id, folder_id, message_id, detail_json, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|e| e.to_string())?;
            for (id, detail) in details {
                stmt.execute(rusqlite::params![
                    account_id,
                    folder,
                    id,
                    serialize_detail(detail)?,
                    now,
                ])
                .map_err(|e| e.to_string())?;
            }
        }
        conn.execute(
            "INSERT INTO mail_cache_meta (account_id, folder_id, next_cursor, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_id, folder_id) DO UPDATE SET next_cursor=excluded.next_cursor, updated_at=excluded.updated_at",
            rusqlite::params![account_id, folder, next_cursor, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => conn
            .execute("COMMIT", [])
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(e)
        }
    }
}

/// 增量 upsert（upsertMailMessages），并返回被更新消息的最大 receivedDateTime。
pub fn upsert_mail_messages(
    conn: &Connection,
    account_id: &str,
    folder_id: &str,
    items: &[MailListItem],
) -> Result<Option<String>, String> {
    let folder = if folder_id.is_empty() {
        DEFAULT_FOLDER
    } else {
        folder_id
    };
    let now = now_iso();
    let mut latest: Option<String> = None;
    let mut stmt = conn
        .prepare(
            "INSERT INTO mail_messages (account_id, folder_id, message_id, subject, from_name, from_address, received_date_time, sent_date_time, is_read, importance, has_attachments, body_preview, web_link, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(account_id, folder_id, message_id) DO UPDATE SET
               subject=excluded.subject, from_name=excluded.from_name, from_address=excluded.from_address,
               received_date_time=excluded.received_date_time, sent_date_time=excluded.sent_date_time,
               is_read=excluded.is_read, importance=excluded.importance, has_attachments=excluded.has_attachments,
               body_preview=excluded.body_preview, web_link=excluded.web_link, updated_at=excluded.updated_at",
        )
        .map_err(|e| e.to_string())?;
    for item in items {
        stmt.execute(rusqlite::params![
            account_id,
            folder,
            item.id,
            item.subject,
            item.from.as_ref().and_then(|f| f.name.clone()),
            item.from.as_ref().and_then(|f| f.address.clone()),
            item.received_date_time,
            item.sent_date_time,
            item.is_read as i64,
            item.importance,
            item.has_attachments as i64,
            item.body_preview,
            item.web_link,
            now,
        ])
        .map_err(|e| e.to_string())?;
        if latest
            .as_deref()
            .is_none_or(|cur| item.received_date_time.as_deref().is_some_and(|v| v > cur))
        {
            latest = item.received_date_time.clone();
        }
    }
    Ok(latest)
}

pub fn upsert_mail_detail(
    conn: &Connection,
    account_id: &str,
    folder_id: &str,
    detail: &MailDetail,
) -> Result<(), String> {
    let folder = if folder_id.is_empty() {
        DEFAULT_FOLDER
    } else {
        folder_id
    };
    let now = now_iso();
    conn.execute(
        "INSERT INTO mail_details (account_id, folder_id, message_id, detail_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(account_id, folder_id, message_id) DO UPDATE SET detail_json=excluded.detail_json, updated_at=excluded.updated_at",
        rusqlite::params![
            account_id,
            folder,
            detail.id,
            serialize_detail(detail)?,
            now,
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn get_next_cursor(
    conn: &Connection,
    account_id: &str,
    folder_id: &str,
) -> Result<Option<String>, String> {
    let folder = if folder_id.is_empty() {
        DEFAULT_FOLDER
    } else {
        folder_id
    };
    conn.query_row(
        "SELECT next_cursor FROM mail_cache_meta WHERE account_id=?1 AND folder_id=?2",
        rusqlite::params![account_id, folder],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.to_string()),
    })
}

pub fn clear_mail_cache(conn: &Connection, account_id: &str) -> Result<(), String> {
    for table in ["mail_messages", "mail_details", "mail_cache_meta"] {
        conn.execute(
            &format!("DELETE FROM {table} WHERE account_id=?1"),
            [account_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 缓存统计（getMailCacheStats 移植）：计数 + 缓存文本实际字节数（不含 SQLite 页开销）。
pub fn get_mail_cache_stats(conn: &Connection) -> Result<crate::contracts::MailCacheStats, String> {
    let (message_count, message_bytes): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(subject)),0) + COALESCE(SUM(LENGTH(body_preview)),0) FROM mail_messages",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let (detail_count, detail_bytes): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(detail_json)),0) FROM mail_details",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let account_count: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT account_id) FROM mail_cache_meta",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(crate::contracts::MailCacheStats {
        account_count: account_count.max(0) as usize,
        message_count: message_count.max(0) as usize,
        body_count: detail_count.max(0) as usize,
        approximate_bytes: message_bytes + detail_bytes,
    })
}

/// 清空全部邮件缓存（clearAllMailCache 移植）。
pub fn clear_all_mail_cache(conn: &Connection) -> Result<(), String> {
    for table in ["mail_messages", "mail_details", "mail_cache_meta"] {
        conn.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 单条已读状态更新（markMessageRead 落缓存）。
pub fn set_message_read(
    conn: &Connection,
    account_id: &str,
    folder_id: &str,
    message_id: &str,
    is_read: bool,
) -> Result<(), String> {
    let folder = if folder_id.is_empty() {
        DEFAULT_FOLDER
    } else {
        folder_id
    };
    conn.execute(
        "UPDATE mail_messages SET is_read=?4, updated_at=?5 WHERE account_id=?1 AND folder_id=?2 AND message_id=?3",
        rusqlite::params![account_id, folder, message_id, is_read as i64, now_iso()],
    )
    .map_err(|e| e.to_string())?;
    // 详情 JSON 里的 isRead 一并同步
    let json: Option<String> = conn
        .query_row(
            "SELECT detail_json FROM mail_details WHERE account_id=?1 AND folder_id=?2 AND message_id=?3",
            rusqlite::params![account_id, folder, message_id],
            |r| r.get(0),
        )
        .ok();
    if let Some(json) = json {
        // 详情 JSON（可能带 v2 信封）里的 isRead 一并同步。
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&json) {
            if value.get("detail").is_some() {
                value["detail"]["isRead"] = serde_json::Value::Bool(is_read);
            } else {
                value["isRead"] = serde_json::Value::Bool(is_read);
            }
            let _ = conn.execute(
                "UPDATE mail_details SET detail_json=?4, updated_at=?5 WHERE account_id=?1 AND folder_id=?2 AND message_id=?3",
                rusqlite::params![account_id, folder, message_id, value.to_string(), now_iso()],
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::MailDetailBody;

    fn item(id: &str, received: &str, is_read: bool) -> MailListItem {
        MailListItem {
            id: id.into(),
            subject: format!("subject-{id}"),
            from: Some(crate::contracts::MailRecipient {
                name: Some("Sender".into()),
                address: Some("s@x.com".into()),
            }),
            received_date_time: Some(received.into()),
            sent_date_time: None,
            is_read,
            importance: "normal".into(),
            has_attachments: false,
            body_preview: Some("preview".into()),
            web_link: None,
        }
    }

    fn detail(id: &str) -> MailDetail {
        MailDetail {
            id: id.into(),
            subject: format!("subject-{id}"),
            body: MailDetailBody {
                content: "<p>hi</p>".into(),
                content_type: "html".into(),
            },
            from: crate::contracts::MailRecipient {
                name: Some("S".into()),
                address: Some("s@x.com".into()),
            },
            to_recipients: vec![],
            cc_recipients: vec![],
            received_date_time: Some("2024-05-01T00:00:00Z".into()),
            sent_date_time: None,
            is_read: false,
            has_attachments: false,
            attachments: vec![],
            conversation_id: None,
            web_link: None,
            importance: "normal".into(),
            flag: crate::contracts::MailFlag {
                flag_status: "notFlagged".into(),
            },
        }
    }

    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::apply_database_migrations(&mut conn).unwrap();
        conn
    }

    #[test]
    fn replace_and_read() {
        let conn = setup();
        let items = vec![
            item("m1", "2024-05-02", false),
            item("m2", "2024-05-01", true),
        ];
        let details = vec![
            ("m1".to_string(), detail("m1")),
            ("m2".to_string(), detail("m2")),
        ];
        replace_account_mail_cache(&conn, "a1", "INBOX", &items, &details, Some("cursor-9"))
            .unwrap();

        let (list, total) = read_mail_list(&conn, "a1", "INBOX", 1, 25).unwrap();
        assert_eq!(total, 2);
        // 按 receivedDateTime DESC
        assert_eq!(list[0].id, "m1");
        assert!(!list[0].is_read);
        assert!(list[1].is_read);

        let d = read_mail_detail(&conn, "a1", "INBOX", "m1")
            .unwrap()
            .unwrap();
        assert_eq!(d.body.content, "<p>hi</p>");
        assert_eq!(
            get_next_cursor(&conn, "a1", "INBOX").unwrap().as_deref(),
            Some("cursor-9")
        );
    }

    #[test]
    fn parses_legacy_v2_envelope_with_missing_fields() {
        // 原版 Electron 写入的真实缓存形态：v2 信封 + 内层缺 attachments/flag、toRecipients 为 null。
        let json = r#"{"version":2,"detail":{"id":"366","subject":"验证邮箱以注册Qoder",
            "from":{"name":"","address":"no-reply@qoder.com"},
            "receivedDateTime":"2026-11-01T04:43:50.000Z","sentDateTime":"2026-11-01T04:43:43.000Z",
            "isRead":false,"importance":"normal","hasAttachments":false,"bodyPreview":"",
            "webLink":null,"toRecipients":null,"ccRecipients":null,
            "body":{"contentType":"html","content":"<html><body>hi</body></html>"}}}"#;
        let detail = parse_detail_json(json).expect("legacy envelope must parse");
        assert_eq!(detail.id, "366");
        assert_eq!(detail.from.address.as_deref(), Some("no-reply@qoder.com"));
        assert!(detail.attachments.is_empty());
        assert_eq!(detail.flag.flag_status, "");
        assert_eq!(detail.to_recipients.len(), 0);
    }

    #[test]
    fn parses_bare_detail_json() {
        let json = r#"{"id":"1","subject":"s","body":{"contentType":"text","content":"c"},
            "from":{"name":"n","address":"a@x.com"},"toRecipients":[],"ccRecipients":[],
            "isRead":true,"importance":"normal","hasAttachments":false,"attachments":[],
            "flag":{"flagStatus":"notFlagged"}}"#;
        let detail = parse_detail_json(json).unwrap();
        assert_eq!(detail.id, "1");
        assert_eq!(detail.flag.flag_status, "notFlagged");
    }

    #[test]
    fn upsert_updates_and_returns_latest() {
        let conn = setup();
        upsert_mail_messages(&conn, "a1", "INBOX", &[item("m1", "2024-05-02", false)]).unwrap();
        let latest = upsert_mail_messages(
            &conn,
            "a1",
            "INBOX",
            &[
                item("m2", "2024-05-05", false),
                item("m1", "2024-05-02", true), // 已读更新
            ],
        )
        .unwrap();
        assert_eq!(latest.as_deref(), Some("2024-05-05"));
        let (_, total) = read_mail_list(&conn, "a1", "INBOX", 1, 25).unwrap();
        assert_eq!(total, 2);
        let (list, _) = read_mail_list(&conn, "a1", "INBOX", 1, 25).unwrap();
        let m1 = list.iter().find(|m| m.id == "m1").unwrap();
        assert!(m1.is_read);
    }

    #[test]
    fn folder_isolation_and_clear() {
        let conn = setup();
        replace_account_mail_cache(
            &conn,
            "a1",
            "INBOX",
            &[item("m1", "2024-05-02", false)],
            &[],
            None,
        )
        .unwrap();
        replace_account_mail_cache(
            &conn,
            "a1",
            "custom",
            &[item("m2", "2024-05-02", false)],
            &[],
            None,
        )
        .unwrap();
        let (_, inbox_total) = read_mail_list(&conn, "a1", "INBOX", 1, 25).unwrap();
        let (_, custom_total) = read_mail_list(&conn, "a1", "custom", 1, 25).unwrap();
        assert_eq!((inbox_total, custom_total), (1, 1));
        clear_mail_cache(&conn, "a1").unwrap();
        let (_, t) = read_mail_list(&conn, "a1", "INBOX", 1, 25).unwrap();
        assert_eq!(t, 0);
    }

    #[test]
    fn set_read_updates_list_and_detail() {
        let conn = setup();
        let items = vec![item("m1", "2024-05-02", false)];
        let details = vec![("m1".to_string(), detail("m1"))];
        replace_account_mail_cache(&conn, "a1", "INBOX", &items, &details, None).unwrap();
        set_message_read(&conn, "a1", "INBOX", "m1", true).unwrap();
        let (list, _) = read_mail_list(&conn, "a1", "INBOX", 1, 25).unwrap();
        assert!(list[0].is_read);
        let d = read_mail_detail(&conn, "a1", "INBOX", "m1")
            .unwrap()
            .unwrap();
        assert!(d.is_read);
    }
}

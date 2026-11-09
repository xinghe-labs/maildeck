//! Microsoft Graph HTTP 客户端（对应原 graph-client.ts + graph-errors.ts）。
//! 429/Retry-After、graph notFound、响应大小上限、网络错误归一化都在这里收口。

use crate::contracts::AppErrorPayload;
use crate::contracts::{
    AccountRecord, Diagnostic, MailDetail, MailDetailBody, MailFlag, MailListItem, MailRecipient,
};
use crate::errors::{normalize_message, AppError, GRAPH_NOT_FOUND, MAIL_TOO_LARGE};
use serde_json::Value;
use std::time::Duration;

/// 单响应字节上限（原 MAX_GRAPH_RESPONSE_BYTES = 25MB）。
pub const MAX_GRAPH_RESPONSE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
#[error("graph request failed: {message} (status {status})")]
pub struct GraphRequestError {
    pub status: u16,
    pub message: String,
}

impl GraphRequestError {
    pub fn to_app_error(&self) -> AppError {
        let lower = self.message.to_lowercase();
        if self.status == 404 {
            return AppError::GraphNotFound(self.message.clone());
        }
        if self.status == 429 {
            return AppError::Throttled(0);
        }
        normalize_message(&self.message, &lower)
    }
}

#[derive(Debug, thiserror::Error)]
#[error("graph response too large: {0} bytes")]
pub struct GraphResponseTooLargeError(pub usize);

pub struct GraphClient {
    endpoint: String,
    timeout: Duration,
}

pub struct RemoteMailPage {
    pub messages: Vec<MailListItem>,
    pub details: Vec<(String, MailDetail)>,
    pub total: i64,
}

pub struct InboxCount {
    pub count: i64,
    pub latest_mail_at: Option<String>,
}

impl GraphClient {
    pub fn new(endpoint: String, timeout: Duration) -> Self {
        Self {
            endpoint: endpoint.trim_end_matches('/').to_string(),
            timeout,
        }
    }

    fn http(&self) -> Result<reqwest::blocking::Client, GraphRequestError> {
        reqwest::blocking::Client::builder()
            .timeout(self.timeout)
            .build()
            .map_err(|e| GraphRequestError {
                status: 0,
                message: e.to_string(),
            })
    }

    fn request(
        &self,
        method: reqwest::Method,
        url: &str,
        token: &str,
        body: Option<Value>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        let client = self.http()?;
        let mut req = client
            .request(method, url)
            .bearer_auth(token)
            .header("ConsistencyLevel", "eventual");
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send()?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes()?;
        if bytes.len() > MAX_GRAPH_RESPONSE_BYTES {
            return Err(Box::new(GraphResponseTooLargeError(bytes.len())));
        }
        let text = String::from_utf8_lossy(&bytes).to_string();
        if !(200..300).contains(&status) {
            return Err(Box::new(GraphRequestError {
                status,
                message: summarize_graph_error(&text, status),
            }));
        }
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| {
            Box::new(GraphRequestError {
                status,
                message: format!("invalid json response: {e}"),
            }) as Box<dyn std::error::Error + Send + Sync>
        })
    }

    /// 收件箱未读计数 + 最新邮件时间（inbox refresh 用）。
    pub fn inbox_unread_count(
        &self,
        token: &str,
        record: &AccountRecord,
    ) -> Result<InboxCount, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!("{}/users/{}/mailFolders/inbox", self.endpoint, record.email);
        let value = self.request(reqwest::Method::GET, &url, token, None)?;
        let count = value
            .get("totalItemCount")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        // 最新邮件时间：单独拉一封
        let latest = self
            .list_messages(token, record, "inbox", 1, 1)
            .ok()
            .and_then(|page| {
                page.messages
                    .first()
                    .and_then(|m| m.received_date_time.clone())
            });
        Ok(InboxCount {
            count,
            latest_mail_at: latest,
        })
    }

    /// 邮件列表页（$top/$skip 分页，与原版一致用 messages endpoint）。
    pub fn list_messages(
        &self,
        token: &str,
        record: &AccountRecord,
        folder_id: &str,
        page: i64,
        page_size: i64,
    ) -> Result<RemoteMailPage, Box<dyn std::error::Error + Send + Sync>> {
        let page = page.max(1);
        let page_size = page_size.clamp(1, 100);
        let skip = (page - 1) * page_size;
        let select = "id,subject,from,receivedDateTime,sentDateTime,isRead,importance,hasAttachments,bodyPreview,webLink";
        let url = format!(
            "{}/users/{}/mailFolders/{}/messages?$select={}&$orderby=receivedDateTime desc&$top={}&$skip={}",
            self.endpoint,
            urlencode(&record.email),
            urlencode(folder_id),
            urlencode(select),
            page_size,
            skip,
        );
        let value = self.request(reqwest::Method::GET, &url, token, None)?;
        let items = value
            .get("value")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut messages = Vec::new();
        let mut details = Vec::new();
        for item in &items {
            if let Some(list_item) = message_to_list_item(item) {
                messages.push(list_item);
            }
            if let Some(detail) = message_to_detail(item) {
                details.push((detail.id.clone(), detail));
            }
        }
        let total = value
            .get("@odata.count")
            .and_then(|v| v.as_i64())
            .unwrap_or(messages.len() as i64 + skip);
        Ok(RemoteMailPage {
            messages,
            details,
            total,
        })
    }

    /// 单封详情（含 body 全文）。
    pub fn get_message(
        &self,
        token: &str,
        record: &AccountRecord,
        folder_id: &str,
        message_id: &str,
    ) -> Result<MailDetail, Box<dyn std::error::Error + Send + Sync>> {
        let select = "id,subject,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,attachments,conversationId,webLink,importance,flag";
        let url = format!(
            "{}/users/{}/mailFolders/{}/messages/{}?$select={}&$expand=attachments($select=id,name,contentType,size,isInline)",
            self.endpoint,
            urlencode(&record.email),
            urlencode(folder_id),
            urlencode(message_id),
            urlencode(select),
        );
        let value = self.request(reqwest::Method::GET, &url, token, None)?;
        message_to_detail(&value).ok_or_else(|| {
            Box::new(GraphRequestError {
                status: 200,
                message: "message payload missing id".into(),
            }) as Box<dyn std::error::Error + Send + Sync>
        })
    }

    /// 标记已读/未读。
    pub fn mark_read(
        &self,
        token: &str,
        record: &AccountRecord,
        folder_id: &str,
        message_id: &str,
        is_read: bool,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let url = format!(
            "{}/users/{}/mailFolders/{}/messages/{}",
            self.endpoint,
            urlencode(&record.email),
            urlencode(folder_id),
            urlencode(message_id),
        );
        self.request(
            reqwest::Method::PATCH,
            &url,
            token,
            Some(serde_json::json!({ "isRead": is_read })),
        )?;
        Ok(())
    }

    /// 邮箱文件夹列表（与原版一致：$top=100 单页）。
    pub fn list_folders(
        &self,
        token: &str,
    ) -> Result<Vec<crate::contracts::MailFolder>, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!(
            "{}/me/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount",
            self.endpoint
        );
        let value = self.request(reqwest::Method::GET, &url, token, None)?;
        let folders = value
            .get("value")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(folders
            .iter()
            .filter_map(|f| {
                let id = f.get("id")?.as_str()?.to_string();
                Some(crate::contracts::MailFolder {
                    id,
                    display_name: f
                        .get("displayName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    total_item_count: f
                        .get("totalItemCount")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    unread_item_count: f
                        .get("unreadItemCount")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                })
            })
            .collect())
    }

    /// 附件元数据列表（只有 fileAttachment 能经 /$value 取原始字节）。
    pub fn list_attachments(
        &self,
        token: &str,
        message_id: &str,
    ) -> Result<Vec<crate::contracts::MailAttachmentMeta>, Box<dyn std::error::Error + Send + Sync>>
    {
        let url = format!(
            "{}/me/messages/{}/attachments?$select=id,name,contentType,size,isInline&$top=100",
            self.endpoint,
            urlencode(message_id),
        );
        let value = self.request(reqwest::Method::GET, &url, token, None)?;
        let items = value
            .get("value")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(items
            .iter()
            .filter_map(|a| {
                let id = a.get("id")?.as_str()?.to_string();
                let name = a
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                Some(crate::contracts::MailAttachmentMeta {
                    id,
                    name: if name.is_empty() {
                        "未命名附件".into()
                    } else {
                        name
                    },
                    content_type: a
                        .get("contentType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("application/octet-stream")
                        .to_string(),
                    size: a.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
                    is_inline: a.get("isInline").and_then(|v| v.as_bool()).unwrap_or(false),
                })
            })
            .collect())
    }

    /// 附件原始字节（/$value 端点返回二进制而非 JSON）。
    pub fn download_attachment(
        &self,
        token: &str,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!(
            "{}/me/messages/{}/attachments/{}/$value",
            self.endpoint,
            urlencode(message_id),
            urlencode(attachment_id),
        );
        let client = self.http()?;
        let resp = client
            .request(reqwest::Method::GET, &url)
            .bearer_auth(token)
            .header("ConsistencyLevel", "eventual")
            .send()?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes()?;
        if bytes.len() > MAX_GRAPH_RESPONSE_BYTES {
            return Err(Box::new(GraphResponseTooLargeError(bytes.len())));
        }
        if !(200..300).contains(&status) {
            let text = String::from_utf8_lossy(&bytes);
            return Err(Box::new(GraphRequestError {
                status,
                message: summarize_graph_error(&text, status),
            }));
        }
        Ok(bytes.to_vec())
    }

    /// /me 的邮箱地址（readAccountEmail：优先 mail，回退 userPrincipalName）。
    pub fn get_me_email(
        &self,
        token: &str,
    ) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!("{}/me?$select=mail,userPrincipalName", self.endpoint);
        let value = self.request(reqwest::Method::GET, &url, token, None)?;
        let email = value
            .get("mail")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                value
                    .get("userPrincipalName")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
            })
            .map(str::to_string);
        Ok(email)
    }
}

fn summarize_graph_error(text: &str, status: u16) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        if let Some(msg) = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return format!("HTTP {status}: {msg}");
        }
    }
    format!(
        "HTTP {status}: {}",
        text.chars().take(200).collect::<String>()
    )
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn recipient_from_value(v: Option<&Value>) -> Option<MailRecipient> {
    let addr = v?.get("emailAddress")?;
    Some(MailRecipient {
        name: addr
            .get("name")
            .and_then(|n| n.as_str())
            .map(str::to_string),
        address: addr
            .get("address")
            .and_then(|n| n.as_str())
            .map(str::to_string),
    })
}

pub fn message_to_list_item(item: &Value) -> Option<MailListItem> {
    let id = item.get("id")?.as_str()?.to_string();
    Some(MailListItem {
        id,
        subject: item
            .get("subject")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        from: recipient_from_value(item.get("from")),
        received_date_time: item
            .get("receivedDateTime")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        sent_date_time: item
            .get("sentDateTime")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        is_read: item
            .get("isRead")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        importance: item
            .get("importance")
            .and_then(|v| v.as_str())
            .unwrap_or("normal")
            .to_string(),
        has_attachments: item
            .get("hasAttachments")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        body_preview: item
            .get("bodyPreview")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        web_link: item
            .get("webLink")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

pub fn message_to_detail(item: &Value) -> Option<MailDetail> {
    let id = item.get("id")?.as_str()?.to_string();
    let body = item.get("body")?;
    let attachments = item
        .get("attachments")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|a| crate::contracts::MailAttachment {
                    id: a
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    name: a
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    content_type: a
                        .get("contentType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    size: a.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
                    is_inline: a.get("isInline").and_then(|v| v.as_bool()).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(MailDetail {
        id,
        subject: item
            .get("subject")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        body: MailDetailBody {
            content: body
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            content_type: body
                .get("contentType")
                .and_then(|v| v.as_str())
                .unwrap_or("html")
                .to_string(),
        },
        from: recipient_from_value(item.get("from")).unwrap_or(MailRecipient {
            name: None,
            address: None,
        }),
        to_recipients: item
            .get("toRecipients")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|r| recipient_from_value(Some(r)))
                    .collect()
            })
            .unwrap_or_default(),
        cc_recipients: item
            .get("ccRecipients")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|r| recipient_from_value(Some(r)))
                    .collect()
            })
            .unwrap_or_default(),
        received_date_time: item
            .get("receivedDateTime")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        sent_date_time: item
            .get("sentDateTime")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        is_read: item
            .get("isRead")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        has_attachments: item
            .get("hasAttachments")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        attachments,
        conversation_id: item
            .get("conversationId")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        web_link: item
            .get("webLink")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        importance: item
            .get("importance")
            .and_then(|v| v.as_str())
            .unwrap_or("normal")
            .to_string(),
        flag: MailFlag {
            flag_status: item
                .get("flag")
                .and_then(|f| f.get("flagStatus"))
                .and_then(|v| v.as_str())
                .unwrap_or("notFlagged")
                .to_string(),
        },
    })
}

/// 错误负载（graph-errors.toGraphErrorPayload 等价）。
pub fn graph_error_payload(
    err: &(dyn std::error::Error + Send + Sync + 'static),
) -> AppErrorPayload {
    if let Some(too_large) = err.downcast_ref::<GraphResponseTooLargeError>() {
        return AppErrorPayload {
            code: MAIL_TOO_LARGE.into(),
            message: format!("邮件内容过大（{} bytes）", too_large.0),
            retryable: false,
            diagnostic: None,
        };
    }
    if let Some(graph_err) = err.downcast_ref::<GraphRequestError>() {
        let app = graph_err.to_app_error();
        if app.code() == GRAPH_NOT_FOUND {
            return AppErrorPayload {
                code: app.code().into(),
                message: app.to_string(),
                retryable: false,
                diagnostic: Some(Diagnostic {
                    request_id: Some(format!("status {}", graph_err.status)),
                }),
            };
        }
        return app.payload();
    }
    crate::errors::normalize_error(err).payload()
}

fn _assert_send_sync() {
    fn is_send_sync<T: Send + Sync>() {}
    is_send_sync::<GraphClient>();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_parsing_roundtrip() {
        let raw = serde_json::json!({
            "id": "AAA-111",
            "subject": "Test mail",
            "from": { "emailAddress": { "name": "Alice", "address": "alice@x.com" } },
            "receivedDateTime": "2024-05-01T10:00:00Z",
            "isRead": false,
            "importance": "high",
            "hasAttachments": true,
            "bodyPreview": "hello",
            "webLink": "https://outlook.example/m1",
            "body": { "content": "<p>hello</p>", "contentType": "html" },
            "toRecipients": [ { "emailAddress": { "name": "Bob", "address": "bob@x.com" } } ],
            "flag": { "flagStatus": "flagged" },
            "attachments": [ { "id": "att1", "name": "a.pdf", "contentType": "application/pdf", "size": 10, "isInline": false } ]
        });
        let list = message_to_list_item(&raw).unwrap();
        assert_eq!(list.id, "AAA-111");
        assert_eq!(
            list.from.and_then(|f| f.address).as_deref(),
            Some("alice@x.com")
        );
        assert_eq!(list.importance, "high");
        assert!(list.has_attachments);

        let detail = message_to_detail(&raw).unwrap();
        assert_eq!(detail.body.content, "<p>hello</p>");
        assert_eq!(detail.to_recipients.len(), 1);
        assert_eq!(detail.flag.flag_status, "flagged");
        assert_eq!(detail.attachments[0].name, "a.pdf");
    }

    #[test]
    fn missing_id_is_none() {
        let raw = serde_json::json!({ "subject": "no id" });
        assert!(message_to_list_item(&raw).is_none());
    }

    #[test]
    fn error_summarize_and_payload() {
        let body = serde_json::json!({ "error": { "code": "ErrorItemNotFound", "message": "The specified object was not found" } }).to_string();
        assert_eq!(
            summarize_graph_error(&body, 404),
            "HTTP 404: The specified object was not found"
        );
        let err = GraphRequestError {
            status: 404,
            message: "not found".into(),
        };
        let payload = graph_error_payload(&err);
        assert_eq!(payload.code, "GRAPH_NOT_FOUND");

        let too_large = GraphResponseTooLargeError(MAX_GRAPH_RESPONSE_BYTES + 1);
        let payload = graph_error_payload(&too_large);
        assert_eq!(payload.code, "MAIL_TOO_LARGE");
    }
}

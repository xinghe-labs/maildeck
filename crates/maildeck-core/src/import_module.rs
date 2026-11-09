//! 账号导入/更新（对应原 import-parser.ts + account-store.ts 的 validateImportInput /
//! previewAccounts / upsertAccounts / updateAccount）。逐行容错，错误聚合。

use crate::account_store::{now_iso, AccountStore};
use crate::contracts::{
    AccountRecord, AccountStatus, AccountUpdateInput, AccountView, ImportPreviewResult,
};
use crate::credentials::{protect_refresh_token, CredentialGeneration};
use crate::errors::AppError;

/// toView 移植：AccountRecord → 渲染层投影。
pub fn to_view(record: &AccountRecord) -> AccountView {
    AccountView {
        id: record.id.clone(),
        email: record.email.clone(),
        client_id: record.client_id.clone(),
        remark: record.remark.clone(),
        group: record.group_name.clone(),
        auth_mode: None,
        status: record.status,
        last_checked_at: record.last_checked_at.clone(),
        last_error: record.last_error.clone(),
        last_refreshed_at: Some(record.last_refreshed_at.clone()),
        last_inbox_count: Some(record.last_inbox_count),
        last_mail_at: Some(record.last_mail_at.clone()),
        last_mail_cursor: None,
        inbox_folder_id: Some(record.inbox_folder_id.clone()),
        graph_delta_link: Some(record.graph_delta_link.clone()),
        refresh_cooldown_until: Some(record.refresh_cooldown_until.clone()),
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
    }
}

pub const IMPORT_MAX_ROWS: usize = 5_000;
pub const IMPORT_TEXT_MAX_BYTES: usize = 10 * 1024 * 1024;

const LIMIT_CLIENT_ID: usize = 256;
const LIMIT_REFRESH_TOKEN: usize = 32_768;
const LIMIT_REMARK: usize = 1_000;
const LIMIT_GROUP: usize = 200;

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AccountInput {
    pub email: String,
    pub client_id: String,
    pub refresh_token: String,
    pub remark: String,
    pub group: String,
}

fn is_uuid(value: &str) -> bool {
    let v = value.trim();
    let bytes = v.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    v.split('-').map(str::len).collect::<Vec<_>>() == [8, 4, 4, 4, 12]
        && v.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
}

fn looks_like_refresh_token(value: &str) -> bool {
    let v = value.trim();
    v.starts_with("M.") && v.len() > 80
}

fn looks_like_access_token(value: &str) -> bool {
    let v = value.trim();
    v.starts_with("Ew") && v.len() > 80 && !v.contains('.')
}

fn is_email_like(value: &str) -> bool {
    let v = value.trim();
    let Some((local, domain)) = v.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !v.contains(char::is_whitespace)
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
}

fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

// ---------- 解析（import-parser.ts 移植） ----------

/// CSV 单行解析：支持双引号包裹与 "" 转义，逗号分隔。
pub fn parse_csv_line(line: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = line.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if ch == '"' && in_quotes && next == Some('"') {
            current.push('"');
            index += 2;
            continue;
        }
        if ch == '"' {
            in_quotes = !in_quotes;
            index += 1;
            continue;
        }
        if ch == ',' && !in_quotes {
            cells.push(current.trim().to_string());
            current.clear();
            index += 1;
            continue;
        }
        current.push(ch);
        index += 1;
    }
    cells.push(current.trim().to_string());
    cells
}

fn is_header(cells: &[String]) -> bool {
    let normalized: Vec<String> = cells.iter().map(|c| c.trim().to_lowercase()).collect();
    normalized.iter().any(|c| c == "email")
        && normalized
            .iter()
            .any(|c| c == "client_id" || c == "clientid")
}

fn parse_dashed_line(cells: &[&str]) -> AccountInput {
    let second_looks_client_id = is_uuid(cells.get(1).copied().unwrap_or(""));
    let third_looks_client_id = is_uuid(cells.get(2).copied().unwrap_or(""));
    let get = |i: usize| cells.get(i).copied().unwrap_or("").to_string();
    if cells.len() >= 4 && third_looks_client_id && !second_looks_client_id {
        return AccountInput {
            email: get(0),
            client_id: get(2),
            refresh_token: get(3),
            remark: get(4),
            group: get(5),
        };
    }
    AccountInput {
        email: get(0),
        client_id: get(1),
        refresh_token: get(2),
        remark: get(3),
        group: get(4),
    }
}

/// parseAccountImport 移植：去 BOM → 表头映射 / ---- 分隔 / CSV 逗号。
pub fn parse_account_import(text: &str) -> Vec<AccountInput> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let first_cells = parse_csv_line(lines[0]);
    if is_header(&first_cells) {
        let header: Vec<String> = first_cells
            .iter()
            .map(|c| c.trim().to_lowercase())
            .collect();
        let index_of = |names: &[&str]| header.iter().position(|c| names.contains(&c.as_str()));
        let email_i = index_of(&["email", "mail", "account"]);
        let client_i = index_of(&["client_id", "clientid", "client id"]);
        let token_i = index_of(&["refresh_token", "refreshtoken", "refresh token", "rt"]);
        let remark_i = index_of(&["remark", "note", "备注"]);
        let group_i = index_of(&["group", "分组"]);
        let cell = |cells: &[String], i: Option<usize>| -> String {
            i.and_then(|i| cells.get(i)).cloned().unwrap_or_default()
        };
        return lines[1..]
            .iter()
            .map(|line| {
                let cells = parse_csv_line(line);
                AccountInput {
                    email: cell(&cells, email_i),
                    client_id: cell(&cells, client_i),
                    refresh_token: cell(&cells, token_i),
                    remark: cell(&cells, remark_i),
                    group: cell(&cells, group_i),
                }
            })
            .collect();
    }
    lines
        .iter()
        .map(|line| {
            if line.contains("----") {
                return parse_dashed_line(&line.split("----").map(str::trim).collect::<Vec<_>>());
            }
            let cells = parse_csv_line(line);
            AccountInput {
                email: cells.first().cloned().unwrap_or_default(),
                client_id: cells.get(1).cloned().unwrap_or_default(),
                refresh_token: cells.get(2).cloned().unwrap_or_default(),
                remark: cells.get(3).cloned().unwrap_or_default(),
                group: cells.get(4).cloned().unwrap_or_default(),
            }
        })
        .collect()
}

// ---------- 校验（validateImportInput 移植） ----------

pub struct ImportValidation {
    pub email: String,
    pub client_id: String,
    pub refresh_token: String,
    pub remark: String,
    pub group: String,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn validate_import_input(input: &AccountInput, row: usize) -> ImportValidation {
    let email = normalize_email(&input.email);
    let client_id = input.client_id.trim().to_string();
    let refresh_token = input.refresh_token.trim().to_string();
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if email.is_empty() || client_id.is_empty() || refresh_token.is_empty() {
        errors.push(format!("第 {row} 行缺少 email、client_id 或 refresh_token"));
        return ImportValidation {
            email,
            client_id,
            refresh_token,
            remark: input.remark.trim().to_string(),
            group: input.group.trim().to_string(),
            errors,
            warnings,
        };
    }

    if !is_email_like(&email) {
        errors.push(format!("第 {row} 行 email 格式不正确"));
    }
    if !is_uuid(&client_id) {
        errors.push(format!("第 {row} 行 client_id 不是 UUID，可能字段顺序写错"));
    }
    if is_uuid(&refresh_token) {
        errors.push(format!(
            "第 {row} 行 refresh_token 看起来像 client_id，疑似字段顺序错误"
        ));
    }
    if looks_like_refresh_token(&client_id) {
        errors.push(format!(
            "第 {row} 行 client_id 看起来像 refresh_token，疑似字段顺序错误"
        ));
    }
    if looks_like_access_token(&refresh_token) {
        errors.push(format!(
            "第 {row} 行 refresh_token 看起来像 access_token，请导入 refresh_token"
        ));
    } else if !looks_like_refresh_token(&refresh_token) {
        warnings.push(format!(
            "第 {row} 行 refresh_token 不像常见 Microsoft refresh token，请确认不是复制了密码或 access token"
        ));
    }

    if client_id.len() > LIMIT_CLIENT_ID {
        errors.push(format!("第 {row} 行 client_id 超过 {LIMIT_CLIENT_ID} 字符"));
    }
    if refresh_token.len() > LIMIT_REFRESH_TOKEN {
        errors.push(format!(
            "第 {row} 行 refresh_token 超过 {LIMIT_REFRESH_TOKEN} 字符"
        ));
    }
    let remark = input.remark.trim().to_string();
    if remark.len() > LIMIT_REMARK {
        errors.push(format!("第 {row} 行备注超过 {LIMIT_REMARK} 字符"));
    }
    let group = input.group.trim().to_string();
    if group.len() > LIMIT_GROUP {
        errors.push(format!("第 {row} 行分组超过 {LIMIT_GROUP} 字符"));
    }

    ImportValidation {
        email,
        client_id,
        refresh_token,
        remark,
        group,
        errors,
        warnings,
    }
}

// ---------- 预览 / upsert / update ----------

fn check_row_limit(inputs: &[AccountInput]) -> Result<(), AppError> {
    if inputs.len() > IMPORT_MAX_ROWS {
        return Err(AppError::Unknown(format!(
            "单次导入不能超过 {} 行",
            IMPORT_MAX_ROWS
        )));
    }
    Ok(())
}

/// previewAccounts 移植。
pub fn preview_accounts(
    store: &AccountStore,
    inputs: &[AccountInput],
) -> Result<ImportPreviewResult, AppError> {
    check_row_limit(inputs)?;
    let existing: std::collections::HashSet<String> = store
        .list()
        .map_err(AppError::Unknown)?
        .into_iter()
        .map(|a| a.email)
        .collect();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let (mut valid, mut duplicates, mut invalid) = (0usize, 0usize, 0usize);

    for (index, input) in inputs.iter().enumerate() {
        let result = validate_import_input(input, index + 1);
        errors.extend(result.errors.iter().cloned());
        warnings.extend(result.warnings.iter().cloned());
        if !result.errors.is_empty() {
            invalid += 1;
            continue;
        }
        valid += 1;
        if existing.contains(&result.email) || seen.contains(&result.email) {
            duplicates += 1;
        }
        seen.insert(result.email);
    }

    Ok(ImportPreviewResult {
        total: inputs.len(),
        valid,
        duplicates,
        invalid,
        errors,
        warnings,
    })
}

fn record_to_view(record: &AccountRecord) -> AccountView {
    to_view(record)
}

/// upsertAccounts 移植：已存在 → 更新凭据并重置状态（generation+1、清冷却）；
/// 新 → 插入；非法行 → skipped + errors。
pub fn upsert_accounts(
    store: &AccountStore,
    inputs: &[AccountInput],
) -> Result<crate::contracts::ImportResult, AppError> {
    check_row_limit(inputs)?;
    let mut imported = 0usize;
    let mut updated = 0usize;
    let mut skipped = 0usize;
    let mut errors: Vec<String> = Vec::new();
    let mut affected: Vec<String> = Vec::new();

    for (index, input) in inputs.iter().enumerate() {
        let row = index + 1;
        let result = validate_import_input(input, row);
        if !result.errors.is_empty() {
            skipped += 1;
            errors.extend(result.errors);
            continue;
        }
        let timestamp = now_iso();
        let encrypted = protect_refresh_token(&result.refresh_token, CredentialGeneration::Dpapi)
            .map_err(AppError::Unknown)?;
        if let Some(existing) = store
            .get_by_email(&result.email)
            .map_err(AppError::Unknown)?
        {
            // 新凭据等于一次新尝试：generation+1，旧失败留下的冷却不再适用。
            let next = AccountRecord {
                client_id: result.client_id.clone(),
                encrypted_refresh_token: encrypted.clone(),
                remark: if result.remark.is_empty() {
                    existing.remark.clone()
                } else {
                    result.remark.clone()
                },
                group_name: if result.group.is_empty() {
                    existing.group_name.clone()
                } else {
                    result.group.clone()
                },
                status: AccountStatus::Untested,
                last_error: None,
                refresh_cooldown_until: None,
                credential_generation: existing.credential_generation + 1,
                updated_at: timestamp.clone(),
                ..existing.clone()
            };
            store.update(&next).map_err(AppError::Unknown)?;
            affected.push(existing.id.clone());
            updated += 1;
            continue;
        }
        let record = AccountRecord {
            id: uuid::Uuid::new_v4().to_string(),
            email: result.email.clone(),
            client_id: result.client_id.clone(),
            encrypted_refresh_token: encrypted,
            remark: result.remark.clone(),
            group_name: result.group.clone(),
            status: AccountStatus::Untested,
            last_checked_at: None,
            last_error: None,
            last_refreshed_at: None,
            last_inbox_count: 0,
            last_mail_at: None,
            inbox_folder_id: None,
            graph_delta_link: None,
            refresh_cooldown_until: None,
            credential_generation: 1,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        store.insert(&record).map_err(AppError::Unknown)?;
        affected.push(record.id.clone());
        imported += 1;
    }

    let accounts = affected
        .iter()
        .filter_map(|id| store.get(id).ok().flatten())
        .map(|r| record_to_view(&r))
        .collect();
    Ok(crate::contracts::ImportResult {
        imported,
        updated,
        skipped,
        errors,
        accounts,
    })
}

/// updateAccount 移植：凭据/身份变化才重置状态并 generation+1。
pub fn update_account(
    store: &AccountStore,
    input: &AccountUpdateInput,
) -> Result<AccountView, AppError> {
    let account = store
        .get(&input.id)
        .map_err(AppError::Unknown)?
        .ok_or_else(|| AppError::Unknown("账号不存在".into()))?;
    let email = normalize_email(&input.email);
    let client_id = input.client_id.trim().to_string();
    let refresh_token = input
        .refresh_token
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();

    if email.is_empty() || client_id.is_empty() {
        return Err(AppError::Unknown("邮箱和 Client ID 不能为空".into()));
    }
    if let Some(existing_email) = store.get_by_email(&email).map_err(AppError::Unknown)? {
        if existing_email.id != input.id {
            return Err(AppError::Unknown("邮箱已存在".into()));
        }
    }

    // 只有凭据/身份真的变了才算一次新尝试；只改备注/分组不污染失效筛选。
    let credentials_changed =
        email != account.email || client_id != account.client_id || !refresh_token.is_empty();

    let encrypted = if refresh_token.is_empty() {
        account.encrypted_refresh_token.clone()
    } else {
        protect_refresh_token(&refresh_token, CredentialGeneration::Dpapi)
            .map_err(AppError::Unknown)?
    };

    let next = AccountRecord {
        email,
        client_id,
        encrypted_refresh_token: encrypted,
        remark: input.remark.as_deref().unwrap_or("").trim().to_string(),
        group_name: input.group.as_deref().unwrap_or("").trim().to_string(),
        status: if credentials_changed {
            AccountStatus::Untested
        } else {
            account.status
        },
        last_error: if credentials_changed {
            None
        } else {
            account.last_error.clone()
        },
        refresh_cooldown_until: if credentials_changed {
            None
        } else {
            account.refresh_cooldown_until.clone()
        },
        credential_generation: if credentials_changed {
            account.credential_generation + 1
        } else {
            account.credential_generation
        },
        updated_at: now_iso(),
        ..account.clone()
    };
    store.update(&next).map_err(AppError::Unknown)?;
    Ok(record_to_view(&next))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_csv_with_quotes() {
        let cells = parse_csv_line("\"a,b\", c ,\"he said \"\"hi\"\"\"");
        assert_eq!(cells, vec!["a,b", "c", "he said \"hi\""]);
    }

    #[test]
    fn parse_header_csv() {
        let text = "Email,client_id,refresh_token,备注,分组\na@x.com,cid,rt,备注A,组A";
        let inputs = parse_account_import(text);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].email, "a@x.com");
        assert_eq!(inputs[0].client_id, "cid");
        assert_eq!(inputs[0].remark, "备注A");
        assert_eq!(inputs[0].group, "组A");
    }

    #[test]
    fn parse_dashed_swaps_uuid_column() {
        let text = "a@x.com----rt-not-uuid----01234567-89ab-cdef-0123-456789abcdef----M.rtok";
        let inputs = parse_account_import(text);
        assert_eq!(inputs[0].client_id, "01234567-89ab-cdef-0123-456789abcdef");
        assert_eq!(inputs[0].refresh_token, "M.rtok");
    }

    #[test]
    fn validate_flags_field_swaps() {
        let input = AccountInput {
            email: "a@x.com".into(),
            client_id: "M.".to_string() + &"x".repeat(90),
            refresh_token: uuid::Uuid::new_v4().to_string(),
            remark: String::new(),
            group: String::new(),
        };
        let v = validate_import_input(&input, 1);
        assert!(v
            .errors
            .iter()
            .any(|e| e.contains("refresh_token 看起来像 client_id")));
        assert!(v
            .errors
            .iter()
            .any(|e| e.contains("client_id 看起来像 refresh_token")));
    }

    #[test]
    fn validate_warns_on_unusual_token() {
        let input = AccountInput {
            email: "a@x.com".into(),
            client_id: uuid::Uuid::new_v4().to_string(),
            refresh_token: "short-token".into(),
            remark: String::new(),
            group: String::new(),
        };
        let v = validate_import_input(&input, 3);
        assert!(v.errors.is_empty());
        assert_eq!(v.warnings.len(), 1);
    }

    #[test]
    fn preview_counts_duplicates() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AccountStore::open_at(&dir.path().join("t.db")).unwrap();
        let uid = uuid::Uuid::new_v4().to_string();
        let inputs = vec![
            AccountInput {
                email: "a@x.com".into(),
                client_id: uid.clone(),
                refresh_token: format!("M.{}", "t".repeat(90)),
                remark: String::new(),
                group: String::new(),
            },
            AccountInput {
                email: "A@X.com".into(),
                client_id: uid.clone(),
                refresh_token: format!("M.{}", "t".repeat(90)),
                remark: String::new(),
                group: String::new(),
            },
            AccountInput {
                email: "bad".into(),
                client_id: uid,
                refresh_token: format!("M.{}", "t".repeat(90)),
                remark: String::new(),
                group: String::new(),
            },
        ];
        let preview = preview_accounts(&store, &inputs).unwrap();
        assert_eq!(preview.total, 3);
        assert_eq!(preview.valid, 2);
        assert_eq!(preview.duplicates, 1, "大小写归一后重复");
        assert_eq!(preview.invalid, 1);
    }

    #[test]
    fn upsert_updates_existing_and_bumps_generation() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AccountStore::open_at(&dir.path().join("t.db")).unwrap();
        let uid = uuid::Uuid::new_v4().to_string();
        let token = format!("M.{}", "t".repeat(90));
        let mk = |rt: &str| {
            vec![AccountInput {
                email: "a@x.com".into(),
                client_id: uid.clone(),
                refresh_token: rt.to_string(),
                remark: String::new(),
                group: String::new(),
            }]
        };
        let first = upsert_accounts(&store, &mk(&token)).unwrap();
        assert_eq!(first.imported, 1);
        assert_eq!(first.updated, 0);
        let id = first.accounts[0].id.clone();
        let second = upsert_accounts(&store, &mk(&format!("M.{}", "u".repeat(90)))).unwrap();
        assert_eq!(second.updated, 1);
        assert_eq!(second.imported, 0);
        let rec = store.get(&id).unwrap().unwrap();
        assert_eq!(rec.credential_generation, 2);
        assert!(matches!(rec.status, AccountStatus::Untested));
    }

    #[test]
    fn update_keeps_status_when_only_remark_changes() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AccountStore::open_at(&dir.path().join("t.db")).unwrap();
        let uid = uuid::Uuid::new_v4().to_string();
        let inputs = vec![AccountInput {
            email: "a@x.com".into(),
            client_id: uid,
            refresh_token: format!("M.{}", "t".repeat(90)),
            remark: String::new(),
            group: String::new(),
        }];
        let result = upsert_accounts(&store, &inputs).unwrap();
        let id = result.accounts[0].id.clone();
        store
            .set_status(&id, AccountStatus::Invalid, Some("boom"))
            .unwrap();
        let updated = update_account(
            &store,
            &AccountUpdateInput {
                id: id.clone(),
                email: "a@x.com".into(),
                client_id: result.accounts[0].client_id.clone(),
                refresh_token: None,
                remark: Some("新备注".into()),
                group: None,
            },
        )
        .unwrap();
        assert_eq!(updated.remark, "新备注");
        let rec = store.get(&id).unwrap().unwrap();
        assert!(
            matches!(rec.status, AccountStatus::Invalid),
            "仅改备注不改状态"
        );
        assert_eq!(rec.credential_generation, 1);
    }
}

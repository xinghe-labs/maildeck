import { app } from "electron";
import { copyFile, readFile, rename } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getDatabase, transaction } from "./database.js";
import { decryptSecret, encryptSecret } from "./token-crypto.js";
import type { AccountInput, AccountRecord, AccountUpdateInput, AccountView, ImportPreviewResult } from "./types.js";

interface StoreFile {
  version: number;
  accounts: AccountRecord[];
}

interface AccountRow {
  id: string;
  email: string;
  client_id: string;
  encrypted_refresh_token: string;
  remark: string;
  group_name: string;
  status: AccountRecord["status"];
  last_checked_at: string | null;
  last_error: string | null;
  last_refreshed_at: string | null;
  last_inbox_count: number | null;
  last_mail_at: string | null;
  last_mail_cursor: string | null;
  created_at: string;
  updated_at: string;
}

const STORE_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let storeQueue = Promise.resolve();
let migratedLegacyAccounts = false;

async function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = storeQueue;
  let release!: () => void;
  storeQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release();
  }
}

function looksLikeLongMicrosoftRefreshToken(value: string) {
  return value.startsWith("M.") && value.length > 100;
}

function looksLikeMisparsedLegacyAccount(account: AccountRecord) {
  const decrypted = decryptSecret(account.encryptedRefreshToken);

  return (
    !UUID_PATTERN.test(account.clientId) &&
    UUID_PATTERN.test(decrypted) &&
    looksLikeLongMicrosoftRefreshToken(account.remark)
  );
}

function normalizeLegacyAccount(account: AccountRecord): AccountRecord {
  if (!looksLikeMisparsedLegacyAccount(account)) {
    return account;
  }

  const previousClientId = account.clientId;
  const actualClientId = decryptSecret(account.encryptedRefreshToken);
  const actualRefreshToken = account.remark;

  return {
    ...account,
    clientId: actualClientId,
    encryptedRefreshToken: encryptSecret(actualRefreshToken),
    remark: previousClientId,
    status: "untested",
    lastCheckedAt: null,
    lastError: null,
    updatedAt: nowIso()
  };
}

function getStorePath() {
  return path.join(app.getPath("userData"), "accounts.json");
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function rowToRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    email: row.email,
    clientId: row.client_id,
    encryptedRefreshToken: row.encrypted_refresh_token,
    remark: row.remark || "",
    group: row.group_name || "",
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    lastRefreshedAt: row.last_refreshed_at,
    lastInboxCount: row.last_inbox_count || 0,
    lastMailAt: row.last_mail_at,
    lastMailCursor: row.last_mail_cursor,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toView(account: AccountRecord): AccountView {
  return {
    id: account.id,
    email: account.email,
    clientId: account.clientId,
    remark: account.remark,
    group: account.group,
    status: account.status,
    lastCheckedAt: account.lastCheckedAt,
    lastError: account.lastError,
    lastRefreshedAt: account.lastRefreshedAt || null,
    lastInboxCount: account.lastInboxCount || 0,
    lastMailAt: account.lastMailAt || null,
    lastMailCursor: account.lastMailCursor || null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function getAccountById(accountId: string) {
  const row = getDatabase()
    .prepare("SELECT * FROM accounts WHERE id = ?")
    .get(accountId) as AccountRow | undefined;
  return row ? rowToRecord(row) : null;
}

function getAccountByEmail(email: string) {
  const row = getDatabase()
    .prepare("SELECT * FROM accounts WHERE email = ?")
    .get(email) as AccountRow | undefined;
  return row ? rowToRecord(row) : null;
}

function listAccountRecords() {
  const rows = getDatabase()
    .prepare("SELECT * FROM accounts ORDER BY email ASC")
    .all() as unknown as AccountRow[];
  return rows.map(rowToRecord);
}

function insertOrReplaceAccount(account: AccountRecord) {
  getDatabase()
    .prepare(`
      INSERT INTO accounts (
        id, email, client_id, encrypted_refresh_token, remark, group_name, status,
        last_checked_at, last_error, last_refreshed_at, last_inbox_count,
        last_mail_at, last_mail_cursor, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        client_id = excluded.client_id,
        encrypted_refresh_token = excluded.encrypted_refresh_token,
        remark = excluded.remark,
        group_name = excluded.group_name,
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        last_error = excluded.last_error,
        last_refreshed_at = excluded.last_refreshed_at,
        last_inbox_count = excluded.last_inbox_count,
        last_mail_at = excluded.last_mail_at,
        last_mail_cursor = excluded.last_mail_cursor,
        updated_at = excluded.updated_at
    `)
    .run(
      account.id,
      account.email,
      account.clientId,
      account.encryptedRefreshToken,
      account.remark,
      account.group,
      account.status,
      account.lastCheckedAt,
      account.lastError,
      account.lastRefreshedAt || null,
      account.lastInboxCount || 0,
      account.lastMailAt || null,
      account.lastMailCursor || null,
      account.createdAt,
      account.updatedAt
    );
}

async function readLegacyStore(): Promise<StoreFile> {
  try {
    const raw = await readFile(getStorePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    return {
      version: parsed.version || STORE_VERSION,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts.map(normalizeLegacyAccount) : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, accounts: [] };
    }

    if (error instanceof SyntaxError) {
      const storePath = getStorePath();
      const brokenPath = `${storePath}.broken-${Date.now()}`;
      await copyFile(storePath, brokenPath).catch(() => undefined);
      return { version: STORE_VERSION, accounts: [] };
    }

    throw error;
  }
}

async function migrateLegacyAccountsOnce() {
  if (migratedLegacyAccounts) {
    return;
  }

  migratedLegacyAccounts = true;

  const db = getDatabase();
  const existing = db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number };
  if (existing.count > 0) {
    return;
  }

  const legacy = await readLegacyStore();
  if (legacy.accounts.length === 0) {
    return;
  }

  transaction(() => {
    for (const account of legacy.accounts) {
      insertOrReplaceAccount(account);
    }
  });

  const storePath = getStorePath();
  await copyFile(storePath, `${storePath}.migrated-${Date.now()}.bak`).catch(() => undefined);
  await rename(storePath, `${storePath}.migrated`).catch(() => undefined);
}

export async function listAccounts(): Promise<AccountView[]> {
  await migrateLegacyAccountsOnce();
  return listAccountRecords().map(toView);
}

export async function getAccountRecord(accountId: string): Promise<AccountRecord> {
  await migrateLegacyAccountsOnce();
  const account = getAccountById(accountId);

  if (!account) {
    throw new Error("账号不存在");
  }

  return account;
}

export async function getRefreshToken(accountId: string): Promise<string> {
  const account = await getAccountRecord(accountId);
  return decryptSecret(account.encryptedRefreshToken);
}

export async function previewAccounts(inputs: AccountInput[]): Promise<ImportPreviewResult> {
  await migrateLegacyAccountsOnce();
  const existingEmails = new Set(listAccountRecords().map((account) => account.email));
  const seenEmails = new Set<string>();
  const errors: string[] = [];
  let valid = 0;
  let duplicates = 0;
  let invalid = 0;

  for (const [index, input] of inputs.entries()) {
    const email = normalizeEmail(input.email);
    const clientId = input.clientId.trim();
    const refreshToken = input.refreshToken.trim();

    if (!email || !clientId || !refreshToken) {
      invalid += 1;
      errors.push(`第 ${index + 1} 行缺少 email、client_id 或 refresh_token`);
      continue;
    }

    valid += 1;
    if (existingEmails.has(email) || seenEmails.has(email)) {
      duplicates += 1;
    }
    seenEmails.add(email);
  }

  return {
    total: inputs.length,
    valid,
    duplicates,
    invalid,
    errors
  };
}

export async function upsertAccounts(inputs: AccountInput[]) {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    transaction(() => {
      for (const [index, input] of inputs.entries()) {
        const email = normalizeEmail(input.email);
        const clientId = input.clientId.trim();
        const refreshToken = input.refreshToken.trim();

        if (!email || !clientId || !refreshToken) {
          skipped += 1;
          errors.push(`第 ${index + 1} 行缺少 email、client_id 或 refresh_token`);
          continue;
        }

        const existing = getAccountByEmail(email);
        const timestamp = nowIso();

        if (existing) {
          insertOrReplaceAccount({
            ...existing,
            clientId,
            encryptedRefreshToken: encryptSecret(refreshToken),
            remark: input.remark?.trim() || existing.remark,
            group: input.group?.trim() || existing.group,
            status: "untested",
            lastError: null,
            updatedAt: timestamp
          });
          updated += 1;
          continue;
        }

        insertOrReplaceAccount({
          id: crypto.randomUUID(),
          email,
          clientId,
          encryptedRefreshToken: encryptSecret(refreshToken),
          remark: input.remark?.trim() || "",
          group: input.group?.trim() || "",
          status: "untested",
          lastCheckedAt: null,
          lastError: null,
          lastRefreshedAt: null,
          lastInboxCount: 0,
          lastMailAt: null,
          lastMailCursor: null,
          createdAt: timestamp,
          updatedAt: timestamp
        });
        imported += 1;
      }
    });

    return {
      imported,
      updated,
      skipped,
      errors,
      accounts: listAccountRecords().map(toView)
    };
  });
}

export async function deleteAccount(accountId: string): Promise<AccountView[]> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    let changes = 0;
    transaction(() => {
      const db = getDatabase();
      db.prepare("DELETE FROM mail_messages WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM mail_details WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM mail_cache_meta WHERE account_id = ?").run(accountId);
      const result = db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
      changes = Number(result.changes);
    });

    if (changes === 0) {
      throw new Error("账号不存在");
    }

    return listAccountRecords().map(toView);
  });
}

export async function updateAccount(input: AccountUpdateInput): Promise<AccountView> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    const account = getAccountById(input.id);

    if (!account) {
      throw new Error("账号不存在");
    }

    const email = normalizeEmail(input.email);
    const clientId = input.clientId.trim();
    const refreshToken = input.refreshToken?.trim() || "";

    if (!email || !clientId) {
      throw new Error("邮箱和 Client ID 不能为空");
    }

    const existingEmail = getAccountByEmail(email);
    if (existingEmail && existingEmail.id !== input.id) {
      throw new Error("邮箱已存在");
    }

    const next: AccountRecord = {
      ...account,
      email,
      clientId,
      remark: input.remark?.trim() || "",
      group: input.group?.trim() || "",
      status: "untested",
      lastError: null,
      updatedAt: nowIso()
    };

    if (refreshToken) {
      next.encryptedRefreshToken = encryptSecret(refreshToken);
    }

    insertOrReplaceAccount(next);
    return toView(next);
  });
}

export async function updateAccountStatus(
  accountId: string,
  status: AccountRecord["status"],
  lastError: string | null,
  refreshToken?: string
): Promise<AccountView> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    const account = getAccountById(accountId);

    if (!account) {
      throw new Error("账号不存在");
    }

    const timestamp = nowIso();
    const next: AccountRecord = {
      ...account,
      status,
      lastError,
      lastCheckedAt: timestamp,
      updatedAt: timestamp,
      encryptedRefreshToken: refreshToken ? encryptSecret(refreshToken) : account.encryptedRefreshToken
    };

    insertOrReplaceAccount(next);
    return toView(next);
  });
}

export async function updateAccountRefreshState(
  accountId: string,
  values: {
    status: AccountRecord["status"];
    lastError: string | null;
    lastInboxCount: number;
    lastMailAt: string | null;
    lastMailCursor?: string | null;
  }
): Promise<AccountView> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    const account = getAccountById(accountId);

    if (!account) {
      throw new Error("账号不存在");
    }

    const timestamp = nowIso();
    const next: AccountRecord = {
      ...account,
      status: values.status,
      lastError: values.lastError,
      lastCheckedAt: timestamp,
      lastRefreshedAt: timestamp,
      lastInboxCount: values.lastInboxCount,
      lastMailAt: values.lastMailAt,
      lastMailCursor: values.lastMailCursor ?? account.lastMailCursor ?? null,
      updatedAt: timestamp
    };

    insertOrReplaceAccount(next);
    return toView(next);
  });
}

import { app } from "electron";
import { copyFile, readFile, rename } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { getDatabase, transaction } from "./database.js";
import { decryptSecret, encryptSecret } from "./token-crypto.js";
import { resolveRefreshTimestamps } from "./account-refresh-state.js";
import { credentialGenerations, CredentialsChangedError } from "./credential-generations.js";
import { ACCOUNT_VIEW_COLUMNS, type AccountViewRow } from "./account-view-projection.js";
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
  inbox_folder_id: string | null;
  graph_delta_link: string | null;
  refresh_cooldown_until: string | null;
  credential_generation: number;
  created_at: string;
  updated_at: string;
}

const STORE_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const legacyAccountSchema = z.object({
  id: z.string().trim().min(1).max(128),
  email: z.string().trim().min(1).max(320),
  clientId: z.string().trim().min(1).max(256),
  encryptedRefreshToken: z.string().min(1).max(256 * 1024),
  remark: z.string().max(1_000).optional(),
  group: z.string().max(200).optional(),
  status: z.enum(["untested", "valid", "invalid"]).optional(),
  lastCheckedAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  lastRefreshedAt: z.string().nullable().optional(),
  lastInboxCount: z.number().int().nonnegative().optional(),
  lastMailAt: z.string().nullable().optional(),
  lastMailCursor: z.string().nullable().optional(),
  inboxFolderId: z.string().nullable().optional(),
  graphDeltaLink: z.string().nullable().optional(),
  refreshCooldownUntil: z.string().nullable().optional(),
  credentialGeneration: z.number().int().nonnegative().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
});
let storeQueue = Promise.resolve();
let legacyAccountsMigration: Promise<void> | null = null;

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

function getMisparsedLegacyClientId(account: AccountRecord) {
  let decrypted: string;
  try {
    decrypted = decryptSecret(account.encryptedRefreshToken);
  } catch {
    return null;
  }

  return (
    !UUID_PATTERN.test(account.clientId) &&
    UUID_PATTERN.test(decrypted) &&
    looksLikeLongMicrosoftRefreshToken(account.remark)
  ) ? decrypted : null;
}

function normalizeLegacyAccount(account: AccountRecord): AccountRecord {
  const actualClientId = getMisparsedLegacyClientId(account);
  if (!actualClientId) {
    return { ...account, credentialGeneration: account.credentialGeneration ?? 0 };
  }

  const previousClientId = account.clientId;
  const actualRefreshToken = account.remark;

  return {
    ...account,
    clientId: actualClientId,
    encryptedRefreshToken: encryptSecret(actualRefreshToken),
    remark: previousClientId,
    status: "untested",
    lastCheckedAt: null,
    lastError: null,
    credentialGeneration: account.credentialGeneration ?? 0,
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

function isEmailLike(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function looksLikeRefreshToken(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("M.") && trimmed.length > 80;
}

function looksLikeAccessToken(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("Ew") && trimmed.length > 80 && !trimmed.includes(".");
}

function validateImportInput(input: AccountInput, rowNumber: number) {
  const email = normalizeEmail(input.email);
  const clientId = input.clientId.trim();
  const refreshToken = input.refreshToken.trim();
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!email || !clientId || !refreshToken) {
    errors.push(`第 ${rowNumber} 行缺少 email、client_id 或 refresh_token`);
    return { email, clientId, refreshToken, errors, warnings };
  }

  if (!isEmailLike(email)) {
    errors.push(`第 ${rowNumber} 行 email 格式不正确`);
  }

  if (!UUID_PATTERN.test(clientId)) {
    errors.push(`第 ${rowNumber} 行 client_id 不是 UUID，可能字段顺序写错`);
  }

  if (UUID_PATTERN.test(refreshToken)) {
    errors.push(`第 ${rowNumber} 行 refresh_token 看起来像 client_id，疑似字段顺序错误`);
  }

  if (looksLikeRefreshToken(clientId)) {
    errors.push(`第 ${rowNumber} 行 client_id 看起来像 refresh_token，疑似字段顺序错误`);
  }

  if (looksLikeAccessToken(refreshToken)) {
    errors.push(`第 ${rowNumber} 行 refresh_token 看起来像 access_token，请导入 refresh_token`);
  } else if (!looksLikeRefreshToken(refreshToken)) {
    warnings.push(`第 ${rowNumber} 行 refresh_token 不像常见 Microsoft refresh token，请确认不是复制了密码或 access token`);
  }

  return { email, clientId, refreshToken, errors, warnings };
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
    inboxFolderId: row.inbox_folder_id,
    graphDeltaLink: row.graph_delta_link,
    refreshCooldownUntil: row.refresh_cooldown_until,
    credentialGeneration: row.credential_generation || 0,
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
    inboxFolderId: account.inboxFolderId || null,
    graphDeltaLink: account.graphDeltaLink || null,
    refreshCooldownUntil: account.refreshCooldownUntil || null,
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

function listAccountViews() {
  const rows = getDatabase()
    .prepare(`SELECT ${ACCOUNT_VIEW_COLUMNS} FROM accounts ORDER BY email ASC`)
    .all() as unknown as AccountViewRow[];
  return rows;
}

function listAccountEmails() {
  return getDatabase()
    .prepare("SELECT email FROM accounts")
    .all() as unknown as Array<{ email: string }>;
}

function insertOrReplaceAccount(account: AccountRecord) {
  getDatabase()
    .prepare(`
      INSERT INTO accounts (
        id, email, client_id, encrypted_refresh_token, remark, group_name, status,
        last_checked_at, last_error, last_refreshed_at, last_inbox_count,
        last_mail_at, last_mail_cursor, inbox_folder_id, graph_delta_link,
        refresh_cooldown_until, credential_generation, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        inbox_folder_id = excluded.inbox_folder_id,
        graph_delta_link = excluded.graph_delta_link,
        refresh_cooldown_until = excluded.refresh_cooldown_until,
        credential_generation = excluded.credential_generation,
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
      account.inboxFolderId || null,
      account.graphDeltaLink || null,
      account.refreshCooldownUntil || null,
      account.credentialGeneration,
      account.createdAt,
      account.updatedAt
    );
}

function normalizeLegacyTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function parseLegacyAccount(value: unknown): AccountRecord | null {
  const parsed = legacyAccountSchema.safeParse(value);
  if (!parsed.success || !isEmailLike(parsed.data.email)) {
    return null;
  }

  const timestamp = nowIso();
  const account: AccountRecord = {
    id: parsed.data.id,
    email: normalizeEmail(parsed.data.email),
    clientId: parsed.data.clientId,
    encryptedRefreshToken: parsed.data.encryptedRefreshToken,
    remark: parsed.data.remark || "",
    group: parsed.data.group || "",
    status: parsed.data.status || "untested",
    lastCheckedAt: normalizeLegacyTimestamp(parsed.data.lastCheckedAt),
    lastError: parsed.data.lastError || null,
    lastRefreshedAt: normalizeLegacyTimestamp(parsed.data.lastRefreshedAt),
    lastInboxCount: parsed.data.lastInboxCount || 0,
    lastMailAt: normalizeLegacyTimestamp(parsed.data.lastMailAt),
    lastMailCursor: parsed.data.lastMailCursor || null,
    inboxFolderId: parsed.data.inboxFolderId || null,
    graphDeltaLink: parsed.data.graphDeltaLink || null,
    refreshCooldownUntil: normalizeLegacyTimestamp(parsed.data.refreshCooldownUntil),
    credentialGeneration: parsed.data.credentialGeneration || 0,
    createdAt: normalizeLegacyTimestamp(parsed.data.createdAt) || timestamp,
    updatedAt: normalizeLegacyTimestamp(parsed.data.updatedAt) || timestamp
  };

  try {
    return normalizeLegacyAccount(account);
  } catch {
    // 字段错位修复需要重新加密；系统凭据服务暂不可用时仍保留原账号，等待后续重试。
    return account;
  }
}

async function backupBrokenLegacyStore(storePath: string) {
  await copyFile(storePath, `${storePath}.broken-${Date.now()}.bak`).catch(() => undefined);
}

async function readLegacyStore(): Promise<StoreFile> {
  const storePath = getStorePath();
  let raw: string;
  try {
    raw = await readFile(storePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, accounts: [] };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    await backupBrokenLegacyStore(storePath);
    return { version: STORE_VERSION, accounts: [] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await backupBrokenLegacyStore(storePath);
    return { version: STORE_VERSION, accounts: [] };
  }

  const candidate = parsed as Record<string, unknown>;
  if (!Array.isArray(candidate.accounts)) {
    await backupBrokenLegacyStore(storePath);
    return { version: STORE_VERSION, accounts: [] };
  }

  const accounts: AccountRecord[] = [];
  const accountIds = new Set<string>();
  const emails = new Set<string>();
  let damaged = typeof candidate.version !== "number";

  for (const value of candidate.accounts) {
    const account = parseLegacyAccount(value);
    if (!account || accountIds.has(account.id) || emails.has(account.email)) {
      damaged = true;
      continue;
    }
    accountIds.add(account.id);
    emails.add(account.email);
    accounts.push(account);
  }

  if (damaged) {
    await backupBrokenLegacyStore(storePath);
  }

  return {
    version: typeof candidate.version === "number" ? candidate.version : STORE_VERSION,
    accounts
  };
}

async function migrateLegacyAccounts() {
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

async function migrateLegacyAccountsOnce() {
  if (!legacyAccountsMigration) {
    legacyAccountsMigration = migrateLegacyAccounts().catch((error) => {
      legacyAccountsMigration = null;
      throw error;
    });
  }

  return legacyAccountsMigration;
}

export async function listAccounts(): Promise<AccountView[]> {
  await migrateLegacyAccountsOnce();
  return listAccountViews();
}

export async function getAccountRecord(accountId: string): Promise<AccountRecord> {
  await migrateLegacyAccountsOnce();
  const account = getAccountById(accountId);

  if (!account) {
    throw new Error("账号不存在");
  }

  return account;
}

export async function getAccountCredentials(accountId: string) {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    const account = getAccountById(accountId);
    if (!account) {
      throw new Error("账号不存在");
    }
    return {
      account,
      accountId: account.id,
      email: account.email,
      clientId: account.clientId,
      refreshToken: decryptSecret(account.encryptedRefreshToken),
      credentialGeneration: account.credentialGeneration
    };
  });
}

export async function getRefreshToken(accountId: string): Promise<string> {
  return (await getAccountCredentials(accountId)).refreshToken;
}

export async function assertAccountCredentialGeneration(accountId: string, expectedGeneration: number): Promise<void> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    const account = getAccountById(accountId);
    if (!account) {
      throw new Error("账号不存在");
    }
    if (account.credentialGeneration !== expectedGeneration) {
      throw new CredentialsChangedError();
    }
  });
}

export async function findAccountIdsByEmails(emails: Iterable<string>): Promise<string[]> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    const accountIds = new Set<string>();
    for (const email of emails) {
      const account = getAccountByEmail(normalizeEmail(email));
      if (account) {
        accountIds.add(account.id);
      }
    }
    return [...accountIds].sort();
  });
}

export async function previewAccounts(inputs: AccountInput[]): Promise<ImportPreviewResult> {
  await migrateLegacyAccountsOnce();
  const existingEmails = new Set(listAccountEmails().map((account) => account.email));
  const seenEmails = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  let valid = 0;
  let duplicates = 0;
  let invalid = 0;

  for (const [index, input] of inputs.entries()) {
    const result = validateImportInput(input, index + 1);
    errors.push(...result.errors);
    warnings.push(...result.warnings);

    if (result.errors.length > 0) {
      invalid += 1;
      continue;
    }

    valid += 1;
    if (existingEmails.has(result.email) || seenEmails.has(result.email)) {
      duplicates += 1;
    }
    seenEmails.add(result.email);
  }

  return {
    total: inputs.length,
    valid,
    duplicates,
    invalid,
    errors,
    warnings
  };
}

export async function upsertAccounts(inputs: AccountInput[]) {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];
    const affectedAccountIds: string[] = [];

    transaction(() => {
      for (const [index, input] of inputs.entries()) {
        const result = validateImportInput(input, index + 1);
        const email = result.email;
        const clientId = result.clientId;
        const refreshToken = result.refreshToken;

        if (result.errors.length > 0) {
          skipped += 1;
          errors.push(...result.errors);
          continue;
        }

        const existing = getAccountByEmail(email);
        const timestamp = nowIso();

        if (existing) {
          credentialGenerations.invalidateAccounts([existing.id]);
          affectedAccountIds.push(existing.id);
          insertOrReplaceAccount({
            ...existing,
            clientId,
            encryptedRefreshToken: encryptSecret(refreshToken),
            remark: input.remark?.trim() || existing.remark,
            group: input.group?.trim() || existing.group,
            status: "untested",
            lastError: null,
            credentialGeneration: existing.credentialGeneration + 1,
            updatedAt: timestamp
          });
          updated += 1;
          continue;
        }

        const accountId = crypto.randomUUID();
        credentialGenerations.invalidateAccounts([accountId]);
        affectedAccountIds.push(accountId);
        insertOrReplaceAccount({
          id: accountId,
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
          inboxFolderId: null,
          graphDeltaLink: null,
          refreshCooldownUntil: null,
          credentialGeneration: 1,
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
      affectedAccountIds: [...new Set(affectedAccountIds)],
      accounts: listAccountViews()
    };
  });
}

export async function deleteAccount(accountId: string): Promise<AccountView[]> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    if (!getAccountById(accountId)) {
      throw new Error("账号不存在");
    }
    credentialGenerations.invalidateAccounts([accountId]);
    transaction(() => {
      const db = getDatabase();
      db.prepare("DELETE FROM mail_messages WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM mail_details WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM mail_cache_meta WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    });

    return listAccountViews();
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

    credentialGenerations.invalidateAccounts([account.id]);
    const next: AccountRecord = {
      ...account,
      email,
      clientId,
      remark: input.remark?.trim() || "",
      group: input.group?.trim() || "",
      status: "untested",
      lastError: null,
      credentialGeneration: account.credentialGeneration + 1,
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
  refreshToken?: string,
  options: {
    expectedCredentialGeneration?: number;
    assertCurrent?: () => void;
    afterCommit?: () => void;
  } = {}
): Promise<AccountView> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    const account = getAccountById(accountId);

    if (!account) {
      throw new Error("账号不存在");
    }
    if (
      options.expectedCredentialGeneration !== undefined &&
      account.credentialGeneration !== options.expectedCredentialGeneration
    ) {
      throw new CredentialsChangedError();
    }
    options.assertCurrent?.();

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
    options.afterCommit?.();
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
    inboxFolderId?: string | null;
    graphDeltaLink?: string | null;
    refreshCooldownUntil?: string | null;
  },
  options: { assertCurrent?: () => void } = {}
): Promise<AccountView> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    const account = getAccountById(accountId);

    if (!account) {
      throw new Error("账号不存在");
    }
    options.assertCurrent?.();

    const timestamp = nowIso();
    const refreshTimestamps = resolveRefreshTimestamps(account.lastRefreshedAt, timestamp, true);
    const next: AccountRecord = {
      ...account,
      status: values.status,
      lastError: values.lastError,
      lastCheckedAt: refreshTimestamps.lastCheckedAt,
      lastRefreshedAt: refreshTimestamps.lastRefreshedAt,
      lastInboxCount: values.lastInboxCount,
      lastMailAt: values.lastMailAt,
      lastMailCursor: values.lastMailCursor ?? account.lastMailCursor ?? null,
      inboxFolderId: values.inboxFolderId ?? account.inboxFolderId ?? null,
      graphDeltaLink: values.graphDeltaLink ?? account.graphDeltaLink ?? null,
      refreshCooldownUntil: values.refreshCooldownUntil ?? account.refreshCooldownUntil ?? null,
      updatedAt: timestamp
    };

    insertOrReplaceAccount(next);
    return toView(next);
  });
}

export async function updateAccountInboxFolder(
  accountId: string,
  inboxFolderId: string,
  options: { assertCurrent?: () => void } = {}
): Promise<AccountView> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    const account = getAccountById(accountId);
    if (!account) {
      throw new Error("账号不存在");
    }
    options.assertCurrent?.();

    const next: AccountRecord = {
      ...account,
      inboxFolderId,
      graphDeltaLink: null,
      updatedAt: nowIso()
    };
    insertOrReplaceAccount(next);
    return toView(next);
  });
}

export async function updateAccountRefreshFailure(
  accountId: string,
  values: {
    status: AccountRecord["status"];
    lastError: string;
    refreshCooldownUntil?: string | null;
  },
  options: { assertCurrent?: () => void } = {}
): Promise<AccountView> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    const account = getAccountById(accountId);
    if (!account) {
      throw new Error("账号不存在");
    }
    options.assertCurrent?.();
    const timestamp = nowIso();
    const refreshTimestamps = resolveRefreshTimestamps(account.lastRefreshedAt, timestamp, false);
    const next: AccountRecord = {
      ...account,
      status: values.status,
      lastError: values.lastError,
      lastCheckedAt: refreshTimestamps.lastCheckedAt,
      lastRefreshedAt: refreshTimestamps.lastRefreshedAt,
      refreshCooldownUntil: values.refreshCooldownUntil ?? account.refreshCooldownUntil ?? null,
      updatedAt: timestamp
    };

    insertOrReplaceAccount(next);
    return toView(next);
  });
}

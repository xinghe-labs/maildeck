import { app } from "electron";
import { copyFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getDatabase, transaction } from "./database.js";
import { normalizeMailDate } from "./mail-date-normalizer.js";
import { normalizeMailContentType, normalizeMailText } from "./mail-text-normalizer.js";
import type { MailMessageDetail, MailMessageSummary } from "./types.js";
import { FileTooLargeError, readUtf8FileBounded } from "./bounded-file-reader.js";

interface CacheRecord {
  accountId: string;
  messages: MailMessageSummary[];
  details: Record<string, MailMessageDetail>;
  detailUpdatedAt?: Record<string, string>;
  nextCursor?: string | null;
  updatedAt: string | null;
}

interface CacheFile {
  version: number;
  accounts: Record<string, CacheRecord>;
}

interface MailMessageRow {
  message_id: string;
  subject: string;
  from_name: string | null;
  from_address: string | null;
  received_date_time: string | null;
  sent_date_time: string | null;
  is_read: number;
  importance: string;
  has_attachments: number;
  body_preview: string | null;
  web_link: string | null;
}

interface MailMetaRow {
  next_cursor: string | null;
  updated_at: string | null;
}

const KEEP_EXISTING_CURSOR = Symbol("keep-existing-cursor");

interface MailDetailRow {
  detail_json: string;
  updated_at: string | null;
}

interface StoredMailDetailV2 {
  version: 2;
  detail: MailMessageDetail;
}

const cachedMailAddressSchema = z.object({
  name: z.string().nullable().optional(),
  address: z.string().nullable().optional()
});

const cachedMailSummarySchema = z.object({
  id: z.string().min(1),
  subject: z.string().nullable().optional(),
  from: cachedMailAddressSchema.nullable().optional(),
  receivedDateTime: z.string().nullable().optional(),
  sentDateTime: z.string().nullable().optional(),
  isRead: z.boolean().optional(),
  importance: z.string().nullable().optional(),
  hasAttachments: z.boolean().optional(),
  bodyPreview: z.string().nullable().optional(),
  webLink: z.string().nullable().optional()
});

const cachedMailDetailSchema = z.object({
  id: z.string().min(1),
  subject: z.string().nullable().optional(),
  from: cachedMailAddressSchema.nullable().optional(),
  receivedDateTime: z.string().nullable().optional(),
  sentDateTime: z.string().nullable().optional(),
  isRead: z.boolean().optional(),
  importance: z.string().nullable().optional(),
  hasAttachments: z.boolean().optional(),
  bodyPreview: z.string().nullable().optional(),
  webLink: z.string().nullable().optional(),
  toRecipients: z.array(cachedMailAddressSchema).nullable().optional(),
  ccRecipients: z.array(cachedMailAddressSchema).nullable().optional(),
  body: z.object({
    contentType: z.string().nullable().optional(),
    content: z.string().nullable().optional()
  }).nullable().optional()
});

const storedMailDetailV2Schema = z.object({
  version: z.literal(2),
  detail: cachedMailDetailSchema
});

type CachedMailDetail = z.infer<typeof cachedMailDetailSchema>;
type CachedMailSummary = z.infer<typeof cachedMailSummarySchema>;

const CACHE_VERSION = 1;
export const LEGACY_MAIL_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const MAX_MESSAGES_PER_ACCOUNT = 100;
const MAX_DETAILS_PER_ACCOUNT = 40;
const MESSAGE_CACHE_TTL_MS = 5 * 60 * 1000;
let cacheQueue = Promise.resolve();
let legacyCacheMigration: Promise<void> | null = null;

async function withCacheLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = cacheQueue;
  let release!: () => void;
  cacheQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release();
  }
}

function nowIso() {
  return new Date().toISOString();
}

function getCachePath() {
  return path.join(app.getPath("userData"), "mail-cache.json");
}

function emptyCache(): CacheFile {
  return {
    version: CACHE_VERSION,
    accounts: {}
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeCachedSummary(message: CachedMailSummary): MailMessageSummary {
  const from = message.from;
  return {
    id: message.id,
    subject: normalizeMailText(message.subject),
    from: from && (from.name || from.address)
      ? { name: normalizeMailText(from.name), address: from.address || "" }
      : null,
    receivedDateTime: normalizeMailDate(message.receivedDateTime),
    sentDateTime: normalizeMailDate(message.sentDateTime),
    isRead: message.isRead === true,
    importance: message.importance || "normal",
    hasAttachments: message.hasAttachments === true,
    bodyPreview: normalizeMailText(message.bodyPreview),
    webLink: message.webLink || null
  };
}

function parseLegacyCacheRecord(value: unknown): { record: CacheRecord; damaged: boolean } | null {
  const candidate = asRecord(value);
  const accountId = typeof candidate?.accountId === "string" ? candidate.accountId.trim() : "";
  if (!candidate || !accountId || accountId.length > 128) {
    return null;
  }

  let damaged = false;
  const messages: MailMessageSummary[] = [];
  const messageIds = new Set<string>();
  if (!Array.isArray(candidate.messages)) {
    damaged = true;
  } else {
    for (const value of candidate.messages) {
      const parsed = cachedMailSummarySchema.safeParse(value);
      if (!parsed.success || messageIds.has(parsed.data.id)) {
        damaged = true;
        continue;
      }
      messageIds.add(parsed.data.id);
      messages.push(normalizeCachedSummary(parsed.data));
    }
  }

  const details: Record<string, MailMessageDetail> = Object.create(null) as Record<string, MailMessageDetail>;
  const rawDetails = asRecord(candidate.details);
  if (!rawDetails) {
    damaged = true;
  } else {
    for (const value of Object.values(rawDetails)) {
      const parsed = cachedMailDetailSchema.safeParse(value);
      if (!parsed.success || Object.prototype.hasOwnProperty.call(details, parsed.data.id)) {
        damaged = true;
        continue;
      }
      details[parsed.data.id] = normalizeCachedDetail(parsed.data);
    }
  }

  const detailUpdatedAt: Record<string, string> = Object.create(null) as Record<string, string>;
  if (candidate.detailUpdatedAt !== undefined) {
    const rawDetailTimestamps = asRecord(candidate.detailUpdatedAt);
    if (!rawDetailTimestamps) {
      damaged = true;
    } else {
      for (const [messageId, value] of Object.entries(rawDetailTimestamps)) {
        const normalized = normalizeMailDate(value);
        if (!normalized) {
          damaged = true;
          continue;
        }
        detailUpdatedAt[messageId] = normalized;
      }
    }
  }

  let nextCursor: string | null = null;
  if (candidate.nextCursor === null || candidate.nextCursor === undefined) {
    nextCursor = null;
  } else if (typeof candidate.nextCursor === "string" && candidate.nextCursor.length <= 16_384) {
    nextCursor = candidate.nextCursor;
  } else {
    damaged = true;
  }

  const updatedAt = normalizeMailDate(candidate.updatedAt);
  if (candidate.updatedAt !== null && candidate.updatedAt !== undefined && !updatedAt) {
    damaged = true;
  }

  return {
    damaged,
    record: {
      accountId,
      messages,
      details,
      detailUpdatedAt,
      nextCursor,
      updatedAt
    }
  };
}

async function backupBrokenLegacyCache(cachePath: string) {
  await copyFile(cachePath, `${cachePath}.broken-${Date.now()}.bak`).catch(() => undefined);
}

async function readLegacyCache(): Promise<CacheFile> {
  const cachePath = getCachePath();
  let raw: string;
  try {
    raw = await readUtf8FileBounded(cachePath, LEGACY_MAIL_CACHE_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyCache();
    }
    if (error instanceof FileTooLargeError) {
      await backupBrokenLegacyCache(cachePath);
      return emptyCache();
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
    await backupBrokenLegacyCache(cachePath);
    return emptyCache();
  }

  const candidate = asRecord(parsed);
  if (!candidate) {
    await backupBrokenLegacyCache(cachePath);
    return emptyCache();
  }
  if (typeof candidate.version === "number" && candidate.version > CACHE_VERSION) {
    return emptyCache();
  }

  const rawAccounts = asRecord(candidate.accounts);
  if (!rawAccounts) {
    await backupBrokenLegacyCache(cachePath);
    return emptyCache();
  }

  const accounts: Record<string, CacheRecord> = Object.create(null) as Record<string, CacheRecord>;
  const accountIds = new Set<string>();
  let damaged = typeof candidate.version !== "number";
  for (const value of Object.values(rawAccounts)) {
    const parsedRecord = parseLegacyCacheRecord(value);
    if (!parsedRecord || accountIds.has(parsedRecord.record.accountId)) {
      damaged = true;
      continue;
    }
    damaged ||= parsedRecord.damaged;
    accountIds.add(parsedRecord.record.accountId);
    accounts[parsedRecord.record.accountId] = parsedRecord.record;
  }

  if (damaged) {
    await backupBrokenLegacyCache(cachePath);
  }

  return {
    version: typeof candidate.version === "number" ? candidate.version : CACHE_VERSION,
    accounts
  };
}

function isFresh(updatedAt: string | null) {
  if (!updatedAt) {
    return false;
  }

  const timestamp = new Date(updatedAt).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= MESSAGE_CACHE_TTL_MS;
}

function rowToMessage(row: MailMessageRow): MailMessageSummary {
  return {
    id: row.message_id,
    subject: normalizeMailText(row.subject),
    from: row.from_name || row.from_address ? { name: normalizeMailText(row.from_name), address: row.from_address || "" } : null,
    receivedDateTime: row.received_date_time,
    sentDateTime: row.sent_date_time,
    isRead: Boolean(row.is_read),
    importance: row.importance || "normal",
    hasAttachments: Boolean(row.has_attachments),
    bodyPreview: normalizeMailText(row.body_preview),
    webLink: row.web_link
  };
}

function saveMessagesSync(accountId: string, messages: MailMessageSummary[], nextCursor: string | null | typeof KEEP_EXISTING_CURSOR) {
  const db = getDatabase();
  const timestamp = nowIso();
  const upsert = db.prepare(`
    INSERT INTO mail_messages (
      account_id, message_id, subject, from_name, from_address,
      received_date_time, sent_date_time, is_read, importance,
      has_attachments, body_preview, web_link, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, message_id) DO UPDATE SET
      subject = excluded.subject,
      from_name = excluded.from_name,
      from_address = excluded.from_address,
      received_date_time = excluded.received_date_time,
      sent_date_time = excluded.sent_date_time,
      is_read = excluded.is_read,
      importance = excluded.importance,
      has_attachments = excluded.has_attachments,
      body_preview = excluded.body_preview,
      web_link = excluded.web_link,
      updated_at = excluded.updated_at
  `);

  for (const message of messages) {
    upsert.run(
      accountId,
      message.id,
      message.subject,
      message.from?.name || null,
      message.from?.address || null,
      message.receivedDateTime,
      message.sentDateTime,
      message.isRead ? 1 : 0,
      message.importance,
      message.hasAttachments ? 1 : 0,
      message.bodyPreview,
      message.webLink,
      timestamp
    );
  }

  if (nextCursor === KEEP_EXISTING_CURSOR) {
    db.prepare(`
      INSERT INTO mail_cache_meta (account_id, next_cursor, updated_at)
      VALUES (?, NULL, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        updated_at = excluded.updated_at
    `).run(accountId, timestamp);
  } else {
    db.prepare(`
      INSERT INTO mail_cache_meta (account_id, next_cursor, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        next_cursor = excluded.next_cursor,
        updated_at = excluded.updated_at
    `).run(accountId, nextCursor, timestamp);
  }

  const staleRows = db
    .prepare(`
      SELECT message_id FROM mail_messages
      WHERE account_id = ?
      ORDER BY COALESCE(received_date_time, sent_date_time, updated_at) DESC
      LIMIT -1 OFFSET ?
    `)
    .all(accountId, MAX_MESSAGES_PER_ACCOUNT) as Array<{ message_id: string }>;
  const deleteMessage = db.prepare("DELETE FROM mail_messages WHERE account_id = ? AND message_id = ?");
  for (const row of staleRows) {
    deleteMessage.run(accountId, row.message_id);
  }
}

async function migrateLegacyCache() {
  const db = getDatabase();
  const existing = db.prepare("SELECT COUNT(*) AS count FROM mail_messages").get() as { count: number };
  if (existing.count > 0) {
    return;
  }

  const legacy = await readLegacyCache();
  const accountRows = db.prepare("SELECT id FROM accounts").all() as Array<{ id: string }>;
  const accountIds = new Set(accountRows.map((row) => row.id));
  const records = Object.values(legacy.accounts).filter((record) => accountIds.has(record.accountId));
  if (records.length === 0) {
    return;
  }

  transaction(() => {
    for (const record of records) {
      if (record.messages.length > 0) {
        saveMessagesSync(record.accountId, record.messages, record.nextCursor ?? null);
      }

      const detailUpsert = db.prepare(`
        INSERT INTO mail_details (account_id, message_id, detail_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, message_id) DO UPDATE SET
          detail_json = excluded.detail_json,
          updated_at = excluded.updated_at
      `);
      for (const detail of Object.values(record.details)) {
        detailUpsert.run(
          record.accountId,
          detail.id,
          serializeMailDetail(detail),
          record.detailUpdatedAt?.[detail.id] || record.updatedAt || nowIso()
        );
      }
    }
  });

  const cachePath = getCachePath();
  await copyFile(cachePath, `${cachePath}.migrated-${Date.now()}.bak`).catch(() => undefined);
  await rename(cachePath, `${cachePath}.migrated`).catch(() => undefined);
}

async function migrateLegacyCacheOnce() {
  if (!legacyCacheMigration) {
    legacyCacheMigration = migrateLegacyCache().catch((error) => {
      legacyCacheMigration = null;
      throw error;
    });
  }

  return legacyCacheMigration;
}

export async function getCachedMessages(accountId: string, search = "", top = 50, enabled = true) {
  await migrateLegacyCacheOnce();
  if (!enabled) {
    return [];
  }

  const meta = getDatabase()
    .prepare("SELECT next_cursor, updated_at FROM mail_cache_meta WHERE account_id = ?")
    .get(accountId) as MailMetaRow | undefined;
  if (!meta || !isFresh(meta.updated_at)) {
    return [];
  }

  const query = search.trim().toLowerCase();
  const rows = getDatabase()
    .prepare(`
      SELECT * FROM mail_messages
      WHERE account_id = ?
      ORDER BY COALESCE(received_date_time, sent_date_time, updated_at) DESC
      LIMIT ?
    `)
    .all(accountId, query ? MAX_MESSAGES_PER_ACCOUNT : Math.max(1, top)) as unknown as MailMessageRow[];

  const messages = rows.map(rowToMessage);

  return query
    ? messages.filter((message) =>
        [message.subject, message.bodyPreview, message.from?.name || "", message.from?.address || ""]
          .join("\n")
          .toLowerCase()
          .includes(query)
      ).slice(0, Math.max(1, top))
    : messages;
}

export async function getCachedCursor(accountId: string) {
  await migrateLegacyCacheOnce();
  const row = getDatabase()
    .prepare("SELECT next_cursor FROM mail_cache_meta WHERE account_id = ?")
    .get(accountId) as { next_cursor: string | null } | undefined;
  return row?.next_cursor || null;
}

export async function saveCachedMessages(
  accountId: string,
  messages: MailMessageSummary[],
  enabled = true,
  nextCursor?: string | null,
  options: { readBack?: boolean; assertCurrent?: () => void } = {}
) {
  await migrateLegacyCacheOnce();
  if (!enabled) {
    return messages;
  }

  return withCacheLock(async () => {
    options.assertCurrent?.();
    transaction(() => {
      saveMessagesSync(accountId, messages, nextCursor === undefined ? KEEP_EXISTING_CURSOR : nextCursor);
    });

    return options.readBack === false ? messages : getCachedMessages(accountId, "", MAX_MESSAGES_PER_ACCOUNT, true);
  });
}

function looksLikeLegacyTextAsHtml(detail: MailMessageDetail) {
  if (detail.body.contentType.toLowerCase() === "html") {
    return false;
  }

  const value = detail.body.content.trim();
  if (!/^<p>[\s\S]*<\/p>$/iu.test(value)) {
    return false;
  }

  const remainingMarkup = value
    .replace(/<\/?p>/giu, "")
    .replace(/<br\s*\/?\s*>/giu, "")
    .replace(/<a\b[^>]*>|<\/a>/giu, "");
  return !/<\/?[a-z][^>]*>/iu.test(remainingMarkup);
}

function parseStoredMailDetail(value: string) {
  let stored: unknown;
  try {
    stored = JSON.parse(value) as unknown;
  } catch {
    return null;
  }

  const versioned = storedMailDetailV2Schema.safeParse(stored);
  if (versioned.success) {
    return normalizeCachedDetail(versioned.data.detail);
  }

  const legacy = cachedMailDetailSchema.safeParse(stored);
  if (!legacy.success) {
    return null;
  }

  const detail = normalizeCachedDetail(legacy.data);
  if (looksLikeLegacyTextAsHtml(detail)) {
    return {
      ...detail,
      body: { ...detail.body, contentType: "html" }
    };
  }
  return detail;
}

function normalizeCachedDetail(detail: CachedMailDetail): MailMessageDetail {
  const body = detail.body ?? {};
  const toRecipients = detail.toRecipients ?? [];
  const ccRecipients = detail.ccRecipients ?? [];
  return {
    id: detail.id,
    subject: normalizeMailText(detail.subject),
    bodyPreview: normalizeMailText(detail.bodyPreview),
    from: detail.from ? { name: normalizeMailText(detail.from.name), address: detail.from.address || "" } : null,
    receivedDateTime: normalizeMailDate(detail.receivedDateTime),
    sentDateTime: normalizeMailDate(detail.sentDateTime),
    isRead: detail.isRead === true,
    importance: detail.importance || "normal",
    hasAttachments: detail.hasAttachments === true,
    webLink: detail.webLink || null,
    toRecipients: toRecipients.map((item) => ({ name: normalizeMailText(item.name), address: item.address || "" })),
    ccRecipients: ccRecipients.map((item) => ({ name: normalizeMailText(item.name), address: item.address || "" })),
    body: {
      contentType: normalizeMailContentType(body.contentType),
      content: normalizeMailText(body.content)
    }
  };
}

function serializeMailDetail(detail: MailMessageDetail) {
  return JSON.stringify({ version: 2, detail } satisfies StoredMailDetailV2);
}

export async function getCachedMessageDetail(accountId: string, messageId: string, enabled = true) {
  await migrateLegacyCacheOnce();
  if (!enabled) {
    return null;
  }

  const row = getDatabase()
    .prepare("SELECT detail_json, updated_at FROM mail_details WHERE account_id = ? AND message_id = ?")
    .get(accountId, messageId) as MailDetailRow | undefined;
  if (!row || !isFresh(row.updated_at)) {
    return null;
  }

  const detail = parseStoredMailDetail(row.detail_json);
  if (detail) {
    return detail;
  }

  getDatabase()
    .prepare("DELETE FROM mail_details WHERE account_id = ? AND message_id = ? AND detail_json = ?")
    .run(accountId, messageId, row.detail_json);
  return null;
}

export async function saveCachedMessageDetail(
  accountId: string,
  detail: MailMessageDetail,
  enabled = true,
  options: { assertCurrent?: () => void } = {}
) {
  await migrateLegacyCacheOnce();
  if (!enabled) {
    return;
  }

  return withCacheLock(async () => {
    options.assertCurrent?.();
    transaction(() => {
      const db = getDatabase();
      db.prepare(`
        INSERT INTO mail_details (account_id, message_id, detail_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, message_id) DO UPDATE SET
          detail_json = excluded.detail_json,
          updated_at = excluded.updated_at
      `).run(accountId, detail.id, serializeMailDetail(detail), nowIso());

      const staleRows = db
        .prepare(`
          SELECT message_id FROM mail_details
          WHERE account_id = ?
          ORDER BY updated_at DESC
          LIMIT -1 OFFSET ?
        `)
        .all(accountId, MAX_DETAILS_PER_ACCOUNT) as Array<{ message_id: string }>;
      const deleteDetail = db.prepare("DELETE FROM mail_details WHERE account_id = ? AND message_id = ?");
      for (const row of staleRows) {
        deleteDetail.run(accountId, row.message_id);
      }
    });
  });
}

export async function clearAccountCache(accountId: string) {
  await migrateLegacyCacheOnce();
  return withCacheLock(async () => {
    transaction(() => {
      const db = getDatabase();
      db.prepare("DELETE FROM mail_messages WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM mail_details WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM mail_cache_meta WHERE account_id = ?").run(accountId);
    });
  });
}

export async function clearAllMailCache() {
  await migrateLegacyCacheOnce();
  return withCacheLock(async () => {
    transaction(() => {
      const db = getDatabase();
      db.prepare("DELETE FROM mail_messages").run();
      db.prepare("DELETE FROM mail_details").run();
      db.prepare("DELETE FROM mail_cache_meta").run();
    });
  });
}

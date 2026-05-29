import { app } from "electron";
import { copyFile, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { getDatabase, transaction } from "./database.js";
import type { MailMessageDetail, MailMessageSummary } from "./types.js";

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

interface MailDetailRow {
  detail_json: string;
  updated_at: string | null;
}

const CACHE_VERSION = 1;
const MAX_MESSAGES_PER_ACCOUNT = 100;
const MAX_DETAILS_PER_ACCOUNT = 40;
const MESSAGE_CACHE_TTL_MS = 5 * 60 * 1000;
let cacheQueue = Promise.resolve();
let migratedLegacyCache = false;

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

async function readLegacyCache(): Promise<CacheFile> {
  try {
    const raw = await readFile(getCachePath(), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    return {
      version: parsed.version || CACHE_VERSION,
      accounts: parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return emptyCache();
    }

    throw error;
  }
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
    subject: row.subject,
    from: row.from_name || row.from_address ? { name: row.from_name || "", address: row.from_address || "" } : null,
    receivedDateTime: row.received_date_time,
    sentDateTime: row.sent_date_time,
    isRead: Boolean(row.is_read),
    importance: row.importance || "normal",
    hasAttachments: Boolean(row.has_attachments),
    bodyPreview: row.body_preview || "",
    webLink: row.web_link
  };
}

function saveMessagesSync(accountId: string, messages: MailMessageSummary[], nextCursor?: string | null) {
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

  db.prepare(`
    INSERT INTO mail_cache_meta (account_id, next_cursor, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      next_cursor = COALESCE(excluded.next_cursor, mail_cache_meta.next_cursor),
      updated_at = excluded.updated_at
  `).run(accountId, nextCursor ?? null, timestamp);

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

async function migrateLegacyCacheOnce() {
  if (migratedLegacyCache) {
    return;
  }

  migratedLegacyCache = true;

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
        saveMessagesSync(record.accountId, record.messages, record.nextCursor);
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
          JSON.stringify(detail),
          record.detailUpdatedAt?.[detail.id] || record.updatedAt || nowIso()
        );
      }
    }
  });

  const cachePath = getCachePath();
  await copyFile(cachePath, `${cachePath}.migrated-${Date.now()}.bak`).catch(() => undefined);
  await rename(cachePath, `${cachePath}.migrated`).catch(() => undefined);
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
  options: { readBack?: boolean } = {}
) {
  await migrateLegacyCacheOnce();
  if (!enabled) {
    return messages;
  }

  return withCacheLock(async () => {
    transaction(() => {
      saveMessagesSync(accountId, messages, nextCursor);
    });

    return options.readBack === false ? messages : getCachedMessages(accountId, "", MAX_MESSAGES_PER_ACCOUNT, true);
  });
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

  return JSON.parse(row.detail_json) as MailMessageDetail;
}

export async function saveCachedMessageDetail(accountId: string, detail: MailMessageDetail, enabled = true) {
  await migrateLegacyCacheOnce();
  if (!enabled) {
    return;
  }

  return withCacheLock(async () => {
    transaction(() => {
      const db = getDatabase();
      db.prepare(`
        INSERT INTO mail_details (account_id, message_id, detail_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, message_id) DO UPDATE SET
          detail_json = excluded.detail_json,
          updated_at = excluded.updated_at
      `).run(accountId, detail.id, JSON.stringify(detail), nowIso());

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

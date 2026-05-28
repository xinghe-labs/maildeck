import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

let database: DatabaseSync | null = null;
const CURRENT_SCHEMA_VERSION = 2;

export function getDatabase() {
  if (database) {
    return database;
  }

  const userDataPath = app.getPath("userData");
  mkdirSync(userDataPath, { recursive: true });
  database = new DatabaseSync(path.join(userDataPath, "outlook-manager.db"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

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
      inbox_folder_id TEXT,
      refresh_cooldown_until TEXT,
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
  `);

  const columns = database.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("inbox_folder_id")) {
    database.exec("ALTER TABLE accounts ADD COLUMN inbox_folder_id TEXT");
  }
  if (!columnNames.has("refresh_cooldown_until")) {
    database.exec("ALTER TABLE accounts ADD COLUMN refresh_cooldown_until TEXT");
  }

  database
    .prepare(`
      INSERT INTO schema_migrations (id, version, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = CASE
          WHEN schema_migrations.version < excluded.version THEN excluded.version
          ELSE schema_migrations.version
        END,
        updated_at = CASE
          WHEN schema_migrations.version < excluded.version THEN excluded.updated_at
          ELSE schema_migrations.updated_at
        END
    `)
    .run(CURRENT_SCHEMA_VERSION, new Date().toISOString());

  return database;
}

export function closeDatabase() {
  if (!database) {
    return;
  }

  database.close();
  database = null;
}

export function transaction<T>(operation: () => T): T {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

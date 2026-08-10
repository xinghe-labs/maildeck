import type { DatabaseSync } from "node:sqlite";

export interface DatabaseMigration {
  version: number;
  up: (database: DatabaseSync) => void;
  verifySource?: (database: DatabaseSync) => void;
  verify?: (database: DatabaseSync) => void;
}

export const CURRENT_SCHEMA_VERSION = 5;

function tableExists(database: DatabaseSync, tableName: string) {
  return Boolean(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)
  );
}

function accountColumns(database: DatabaseSync) {
  if (!tableExists(database, "accounts")) {
    return new Set<string>();
  }

  const columns = database.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

interface TableColumn {
  name: string;
  pk: number;
}

function tableColumns(database: DatabaseSync, tableName: string) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all() as unknown as TableColumn[];
}

function addAccountColumnIfMissing(database: DatabaseSync, name: string, definition: string) {
  if (!accountColumns(database).has(name)) {
    database.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${definition}`);
  }
}

function assertTables(database: DatabaseSync, tableNames: string[]) {
  for (const tableName of tableNames) {
    if (!tableExists(database, tableName)) {
      throw new Error(`Database migration verification failed: missing table ${tableName}`);
    }
  }
}

function assertAccountColumns(database: DatabaseSync, columnNames: string[]) {
  const columns = accountColumns(database);
  for (const columnName of columnNames) {
    if (!columns.has(columnName)) {
      throw new Error(`Database migration verification failed: missing accounts.${columnName}`);
    }
  }
}

function assertTableColumns(database: DatabaseSync, tableName: string, columnNames: string[]) {
  const columns = new Set(tableColumns(database, tableName).map((column) => column.name));
  for (const columnName of columnNames) {
    if (!columns.has(columnName)) {
      throw new Error(`Database migration verification failed: missing ${tableName}.${columnName}`);
    }
  }
}

function assertPrimaryKey(database: DatabaseSync, tableName: string, expectedColumns: string[]) {
  const primaryKey = tableColumns(database, tableName)
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  if (primaryKey.join("\0") !== expectedColumns.join("\0")) {
    throw new Error(`Database migration verification failed: invalid primary key for ${tableName}`);
  }
}

function assertIndexes(database: DatabaseSync, indexNames: string[]) {
  for (const indexName of indexNames) {
    const row = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(indexName);
    if (!row) {
      throw new Error(`Database migration verification failed: missing index ${indexName}`);
    }
  }
}

const BASE_ACCOUNT_COLUMNS = [
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
  "updated_at"
];

function verifySchemaForVersion(
  database: DatabaseSync,
  version: number,
  options: { allowMissingLegacyAccessTokenCache?: boolean } = {}
) {
  assertTables(database, ["accounts", "mail_cache_meta", "mail_messages", "mail_details", "schema_migrations"]);
  assertAccountColumns(database, BASE_ACCOUNT_COLUMNS);
  assertTableColumns(database, "mail_cache_meta", ["account_id", "next_cursor", "updated_at"]);
  assertTableColumns(database, "mail_messages", [
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
    "updated_at"
  ]);
  assertTableColumns(database, "mail_details", ["account_id", "message_id", "detail_json", "updated_at"]);
  assertTableColumns(database, "schema_migrations", ["id", "version", "updated_at"]);
  assertPrimaryKey(database, "accounts", ["id"]);
  assertPrimaryKey(database, "mail_cache_meta", ["account_id"]);
  assertPrimaryKey(database, "mail_messages", ["account_id", "message_id"]);
  assertPrimaryKey(database, "mail_details", ["account_id", "message_id"]);
  assertPrimaryKey(database, "schema_migrations", ["id"]);
  assertIndexes(database, [
    "idx_accounts_email",
    "idx_accounts_status",
    "idx_accounts_group_name",
    "idx_mail_messages_account_updated",
    "idx_mail_messages_account_received"
  ]);

  if (version >= 2) {
    assertAccountColumns(database, ["inbox_folder_id", "refresh_cooldown_until"]);
  }
  if (version >= 3) {
    assertAccountColumns(database, ["graph_delta_link"]);
  }
  if (version === 4) {
    if (tableExists(database, "access_token_cache")) {
      assertTableColumns(database, "access_token_cache", [
        "account_id",
        "encrypted_access_token",
        "expires_at",
        "scope",
        "auth_mode",
        "updated_at"
      ]);
      assertPrimaryKey(database, "access_token_cache", ["account_id"]);
    } else if (!options.allowMissingLegacyAccessTokenCache) {
      throw new Error("Database migration verification failed: missing table access_token_cache");
    }
  }
  if (version >= 5) {
    assertAccountColumns(database, ["credential_generation"]);
    if (tableExists(database, "access_token_cache")) {
      throw new Error("Database migration verification failed: access_token_cache still exists");
    }
  }
}

export function readSchemaVersion(database: DatabaseSync) {
  if (!tableExists(database, "schema_migrations")) {
    return 0;
  }

  const row = database.prepare("SELECT version FROM schema_migrations WHERE id = 1").get() as
    | { version: number }
    | undefined;
  const version = row?.version ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`Invalid database schema version: ${String(version)}`);
  }
  return version;
}

function writeSchemaVersion(database: DatabaseSync, version: number) {
  database
    .prepare(`
      INSERT INTO schema_migrations (id, version, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        updated_at = excluded.updated_at
    `)
    .run(version, new Date().toISOString());
}

const DATABASE_MIGRATIONS: DatabaseMigration[] = [
  {
    version: 1,
    up(database) {
      database.exec(`
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
      `);
    },
    verify(database) {
      verifySchemaForVersion(database, 1);
    }
  },
  {
    version: 2,
    up(database) {
      addAccountColumnIfMissing(database, "inbox_folder_id", "TEXT");
      addAccountColumnIfMissing(database, "refresh_cooldown_until", "TEXT");
    },
    verify(database) {
      verifySchemaForVersion(database, 2);
    }
  },
  {
    version: 3,
    up(database) {
      addAccountColumnIfMissing(database, "graph_delta_link", "TEXT");
    },
    verify(database) {
      verifySchemaForVersion(database, 3);
    }
  },
  {
    version: 4,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS access_token_cache (
          account_id TEXT PRIMARY KEY,
          encrypted_access_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL DEFAULT '',
          auth_mode TEXT NOT NULL DEFAULT 'graph',
          updated_at TEXT NOT NULL
        );
      `);
    },
    verifySource(database) {
      verifySchemaForVersion(database, 4, { allowMissingLegacyAccessTokenCache: true });
    },
    verify(database) {
      verifySchemaForVersion(database, 4);
    }
  },
  {
    version: 5,
    up(database) {
      addAccountColumnIfMissing(database, "inbox_folder_id", "TEXT");
      addAccountColumnIfMissing(database, "graph_delta_link", "TEXT");
      addAccountColumnIfMissing(database, "refresh_cooldown_until", "TEXT");
      addAccountColumnIfMissing(database, "credential_generation", "INTEGER NOT NULL DEFAULT 0");
      database.exec("DROP TABLE IF EXISTS access_token_cache");
    },
    verify(database) {
      verifySchemaForVersion(database, 5);
    }
  }
];

export function applyDatabaseMigrations(
  database: DatabaseSync,
  migrations: DatabaseMigration[] = DATABASE_MIGRATIONS
) {
  let currentVersion = readSchemaVersion(database);
  const latestVersion = migrations.at(-1)?.version ?? currentVersion;
  if (currentVersion > latestVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than the supported version ${latestVersion}`
    );
  }

  const pending = migrations.filter((migration) => migration.version > currentVersion);
  if (pending.length === 0) {
    migrations.find((migration) => migration.version === currentVersion)?.verify?.(database);
    return currentVersion;
  }

  const currentMigration = migrations.find((migration) => migration.version === currentVersion);
  (currentMigration?.verifySource ?? currentMigration?.verify)?.(database);

  let expectedVersion = currentVersion + 1;
  for (const migration of pending) {
    if (migration.version !== expectedVersion) {
      throw new Error(`Database migration ${expectedVersion} is missing`);
    }
    expectedVersion += 1;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      migration.up(database);
      migration.verify?.(database);
      writeSchemaVersion(database, migration.version);
      currentVersion = migration.version;
    }
    database.exec("COMMIT");
    return currentVersion;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

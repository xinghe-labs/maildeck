import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({ userDataPath: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronState.userDataPath
  }
}));

const temporaryDirectories: string[] = [];

async function createTemporaryUserData() {
  const directory = await mkdtemp(path.join(tmpdir(), "outlook-manager-migrations-"));
  temporaryDirectories.push(directory);
  electronState.userDataPath = directory;
  vi.resetModules();
  return directory;
}

function createVersionFixture(databasePath: string, version: number) {
  const database = new DatabaseSync(databasePath);
  const version2Columns = version >= 2 ? "inbox_folder_id TEXT, refresh_cooldown_until TEXT," : "";
  const version3Columns = version >= 3 ? "graph_delta_link TEXT," : "";
  const version5Columns = version >= 5 ? "credential_generation INTEGER NOT NULL DEFAULT 0," : "";

  database.exec(`
    CREATE TABLE accounts (
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
      ${version2Columns}
      ${version3Columns}
      ${version5Columns}
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO accounts (
      id, email, client_id, encrypted_refresh_token, created_at, updated_at
    ) VALUES (
      'account-${version}', 'person${version}@example.com', 'client-${version}', 'safe:dG9rZW4=',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    CREATE INDEX idx_accounts_email ON accounts(email);
    CREATE INDEX idx_accounts_status ON accounts(status);
    CREATE INDEX idx_accounts_group_name ON accounts(group_name);

    CREATE TABLE mail_cache_meta (
      account_id TEXT PRIMARY KEY,
      next_cursor TEXT,
      updated_at TEXT
    );
    INSERT INTO mail_cache_meta VALUES (
      'account-${version}', 'cursor-${version}', '2026-01-01T00:00:00.000Z'
    );

    CREATE TABLE mail_messages (
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
    INSERT INTO mail_messages (
      account_id, message_id, subject, body_preview, updated_at
    ) VALUES (
      'account-${version}', 'message-${version}', 'Subject ${version}', 'Preview ${version}',
      '2026-01-01T00:00:00.000Z'
    );

    CREATE INDEX idx_mail_messages_account_updated ON mail_messages(account_id, updated_at);
    CREATE INDEX idx_mail_messages_account_received ON mail_messages(account_id, received_date_time);

    CREATE TABLE mail_details (
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, message_id)
    );
    INSERT INTO mail_details VALUES (
      'account-${version}', 'message-${version}', '{"body":"Detail ${version}"}',
      '2026-01-01T00:00:00.000Z'
    );

    CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations VALUES (1, ${version}, '2026-01-01T00:00:00.000Z');
  `);

  if (version === 4) {
    database.exec(`
      CREATE TABLE access_token_cache (
        account_id TEXT PRIMARY KEY,
        encrypted_access_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        auth_mode TEXT NOT NULL DEFAULT 'graph',
        updated_at TEXT NOT NULL
      );
      INSERT INTO access_token_cache VALUES (
        'account-${version}', 'safe:bGVnYWN5LWFjY2Vzcw==', 9999999999999, 'Mail.Read', 'graph',
        '2026-01-01T00:00:00.000Z'
      );
    `);
  }

  database.close();
}

afterEach(async () => {
  const { closeDatabase } = await import("../electron/main/database.js");
  closeDatabase();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ordered database migrations", () => {
  it.each([1, 2, 3, 4])("upgrades a v%i database transactionally while preserving user data", async (version) => {
    const directory = await createTemporaryUserData();
    const databasePath = path.join(directory, "outlook-manager.db");
    createVersionFixture(databasePath, version);

    const { getDatabase } = await import("../electron/main/database.js");
    const database = getDatabase();
    const accountColumns = database.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
    const migration = database.prepare("SELECT version FROM schema_migrations WHERE id = 1").get() as { version: number };
    const account = database.prepare("SELECT email, credential_generation FROM accounts").get() as {
      email: string;
      credential_generation: number;
    };
    const message = database.prepare("SELECT subject, body_preview FROM mail_messages").get();
    const detail = database.prepare("SELECT detail_json FROM mail_details").get();
    const cacheMeta = database.prepare("SELECT next_cursor FROM mail_cache_meta").get();
    const accessTokenTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_token_cache'")
      .get();

    expect(migration.version).toBe(5);
    expect(accountColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["inbox_folder_id", "graph_delta_link", "refresh_cooldown_until", "credential_generation"])
    );
    expect(account).toEqual({ email: `person${version}@example.com`, credential_generation: 0 });
    expect(message).toEqual({ subject: `Subject ${version}`, body_preview: `Preview ${version}` });
    expect(detail).toEqual({ detail_json: `{"body":"Detail ${version}"}` });
    expect(cacheMeta).toEqual({ next_cursor: `cursor-${version}` });
    expect(accessTokenTable).toBeUndefined();

    const backupNames = (await readdir(directory)).filter((name) => /^outlook-manager\.pre-v5\..+\.db\.bak$/u.test(name));
    expect(backupNames).toHaveLength(1);
    const backup = new DatabaseSync(path.join(directory, backupNames[0]));
    expect(backup.prepare("SELECT version FROM schema_migrations WHERE id = 1").get()).toEqual({ version });
    expect(backup.prepare("SELECT email FROM accounts").get()).toEqual({ email: `person${version}@example.com` });
    backup.close();
  });

  it("rolls back every migration and its version updates when a later step fails", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES (1, 1, '2026-01-01T00:00:00.000Z');
    `);
    const { applyDatabaseMigrations } = await import("../electron/main/database.js");

    expect(() =>
      applyDatabaseMigrations(database, [
        {
          version: 2,
          up: (target: DatabaseSync) => target.exec("CREATE TABLE migration_marker (value TEXT NOT NULL)")
        },
        {
          version: 3,
          up: (target: DatabaseSync) => {
            target.exec("INSERT INTO migration_marker VALUES ('partial')");
            throw new Error("injected migration failure");
          }
        }
      ])
    ).toThrow("injected migration failure");

    expect(database.prepare("SELECT version FROM schema_migrations WHERE id = 1").get()).toEqual({ version: 1 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'migration_marker'").get()).toBeUndefined();
    database.close();
  });

  it("does not create a migration backup for a fresh database", async () => {
    const directory = await createTemporaryUserData();
    const { getDatabase } = await import("../electron/main/database.js");

    getDatabase();

    expect((await readdir(directory)).filter((name) => name.endsWith(".db.bak"))).toEqual([]);
  });

  it("preserves both the original database and its backup when a file migration fails", async () => {
    const directory = await createTemporaryUserData();
    const databasePath = path.join(directory, "outlook-manager.db");
    createVersionFixture(databasePath, 4);
    const damaged = new DatabaseSync(databasePath);
    damaged.exec(`
      DROP TABLE access_token_cache;
      CREATE VIEW access_token_cache AS
        SELECT id AS account_id, encrypted_refresh_token AS encrypted_access_token FROM accounts;
    `);
    damaged.close();
    const { getDatabase } = await import("../electron/main/database.js");

    expect(() => getDatabase()).toThrow(/backup preserved/u);

    const original = new DatabaseSync(databasePath);
    expect(original.prepare("SELECT version FROM schema_migrations WHERE id = 1").get()).toEqual({ version: 4 });
    expect((original.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).map(({ name }) => name)).not.toContain(
      "credential_generation"
    );
    expect(original.prepare("SELECT type FROM sqlite_master WHERE name = 'access_token_cache'").get()).toEqual({ type: "view" });
    original.close();

    const backupNames = (await readdir(directory)).filter((name) => /^outlook-manager\.pre-v5\..+\.db\.bak$/u.test(name));
    expect(backupNames).toHaveLength(1);
    const backup = new DatabaseSync(path.join(directory, backupNames[0]));
    expect(backup.prepare("SELECT version FROM schema_migrations WHERE id = 1").get()).toEqual({ version: 4 });
    expect(backup.prepare("SELECT email FROM accounts").get()).toEqual({ email: "person4@example.com" });
    backup.close();
  });

  it("rejects a malformed database that already claims to be current", async () => {
    const directory = await createTemporaryUserData();
    const databasePath = path.join(directory, "outlook-manager.db");
    createVersionFixture(databasePath, 5);
    const malformed = new DatabaseSync(databasePath);
    malformed.exec(`
      DROP TABLE mail_details;
      CREATE TABLE access_token_cache (account_id TEXT PRIMARY KEY);
    `);
    malformed.close();
    const { getDatabase } = await import("../electron/main/database.js");

    expect(() => getDatabase()).toThrow(/missing table mail_details|access_token_cache still exists/u);
  });

  it("recovers a legacy v5 migration that dropped access tokens before recording version 5", async () => {
    const directory = await createTemporaryUserData();
    const databasePath = path.join(directory, "outlook-manager.db");
    createVersionFixture(databasePath, 5);
    const partiallyMigrated = new DatabaseSync(databasePath);
    partiallyMigrated.prepare("UPDATE schema_migrations SET version = 4 WHERE id = 1").run();
    partiallyMigrated.close();
    const { getDatabase } = await import("../electron/main/database.js");

    const upgraded = getDatabase();

    expect(upgraded.prepare("SELECT version FROM schema_migrations WHERE id = 1").get()).toEqual({ version: 5 });
    expect(
      upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_token_cache'").get()
    ).toBeUndefined();
    expect(upgraded.prepare("SELECT email, credential_generation FROM accounts").get()).toEqual({
      email: "person5@example.com",
      credential_generation: 0
    });
  });

  it("backs up a readable database before reporting damaged version metadata", async () => {
    const directory = await createTemporaryUserData();
    const databasePath = path.join(directory, "outlook-manager.db");
    createVersionFixture(databasePath, 4);
    const damaged = new DatabaseSync(databasePath);
    damaged.exec("ALTER TABLE schema_migrations RENAME COLUMN version TO broken_version");
    damaged.close();
    const { getDatabase } = await import("../electron/main/database.js");

    expect(() => getDatabase()).toThrow(/backup preserved/u);

    const backupNames = (await readdir(directory)).filter((name) => /^outlook-manager\.pre-v5\..+\.db\.bak$/u.test(name));
    expect(backupNames).toHaveLength(1);
    const backup = new DatabaseSync(path.join(directory, backupNames[0]));
    expect((backup.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain(
      "broken_version"
    );
    expect(backup.prepare("SELECT email FROM accounts").get()).toEqual({ email: "person4@example.com" });
    backup.close();
  });

  it("includes committed uncheckpointed WAL data in both the upgrade and backup", async () => {
    const directory = await createTemporaryUserData();
    const databasePath = path.join(directory, "outlook-manager.db");
    createVersionFixture(databasePath, 4);
    const writer = new DatabaseSync(databasePath);

    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        UPDATE mail_messages SET subject = 'Committed in WAL' WHERE message_id = 'message-4';
        UPDATE mail_details SET detail_json = '{"body":"WAL detail"}' WHERE message_id = 'message-4';
      `);
      expect((await stat(`${databasePath}-wal`)).size).toBeGreaterThan(0);

      const { getDatabase } = await import("../electron/main/database.js");
      const upgraded = getDatabase();
      expect(upgraded.prepare("SELECT subject FROM mail_messages WHERE message_id = 'message-4'").get()).toEqual({
        subject: "Committed in WAL"
      });

      const backupNames = (await readdir(directory)).filter((name) => /^outlook-manager\.pre-v5\..+\.db\.bak$/u.test(name));
      expect(backupNames).toHaveLength(1);
      const backup = new DatabaseSync(path.join(directory, backupNames[0]));
      expect(backup.prepare("SELECT subject FROM mail_messages WHERE message_id = 'message-4'").get()).toEqual({
        subject: "Committed in WAL"
      });
      expect(backup.prepare("SELECT detail_json FROM mail_details WHERE message_id = 'message-4'").get()).toEqual({
        detail_json: '{"body":"WAL detail"}'
      });
      expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      backup.close();
    } finally {
      writer.close();
    }
  });

  it("refuses to open a database created by a newer application version", async () => {
    const directory = await createTemporaryUserData();
    const databasePath = path.join(directory, "outlook-manager.db");
    createVersionFixture(databasePath, 4);
    const newer = new DatabaseSync(databasePath);
    newer.prepare("UPDATE schema_migrations SET version = 6 WHERE id = 1").run();
    newer.close();
    const { getDatabase } = await import("../electron/main/database.js");

    expect(() => getDatabase()).toThrow(/newer|更高/u);
    expect((await readdir(directory)).filter((name) => name.endsWith(".db.bak"))).toEqual([]);
  });
});

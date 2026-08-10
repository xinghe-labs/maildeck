import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobCanceledError } from "../electron/main/job-errors.js";

const electronState = vi.hoisted(() => ({ userDataPath: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronState.userDataPath
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8")
  }
}));

const temporaryDirectories: string[] = [];

async function createTemporaryUserData() {
  const directory = await mkdtemp(path.join(tmpdir(), "outlook-manager-credentials-"));
  temporaryDirectories.push(directory);
  electronState.userDataPath = directory;
  vi.resetModules();
  return directory;
}

afterEach(async () => {
  const { closeDatabase } = await import("../electron/main/database.js");
  closeDatabase();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("credential storage migration", () => {
  it("preserves accounts, adds credential generations, and removes persisted access tokens", async () => {
    const directory = await createTemporaryUserData();
    const legacy = new DatabaseSync(path.join(directory, "outlook-manager.db"));
    legacy.exec(`
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
        inbox_folder_id TEXT,
        graph_delta_link TEXT,
        refresh_cooldown_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO accounts (
        id, email, client_id, encrypted_refresh_token, created_at, updated_at
      ) VALUES (
        'account-1', 'person@example.com', 'client-1', 'safe:bGVnYWN5',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE mail_cache_meta (
        account_id TEXT PRIMARY KEY,
        next_cursor TEXT,
        updated_at TEXT
      );
      INSERT INTO mail_cache_meta VALUES (
        'account-1', 'cursor-42', '2026-01-01T00:00:00.000Z'
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
        'account-1', 'message-1', 'Preserved subject', 'Preserved preview',
        '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE mail_details (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, message_id)
      );
      INSERT INTO mail_details VALUES (
        'account-1', 'message-1', '{"body":"Preserved detail"}',
        '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE access_token_cache (
        account_id TEXT PRIMARY KEY,
        encrypted_access_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        auth_mode TEXT NOT NULL DEFAULT 'graph',
        updated_at TEXT NOT NULL
      );
      INSERT INTO access_token_cache VALUES (
        'account-1', 'safe:bGVnYWN5LWFjY2Vzcw==', 9999999999999, 'Mail.Read', 'graph',
        '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES (1, 4, '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const { getDatabase } = await import("../electron/main/database.js");
    const database = getDatabase();
    const columns = database.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
    const accessTokenTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_token_cache'")
      .get();
    const account = database
      .prepare("SELECT email, encrypted_refresh_token, credential_generation FROM accounts WHERE id = 'account-1'")
      .get() as { email: string; encrypted_refresh_token: string; credential_generation: number };
    const message = database
      .prepare("SELECT subject, body_preview FROM mail_messages WHERE account_id = 'account-1'")
      .get() as { subject: string; body_preview: string };
    const detail = database
      .prepare("SELECT detail_json FROM mail_details WHERE account_id = 'account-1'")
      .get() as { detail_json: string };
    const cacheMeta = database
      .prepare("SELECT next_cursor FROM mail_cache_meta WHERE account_id = 'account-1'")
      .get() as { next_cursor: string };
    const migration = database.prepare("SELECT version FROM schema_migrations WHERE id = 1").get() as { version: number };

    expect(columns.map((column) => column.name)).toContain("credential_generation");
    expect(accessTokenTable).toBeUndefined();
    expect(account).toEqual({
      email: "person@example.com",
      encrypted_refresh_token: "safe:bGVnYWN5",
      credential_generation: 0
    });
    expect(message).toEqual({ subject: "Preserved subject", body_preview: "Preserved preview" });
    expect(detail).toEqual({ detail_json: '{"body":"Preserved detail"}' });
    expect(cacheMeta).toEqual({ next_cursor: "cursor-42" });
    expect(migration.version).toBe(5);
  });

  it("increments generations on reimport and refuses stale refresh-token writes", async () => {
    await createTemporaryUserData();
    const accountStore = await import("../electron/main/account-store.js");
    const { credentialGenerations } = await import("../electron/main/credential-generations.js");
    const input = {
      email: "person@example.com",
      clientId: "00000000-0000-4000-8000-000000000001",
      refreshToken: `M.${"a".repeat(100)}`
    };

    const first = await accountStore.upsertAccounts([input]);
    const accountId = first.affectedAccountIds[0];
    const firstRecord = await accountStore.getAccountRecord(accountId);
    const snapshot = credentialGenerations.capture(accountId);
    const nextRefreshToken = `M.${"b".repeat(100)}`;

    const second = await accountStore.upsertAccounts([{ ...input, refreshToken: nextRefreshToken }]);
    const secondRecord = await accountStore.getAccountRecord(accountId);

    expect(second.affectedAccountIds).toEqual([accountId]);
    expect(secondRecord.credentialGeneration).toBe(firstRecord.credentialGeneration + 1);
    expect(credentialGenerations.isCurrent(snapshot)).toBe(false);
    await expect(
      accountStore.updateAccountStatus(accountId, "valid", null, "rotated-old", {
        expectedCredentialGeneration: firstRecord.credentialGeneration
      })
    ).rejects.toThrow("凭据或代理已更新");
    await expect(accountStore.getRefreshToken(accountId)).resolves.toBe(nextRefreshToken);
  });

  it("invalidates a fallback token rotation before a queued stale commit can acquire the store lock", async () => {
    await createTemporaryUserData();
    const accountStore = await import("../electron/main/account-store.js");
    const { credentialGenerations } = await import("../electron/main/credential-generations.js");
    const created = await accountStore.upsertAccounts([
      {
        email: "person@example.com",
        clientId: "00000000-0000-4000-8000-000000000001",
        refreshToken: `M.${"a".repeat(100)}`
      }
    ]);
    const accountId = created.affectedAccountIds[0];
    const account = await accountStore.getAccountRecord(accountId);
    const snapshot = credentialGenerations.capture(accountId);
    const fallbackRefreshToken = `M.${"b".repeat(100)}`;
    const staleRefreshToken = `M.${"c".repeat(100)}`;

    const fallbackCommit = accountStore.updateAccountStatus(accountId, "valid", null, fallbackRefreshToken, {
      expectedCredentialGeneration: account.credentialGeneration,
      assertCurrent: () => credentialGenerations.assertCurrent(snapshot),
      afterCommit: () => credentialGenerations.invalidateAccounts([accountId])
    });
    const staleCommit = accountStore.updateAccountStatus(accountId, "valid", null, staleRefreshToken, {
      expectedCredentialGeneration: account.credentialGeneration,
      assertCurrent: () => credentialGenerations.assertCurrent(snapshot)
    });
    const staleExpectation = expect(staleCommit).rejects.toThrow("凭据或代理已更新");

    await fallbackCommit;
    await staleExpectation;
    await expect(accountStore.getRefreshToken(accountId)).resolves.toBe(fallbackRefreshToken);
  });

  it("checks cancellation inside the account store lock before refreshing state", async () => {
    await createTemporaryUserData();
    const accountStore = await import("../electron/main/account-store.js");
    const created = await accountStore.upsertAccounts([
      {
        email: "person@example.com",
        clientId: "00000000-0000-4000-8000-000000000001",
        refreshToken: `M.${"a".repeat(100)}`
      }
    ]);
    const accountId = created.affectedAccountIds[0];
    const controller = new AbortController();
    const canceled = new JobCanceledError("刷新已取消");
    controller.abort(canceled);

    await expect(
      accountStore.updateAccountRefreshState(accountId, {
        status: "valid",
        lastError: null,
        lastInboxCount: 10,
        lastMailAt: null
      }, {
        assertCurrent: () => controller.signal.throwIfAborted()
      })
    ).rejects.toBe(canceled);
    await expect(accountStore.getAccountRecord(accountId)).resolves.toMatchObject({
      status: "untested",
      lastInboxCount: 0
    });
  });

  it("invalidates account generations on edit and delete", async () => {
    await createTemporaryUserData();
    const accountStore = await import("../electron/main/account-store.js");
    const { credentialGenerations } = await import("../electron/main/credential-generations.js");
    const created = await accountStore.upsertAccounts([
      {
        email: "person@example.com",
        clientId: "00000000-0000-4000-8000-000000000001",
        refreshToken: `M.${"a".repeat(100)}`
      }
    ]);
    const accountId = created.affectedAccountIds[0];
    const beforeUpdate = await accountStore.getAccountRecord(accountId);
    const updateSnapshot = credentialGenerations.capture(accountId);

    await accountStore.updateAccount({
      id: accountId,
      email: "person@example.com",
      clientId: beforeUpdate.clientId,
      remark: "updated",
      group: "security"
    });
    const afterUpdate = await accountStore.getAccountRecord(accountId);

    expect(afterUpdate.credentialGeneration).toBe(beforeUpdate.credentialGeneration + 1);
    expect(credentialGenerations.isCurrent(updateSnapshot)).toBe(false);

    const deleteSnapshot = credentialGenerations.capture(accountId);
    await accountStore.deleteAccount(accountId);
    expect(credentialGenerations.isCurrent(deleteSnapshot)).toBe(false);
  });

  it("invalidates all token work only when the normalized proxy changes", async () => {
    await createTemporaryUserData();
    const settingsStore = await import("../electron/main/settings-store.js");
    const { credentialGenerations } = await import("../electron/main/credential-generations.js");
    const unchangedSnapshot = credentialGenerations.capture("account-1");

    await settingsStore.updateSettings({ batchConcurrency: 7 });
    expect(credentialGenerations.isCurrent(unchangedSnapshot)).toBe(true);

    const proxySnapshot = credentialGenerations.capture("account-1");
    await settingsStore.updateSettings({
      proxyUrl: "http://proxy.example:8080",
      proxyUsername: "",
      proxyPassword: ""
    });
    expect(credentialGenerations.isCurrent(proxySnapshot)).toBe(false);
  });
});

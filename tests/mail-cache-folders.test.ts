import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailMessageSummary } from "../electron/shared/ipc-contracts.js";

const electronState = vi.hoisted(() => ({ userDataPath: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronState.userDataPath
  }
}));

const temporaryDirectories: string[] = [];

async function createTemporaryUserData() {
  const directory = await mkdtemp(path.join(tmpdir(), "maildeck-mail-cache-folders-"));
  temporaryDirectories.push(directory);
  electronState.userDataPath = directory;
  vi.resetModules();
  return directory;
}

function summary(id: string, received: string): MailMessageSummary {
  return {
    id,
    subject: `subject-${id}`,
    from: null,
    receivedDateTime: received,
    sentDateTime: null,
    isRead: false,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: "",
    webLink: null
  };
}

afterEach(async () => {
  const { closeDatabase } = await import("../electron/main/database.js");
  closeDatabase();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("folder-scoped mail cache", () => {
  it("keeps messages and cursors isolated between folders for the same account", async () => {
    await createTemporaryUserData();
    const cache = await import("../electron/main/mail-cache.js");

    await cache.saveCachedMessages("account-1", [summary("11", "2026-01-02T00:00:00.000Z")], true, "10", {
      folderId: "Sent"
    });
    await cache.saveCachedMessages("account-1", [summary("22", "2026-01-03T00:00:00.000Z")], true, "20");

    await expect(cache.getCachedMessages("account-1", "", 50, true, "Sent")).resolves.toHaveLength(1);
    const sent = await cache.getCachedMessages("account-1", "", 50, true, "Sent");
    expect(sent[0].id).toBe("11");
    await expect(cache.getCachedCursor("account-1", "Sent")).resolves.toBe("10");

    const inbox = await cache.getCachedMessages("account-1", "", 50, true);
    expect(inbox[0].id).toBe("22");
    await expect(cache.getCachedCursor("account-1")).resolves.toBe("20");
  });

  it("keeps message details isolated between folders for the same numeric message id", async () => {
    await createTemporaryUserData();
    const cache = await import("../electron/main/mail-cache.js");
    const detail = (id: string, content: string) => ({
      id,
      subject: "subject",
      from: null,
      receivedDateTime: null,
      sentDateTime: null,
      isRead: false,
      importance: "normal",
      hasAttachments: false,
      bodyPreview: "",
      webLink: null,
      toRecipients: [],
      ccRecipients: [],
      body: { contentType: "text", content }
    });

    // IMAP UID 在不同文件夹中可能重复：同账号同 UID 的正文必须按 folder 键隔离。
    await cache.saveCachedMessageDetail("account-1", detail("5", "sent-body"), true, { folderId: "Sent" });
    await cache.saveCachedMessageDetail("account-1", detail("5", "inbox-body"), true);

    await expect(cache.getCachedMessageDetail("account-1", "5", true, "Sent")).resolves.toMatchObject({
      body: { content: "sent-body" }
    });
    await expect(cache.getCachedMessageDetail("account-1", "5", true)).resolves.toMatchObject({
      body: { content: "inbox-body" }
    });
  });

  it("clears every folder when the account cache is cleared", async () => {
    await createTemporaryUserData();
    const cache = await import("../electron/main/mail-cache.js");

    await cache.saveCachedMessages("account-1", [summary("11", "2026-01-02T00:00:00.000Z")], true, null, {
      folderId: "Sent"
    });
    await cache.saveCachedMessages("account-1", [summary("22", "2026-01-03T00:00:00.000Z")], true, null);
    await cache.saveCachedMessageDetail(
      "account-1",
      {
        id: "22",
        subject: "subject",
        from: null,
        receivedDateTime: null,
        sentDateTime: null,
        isRead: false,
        importance: "normal",
        hasAttachments: false,
        bodyPreview: "",
        webLink: null,
        toRecipients: [],
        ccRecipients: [],
        body: { contentType: "text", content: "body" }
      },
      true
    );

    await cache.clearAccountCache("account-1");

    await expect(cache.getCachedMessages("account-1", "", 50, true, "Sent")).resolves.toHaveLength(0);
    await expect(cache.getCachedMessages("account-1", "", 50, true)).resolves.toHaveLength(0);
    await expect(cache.getCachedMessageDetail("account-1", "22", true)).resolves.toBeNull();
  });

  it("migrates a legacy v5 database into the INBOX folder key", async () => {
    await createTemporaryUserData();
    const { DatabaseSync } = await import("node:sqlite");
    const databasePath = path.join(electronState.userDataPath, "maildeck.db");
    const legacy = new DatabaseSync(databasePath);
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        inbox_folder_id TEXT,
        refresh_cooldown_until TEXT,
        graph_delta_link TEXT,
        credential_generation INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO accounts (id, email, client_id, encrypted_refresh_token, created_at, updated_at)
        VALUES ('account-1', 'person@example.com', 'client-1', 'safe:dG9rZW4=',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      CREATE INDEX idx_accounts_email ON accounts(email);
      CREATE INDEX idx_accounts_status ON accounts(status);
      CREATE INDEX idx_accounts_group_name ON accounts(group_name);
      CREATE TABLE mail_cache_meta (
        account_id TEXT PRIMARY KEY,
        next_cursor TEXT,
        updated_at TEXT
      );
      INSERT INTO mail_cache_meta VALUES ('account-1', 'legacy-cursor', '${new Date().toISOString()}');
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
      INSERT INTO mail_messages (account_id, message_id, subject, body_preview, updated_at)
        VALUES ('account-1', '33', 'Legacy subject', 'Legacy preview', '${new Date().toISOString()}');
      CREATE INDEX idx_mail_messages_account_updated ON mail_messages(account_id, updated_at);
      CREATE INDEX idx_mail_messages_account_received ON mail_messages(account_id, received_date_time);
      CREATE TABLE mail_details (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, message_id)
      );
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES (1, 5, '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const cache = await import("../electron/main/mail-cache.js");
    const rows = await cache.getCachedMessages("account-1", "", 50, true);
    expect(rows.map((row) => row.id)).toEqual(["33"]);
    await expect(cache.getCachedCursor("account-1")).resolves.toBe("legacy-cursor");
  });
});

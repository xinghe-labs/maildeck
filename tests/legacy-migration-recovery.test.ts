import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({ userDataPath: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronState.userDataPath
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => {
      const decoded = value.toString("utf8");
      if (decoded === "throw-me") {
        throw new Error("cannot decrypt legacy secret");
      }
      return decoded;
    }
  }
}));

const temporaryDirectories: string[] = [];

async function createTemporaryUserData() {
  const directory = await mkdtemp(path.join(tmpdir(), "outlook-manager-legacy-recovery-"));
  temporaryDirectories.push(directory);
  electronState.userDataPath = directory;
  vi.resetModules();
  return directory;
}

function encrypted(value: string) {
  return `safe:${Buffer.from(value, "utf8").toString("base64")}`;
}

function legacyAccount(id: string, email: string, token = `M.${"a".repeat(100)}`) {
  return {
    id,
    email,
    clientId: "00000000-0000-4000-8000-000000000001",
    encryptedRefreshToken: encrypted(token),
    remark: "",
    group: "",
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
    credentialGeneration: 0,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z"
  };
}

function legacyMessage(id: string) {
  return {
    id,
    subject: "CafÃ©",
    from: { name: "MÃ¼ller", address: "sender@example.com" },
    receivedDateTime: "2026-08-18T00:00:00+08:00",
    sentDateTime: null,
    isRead: false,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: "ä½ å¥½",
    webLink: null
  };
}

function legacyDetail(id: string) {
  return {
    ...legacyMessage(id),
    toRecipients: [],
    ccRecipients: [],
    body: { contentType: "text", content: "ä½ å¥½" }
  };
}

afterEach(async () => {
  const { closeDatabase } = await import("../electron/main/database.js");
  closeDatabase();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("legacy account migration recovery", () => {
  it("migrates valid records, skips damaged or duplicate records, and preserves backups", async () => {
    const directory = await createTemporaryUserData();
    const damagedAccount = legacyAccount("account-damaged-secret", "damaged@example.com", "throw-me");
    await writeFile(path.join(directory, "accounts.json"), JSON.stringify({
      version: 1,
      accounts: [
        legacyAccount("account-1", "person@example.com"),
        null,
        legacyAccount("account-duplicate", "person@example.com"),
        damagedAccount
      ]
    }));

    const accountStore = await import("../electron/main/account-store.js");
    const accounts = await accountStore.listAccounts();

    expect(accounts.map((account) => account.email)).toEqual(["damaged@example.com", "person@example.com"]);
    await expect(accountStore.getAccountRecord("account-damaged-secret")).resolves.toMatchObject({
      encryptedRefreshToken: damagedAccount.encryptedRefreshToken
    });
    expect(await readdir(directory)).toEqual(expect.arrayContaining([
      "accounts.json.migrated",
      expect.stringMatching(/^accounts\.json\.broken-/)
    ]));
  });

  it("retries account migration after a transient legacy-file read failure", async () => {
    const directory = await createTemporaryUserData();
    const legacyPath = path.join(directory, "accounts.json");
    await mkdir(legacyPath);
    const accountStore = await import("../electron/main/account-store.js");

    await expect(accountStore.listAccounts()).rejects.toBeDefined();
    await rm(legacyPath, { recursive: true, force: true });
    await writeFile(legacyPath, JSON.stringify({ version: 1, accounts: [legacyAccount("account-1", "person@example.com")] }));

    await expect(accountStore.listAccounts()).resolves.toHaveLength(1);
  });

  it("preserves a future account-store version without downgrading it", async () => {
    const directory = await createTemporaryUserData();
    const legacyPath = path.join(directory, "accounts.json");
    const original = JSON.stringify({
      version: 2,
      accounts: [legacyAccount("future-account", "future@example.com")],
      futureField: { retained: true }
    });
    await writeFile(legacyPath, original, "utf8");
    const accountStore = await import("../electron/main/account-store.js");

    await expect(accountStore.listAccounts()).resolves.toEqual([]);
    await expect(readFile(legacyPath, "utf8")).resolves.toBe(original);
    expect((await readdir(directory)).filter((name) => name.startsWith("accounts.json."))).toEqual([]);
  });
});

describe("legacy mail cache migration recovery", () => {
  it("migrates valid summaries and details while skipping malformed entries", async () => {
    const directory = await createTemporaryUserData();
    const accountStore = await import("../electron/main/account-store.js");
    const created = await accountStore.upsertAccounts([{
      email: "person@example.com",
      clientId: "00000000-0000-4000-8000-000000000001",
      refreshToken: `M.${"a".repeat(100)}`
    }]);
    const accountId = created.affectedAccountIds[0];
    const cacheTimestamp = new Date().toISOString();
    await writeFile(path.join(directory, "mail-cache.json"), JSON.stringify({
      version: 1,
      accounts: {
        [accountId]: {
          accountId,
          messages: [legacyMessage("message-1"), { id: 42 }, null],
          details: {
            "message-1": legacyDetail("message-1"),
            broken: { id: 42 }
          },
          detailUpdatedAt: { "message-1": cacheTimestamp },
          nextCursor: "cursor-1",
          updatedAt: cacheTimestamp
        },
        broken: null
      }
    }));

    const cache = await import("../electron/main/mail-cache.js");
    await expect(cache.getCachedMessages(accountId)).resolves.toMatchObject([{
      id: "message-1",
      subject: "Café",
      bodyPreview: "你好"
    }]);
    await expect(cache.getCachedMessageDetail(accountId, "message-1")).resolves.toMatchObject({
      body: { content: "你好" }
    });
    expect(await readdir(directory)).toEqual(expect.arrayContaining([
      "mail-cache.json.migrated",
      expect.stringMatching(/^mail-cache\.json\.broken-/)
    ]));
  });

  it("retries cache migration after a transient legacy-file read failure", async () => {
    const directory = await createTemporaryUserData();
    const accountStore = await import("../electron/main/account-store.js");
    const created = await accountStore.upsertAccounts([{
      email: "person@example.com",
      clientId: "00000000-0000-4000-8000-000000000001",
      refreshToken: `M.${"a".repeat(100)}`
    }]);
    const accountId = created.affectedAccountIds[0];
    const cachePath = path.join(directory, "mail-cache.json");
    await mkdir(cachePath);
    const cache = await import("../electron/main/mail-cache.js");

    await expect(cache.getCachedMessages(accountId)).rejects.toBeDefined();
    await rm(cachePath, { recursive: true, force: true });
    await writeFile(cachePath, JSON.stringify({
      version: 1,
      accounts: {
        [accountId]: {
          accountId,
          messages: [legacyMessage("message-1")],
          details: {},
          updatedAt: new Date().toISOString()
        }
      }
    }));

    await expect(cache.getCachedMessages(accountId)).resolves.toHaveLength(1);
  });

  it("preserves a future mail-cache version without downgrading it", async () => {
    const directory = await createTemporaryUserData();
    const accountStore = await import("../electron/main/account-store.js");
    const created = await accountStore.upsertAccounts([{
      email: "future@example.com",
      clientId: "00000000-0000-4000-8000-000000000001",
      refreshToken: `M.${"a".repeat(100)}`
    }]);
    const accountId = created.affectedAccountIds[0];
    const cachePath = path.join(directory, "mail-cache.json");
    const original = JSON.stringify({
      version: 2,
      accounts: {
        [accountId]: {
          accountId,
          messages: [legacyMessage("future-message")],
          details: {},
          updatedAt: new Date().toISOString(),
          futureField: { retained: true }
        }
      }
    });
    await writeFile(cachePath, original, "utf8");
    const cache = await import("../electron/main/mail-cache.js");

    await expect(cache.getCachedMessages(accountId)).resolves.toEqual([]);
    await expect(readFile(cachePath, "utf8")).resolves.toBe(original);
    expect((await readdir(directory)).filter((name) => name.startsWith("mail-cache.json."))).toEqual([]);
  });
});

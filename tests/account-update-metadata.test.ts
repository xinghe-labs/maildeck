import { mkdtemp, rm } from "node:fs/promises";
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
    decryptString: (value: Buffer) => value.toString("utf8")
  }
}));

const temporaryDirectories: string[] = [];
const CLIENT_ID = "00000000-0000-4000-8000-000000000001";
const REFRESH_TOKEN = `M.${"a".repeat(100)}`;

async function createTemporaryUserData() {
  const directory = await mkdtemp(path.join(tmpdir(), "maildeck-account-update-"));
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

/** 建一个已判定失效、带 lastError 的账号,作为“编辑前”的基线。 */
async function createFailedAccount() {
  const accountStore = await import("../electron/main/account-store.js");
  const created = await accountStore.upsertAccounts([
    { email: "person@example.com", clientId: CLIENT_ID, refreshToken: REFRESH_TOKEN }
  ]);
  const accountId = created.affectedAccountIds[0];
  await accountStore.updateAccountStatus(
    accountId,
    "invalid",
    "Token 无效或已过期,请重新获取 refresh_token。原始错误:live(400): AADSTS50173 Trace ID: abc"
  );
  const before = await accountStore.getAccountRecord(accountId);
  return { accountStore, accountId, before };
}

describe("updateAccount keeps test status when only metadata changes", () => {
  it("keeps status, lastError and credential generation for a remark-only edit", async () => {
    await createTemporaryUserData();
    const { accountStore, accountId, before } = await createFailedAccount();
    expect(before.status).toBe("invalid");

    const view = await accountStore.updateAccount({
      id: accountId,
      email: "person@example.com",
      clientId: CLIENT_ID,
      refreshToken: "",
      remark: "主号",
      group: "A 组"
    });

    expect(view.status).toBe("invalid");
    expect(view.lastError).toContain("AADSTS50173");
    expect(view.remark).toBe("主号");
    expect(view.group).toBe("A 组");

    const after = await accountStore.getAccountRecord(accountId);
    expect(after.credentialGeneration).toBe(before.credentialGeneration);
    // 留空 refreshToken 不能把已有凭据擦掉
    await expect(accountStore.getRefreshToken(accountId)).resolves.toBe(REFRESH_TOKEN);
  });

  it("does not invalidate an in-flight refresh generation for a metadata-only edit", async () => {
    await createTemporaryUserData();
    const { accountStore, accountId, before } = await createFailedAccount();
    const { credentialGenerations } = await import("../electron/main/credential-generations.js");
    const snapshot = credentialGenerations.capture(accountId);

    await accountStore.updateAccount({
      id: accountId,
      email: "person@example.com",
      clientId: CLIENT_ID,
      refreshToken: "",
      remark: "改个备注",
      group: ""
    });

    // 备注编辑不是凭据轮换:发起中的刷新不该因为它拿到 STALE_CREDENTIALS。
    expect(() => credentialGenerations.assertCurrent(snapshot)).not.toThrow();
    const after = await accountStore.getAccountRecord(accountId);
    expect(after.credentialGeneration).toBe(before.credentialGeneration);
  });

  it("resets status and bumps the credential generation when the refresh token changes", async () => {
    await createTemporaryUserData();
    const { accountStore, accountId, before } = await createFailedAccount();

    const view = await accountStore.updateAccount({
      id: accountId,
      email: "person@example.com",
      clientId: CLIENT_ID,
      refreshToken: `M.${"b".repeat(100)}`,
      remark: "主号",
      group: ""
    });

    expect(view.status).toBe("untested");
    expect(view.lastError).toBeNull();
    const after = await accountStore.getAccountRecord(accountId);
    expect(after.credentialGeneration).toBe(before.credentialGeneration + 1);
    await expect(accountStore.getRefreshToken(accountId)).resolves.toBe(`M.${"b".repeat(100)}`);
  });

  it("resets status when the client id changes", async () => {
    await createTemporaryUserData();
    const { accountStore, accountId, before } = await createFailedAccount();

    const view = await accountStore.updateAccount({
      id: accountId,
      email: "person@example.com",
      clientId: "00000000-0000-4000-8000-000000000002",
      refreshToken: "",
      remark: "",
      group: ""
    });

    expect(view.status).toBe("untested");
    const after = await accountStore.getAccountRecord(accountId);
    expect(after.credentialGeneration).toBe(before.credentialGeneration + 1);
  });

  it("resets status when the email changes, because it is the IMAP login name", async () => {
    await createTemporaryUserData();
    const { accountStore, accountId } = await createFailedAccount();

    const view = await accountStore.updateAccount({
      id: accountId,
      email: "renamed@example.com",
      clientId: CLIENT_ID,
      refreshToken: "",
      remark: "",
      group: ""
    });

    expect(view.email).toBe("renamed@example.com");
    expect(view.status).toBe("untested");
  });
});

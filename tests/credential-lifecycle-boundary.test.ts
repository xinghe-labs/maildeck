import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ipcSource = readFileSync(new URL("../electron/main/ipc.ts", import.meta.url), "utf8");
const accountStoreSource = readFileSync(new URL("../electron/main/account-store.ts", import.meta.url), "utf8");
const settingsStoreSource = readFileSync(new URL("../electron/main/settings-store.ts", import.meta.url), "utf8");
const databaseSource = readFileSync(new URL("../electron/main/database.ts", import.meta.url), "utf8");

describe("credential lifecycle boundary", () => {
  it("keeps access tokens in the dedicated in-memory manager", () => {
    expect(ipcSource).toContain("new AccessTokenManager(");
    expect(ipcSource).not.toMatch(/const tokenCache|const tokenRefreshes|access-token-cache/u);
    expect(existsSync(new URL("../electron/main/access-token-cache.ts", import.meta.url))).toBe(false);
  });

  it("serializes every public account mutation before resolving account locks", () => {
    expect(ipcSource).toContain('const ACCOUNT_MUTATION_LOCK = Symbol("account-mutation")');
    expect(ipcSource.match(/runAccountMutation(?:<T>)?\(/gu)).toHaveLength(4);
    expect(ipcSource).toContain("const { affectedAccountIds: _affectedAccountIds, ...result }");
  });

  it("invalidates credential generations at the owning stores", () => {
    expect(accountStoreSource).toContain("credentialGenerations.invalidateAccounts(");
    expect(accountStoreSource).toContain("affectedAccountIds");
    expect(settingsStoreSource.match(/credentialGenerations\.invalidateProxy\(\)/gu)).toHaveLength(2);
    expect(ipcSource.match(/afterCommit: \(\) => credentialGenerations\.invalidateAccounts\(\[accountId\]\)/gu)).toHaveLength(3);
  });

  it("migrates persisted access tokens out of the database", () => {
    expect(databaseSource).toContain("credential_generation INTEGER NOT NULL DEFAULT 0");
    expect(databaseSource).toContain("DROP TABLE IF EXISTS access_token_cache");
    expect(databaseSource).not.toContain("CREATE TABLE IF NOT EXISTS access_token_cache");
  });
});

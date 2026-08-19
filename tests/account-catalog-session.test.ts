import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createAccountCatalogSession,
  type AccountCatalogAdapter
} from "../src/account-catalog-session";
import type {
  AccountView,
  ImportPreviewResult,
  ImportResult,
  TestConnectionResult,
  TestFallbackResult
} from "../src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function account(id: string, status: AccountView["status"] = "untested"): AccountView {
  const timestamp = "2026-08-19T00:00:00.000Z";
  return {
    id,
    email: `${id}@example.com`,
    clientId: `client-${id}`,
    remark: "",
    group: "",
    status,
    lastCheckedAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function importResult(accounts: AccountView[]): ImportResult {
  return { imported: accounts.length, updated: 0, skipped: 0, errors: [], accounts };
}

function testSuccess(next: AccountView): TestConnectionResult {
  return { account: next, ok: true, message: "ok" };
}

function fallbackSuccess(next: AccountView): TestFallbackResult {
  return {
    account: next,
    ok: true,
    message: "ok",
    transport: "imap",
    count: 1,
    elapsedMs: 10
  };
}

function createFakeAdapter() {
  const listRuns: Array<ReturnType<typeof deferred<AccountView[]>>> = [];
  const previewRuns: Array<ReturnType<typeof deferred<ImportPreviewResult>>> = [];
  const importRuns: Array<ReturnType<typeof deferred<ImportResult>>> = [];
  const testRuns = new Map<string, ReturnType<typeof deferred<TestConnectionResult>>>();
  const fallbackRuns = new Map<string, ReturnType<typeof deferred<TestFallbackResult>>>();
  const adapter: AccountCatalogAdapter = {
    list: vi.fn(() => {
      const run = deferred<AccountView[]>();
      listRuns.push(run);
      return run.promise;
    }),
    previewImportText: vi.fn(() => {
      const run = deferred<ImportPreviewResult>();
      previewRuns.push(run);
      return run.promise;
    }),
    importText: vi.fn(() => {
      const run = deferred<ImportResult>();
      importRuns.push(run);
      return run.promise;
    }),
    importFile: vi.fn(async () => null),
    upsert: vi.fn(async (input) => importResult([account(input.email)])),
    update: vi.fn(async (input) => ({ ...account(input.id), email: input.email })),
    delete: vi.fn(async () => []),
    test: vi.fn((accountId) => {
      const run = deferred<TestConnectionResult>();
      testRuns.set(accountId, run);
      return run.promise;
    }),
    testFallback: vi.fn((accountId) => {
      const run = deferred<TestFallbackResult>();
      fallbackRuns.set(accountId, run);
      return run.promise;
    })
  };
  return { adapter, fallbackRuns, importRuns, listRuns, previewRuns, testRuns };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("account catalog session", () => {
  it("deduplicates list loads and projects the latest account snapshot", async () => {
    const fake = createFakeAdapter();
    const session = createAccountCatalogSession(fake.adapter);
    const first = session.load();
    const second = session.load();

    expect(first).toBe(second);
    await flushAsyncWork();
    expect(fake.adapter.list).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().loadingAccounts).toBe(true);

    fake.listRuns[0].resolve([account("account-a")]);
    await expect(first).resolves.toEqual([account("account-a")]);
    expect(session.getSnapshot()).toMatchObject({
      accounts: [account("account-a")],
      loadingAccounts: false
    });
    session.dispose();
  });

  it("clears loading after a list failure and permits a retry", async () => {
    const fake = createFakeAdapter();
    const session = createAccountCatalogSession(fake.adapter);
    const failedLoad = session.load();
    await flushAsyncWork();
    fake.listRuns[0].reject(new Error("list failed"));

    await expect(failedLoad).rejects.toThrow("list failed");
    expect(session.getSnapshot().loadingAccounts).toBe(false);

    const retry = session.load();
    await flushAsyncWork();
    fake.listRuns[1].resolve([account("recovered")]);
    await expect(retry).resolves.toEqual([account("recovered")]);
    session.dispose();
  });

  it("queues a fresh reload when another synchronization arrives during a list read", async () => {
    const fake = createFakeAdapter();
    const session = createAccountCatalogSession(fake.adapter);
    const initialLoad = session.load();
    await flushAsyncWork();
    fake.listRuns[0].resolve([account("initial")]);
    await initialLoad;

    const firstReload = session.reload();
    await flushAsyncWork();
    const queuedReload = session.reload();
    expect(fake.adapter.list).toHaveBeenCalledTimes(2);

    fake.listRuns[1].resolve([account("first")]);
    await expect(firstReload).resolves.toEqual([account("first")]);
    await flushAsyncWork();
    expect(fake.adapter.list).toHaveBeenCalledTimes(3);
    fake.listRuns[2].resolve([account("latest")]);

    await expect(queuedReload).resolves.toEqual([account("latest")]);
    expect(session.getSnapshot().accounts).toEqual([account("latest")]);
    session.dispose();
  });

  it("preserves a newer account test projection when an older list load finishes", async () => {
    const fake = createFakeAdapter();
    const session = createAccountCatalogSession(fake.adapter);
    const initialLoad = session.load();
    await flushAsyncWork();
    fake.listRuns[0].resolve([account("account-a")]);
    await initialLoad;

    const staleLoad = session.load();
    await flushAsyncWork();
    const test = session.testConnection("account-a");
    fake.testRuns.get("account-a")!.resolve(testSuccess(account("account-a", "valid")));
    await test;
    fake.listRuns[1].resolve([account("account-a", "untested")]);
    await staleLoad;

    expect(session.getSnapshot().accounts[0].status).toBe("valid");
    session.dispose();
  });

  it("tracks tests per account and never lets one completion clear another", async () => {
    const fake = createFakeAdapter();
    const session = createAccountCatalogSession(fake.adapter);
    const accountATest = session.testConnection("account-a");
    const accountBTest = session.testFallback("account-b");

    expect(accountATest).not.toBeNull();
    expect(accountBTest).not.toBeNull();
    expect(session.testFallback("account-a")).toBeNull();
    expect(session.getSnapshot()).toMatchObject({
      testingAccountIds: ["account-a"],
      fallbackTestingAccountIds: ["account-b"]
    });

    fake.testRuns.get("account-a")!.resolve(testSuccess(account("account-a", "valid")));
    await accountATest;
    expect(session.getSnapshot()).toMatchObject({
      testingAccountIds: [],
      fallbackTestingAccountIds: ["account-b"]
    });

    fake.fallbackRuns.get("account-b")!.resolve(fallbackSuccess(account("account-b", "valid")));
    await accountBTest;
    expect(session.getSnapshot()).toMatchObject({
      testingAccountIds: [],
      fallbackTestingAccountIds: []
    });
    session.dispose();
  });

  it("merges a batch in account order and rejects an older single-test result", async () => {
    const fake = createFakeAdapter();
    const session = createAccountCatalogSession(fake.adapter);
    const load = session.load();
    await flushAsyncWork();
    const original = Array.from({ length: 5_000 }, (_, index) => account(`account-${index}`));
    fake.listRuns[0].resolve(original);
    await load;

    const staleTest = session.testConnection("account-0");
    session.mergeTestResults([
      { accountId: "account-0", account: account("account-0", "valid"), ok: true, message: "ok" },
      {
        accountId: "account-1",
        account: null,
        ok: false,
        error: { code: "NETWORK_ERROR", message: "failed", retryable: true }
      },
      { accountId: "account-4998", account: account("account-4998", "valid"), ok: true, message: "ok" }
    ]);
    fake.testRuns.get("account-0")!.resolve(testSuccess(account("account-0", "invalid")));

    await expect(staleTest).resolves.toBeNull();
    const accounts = session.getSnapshot().accounts;
    expect(accounts).toHaveLength(5_000);
    expect(accounts[0].status).toBe("valid");
    expect(accounts[1]).toBe(original[1]);
    expect(accounts[4_998].status).toBe("valid");
    expect(accounts[4_999]).toBe(original[4_999]);
    session.dispose();
  });

  it("applies only the newest full mutation result", async () => {
    const fake = createFakeAdapter();
    const session = createAccountCatalogSession(fake.adapter);
    const older = session.importText("older");
    const newer = session.importText("newer");

    fake.importRuns[1].resolve(importResult([account("newer")]));
    await expect(newer).resolves.toMatchObject({ accounts: [account("newer")] });
    fake.importRuns[0].resolve(importResult([account("older")]));
    await expect(older).resolves.toBeNull();

    expect(session.getSnapshot().accounts).toEqual([account("newer")]);
    session.dispose();
  });

  it("does not let an older account update overwrite a full projection", async () => {
    const fake = createFakeAdapter();
    const pendingUpdate = deferred<AccountView>();
    fake.adapter.update = vi.fn(() => pendingUpdate.promise);
    const session = createAccountCatalogSession(fake.adapter);
    const load = session.load();
    await flushAsyncWork();
    fake.listRuns[0].resolve([account("account-a")]);
    await load;

    const update = session.update({
      id: "account-a",
      email: "old-update@example.com",
      clientId: "client-account-a"
    });
    const imported = session.importText("new projection");
    fake.importRuns[0].resolve(importResult([{ ...account("account-a"), email: "current@example.com" }]));
    await imported;
    pendingUpdate.resolve({ ...account("account-a"), email: "old-update@example.com" });

    await expect(update).resolves.toBeNull();
    expect(session.getSnapshot().accounts[0].email).toBe("current@example.com");
    session.dispose();
  });

  it("returns only the newest import preview", async () => {
    const fake = createFakeAdapter();
    const session = createAccountCatalogSession(fake.adapter);
    const older = session.previewImportText("older");
    const newer = session.previewImportText("newer");
    const olderPreview: ImportPreviewResult = {
      total: 1,
      valid: 0,
      duplicates: 0,
      invalid: 1,
      errors: ["old"],
      warnings: []
    };
    const newerPreview: ImportPreviewResult = {
      total: 1,
      valid: 1,
      duplicates: 0,
      invalid: 0,
      errors: [],
      warnings: []
    };

    fake.previewRuns[0].resolve(olderPreview);
    await expect(older).resolves.toBeNull();
    fake.previewRuns[1].resolve(newerPreview);
    await expect(newer).resolves.toEqual(newerPreview);
    session.dispose();
  });

  it("ignores both late success and late failure after disposal", async () => {
    const fake = createFakeAdapter();
    const session = createAccountCatalogSession(fake.adapter);
    const load = session.load();
    const test = session.testConnection("account-a");
    await flushAsyncWork();
    const snapshotAtDisposal = session.getSnapshot();

    session.dispose();
    fake.listRuns[0].resolve([account("late")]);
    fake.testRuns.get("account-a")!.reject(new Error("late failure"));

    await expect(load).resolves.toBeNull();
    await expect(test).resolves.toBeNull();
    expect(session.getSnapshot()).toBe(snapshotAtDisposal);
  });
});

describe("account catalog renderer seam", () => {
  it("keeps account transport calls and account projection setters out of views", () => {
    const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const importModalSource = readFileSync(
      new URL("../src/components/ImportModal.tsx", import.meta.url),
      "utf8"
    );

    expect(appSource).toContain("useAccountCatalogSession");
    for (const implementationDetail of [
      "setAccounts",
      "applyAccounts",
      "api.accounts.list",
      "api.accounts.test",
      "api.accounts.testFallback",
      "api.accounts.delete",
      "mergeTestedAccounts"
    ]) {
      expect(appSource).not.toContain(implementationDetail);
    }
    expect(importModalSource).not.toContain("getDesktopApi");
    expect(importModalSource).not.toContain("api.accounts");
  });
});

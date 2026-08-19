import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createRefreshJobSession,
  type RefreshJobAdapter
} from "../src/refresh-job-session";
import type {
  AccountView,
  RefreshJobKind,
  RefreshManyResult,
  RefreshProgressEvent,
  TestManyResult,
  TestProgressEvent
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

function account(id: string): AccountView {
  return {
    id,
    email: `${id}@example.com`,
    clientId: "client-id",
    remark: "",
    group: "",
    status: "valid",
    lastCheckedAt: "2026-08-19T08:00:00.000Z",
    lastError: null,
    createdAt: "2026-08-19T08:00:00.000Z",
    updatedAt: "2026-08-19T08:00:00.000Z"
  };
}

function testSuccess(accountId: string): TestManyResult {
  return { accountId, account: account(accountId), ok: true, message: "ok" };
}

function testFailure(accountId: string): TestManyResult {
  return {
    accountId,
    account: null,
    ok: false,
    error: { code: "NETWORK_ERROR", message: "failed", retryable: true }
  };
}

function refreshSuccess(accountId: string): RefreshManyResult {
  return { accountId, ok: true, count: 1 };
}

function refreshFailure(accountId: string, canceled = false): RefreshManyResult {
  return {
    accountId,
    ok: false,
    count: 0,
    canceled,
    error: {
      code: canceled ? "CANCELED" : "NETWORK_ERROR",
      message: canceled ? "canceled" : "failed",
      retryable: !canceled
    }
  };
}

function createFakeAdapter() {
  const testListeners = new Set<(event: TestProgressEvent) => void>();
  const refreshListeners = new Set<(event: RefreshProgressEvent) => void>();
  const testRuns: Array<ReturnType<typeof deferred<TestManyResult[]>>> = [];
  const refreshRuns: Array<{
    accountIds: string[];
    kind: RefreshJobKind;
    deferred: ReturnType<typeof deferred<RefreshManyResult[]>>;
  }> = [];
  const adapter: RefreshJobAdapter = {
    testMany: vi.fn(() => {
      const run = deferred<TestManyResult[]>();
      testRuns.push(run);
      return run.promise;
    }),
    refreshMany: vi.fn((accountIds, kind) => {
      const run = deferred<RefreshManyResult[]>();
      refreshRuns.push({ accountIds, kind, deferred: run });
      return run.promise;
    }),
    cancel: vi.fn(async (kind) => ({ canceled: kind, count: 1 })),
    onTestProgress: vi.fn((listener) => {
      testListeners.add(listener);
      return () => testListeners.delete(listener);
    }),
    onRefreshProgress: vi.fn((listener) => {
      refreshListeners.add(listener);
      return () => refreshListeners.delete(listener);
    })
  };

  return {
    adapter,
    emitTest(event: TestProgressEvent) {
      for (const listener of testListeners) {
        listener(event);
      }
    },
    emitRefresh(event: RefreshProgressEvent) {
      for (const listener of refreshListeners) {
        listener(event);
      }
    },
    listenerCounts() {
      return { test: testListeners.size, refresh: refreshListeners.size };
    },
    refreshRuns,
    testRuns
  };
}

describe("refresh job session", () => {
  it("correlates monotonic test progress by jobId and ignores stale events", async () => {
    const fake = createFakeAdapter();
    const session = createRefreshJobSession(fake.adapter);
    const execution = session.runTest(["account-a", "account-b"]);
    expect(execution).not.toBeNull();
    expect(session.getSnapshot()).toMatchObject({
      testRunning: true,
      anyJobRunning: true,
      progressText: "测试中 0/2 · 可用 0 · 失效 0"
    });

    fake.emitTest({
      jobId: "job-1",
      kind: "test",
      completed: 1,
      total: 2,
      ok: 1,
      failed: 0,
      accountId: "account-a"
    });
    fake.emitTest({
      jobId: "job-1",
      kind: "test",
      completed: 0,
      total: 2,
      ok: 0,
      failed: 0,
      accountId: "account-b"
    });
    fake.emitTest({
      jobId: "unrelated-job",
      kind: "test",
      completed: 2,
      total: 2,
      ok: 2,
      failed: 0,
      accountId: "account-b"
    });
    expect(session.getSnapshot().progressText).toBe("测试中 1/2 · 可用 1 · 失效 0");

    fake.testRuns[0].resolve([testSuccess("account-a"), testFailure("account-b")]);
    await expect(execution!).resolves.toHaveLength(2);
    expect(session.getSnapshot()).toMatchObject({
      testRunning: false,
      anyJobRunning: false,
      progressText: "测试完成 1/2"
    });

    fake.emitTest({
      jobId: "job-1",
      kind: "test",
      completed: 2,
      total: 2,
      ok: 2,
      failed: 0,
      accountId: "account-b"
    });
    expect(session.getSnapshot().progressText).toBe("测试完成 1/2");
    session.dispose();
  });

  it("keeps foreground jobs mutually exclusive and background progress silent", async () => {
    const fake = createFakeAdapter();
    const session = createRefreshJobSession(fake.adapter);
    const testExecution = session.runTest(["account-a"]);

    expect(session.runRefresh(["account-a"], "refresh")).toBeNull();
    expect(session.runRefresh(["account-a"], "refreshBackground")).toBeNull();
    expect(session.runRefresh(["account-a"], "refreshSingle")).toBeNull();

    fake.testRuns[0].resolve([testSuccess("account-a")]);
    await testExecution;
    expect(session.getSnapshot().progressText).toBe("测试完成 1/1");

    const backgroundExecution = session.runRefresh(["account-a"], "refreshBackground");
    expect(backgroundExecution).not.toBeNull();
    expect(session.getSnapshot()).toMatchObject({
      backgroundRefreshRunning: true,
      progressText: "测试完成 1/1"
    });
    expect(session.runTest(["account-b"])).toBeNull();

    fake.emitRefresh({
      jobId: "background-job",
      kind: "refreshBackground",
      completed: 1,
      total: 1,
      ok: 1,
      failed: 0,
      accountId: "account-a"
    });
    expect(session.getSnapshot().progressText).toBe("测试完成 1/1");
    fake.refreshRuns[0].deferred.resolve([refreshSuccess("account-a")]);
    await backgroundExecution;
    expect(session.getSnapshot()).toMatchObject({
      backgroundRefreshRunning: false,
      progressText: "测试完成 1/1"
    });
    session.dispose();
  });

  it("runs different single-account refreshes in parallel and deduplicates each account", async () => {
    const fake = createFakeAdapter();
    const session = createRefreshJobSession(fake.adapter);
    const accountAExecution = session.runRefresh(["account-a"], "refreshSingle");
    const accountBExecution = session.runRefresh(["account-b"], "refreshSingle");

    expect(accountAExecution).not.toBeNull();
    expect(accountBExecution).not.toBeNull();
    expect(session.runRefresh(["account-a"], "refreshSingle")).toBeNull();
    expect(session.runRefresh(["account-c"], "refresh")).toBeNull();
    expect(session.getSnapshot()).toMatchObject({
      anyJobRunning: true,
      singleRefreshBlocked: false,
      busyAccountIds: ["account-a", "account-b"],
      progressText: ""
    });

    fake.emitRefresh({
      jobId: "single-a",
      kind: "refreshSingle",
      completed: 1,
      total: 1,
      ok: 1,
      failed: 0,
      accountId: "account-a"
    });
    fake.emitRefresh({
      jobId: "single-b",
      kind: "refreshSingle",
      completed: 1,
      total: 1,
      ok: 0,
      failed: 1,
      accountId: "account-b"
    });
    expect(session.getSnapshot().progressText).toBe("");

    fake.refreshRuns[0].deferred.resolve([refreshSuccess("account-a")]);
    fake.refreshRuns[1].deferred.resolve([refreshFailure("account-b")]);
    await Promise.all([accountAExecution, accountBExecution]);
    expect(session.getSnapshot()).toMatchObject({
      anyJobRunning: false,
      busyAccountIds: []
    });
    session.dispose();
  });

  it("projects only retryable manual refresh failures and preserves them across background work", async () => {
    const fake = createFakeAdapter();
    const session = createRefreshJobSession(fake.adapter);
    const execution = session.runRefresh(
      ["account-a", "account-b", "account-c"],
      "refresh"
    );
    fake.refreshRuns[0].deferred.resolve([
      refreshSuccess("account-a"),
      refreshFailure("account-b"),
      refreshFailure("account-c", true)
    ]);
    await execution;

    expect(session.getSnapshot()).toMatchObject({
      progressText: "刷新完成 1/3",
      failedRefreshAccountIds: ["account-b"],
      canRetryFailedRefresh: true
    });

    const backgroundExecution = session.runRefresh(["account-a"], "refreshBackground");
    expect(session.getSnapshot()).toMatchObject({
      progressText: "刷新完成 1/3",
      failedRefreshAccountIds: ["account-b"],
      canRetryFailedRefresh: false
    });
    fake.refreshRuns[1].deferred.resolve([refreshSuccess("account-a")]);
    await backgroundExecution;
    expect(session.getSnapshot()).toMatchObject({
      progressText: "刷新完成 1/3",
      failedRefreshAccountIds: ["account-b"],
      canRetryFailedRefresh: true
    });

    const singleExecution = session.runRefresh(["account-c"], "refreshSingle");
    expect(session.getSnapshot()).toMatchObject({
      failedRefreshAccountIds: ["account-b"],
      canRetryFailedRefresh: false
    });
    fake.refreshRuns[2].deferred.resolve([refreshSuccess("account-c")]);
    await singleExecution;
    expect(session.getSnapshot()).toMatchObject({
      failedRefreshAccountIds: ["account-b"],
      canRetryFailedRefresh: true
    });
    session.dispose();
  });

  it("projects cancellation once and returns to a completed state", async () => {
    const fake = createFakeAdapter();
    const session = createRefreshJobSession(fake.adapter);
    const execution = session.runRefresh(["account-a"], "refresh");

    await expect(session.cancel("refresh")).resolves.toEqual({ canceled: "refresh", count: 1 });
    expect(session.getSnapshot().progressText).toBe("正在取消刷新 0/1 · 成功 0 · 失败 0");
    await expect(session.cancel("refresh")).resolves.toBeNull();
    expect(fake.adapter.cancel).toHaveBeenCalledTimes(1);

    fake.refreshRuns[0].deferred.resolve([refreshFailure("account-a", true)]);
    await execution;
    expect(session.getSnapshot()).toMatchObject({
      manualRefreshRunning: false,
      progressText: "刷新完成 0/1",
      failedRefreshAccountIds: [],
      canRetryFailedRefresh: false
    });
    session.dispose();
  });

  it("clears running state after adapter failure", async () => {
    const fake = createFakeAdapter();
    const session = createRefreshJobSession(fake.adapter);
    const execution = session.runTest(["account-a"]);
    fake.testRuns[0].reject(new Error("invoke failed"));

    await expect(execution).rejects.toThrow("invoke failed");
    expect(session.getSnapshot()).toMatchObject({
      testRunning: false,
      anyJobRunning: false,
      progress: null,
      progressText: ""
    });
    session.dispose();
  });

  it("disconnects progress and ignores completion after disposal", async () => {
    const fake = createFakeAdapter();
    const session = createRefreshJobSession(fake.adapter);
    const listener = vi.fn();
    session.subscribe(listener);
    const execution = session.runTest(["account-a"]);
    const snapshotAtDisposal = session.getSnapshot();

    expect(fake.listenerCounts()).toEqual({ test: 1, refresh: 1 });
    session.dispose();
    expect(fake.listenerCounts()).toEqual({ test: 0, refresh: 0 });
    fake.testRuns[0].resolve([testSuccess("account-a")]);
    await expect(execution).resolves.toBeNull();

    expect(session.getSnapshot()).toBe(snapshotAtDisposal);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores adapter rejection after disposal", async () => {
    const fake = createFakeAdapter();
    const session = createRefreshJobSession(fake.adapter);
    const execution = session.runRefresh(["account-a"], "refresh");

    session.dispose();
    fake.refreshRuns[0].deferred.reject(new Error("late invoke failure"));

    await expect(execution).resolves.toBeNull();
  });

  it("removes the first listener if the second listener cannot be registered", () => {
    const fake = createFakeAdapter();
    fake.adapter.onRefreshProgress = vi.fn(() => {
      throw new Error("listener registration failed");
    });
    const session = createRefreshJobSession(fake.adapter);

    expect(() => session.subscribe(() => undefined)).toThrow("listener registration failed");
    expect(fake.listenerCounts()).toEqual({ test: 0, refresh: 0 });
    session.dispose();
  });
});

describe("refresh job renderer boundary", () => {
  it("keeps orchestration and progress subscriptions out of App", () => {
    const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

    for (const staleImplementationDetail of [
      "setBulkProgress",
      "bulkTesting",
      "bulkRefreshing",
      "bulkProgress",
      "refreshingAccountIds",
      "lastRefreshResults",
      "silentRefreshRef",
      "autoRefreshRunningRef",
      "api.accounts.testMany",
      "api.accounts.refreshMany",
      "onRefreshProgress",
      "onTestProgress"
    ]) {
      expect(appSource).not.toContain(staleImplementationDetail);
    }
  });
});

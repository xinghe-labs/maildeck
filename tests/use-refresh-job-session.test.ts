// @vitest-environment jsdom

import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlookManagerApi } from "../electron/preload/index.cjs";
import type {
  RefreshJobKind,
  RefreshManyResult,
  RefreshProgressEvent,
  TestManyResult,
  TestProgressEvent
} from "../src/types";
import { useRefreshJobSession } from "../src/use-refresh-job-session";

type RefreshJobFacade = ReturnType<typeof useRefreshJobSession>;

const reactTestGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createApi() {
  const testListeners = new Set<(event: TestProgressEvent) => void>();
  const refreshListeners = new Set<(event: RefreshProgressEvent) => void>();
  const testRuns: Array<ReturnType<typeof deferred<TestManyResult[]>>> = [];
  const refreshRuns: Array<{
    accountIds: string[];
    kind: RefreshJobKind;
    deferred: ReturnType<typeof deferred<RefreshManyResult[]>>;
  }> = [];
  const accounts = {
    testMany: vi.fn(() => {
      const run = deferred<TestManyResult[]>();
      testRuns.push(run);
      return run.promise;
    }),
    refreshMany: vi.fn((accountIds: string[], kind: RefreshJobKind) => {
      const run = deferred<RefreshManyResult[]>();
      refreshRuns.push({ accountIds, kind, deferred: run });
      return run.promise;
    }),
    onTestProgress: vi.fn((listener: (event: TestProgressEvent) => void) => {
      testListeners.add(listener);
      return () => testListeners.delete(listener);
    }),
    onRefreshProgress: vi.fn((listener: (event: RefreshProgressEvent) => void) => {
      refreshListeners.add(listener);
      return () => refreshListeners.delete(listener);
    })
  };
  const api = {
    accounts,
    jobs: {
      cancel: vi.fn(async (kind: "test" | "refresh") => ({ canceled: kind, count: 1 }))
    }
  } as unknown as OutlookManagerApi;

  return {
    api,
    accounts,
    listenerCounts: () => ({ test: testListeners.size, refresh: refreshListeners.size }),
    refreshRuns,
    testRuns
  };
}

describe("useRefreshJobSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("keeps one listener pair through StrictMode replay and disconnects after unmount", async () => {
    const fake = createApi();
    let facade: RefreshJobFacade | null = null;
    function Probe() {
      facade = useRefreshJobSession(fake.api);
      return null;
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });

    expect(fake.listenerCounts()).toEqual({ test: 1, refresh: 1 });
    expect(fake.accounts.onTestProgress).toHaveBeenCalledTimes(1);
    expect(fake.accounts.onRefreshProgress).toHaveBeenCalledTimes(1);

    let execution: ReturnType<RefreshJobFacade["runTest"]> = null;
    act(() => {
      execution = facade!.runTest(["account-a"]);
    });
    expect(execution).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    await vi.runAllTimersAsync();
    expect(fake.listenerCounts()).toEqual({ test: 0, refresh: 0 });

    fake.testRuns[0].resolve([]);
    await expect(execution).resolves.toBeNull();
  });

  it("disposes the old session when the Electron API identity changes", async () => {
    const fakeA = createApi();
    const fakeB = createApi();
    let facade: RefreshJobFacade | null = null;
    function Probe({ api }: { api: OutlookManagerApi }) {
      facade = useRefreshJobSession(api);
      return null;
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe, { api: fakeA.api })));
    });
    expect(fakeA.listenerCounts()).toEqual({ test: 1, refresh: 1 });

    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe, { api: fakeB.api })));
    });
    await vi.runAllTimersAsync();
    expect(fakeA.listenerCounts()).toEqual({ test: 0, refresh: 0 });
    expect(fakeB.listenerCounts()).toEqual({ test: 1, refresh: 1 });

    let execution: ReturnType<RefreshJobFacade["runRefresh"]> = null;
    act(() => {
      execution = facade!.runRefresh(["account-b"], "refreshSingle");
    });
    expect(fakeA.accounts.refreshMany).not.toHaveBeenCalled();
    expect(fakeB.accounts.refreshMany).toHaveBeenCalledWith(["account-b"], "refreshSingle");

    fakeB.refreshRuns[0].deferred.resolve([{ accountId: "account-b", ok: true, count: 0 }]);
    await expect(execution).resolves.toEqual([{ accountId: "account-b", ok: true, count: 0 }]);

    await act(async () => {
      root.unmount();
    });
    await vi.runAllTimersAsync();
    expect(fakeB.listenerCounts()).toEqual({ test: 0, refresh: 0 });
  });
});

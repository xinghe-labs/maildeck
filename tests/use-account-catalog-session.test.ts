// @vitest-environment jsdom

import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlookManagerApi } from "../electron/preload/index.cjs";
import type { AccountView } from "../src/types";
import { useAccountCatalogSession } from "../src/use-account-catalog-session";

type AccountCatalogFacade = ReturnType<typeof useAccountCatalogSession>;

const reactTestGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function account(id: string): AccountView {
  const timestamp = "2026-08-19T00:00:00.000Z";
  return {
    id,
    email: `${id}@example.com`,
    clientId: `client-${id}`,
    remark: "",
    group: "",
    status: "untested",
    lastCheckedAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createApi() {
  const listRuns: Array<ReturnType<typeof deferred<AccountView[]>>> = [];
  const accounts = {
    list: vi.fn(() => {
      const run = deferred<AccountView[]>();
      listRuns.push(run);
      return run.promise;
    })
  };
  return {
    api: { accounts } as unknown as OutlookManagerApi,
    accounts,
    listRuns
  };
}

describe("useAccountCatalogSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("deduplicates StrictMode loads and ignores completion after real unmount", async () => {
    const fake = createApi();
    let facade: AccountCatalogFacade | null = null;
    function Probe() {
      facade = useAccountCatalogSession(fake.api);
      return null;
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });

    let first: ReturnType<AccountCatalogFacade["load"]>;
    let second: ReturnType<AccountCatalogFacade["load"]>;
    act(() => {
      first = facade!.load();
      second = facade!.load();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(first!).toBe(second!);
    expect(fake.accounts.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    await vi.runAllTimersAsync();
    fake.listRuns[0].resolve([account("late")]);
    await expect(first!).resolves.toBeNull();
  });

  it("disposes an old session when the Electron adapter identity changes", async () => {
    const fakeA = createApi();
    const fakeB = createApi();
    let facade: AccountCatalogFacade | null = null;
    function Probe({ api }: { api: OutlookManagerApi }) {
      facade = useAccountCatalogSession(api);
      return null;
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe, { api: fakeA.api })));
    });
    let staleLoad: ReturnType<AccountCatalogFacade["load"]>;
    act(() => {
      staleLoad = facade!.load();
    });
    await act(async () => {
      await Promise.resolve();
      root.render(createElement(StrictMode, null, createElement(Probe, { api: fakeB.api })));
    });
    await vi.runAllTimersAsync();

    fakeA.listRuns[0].resolve([account("stale")]);
    await expect(staleLoad!).resolves.toBeNull();

    let currentLoad: ReturnType<AccountCatalogFacade["load"]>;
    act(() => {
      currentLoad = facade!.load();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fakeB.accounts.list).toHaveBeenCalledTimes(1);
    fakeB.listRuns[0].resolve([account("current")]);
    await expect(currentLoad!).resolves.toEqual([account("current")]);

    await act(async () => {
      root.unmount();
    });
    await vi.runAllTimersAsync();
  });
});

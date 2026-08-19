// @vitest-environment jsdom

import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailboxSessionAdapter } from "../src/mailbox-session";
import { useMailboxSession } from "../src/use-mailbox-session";

type MailboxFacade = ReturnType<typeof useMailboxSession>;

const reactTestGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function createAdapter(): MailboxSessionAdapter {
  return {
    listMessages: vi.fn(async () => ({ messages: [], nextCursor: null, totalCount: 0 })),
    getMessage: vi.fn(async () => {
      throw new Error("No message detail expected");
    })
  };
}

describe("useMailboxSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("survives StrictMode effect replay and disposes after a real unmount", async () => {
    const adapter = createAdapter();
    let mailbox: MailboxFacade | null = null;
    function Probe() {
      mailbox = useMailboxSession(adapter);
      return null;
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });

    act(() => {
      mailbox!.reconcileAccounts([{ id: "account-a" }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(adapter.listMessages).toHaveBeenCalledTimes(1);

    act(() => {
      mailbox!.selectAccount("account-b");
    });
    await act(async () => {
      root.unmount();
    });
    await vi.runAllTimersAsync();

    expect(adapter.listMessages).toHaveBeenCalledTimes(1);
  });

  it("disposes the previous session when the desktop adapter changes", async () => {
    const adapterA = createAdapter();
    const adapterB = createAdapter();
    let mailbox: MailboxFacade | null = null;
    function Probe({ adapter }: { adapter: MailboxSessionAdapter }) {
      mailbox = useMailboxSession(adapter);
      return null;
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe, { adapter: adapterA })));
    });
    act(() => {
      mailbox!.selectAccount("account-a");
    });

    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe, { adapter: adapterB })));
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(adapterA.listMessages).not.toHaveBeenCalled();

    act(() => {
      mailbox!.reconcileAccounts([{ id: "account-b" }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(adapterB.listMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    await vi.runAllTimersAsync();
  });
});

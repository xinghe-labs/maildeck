import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createMailboxSession,
  type MailboxSession,
  type MailboxSessionAdapter
} from "../src/mailbox-session";
import type {
  MailListResult,
  MailMessageDetail,
  MailMessageSummary
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

function summary(id: string, subject = id): MailMessageSummary {
  return {
    id,
    subject,
    from: { name: "Sender", address: "sender@example.com" },
    receivedDateTime: "2026-08-19T08:00:00.000Z",
    sentDateTime: null,
    isRead: false,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: `${subject} preview`,
    webLink: null
  };
}

function detail(id: string, subject = id): MailMessageDetail {
  return {
    ...summary(id, subject),
    toRecipients: [],
    ccRecipients: [],
    body: { contentType: "text", content: `${subject} body` }
  };
}

function listResult(
  messages: MailMessageSummary[],
  nextCursor: string | null = null,
  totalCount = messages.length
): MailListResult {
  return { messages, nextCursor, totalCount };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("mailbox session", () => {
  it("selects the first reconciled account and loads its default message detail", async () => {
    vi.useFakeTimers();
    let session: MailboxSession | null = null;
    try {
      const adapter: MailboxSessionAdapter = {
        listMessages: vi.fn(async () => listResult([summary("message-a")])),
        getMessage: vi.fn(async () => detail("message-a"))
      };
      session = createMailboxSession(adapter, { selectionDelayMs: 180 });

      session.reconcileAccounts([{ id: "account-a", lastInboxCount: 1 }]);
      expect(session.getSnapshot()).toMatchObject({
        accountId: "account-a",
        messages: [],
        totalCount: 1
      });

      await vi.advanceTimersByTimeAsync(180);
      await flushAsyncWork();

      expect(adapter.listMessages).toHaveBeenCalledWith({
        accountId: "account-a",
        forceRefresh: false,
        search: "",
        top: 50
      });
      expect(adapter.getMessage).toHaveBeenCalledWith({
        accountId: "account-a",
        messageId: "message-a"
      });
      expect(session.getSnapshot()).toMatchObject({
        accountId: "account-a",
        selectedMessageId: "message-a",
        messageDetail: detail("message-a"),
        loadingMessages: false,
        loadingDetail: false
      });
    } finally {
      session?.dispose();
      vi.useRealTimers();
    }
  });

  it("ignores a late account result after another account is selected", async () => {
    const accountA = deferred<MailListResult>();
    const adapter: MailboxSessionAdapter = {
      listMessages: vi.fn((options) =>
        options.accountId === "account-a"
          ? accountA.promise
          : Promise.resolve(listResult([summary("message-b")]))
      ),
      getMessage: vi.fn(async (options) => detail(options.messageId))
    };
    const session = createMailboxSession(adapter);

    session.selectAccount("account-a");
    const loadAccountA = session.reload();
    session.selectAccount("account-b");
    await session.reload();
    await flushAsyncWork();

    accountA.resolve(listResult([summary("message-a")]));
    await loadAccountA;
    await flushAsyncWork();

    expect(session.getSnapshot()).toMatchObject({
      accountId: "account-b",
      messages: [summary("message-b")],
      selectedMessageId: "message-b",
      messageDetail: detail("message-b"),
      error: ""
    });
    session.dispose();
  });

  it("reloads only when the current account belongs to the expected set", async () => {
    const adapter: MailboxSessionAdapter = {
      listMessages: vi.fn(async (options) =>
        listResult([summary(`message-${options.accountId}`)])
      ),
      getMessage: vi.fn(async (options) => detail(options.messageId))
    };
    const session = createMailboxSession(adapter);

    session.selectAccount("account-a");
    await session.reload();
    session.selectAccount("account-b");

    await expect(session.reloadIfCurrentAccount(["account-a"])).resolves.toBe(false);
    expect(adapter.listMessages).toHaveBeenCalledTimes(1);

    await expect(
      session.reloadIfCurrentAccount(["account-a", "account-b"])
    ).resolves.toBe(true);
    expect(adapter.listMessages).toHaveBeenLastCalledWith({
      accountId: "account-b",
      forceRefresh: false,
      search: "",
      top: 50
    });
    expect(session.getSnapshot().accountId).toBe("account-b");
    session.dispose();
  });

  it("ignores a late pagination failure from the previously selected account", async () => {
    const latePage = deferred<MailListResult>();
    const adapter: MailboxSessionAdapter = {
      listMessages: vi.fn((options) => {
        if (options.accountId === "account-a" && options.cursor) {
          return latePage.promise;
        }
        if (options.accountId === "account-a") {
          return Promise.resolve(listResult([summary("message-a")], "page-a", 2));
        }
        return Promise.resolve(listResult([summary("message-b")]));
      }),
      getMessage: vi.fn(async (options) => detail(options.messageId))
    };
    const session = createMailboxSession(adapter);

    session.selectAccount("account-a");
    await session.reload();
    const loadMore = session.loadMore();
    session.selectAccount("account-b");
    await session.reload();
    latePage.reject(new Error("late page failure"));
    await loadMore;
    await flushAsyncWork();

    expect(session.getSnapshot()).toMatchObject({
      accountId: "account-b",
      messages: [summary("message-b")],
      loadingMessages: false,
      loadingMore: false,
      error: ""
    });
    session.dispose();
  });

  it("deduplicates pagination results and clears the cursor at the total count", async () => {
    const adapter: MailboxSessionAdapter = {
      listMessages: vi.fn((options) => {
        if (options.cursor) {
          return Promise.resolve(
            listResult([summary("message-2", "updated"), summary("message-3")], "page-3", 3)
          );
        }
        return Promise.resolve(
          listResult([summary("message-1"), summary("message-2", "original")], "page-2", 3)
        );
      }),
      getMessage: vi.fn(async (options) => detail(options.messageId))
    };
    const session = createMailboxSession(adapter);

    session.selectAccount("account-a", 3);
    await session.reload();
    await session.loadMore();

    expect(session.getSnapshot().messages.map((message) => [message.id, message.subject])).toEqual([
      ["message-1", "message-1"],
      ["message-2", "updated"],
      ["message-3", "message-3"]
    ]);
    expect(session.getSnapshot()).toMatchObject({ cursor: null, totalCount: 3, loadingMore: false });
    session.dispose();
  });

  it("keeps a late detail result from replacing the newly selected message", async () => {
    const firstDetail = deferred<MailMessageDetail>();
    const adapter: MailboxSessionAdapter = {
      listMessages: vi.fn(async () =>
        listResult([summary("message-1"), summary("message-2")])
      ),
      getMessage: vi.fn((options) =>
        options.messageId === "message-1"
          ? firstDetail.promise
          : Promise.resolve(detail("message-2"))
      )
    };
    const session = createMailboxSession(adapter);

    session.selectAccount("account-a");
    await session.reload();
    await session.selectMessage("message-2");
    firstDetail.resolve(detail("message-1"));
    await flushAsyncWork();

    expect(session.getSnapshot()).toMatchObject({
      selectedMessageId: "message-2",
      messageDetail: detail("message-2"),
      loadingDetail: false,
      error: ""
    });
    session.dispose();
  });

  it("does not let detail success clear a concurrent pagination error", async () => {
    const pendingDetail = deferred<MailMessageDetail>();
    const adapter: MailboxSessionAdapter = {
      listMessages: vi.fn((options) =>
        options.cursor
          ? Promise.reject(new Error("pagination failed"))
          : Promise.resolve(listResult([summary("message-1")], "page-2", 2))
      ),
      getMessage: vi.fn(() => pendingDetail.promise)
    };
    const session = createMailboxSession(adapter);

    session.selectAccount("account-a");
    await session.reload();
    await session.loadMore();
    expect(session.getSnapshot().error).toBe("pagination failed");

    pendingDetail.resolve(detail("message-1"));
    await flushAsyncWork();
    expect(session.getSnapshot()).toMatchObject({
      messageDetail: detail("message-1"),
      loadingDetail: false,
      error: "pagination failed"
    });
    session.dispose();
  });

  it("does not let pagination success clear a concurrent detail error", async () => {
    const pendingPage = deferred<MailListResult>();
    const pendingDetail = deferred<MailMessageDetail>();
    const adapter: MailboxSessionAdapter = {
      listMessages: vi.fn((options) =>
        options.cursor
          ? pendingPage.promise
          : Promise.resolve(listResult([summary("message-1")], "page-2", 2))
      ),
      getMessage: vi.fn(() => pendingDetail.promise)
    };
    const session = createMailboxSession(adapter);

    session.selectAccount("account-a");
    await session.reload();
    const loadMore = session.loadMore();
    pendingDetail.reject(new Error("detail failed"));
    await flushAsyncWork();
    expect(session.getSnapshot().error).toBe("detail failed");

    pendingPage.resolve(listResult([summary("message-2")], null, 2));
    await loadMore;
    expect(session.getSnapshot()).toMatchObject({
      loadingMore: false,
      error: "detail failed"
    });
    session.dispose();
  });

  it("starts a new generation when the search query changes", async () => {
    const oldSearch = deferred<MailListResult>();
    const adapter: MailboxSessionAdapter = {
      listMessages: vi.fn((options) =>
        options.search === "old"
          ? oldSearch.promise
          : Promise.resolve(listResult([summary("new-result")]))
      ),
      getMessage: vi.fn(async (options) => detail(options.messageId))
    };
    const session = createMailboxSession(adapter);

    session.selectAccount("account-a");
    const loadOldSearch = session.search(" old ");
    await session.search("new");
    oldSearch.resolve(listResult([summary("old-result")]));
    await loadOldSearch;
    await flushAsyncWork();

    expect(session.getSnapshot()).toMatchObject({
      query: "new",
      messages: [summary("new-result")],
      selectedMessageId: "new-result",
      error: ""
    });
    session.dispose();
  });

  it("keeps the active search query when switching accounts", async () => {
    const adapter: MailboxSessionAdapter = {
      listMessages: vi.fn(async (options) =>
        listResult([summary(`${options.accountId}-${options.search}`)])
      ),
      getMessage: vi.fn(async (options) => detail(options.messageId))
    };
    const session = createMailboxSession(adapter);

    session.selectAccount("account-a");
    await session.search(" keep me ");
    session.selectAccount("account-b");
    await session.reload();

    expect(adapter.listMessages).toHaveBeenLastCalledWith({
      accountId: "account-b",
      forceRefresh: false,
      search: "keep me",
      top: 50
    });
    expect(session.getSnapshot()).toMatchObject({
      accountId: "account-b",
      query: "keep me",
      selectedMessageId: "account-b-keep me"
    });
    session.dispose();
  });

  it("does not update or notify after disposal", async () => {
    const pendingList = deferred<MailListResult>();
    const adapter: MailboxSessionAdapter = {
      listMessages: vi.fn(() => pendingList.promise),
      getMessage: vi.fn(async (options) => detail(options.messageId))
    };
    const session = createMailboxSession(adapter);
    const listener = vi.fn();
    session.subscribe(listener);
    session.selectAccount("account-a");
    const loading = session.reload();
    const snapshotAtDisposal = session.getSnapshot();
    const notificationCountAtDisposal = listener.mock.calls.length;

    session.dispose();
    pendingList.resolve(listResult([summary("late-message")]));
    await loading;
    await flushAsyncWork();

    expect(session.getSnapshot()).toBe(snapshotAtDisposal);
    expect(listener).toHaveBeenCalledTimes(notificationCountAtDisposal);
  });
});

describe("mailbox session architecture", () => {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  it("keeps mailbox transport calls and request generations out of App", () => {
    expect(appSource).toContain("useMailboxSession");
    expect(appSource).toContain("reloadIfCurrentAccount");
    for (const implementationDetail of [
      "messagesRequestRef",
      "detailRequestRef",
      "api.mail.listMessages",
      "api.mail.getMessage"
    ]) {
      expect(appSource).not.toContain(implementationDetail);
    }
  });
});

/** @vitest-environment jsdom */

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageList } from "../src/components/MessageList";
import type { MailMessageSummary } from "../src/types";

function message(index: number, overrides: Partial<MailMessageSummary> = {}): MailMessageSummary {
  return {
    id: `message-${index}`,
    subject: `Subject ${index}`,
    from: { name: `Sender ${index}`, address: `sender${index}@example.com` },
    receivedDateTime: "2026-08-19T08:00:00.000Z",
    sentDateTime: null,
    isRead: false,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: `Preview ${index}`,
    webLink: null,
    ...overrides
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function renderList(props: Partial<ComponentProps<typeof MessageList>> = {}) {
  const handlers = {
    onMailQueryChange: vi.fn(),
    onExecuteSearch: vi.fn(),
    onClearSearch: vi.fn(),
    onRefresh: vi.fn(),
    onSelectFolder: vi.fn(),
    onSelectMessage: vi.fn(),
    onLoadMore: vi.fn()
  };
  const merged = {
    messages: [],
    selectedMessageId: null,
    loadingMessages: false,
    loadingMore: false,
    mailCursor: null,
    mailQuery: "",
    folders: [],
    selectedFolderId: null,
    inboxFolderId: null,
    canRefresh: true,
    listError: "",
    ...handlers,
    ...props
  };

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(MessageList, merged));
  });

  return { ...handlers, ...props };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function queryRefreshButton() {
  const button = container.querySelector<HTMLButtonElement>("button.toolbar-icon");
  if (!button) {
    throw new Error("refresh button not rendered");
  }
  return button;
}

function querySearchInput() {
  const input = container.querySelector<HTMLInputElement>(".search-box input");
  if (!input) {
    throw new Error("search input not rendered");
  }
  return input;
}

describe("MessageList", () => {
  it("renders one row per message with sender, subject, and preview", () => {
    renderList({ messages: [message(1), message(2, { subject: "Second", bodyPreview: "" })] });

    const rows = container.querySelectorAll(".message-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Sender 1");
    expect(rows[0]?.textContent).toContain("Subject 1");
    expect(rows[0]?.textContent).toContain("Preview 1");
    expect(rows[1]?.textContent).toContain("Second");
  });

  it("marks the selected row and reports clicks", () => {
    const handlers = renderList({
      messages: [message(1), message(2)],
      selectedMessageId: "message-2"
    });

    const rows = container.querySelectorAll<HTMLButtonElement>(".message-row");
    expect(rows[0]?.classList.contains("selected")).toBe(false);
    expect(rows[1]?.classList.contains("selected")).toBe(true);

    act(() => rows[0]?.click());
    expect(handlers.onSelectMessage).toHaveBeenCalledWith("message-1");
  });

  it("shows the empty placeholder only when the list is settled and empty", () => {
    renderList({ messages: [] });
    expect(container.querySelector(".panel-empty")?.textContent).toContain("这个文件夹里还没有邮件");

    act(() => root.unmount());
    renderList({ messages: [], loadingMessages: true });
    expect(container.querySelector(".panel-empty")?.textContent).toContain("正在刷新邮件");
    expect(container.textContent).not.toContain("这个文件夹里还没有邮件");
  });

  it("distinguishes a failed list load from an empty mailbox and offers retry", () => {
    const handlers = renderList({ messages: [], listError: "连接超时" });
    const errorPanel = container.querySelector(".panel-error");
    expect(errorPanel?.textContent).toContain("邮件列表加载失败");
    expect(errorPanel?.textContent).toContain("连接超时");
    expect(container.textContent).not.toContain("这个文件夹里还没有邮件");

    const retry = container.querySelector<HTMLButtonElement>(".panel-error-retry");
    expect(retry).not.toBeNull();
    act(() => retry!.click());
    expect(handlers.onRefresh).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    renderList({ messages: [], listError: "" });
    expect(container.querySelector(".panel-error")).toBeNull();
    expect(container.querySelector(".panel-empty")?.textContent).toContain("这个文件夹里还没有邮件");
  });

  it("shows an attachment marker only for messages that have attachments", () => {
    renderList({ messages: [message(1), message(2, { hasAttachments: true })] });

    const rows = container.querySelectorAll(".message-row");
    expect(rows[0]?.querySelector("svg.lucide-paperclip")).toBeNull();
    expect(rows[1]?.querySelector("svg.lucide-paperclip")).not.toBeNull();
  });

  it("offers load-more only while a cursor exists and the list is not refreshing", () => {
    renderList({ messages: [message(1)], mailCursor: "cursor-1" });
    const loadMore = container.querySelector<HTMLButtonElement>(".load-more-button");
    expect(loadMore?.textContent).toContain("加载更多");
    expect(loadMore?.disabled).toBe(false);

    act(() => root.unmount());
    renderList({ messages: [message(1)], mailCursor: "cursor-1", loadingMore: true });
    expect(container.querySelector<HTMLButtonElement>(".load-more-button")?.disabled).toBe(true);

    act(() => root.unmount());
    renderList({ messages: [message(1)], mailCursor: null });
    expect(container.querySelector(".load-more-button")).toBeNull();
  });

  it("reports load-more clicks", () => {
    const handlers = renderList({ messages: [message(1)], mailCursor: "cursor-1" });

    act(() => container.querySelector<HTMLButtonElement>(".load-more-button")?.click());

    expect(handlers.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("disables the refresh button while refreshing or without a selected account", () => {
    renderList({ messages: [message(1)] });
    expect(queryRefreshButton().disabled).toBe(false);

    act(() => root.unmount());
    renderList({ messages: [message(1)], loadingMessages: true });
    expect(queryRefreshButton().disabled).toBe(true);

    act(() => root.unmount());
    renderList({ messages: [], canRefresh: false });
    expect(queryRefreshButton().disabled).toBe(true);
  });

  it("reports refresh clicks", () => {
    const handlers = renderList({ messages: [message(1)] });

    act(() => queryRefreshButton().click());

    expect(handlers.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("runs the search on Enter and forwards typed input", () => {
    const handlers = renderList({ messages: [message(1)] });

    act(() => setInputValue(querySearchInput(), "invoice"));
    expect(handlers.onMailQueryChange).toHaveBeenCalledWith("invoice");

    act(() => {
      querySearchInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(handlers.onExecuteSearch).toHaveBeenCalledTimes(1);
  });

  it("ignores Enter when there is no account to search", () => {
    const handlers = renderList({ messages: [], canRefresh: false });

    act(() => {
      querySearchInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });

    expect(handlers.onExecuteSearch).not.toHaveBeenCalled();
  });

  it("ignores other keys in the search box", () => {
    const handlers = renderList({ messages: [message(1)] });

    act(() => {
      querySearchInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true })
      );
    });

    expect(handlers.onExecuteSearch).not.toHaveBeenCalled();
  });

  it("marks unread messages with is-unread and leaves read ones unmarked", () => {
    renderList({
      messages: [message(1, { isRead: false }), message(2, { isRead: true })]
    });

    const rows = container.querySelectorAll(".message-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.classList.contains("is-unread")).toBe(true);
    expect(rows[1]?.classList.contains("is-unread")).toBe(false);
  });

  it("does not duplicate the inbox option when the folder list already contains it", () => {
    renderList({
      messages: [message(1)],
      inboxFolderId: "inbox-id",
      folders: [
        { id: "inbox-id", displayName: "收件箱", totalItemCount: 10, unreadItemCount: 1 },
        { id: "junk-id", displayName: "垃圾邮件", totalItemCount: 2, unreadItemCount: 0 },
        { id: "archive-id", displayName: "存档", totalItemCount: 1, unreadItemCount: 0 }
      ]
    });

    const select = container.querySelector<HTMLSelectElement>(".folder-select");
    expect(select).not.toBeNull();
    const labels = [...select!.options].map((option) => option.textContent);
    expect(labels.filter((label) => label === "收件箱")).toHaveLength(1);
    expect(labels).toEqual(["收件箱", "垃圾邮件", "存档"]);
  });

  it("falls back to a synthetic inbox option when the folder list lacks one", () => {
    renderList({
      messages: [message(1)],
      inboxFolderId: null,
      folders: [
        { id: "junk-id", displayName: "垃圾邮件", totalItemCount: 2, unreadItemCount: 0 },
        { id: "archive-id", displayName: "存档", totalItemCount: 1, unreadItemCount: 0 }
      ]
    });

    const select = container.querySelector<HTMLSelectElement>(".folder-select");
    const labels = [...select!.options].map((option) => option.textContent);
    expect(labels).toEqual(["收件箱", "垃圾邮件", "存档"]);
  });
});

describe("MessageList visited rows", () => {
  const unread = message(1, { id: "unread-1", isRead: false });

  it("marks an unread message that was already opened locally", () => {
    // 报告 P0-3：读过的邮件永远保持未读，圆点成了装饰品。
    // 服务器还不支持标记已读时，至少要让用户看出「这封我点开过」。
    renderList({ messages: [unread], visitedMessageIds: new Set(["unread-1"]) });

    const row = container.querySelector(".message-row")!;
    expect(row.classList.contains("is-unread")).toBe(true);
    expect(row.classList.contains("is-visited")).toBe(true);
  });

  it("keeps a never-opened unread message at full strength", () => {
    renderList({ messages: [unread], visitedMessageIds: new Set() });

    const row = container.querySelector(".message-row")!;
    expect(row.classList.contains("is-unread")).toBe(true);
    expect(row.classList.contains("is-visited")).toBe(false);
  });

  it("never marks a read message as visited-unread", () => {
    renderList({ messages: [message(1, { id: "read-1", isRead: true })], visitedMessageIds: new Set(["read-1"]) });

    const row = container.querySelector(".message-row")!;
    expect(row.classList.contains("is-unread")).toBe(false);
    expect(row.classList.contains("is-visited")).toBe(false);
  });
});

describe("MessageList loading feedback", () => {
  // 报告 P2-16：切到草稿箱后只有一行「正在刷新邮件」，用户不知道是在加载还是卡死。
  it("等待超过 3 秒后显示已等待秒数", () => {
    vi.useFakeTimers();
    try {
      renderList({ messages: [], loadingMessages: true });
      expect(container.querySelector(".panel-empty")?.textContent).toContain("正在刷新邮件");

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(container.querySelector(".panel-empty")?.textContent).toContain("已等待 4 秒");
    } finally {
      vi.useRealTimers();
    }
  });

  it("等待超过 8 秒后补一句说明", () => {
    vi.useFakeTimers();
    try {
      renderList({ messages: [], loadingMessages: true });

      act(() => {
        vi.advanceTimersByTime(9000);
      });

      expect(container.querySelector(".panel-empty-hint")?.textContent).toContain("30 秒会超时");
    } finally {
      vi.useRealTimers();
    }
  });

  it("加载结束后计时归零，不会把秒数带到下一次", () => {
    vi.useFakeTimers();
    try {
      renderList({ messages: [], loadingMessages: true });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(container.querySelector(".panel-empty")?.textContent).toContain("已等待 5 秒");
    } finally {
      vi.useRealTimers();
    }

    renderList({ messages: [], loadingMessages: true });
    expect(container.querySelector(".panel-empty")?.textContent).toContain("正在刷新邮件");
    expect(container.querySelector(".panel-empty")?.textContent).not.toContain("已等待");
  });
});

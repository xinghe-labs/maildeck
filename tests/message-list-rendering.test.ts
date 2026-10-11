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
    onRefresh: vi.fn(),
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
    canRefresh: true,
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
    expect(container.querySelector(".panel-empty")?.textContent).toContain("没有邮件可显示");

    act(() => root.unmount());
    renderList({ messages: [], loadingMessages: true });
    expect(container.querySelector(".panel-empty")?.textContent).toContain("正在刷新邮件");
    expect(container.textContent).not.toContain("没有邮件可显示");
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
});

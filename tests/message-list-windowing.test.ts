/** @vitest-environment jsdom */

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageList } from "../src/components/MessageList";
import type { MailMessageSummary } from "../src/types";

function message(index: number): MailMessageSummary {
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
    webLink: null
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
    onMailQueryChange: vi.fn(),
    onExecuteSearch: vi.fn(),
    onClearSearch: vi.fn(),
    onRefresh: vi.fn(),
    onSelectFolder: vi.fn(),
    onSelectMessage: vi.fn(),
    onLoadMore: vi.fn(),
    ...props
  };

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(MessageList, merged));
  });

  return merged;
}

describe("MessageList large-list windowing", () => {
  const messageRowStride = 64;

  it("keeps a bounded number of message rows in the DOM", () => {
    renderList({ messages: Array.from({ length: 5_000 }, (_, index) => message(index)) });

    const rows = container.querySelectorAll(".message-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(40);
    expect(container.textContent).toContain("Subject 0");
    expect(container.textContent).not.toContain("Subject 100");
  });

  it("moves the rendered window when the message list scrolls", () => {
    renderList({ messages: Array.from({ length: 5_000 }, (_, index) => message(index)) });
    const scrollArea = container.querySelector<HTMLElement>(".message-scroll");
    expect(scrollArea).not.toBeNull();

    act(() => {
      scrollArea!.scrollTop = messageRowStride * 100;
      scrollArea!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    expect(container.querySelector('[data-message-index="100"]')).not.toBeNull();
    expect(container.querySelector('[data-message-index="0"]')).toBeNull();
    expect(container.querySelectorAll(".message-row").length).toBeLessThan(40);
  });

  it("returns to the top when the list is rebuilt after a reload", () => {
    const messages = Array.from({ length: 5_000 }, (_, index) => message(index));
    renderList({ messages });
    const scrollArea = container.querySelector<HTMLElement>(".message-scroll")!;

    act(() => {
      scrollArea.scrollTop = messageRowStride * 100;
      scrollArea.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(container.querySelector('[data-message-index="100"]')).not.toBeNull();

    // 刷新重建列表：先清空再装填新数组（mailbox session reload 的实际序列）。
    act(() => {
      root.render(createElement(MessageList, listProps([])));
    });
    act(() => {
      root.render(
        createElement(
          MessageList,
          listProps(messages.map((item, index) => ({ ...item, id: `message-${index}` })))
        )
      );
    });

    expect(scrollArea.scrollTop).toBe(0);
    expect(container.querySelector('[data-message-index="0"]')).not.toBeNull();
  });
});

function listProps(messages: MailMessageSummary[]): ComponentProps<typeof MessageList> {
  return {
    messages,
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
    onMailQueryChange: vi.fn(),
    onExecuteSearch: vi.fn(),
    onClearSearch: vi.fn(),
    onRefresh: vi.fn(),
    onSelectFolder: vi.fn(),
    onSelectMessage: vi.fn(),
    onLoadMore: vi.fn()
  };
}

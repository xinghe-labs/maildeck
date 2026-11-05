/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageList, folderDisplayLabel } from "../src/components/MessageList";
import { AccountSidebar } from "../src/components/AccountSidebar";
import type { AccountView, MailFolder, MailMessageSummary } from "../src/types";

function message(index: number): MailMessageSummary {
  return {
    id: `message-${index}`,
    subject: `Subject ${index}`,
    from: { name: `Sender ${index}`, address: `sender${index}@example.com` },
    receivedDateTime: "2026-08-19T08:00:00.000Z",
    sentDateTime: null,
    isRead: true,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: `Preview ${index}`,
    webLink: null
  };
}

function accountView(id: string): AccountView {
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

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function renderMessageList(props: Partial<Parameters<typeof MessageList>[0]> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(MessageList, {
        messages: [message(1)],
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
      })
    );
  });
}

const folder = (id: string, displayName: string): MailFolder => ({
  id,
  displayName,
  totalItemCount: 1,
  unreadItemCount: 0
});

describe("folder display name mapping", () => {
  it("maps common English folder names to Chinese labels", () => {
    expect(folderDisplayLabel("INBOX")).toBe("收件箱");
    expect(folderDisplayLabel("Sent")).toBe("已发送");
    expect(folderDisplayLabel("Sent Items")).toBe("已发送");
    expect(folderDisplayLabel("Junk")).toBe("垃圾邮件");
    expect(folderDisplayLabel("Deleted")).toBe("已删除");
    expect(folderDisplayLabel("Drafts")).toBe("草稿箱");
    expect(folderDisplayLabel("Outbox")).toBe("发件箱");
  });

  it("keeps unknown folder names verbatim", () => {
    expect(folderDisplayLabel("自定义文件夹")).toBe("自定义文件夹");
    expect(folderDisplayLabel("WeirdCustom")).toBe("WeirdCustom");
  });

  it("renders mapped labels in the folder select", () => {
    renderMessageList({
      folders: [
        folder("inbox-id", "INBOX"),
        folder("sent-id", "Sent"),
        folder("junk-id", "Junk")
      ],
      inboxFolderId: "inbox-id"
    });

    const select = container.querySelector<HTMLSelectElement>(".folder-select");
    const labels = [...select!.options].map((option) => option.textContent);
    expect(labels).toEqual(["收件箱", "已发送", "垃圾邮件"]);
  });
});

describe("Ctrl+F focuses the sidebar search input", () => {
  it("focuses the search input when Ctrl+F is pressed", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const onAccountQueryChange = vi.fn();

    act(() => {
      root.render(
        createElement(AccountSidebar, {
          accounts: [accountView("account-a")],
          filteredAccounts: [accountView("account-a")],
          selectedAccountId: "account-a",
          loadingAccounts: false,
          accountQuery: "",
          statusFilter: "all",
          onAccountQueryChange,
          onStatusFilterChange: vi.fn(),
          onSelectAccount: vi.fn(),
          onOpenImport: vi.fn(),
          onImportFromFile: vi.fn(),
          onReloadAccounts: vi.fn(),
          onOpenSettings: vi.fn(),
          newMailCounts: {},
          busyAccountIds: new Set<string>(),
          onRefreshAccount: vi.fn()
        })
      );
    });

    const input = container.querySelector<HTMLInputElement>('input[placeholder="搜索邮箱"]');
    expect(input).not.toBeNull();

    const prevented = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(prevented);
    });
    expect(document.activeElement).toBe(input);
    expect(prevented.defaultPrevented).toBe(true);
  });
});

/** @vitest-environment jsdom */

import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountSidebar } from "../src/components/AccountSidebar";
import { MessageList } from "../src/components/MessageList";
import { SettingsModal } from "../src/components/SettingsModal";
import type { AccountView, AppSettings, MailMessageSummary } from "../src/types";
import { accountInboxSummary, accountMailStats } from "../src/ui-utils";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function account(overrides: Partial<AccountView> = {}): AccountView {
  const timestamp = "2026-08-15T00:00:00.000Z";
  return {
    id: "account-a",
    email: "user@example.com",
    clientId: "client-a",
    remark: "",
    group: "",
    status: "valid",
    lastCheckedAt: timestamp,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function sidebarProps(
  accounts: AccountView[],
  overrides: Partial<ComponentProps<typeof AccountSidebar>> = {}
): ComponentProps<typeof AccountSidebar> {
  return {
    accounts,
    filteredAccounts: accounts,
    selectedAccountId: accounts[0]?.id ?? null,
    loadingAccounts: false,
    accountQuery: "",
    statusFilter: "all",
    onAccountQueryChange: vi.fn(),
    onStatusFilterChange: vi.fn(),
    onSelectAccount: vi.fn(),
    onOpenImport: vi.fn(),
    onImportFromFile: vi.fn(),
    onReloadAccounts: vi.fn(),
    onOpenSettings: vi.fn(),
    newMailCounts: {},
    busyAccountIds: new Set<string>(),
    onRefreshAccount: vi.fn(),
    ...overrides
  };
}

function message(id: string): MailMessageSummary {
  return {
    id,
    subject: `subject ${id}`,
    from: { name: "Sender", address: "sender@example.com" },
    receivedDateTime: "2026-08-19T08:00:00.000Z",
    sentDateTime: null,
    isRead: false,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: "preview",
    webLink: null
  };
}

function listProps(overrides: Partial<ComponentProps<typeof MessageList>> = {}) {
  return {
    messages: [] as MailMessageSummary[],
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
    ...overrides
  };
}

describe("账号侧栏的状态与引导", () => {
  it("shows each status count on the filter segments", () => {
    const element = render(
      createElement(
        AccountSidebar,
        sidebarProps([
          account({ id: "a", email: "a@x.com", status: "valid" }),
          account({ id: "b", email: "b@x.com", status: "invalid" }),
          account({ id: "c", email: "c@x.com", status: "untested" })
        ])
      )
    );

    const segments = Array.from(element.querySelectorAll(".segmented button")).map((node) =>
      node.textContent?.replace(/\s+/g, "")
    );

    expect(segments).toContain("全部3");
    expect(segments).toContain("可用1");
    expect(segments).toContain("失效1");
    expect(segments).toContain("未测1");
  });

  it("offers the import call-to-action when no account exists", () => {
    const onOpenImport = vi.fn();
    const element = render(createElement(AccountSidebar, sidebarProps([], { onOpenImport })));
    const callToAction = element.querySelector<HTMLButtonElement>(".panel-error-retry");

    expect(element.textContent).toContain("还没有导入任何邮箱");
    expect(callToAction?.textContent).toBe("导入第一个账号");

    act(() => callToAction!.click());
    expect(onOpenImport).toHaveBeenCalledTimes(1);
  });

  it("keeps the failure reason reachable as a tooltip instead of a toast", () => {
    const element = render(
      createElement(
        AccountSidebar,
        sidebarProps([account({ status: "invalid", lastError: "AADSTS7000215: 密钥无效" })])
      )
    );

    const row = element.querySelector('[title*="AADSTS7000215"]');
    expect(row).not.toBeNull();
  });

  it("describes the workspace header as a failure instead of 0 封", () => {
    expect(
      accountInboxSummary({ status: "invalid", lastInboxCount: null, lastMailAt: null } as never)
    ).toBe("收件箱读取失败 · 点上方「刷新」重试");
    expect(
      accountInboxSummary({
        status: "invalid",
        lastRefreshedAt: null,
        lastInboxCount: 0,
        lastMailAt: null
      } as never)
    ).toBe("收件箱读取失败 · 点上方「刷新」重试");
    expect(
      accountInboxSummary({ status: "valid", lastInboxCount: 12, lastMailAt: null } as never)
    ).toBe("收件箱 12 封 · 最新邮件 未刷新");
  });

  it("reports the failure instead of a 0-mail count for accounts that never synced", () => {
    // 带上“失效”前缀，和侧栏筛选标签用同一个词（P14）。
    expect(accountMailStats({ status: "invalid", lastRefreshedAt: null, lastInboxCount: null } as never)).toBe(
      "失效 · 刷新失败"
    );
    expect(accountMailStats({ status: "valid", lastRefreshedAt: null, lastInboxCount: 7 } as never)).toBe(
      "7 封 · 未刷新"
    );
  });
});

describe("邮件列表的失败态与搜索", () => {
  it("splits the readable title from the collapsible raw error", () => {
    const element = render(
      createElement(
        MessageList,
        listProps({
          listError: "Token 无效或已过期。原始错误：live(400): AADSTS50173 Trace ID: abc"
        })
      )
    );

    expect(element.querySelector(".panel-error-title")?.textContent).toBe("Token 无效或已过期");
    const details = element.querySelector<HTMLDetailsElement>(".panel-error-details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector("pre")?.textContent).toContain("AADSTS50173");
  });

  it("offers a clear button once a query is typed", () => {
    const onClearSearch = vi.fn();
    const handlers = { onClearSearch, onMailQueryChange: vi.fn() };
    const element = render(
      createElement(MessageList, listProps({ mailQuery: "账单", ...handlers }))
    );
    const clear = element.querySelector<HTMLButtonElement>(".search-clear");

    expect(clear).not.toBeNull();
    act(() => clear!.click());
    expect(onClearSearch).toHaveBeenCalledTimes(1);
  });

  it("explains an empty result differently from an empty mailbox", () => {
    const withAccount = render(createElement(MessageList, listProps()));
    expect(withAccount.textContent).toContain("这个文件夹里还没有邮件");

    act(() => root!.unmount());
    root = null;

    const noAccount = render(createElement(MessageList, listProps({ canRefresh: false })));
    expect(noAccount.textContent).toContain("先在左侧选择一个邮箱");

    act(() => root!.unmount());
    root = null;

    const searched = render(createElement(MessageList, listProps({ mailQuery: "账单" })));
    expect(searched.textContent).toContain("没有找到匹配「账单」的邮件");
    expect(searched.querySelector(".panel-error-retry")?.textContent).toBe("清除搜索");
  });

  it("keeps existing rows visible while the list refreshes", () => {
    const element = render(
      createElement(MessageList, listProps({ messages: [message("m-1")], loadingMessages: true }))
    );

    expect(element.querySelector(".message-scroll")?.className).toContain("is-stale");
    expect(element.textContent).not.toContain("正在刷新邮件");
  });
});

describe("设置弹窗的信息分组", () => {
  const settings: AppSettings = {
    cacheMessages: true,
    cacheBodies: true,
    proxyUrl: "",
    proxyUsername: "",
    proxyHasPassword: false,
    proxySupported: true,
    batchConcurrency: 4,
    hotmailFallbackEnabled: true,
    autoRefreshEnabled: false,
    autoRefreshIntervalMinutes: 10
  };

  it("groups the fields and shows the running version", () => {
    const element = render(
      createElement(SettingsModal, { settings, onClose: vi.fn(), onSaved: vi.fn() })
    );
    const headings = Array.from(element.querySelectorAll(".settings-section h3")).map(
      (node) => node.textContent
    );

    expect(headings).toEqual(["邮件与缓存", "网络与认证", "自动刷新"]);
    expect(element.querySelector(".settings-version")?.textContent).toMatch(/^Outlook Manager v\S+$/);
    expect(element.textContent).toContain("关闭窗口后刷新停止");
  });
});

describe("工具栏在窄窗口下的文案与换行", () => {
  it("uses full Chinese labels instead of cramped abbreviations", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/App.tsx", "utf8");

    expect(source).not.toContain("批测");
    expect(source).not.toContain("停测");
    expect(source).not.toContain("停刷");
    expect(source).toContain("批量测试");
  });

  it("keeps empty/error panels tight instead of inheriting UA paragraph margins", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/styles.css", "utf8");
    const reset = css.slice(css.indexOf(".panel-empty p {"));
    const block = reset.slice(0, reset.indexOf("}"));

    expect(block).toContain("margin: 0");
    expect(css).toContain(".reader-panel > .panel-empty {");
  });

  it("lets the workspace header wrap instead of squeezing the buttons", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/styles.css", "utf8");
    const header = css.slice(css.indexOf(".workspace-header {"));
    const block = header.slice(0, header.indexOf("}"));

    expect(block).toContain("flex-wrap: wrap");
    expect(block).toContain("row-gap: 10px");
  });
});

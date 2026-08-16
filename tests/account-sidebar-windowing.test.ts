/** @vitest-environment jsdom */

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountSidebar } from "../src/components/AccountSidebar";
import type { AccountView } from "../src/types";

function account(index: number): AccountView {
  const timestamp = "2026-08-15T00:00:00.000Z";
  return {
    id: `account-${index}`,
    email: `user${String(index).padStart(4, "0")}@example.com`,
    clientId: `client-${index}`,
    remark: "",
    group: "",
    status: "untested",
    lastCheckedAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
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

function renderAccounts(accounts: AccountView[]) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root.render(createElement(AccountSidebar, sidebarProps(accounts)));
  });
}

function sidebarProps(
  accounts: AccountView[],
  overrides: Partial<ComponentProps<typeof AccountSidebar>> = {}
): ComponentProps<typeof AccountSidebar> {
  return {
    accounts,
    filteredAccounts: accounts,
    selectedAccountId: accounts[0]?.id || null,
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
    refreshingAccountIds: new Set<string>(),
    onRefreshAccount: vi.fn(),
    ...overrides
  };
}

describe("AccountSidebar large-list windowing", () => {
  const accountRowStride = 88;

  it("keeps a bounded number of account rows in the DOM", () => {
    renderAccounts(Array.from({ length: 5_000 }, (_, index) => account(index)));

    const rows = container.querySelectorAll(".account-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(40);
    expect(container.textContent).toContain("user0000@example.com");
    expect(container.textContent).not.toContain("user0100@example.com");
  });

  it("moves the rendered window when the account list scrolls", () => {
    renderAccounts(Array.from({ length: 5_000 }, (_, index) => account(index)));
    const scrollArea = container.querySelector<HTMLElement>(".account-scroll");
    expect(scrollArea).not.toBeNull();

    act(() => {
      scrollArea!.scrollTop = accountRowStride * 100;
      scrollArea!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    expect(container.querySelector('[data-account-index="100"]')).not.toBeNull();
    expect(container.querySelector('[data-account-index="0"]')).toBeNull();
    expect(container.querySelectorAll(".account-row").length).toBeLessThan(40);
  });

  it("returns to the top when a search changes the filtered account set", () => {
    const accounts = Array.from({ length: 5_000 }, (_, index) => account(index));
    renderAccounts(accounts);
    const scrollArea = container.querySelector<HTMLElement>(".account-scroll")!;

    act(() => {
      scrollArea.scrollTop = accountRowStride * 100;
      scrollArea.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(container.querySelector('[data-account-index="100"]')).not.toBeNull();

    act(() => {
      root.render(
        createElement(
          AccountSidebar,
          sidebarProps(accounts, { accountQuery: "user000", filteredAccounts: accounts.slice(0, 10) })
        )
      );
    });

    expect(scrollArea.scrollTop).toBe(0);
    expect(container.querySelector('[data-account-index="0"]')).not.toBeNull();
    expect(container.querySelectorAll(".account-row")).toHaveLength(10);
  });
});

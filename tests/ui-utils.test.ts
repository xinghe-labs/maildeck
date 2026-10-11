import { AlertCircle, CheckCircle2, ShieldAlert } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  accountMailStats,
  addressList,
  formatDate,
  formatDateShort,
  formatRelativeTime,
  senderLabel,
  statusMeta
} from "../src/ui-utils";
import type { AccountView, MailMessageSummary } from "../src/types";

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});
const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" });

function message(from: MailMessageSummary["from"]): MailMessageSummary {
  return {
    id: "message-1",
    subject: "Subject",
    from,
    receivedDateTime: null,
    sentDateTime: null,
    isRead: false,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: "",
    webLink: null
  };
}

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: "account-1",
    email: "person@example.com",
    clientId: "client-id",
    remark: "",
    group: "",
    status: "untested",
    lastCheckedAt: null,
    lastError: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides
  };
}

describe("mail timestamp formatting", () => {
  it("renders a placeholder for missing values", () => {
    expect(formatDate(null)).toBe("-");
    expect(formatDateShort(null)).toBe("-");
    expect(formatRelativeTime(undefined)).toBe("未刷新");
    expect(formatRelativeTime(null)).toBe("未刷新");
  });

  it("passes unparseable values through instead of printing Invalid Date", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
    expect(formatDateShort("not-a-date")).toBe("not-a-date");
    expect(formatRelativeTime("not-a-date")).toBe("not-a-date");
  });

  it("formats a parseable timestamp", () => {
    const value = "2026-08-19T08:30:00.000Z";

    expect(formatDate(value)).toBe(DATE_TIME_FORMATTER.format(new Date(value)));
    expect(formatRelativeTime(value)).toBe(DATE_TIME_FORMATTER.format(new Date(value)));
  });

  it("shows only the time for today and the date for older mail", () => {
    const now = new Date();
    const older = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1_000);

    expect(formatDateShort(now.toISOString())).toBe(TIME_FORMATTER.format(now));
    expect(formatDateShort(older.toISOString())).toBe(SHORT_DATE_FORMATTER.format(older));
  });
});

describe("sender and recipient labels", () => {
  it("falls back when the sender is unknown", () => {
    expect(senderLabel(message(null))).toBe("未知发件人");
    expect(senderLabel(message({ name: "", address: "" }))).toBe("未知发件人");
  });

  it("prefers the display name and falls back to the address", () => {
    expect(senderLabel(message({ name: "Ann Lee", address: "ann@example.com" }))).toBe("Ann Lee");
    expect(senderLabel(message({ name: "", address: "ann@example.com" }))).toBe("ann@example.com");
  });

  it("joins address lists and marks an empty list", () => {
    expect(addressList([])).toBe("-");
    expect(addressList([
      { name: "Ann", address: "ann@example.com" },
      { name: "", address: "bob@example.com" }
    ])).toBe("Ann, bob@example.com");
  });
});

describe("account status presentation", () => {
  it("maps each status to its label and icon", () => {
    expect(statusMeta(account({ status: "valid" }))).toEqual({
      label: "可用",
      icon: CheckCircle2,
      className: "status-chip status-valid"
    });
    expect(statusMeta(account({ status: "invalid" }))).toEqual({
      label: "失效",
      icon: AlertCircle,
      className: "status-chip status-invalid"
    });
    expect(statusMeta(account({ status: "untested" }))).toEqual({
      label: "未测",
      icon: ShieldAlert,
      className: "status-chip status-untested"
    });
  });

  it("summarizes the inbox count with the refresh time", () => {
    const stats = accountMailStats(account({ lastInboxCount: 12, lastRefreshedAt: null }));

    expect(stats).toBe("12 封 · 未刷新");
  });

  it("uses the fallback count when the account has no recorded inbox size", () => {
    expect(accountMailStats(account(), 7)).toBe("7 封 · 未刷新");
    expect(accountMailStats(account())).toBe("0 封 · 未刷新");
  });
});

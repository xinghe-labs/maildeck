import { CheckCircle2, CircleX, Clock } from "lucide-react";
import type { AccountView, MailMessageSummary } from "./types";

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});
const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" });

export function formatDate(value: string | null) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return DATE_TIME_FORMATTER.format(date);
}

export function formatDateShort(value: string | null) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const now = new Date();
  const sameDay = now.toDateString() === date.toDateString();

  return (sameDay ? TIME_FORMATTER : SHORT_DATE_FORMATTER).format(date);
}

export function formatRelativeTime(value?: string | null) {
  if (!value) {
    return "未刷新";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return DATE_TIME_FORMATTER.format(date);
}

export function senderLabel(message: MailMessageSummary) {
  if (!message.from) {
    return "未知发件人";
  }

  return message.from.name || message.from.address || "未知发件人";
}

export function addressList(addresses: { name: string; address: string }[]) {
  if (addresses.length === 0) {
    return "-";
  }

  return addresses.map((item) => item.name || item.address).join(", ");
}

export function statusMeta(account: AccountView) {
  if (account.status === "valid") {
    return { label: "可用", icon: CheckCircle2, className: "status-chip status-valid" };
  }

  if (account.status === "invalid") {
    // 用 ✕ 而不是圆圈感叹号：17px 里带“!”的圆圈会被看成数字“1”，像未读数。
    return { label: "失效", icon: CircleX, className: "status-chip status-invalid" };
  }

  // 未测用钟表（从未测过），与可用的 ✓、失效的 ✕ 形状互相区分。
  return { label: "未测", icon: Clock, className: "status-chip status-untested" };
}

export function accountMailStats(account: AccountView, fallbackCount = 0) {
  const count = account.lastInboxCount ?? fallbackCount;
  // 从未成功刷新且已判定失效：写“刷新失败”而不是“0 封 · 未刷新”，否则看起来像空邮箱。
  if (account.status === "invalid" && !account.lastRefreshedAt && count === 0) {
    return "刷新失败";
  }

  const refreshedAt = formatRelativeTime(account.lastRefreshedAt);

  return `${count} 封 · ${refreshedAt}`;
}

/**
 * 工作区头部那一行“收件箱 N 封 · 最新邮件 X”。
 * 刷新失败且从未成功过时不能写“0 封”，那会让用户以为邮箱是空的。
 */
export function accountInboxSummary(account: AccountView, fallbackCount = 0) {
  // 状态已判定失效且从未成功刷新过：说清楚“读不到”，不能写 0 封。
  if (account.status === "invalid" && (!account.lastRefreshedAt || account.lastInboxCount == null)) {
    return "收件箱读取失败 · 点上方「刷新」重试";
  }

  const count = account.lastInboxCount ?? fallbackCount;
  return `收件箱 ${count} 封 · 最新邮件 ${formatRelativeTime(account.lastMailAt)}`;
}

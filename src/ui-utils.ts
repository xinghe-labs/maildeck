import { AlertCircle, CheckCircle2, ShieldAlert } from "lucide-react";
import type { AccountView, MailMessageSummary } from "./types";

export function formatDate(value: string | null) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
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

  return new Intl.DateTimeFormat("zh-CN", sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "2-digit", day: "2-digit" }).format(date);
}

export function formatRelativeTime(value?: string | null) {
  if (!value) {
    return "未刷新";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
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
    return { label: "失效", icon: AlertCircle, className: "status-chip status-invalid" };
  }

  return { label: "未测", icon: ShieldAlert, className: "status-chip status-untested" };
}

export function accountMailStats(account: AccountView, fallbackCount = 0) {
  const count = account.lastInboxCount ?? fallbackCount;
  const refreshedAt = formatRelativeTime(account.lastRefreshedAt);

  return `${count} 封 · ${refreshedAt}`;
}

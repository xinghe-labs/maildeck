import type { AppErrorCode } from "./types.js";

export interface NormalizedAppError {
  code: AppErrorCode;
  message: string;
}

export function normalizeError(error: unknown): NormalizedAppError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (message.includes("AADSTS") || lower.includes("invalid_grant") || lower.includes("refresh token")) {
    return { code: "TOKEN_EXPIRED", message: `Token 无效或已过期：${message}` };
  }

  if (lower.includes("authentication failed") || lower.includes("login failed") || lower.includes("invalid credentials")) {
    return { code: "IMAP_AUTH_FAILED", message: `IMAP 登录失败：${message}` };
  }

  if (lower.includes("permission") || lower.includes("scope") || lower.includes("access denied") || lower.includes("unauthorized")) {
    return { code: "SCOPE_MISSING", message: `权限不足：${message}` };
  }

  if (lower.includes("timeout") || lower.includes("network") || lower.includes("econn") || lower.includes("fetch failed")) {
    return { code: "NETWORK_ERROR", message: `网络连接失败：${message}` };
  }

  if (lower.includes("parse") || lower.includes("mime")) {
    return { code: "MAIL_PARSE_FAILED", message: `邮件解析失败：${message}` };
  }

  if (message.includes("未找到收件箱") || lower.includes("mailbox")) {
    return { code: "MAILBOX_NOT_FOUND", message };
  }

  if (message.includes("账号不存在")) {
    return { code: "ACCOUNT_NOT_FOUND", message };
  }

  return { code: "UNKNOWN", message };
}

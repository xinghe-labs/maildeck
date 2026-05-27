import type { AppErrorCode } from "./types.js";

export interface NormalizedAppError {
  code: AppErrorCode;
  message: string;
}

export function normalizeError(error: unknown): NormalizedAppError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (message.includes("AADSTS7000012") || lower.includes("different tenant")) {
    return {
      code: "TOKEN_EXPIRED",
      message: `Token 租户不匹配：当前 refresh_token 属于其它 Microsoft 租户，建议重新获取该邮箱对应的 refresh_token。原始错误：${message}`
    };
  }

  if (message.includes("AADSTS9002313") || lower.includes("malformed") || lower.includes("jwt is not well formed")) {
    return {
      code: "TOKEN_EXPIRED",
      message: `Token 格式不正确：导入字段可能顺序错误，或把 access token/密码当成 refresh_token 导入了。原始错误：${message}`
    };
  }

  if (message.includes("AADSTS") || lower.includes("invalid_grant") || lower.includes("refresh token")) {
    return { code: "TOKEN_EXPIRED", message: `Token 无效或已过期，请重新获取 refresh_token。原始错误：${message}` };
  }

  if (
    lower.includes("authentication failed") ||
    lower.includes("login failed") ||
    lower.includes("invalid credentials") ||
    lower.includes("auth failed")
  ) {
    return { code: "IMAP_AUTH_FAILED", message: `IMAP 登录失败：请确认 token 包含 IMAP.AccessAsUser.All，且邮箱未禁用 IMAP。原始错误：${message}` };
  }

  if (lower.includes("invalid audience") || lower.includes("audience") || lower.includes("jwt")) {
    return {
      code: "SCOPE_MISSING",
      message: `Token 目标服务不匹配：Graph 需要 graph.microsoft.com token，IMAP 需要 outlook.office.com token。原始错误：${message}`
    };
  }

  if (
    lower.includes("permission") ||
    lower.includes("scope") ||
    lower.includes("access denied") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return { code: "SCOPE_MISSING", message: `邮件读取权限不足：请确认 token scope 包含 Mail.Read 或 IMAP.AccessAsUser.All。原始错误：${message}` };
  }

  if (
    lower.includes("timeout") ||
    lower.includes("network") ||
    lower.includes("econn") ||
    lower.includes("fetch failed") ||
    lower.includes("socket") ||
    lower.includes("proxy")
  ) {
    return { code: "NETWORK_ERROR", message: `网络连接失败：请检查代理、DNS 或 Microsoft 服务连接。原始错误：${message}` };
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

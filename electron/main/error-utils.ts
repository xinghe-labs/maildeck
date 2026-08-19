import type { AppErrorCode, AppErrorPayload } from "./types.js";
import { isJobCanceledError } from "./job-errors.js";
import { isMailContentTooLargeError, isMailParseFailedError } from "./mail-errors.js";
import { redactProxyCredentials } from "../shared/proxy-security.js";
import {
  APP_ERROR_MESSAGE_MAX_CHARS,
  DIAGNOSTIC_REQUEST_ID_MAX_CHARS,
  isIpcRequestValidationError
} from "../shared/ipc-contracts.js";
import { isCredentialsChangedError } from "./credential-generations.js";
import {
  isGraphRequestError,
  isGraphResponseInvalidError,
  isGraphResponseTooLargeError
} from "./graph-errors.js";

export interface NormalizedAppError {
  code: AppErrorCode;
  message: string;
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT"
]);

function hasNetworkErrorCode(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;

  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && NETWORK_ERROR_CODES.has(candidate.code.toUpperCase())) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

export function redactSensitiveText(value: string): string {
  return redactProxyCredentials(value)
    .replace(/(["']?\bauthorization\b["']?\s*[:=]\s*["']?\s*(?:bearer\s+)?)[^"'\s,;}]+/giu, "$1***")
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|proxy[_-]?password|password)["']?\s*[:=]\s*["']?)[^"'\s&,;}]+/giu,
      "$1***"
    )
    .replace(/\bM\.[A-Za-z0-9._~+/=-]{40,}\b/gu, "***")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{20,}){1,2}\b/gu, "***")
    .replace(/\bEw[A-Za-z0-9._~+/=-]{60,}\b/gu, "***");
}

export function formatErrorForLog(error: unknown): string {
  const output = error instanceof Error ? error.stack || error.message : String(error);
  return redactSensitiveText(output);
}

export function normalizeError(error: unknown): NormalizedAppError {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  if (isIpcRequestValidationError(error)) {
    return { code: "INVALID_REQUEST", message };
  }
  if (isJobCanceledError(error)) {
    return { code: "CANCELED", message };
  }
  if (isCredentialsChangedError(error)) {
    return { code: "STALE_CREDENTIALS", message };
  }
  if (isMailContentTooLargeError(error)) {
    return { code: "MAIL_TOO_LARGE", message };
  }
  if (isGraphResponseTooLargeError(error)) {
    return { code: "MAIL_TOO_LARGE", message };
  }
  if (isGraphResponseInvalidError(error)) {
    return { code: "MAIL_PARSE_FAILED", message };
  }
  if (isMailParseFailedError(error)) {
    return { code: "MAIL_PARSE_FAILED", message };
  }
  if (isGraphRequestError(error) && error.status === 429) {
    return { code: "THROTTLED", message: `Microsoft Graph 请求过于频繁，请稍后重试。原始错误：${message}` };
  }
  if (isGraphRequestError(error) && error.status >= 500) {
    return { code: "NETWORK_ERROR", message: `Microsoft Graph 服务暂时不可用，请稍后重试。原始错误：${message}` };
  }

  if (hasNetworkErrorCode(error)) {
    return { code: "NETWORK_ERROR", message: `网络连接失败：请检查代理、DNS 或 Microsoft 服务连接。原始错误：${message}` };
  }

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

export function toIpcErrorPayload(error: unknown): AppErrorPayload {
  const normalized = normalizeError(error);
  const requestId = normalized.message.match(/request-id:\s*([a-z0-9-]+)/iu)?.[1];
  const publicMessage = normalized.code === "UNKNOWN"
    ? "操作失败，请重试；如果问题持续，请检查应用日志。"
    : normalized.message;
  const boundedMessage = publicMessage.length <= APP_ERROR_MESSAGE_MAX_CHARS
    ? publicMessage
    : `${publicMessage.slice(0, APP_ERROR_MESSAGE_MAX_CHARS - 3)}...`;

  return {
    code: normalized.code,
    message: boundedMessage,
    retryable: normalized.code === "NETWORK_ERROR" || normalized.code === "STALE_CREDENTIALS" || normalized.code === "THROTTLED",
    ...(requestId ? { diagnostic: { requestId: requestId.slice(0, DIAGNOSTIC_REQUEST_ID_MAX_CHARS) } } : {})
  };
}

export function reportIpcError(error: unknown, context: string): AppErrorPayload {
  const payload = toIpcErrorPayload(error);
  if (payload.code === "UNKNOWN") {
    console.error(`${context} failed`, formatErrorForLog(error));
  }
  return payload;
}

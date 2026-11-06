import type { AppErrorCode, AppErrorPayload } from "./types.js";
import { RequestTimeoutError } from "./request-timeout.js";
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
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
]);

// 供请求层判断 fetch reject 是否属于可重试的网络错误（含超时中止）。
export function isNetworkError(error: unknown): boolean {
  return hasNetworkErrorCode(error) || error instanceof RequestTimeoutError;
}

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

// `AbortSignal.reason` is typed `any` by the DOM lib, but every abort reason in
// this process is a typed Error (`JobCanceledError`, `CredentialsChangedError`)
// or the platform's DOMException. Rejecting with a non-Error would bypass the
// typed cancellation classification in `normalizeError`, so normalize here.
export function abortReasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Operation aborted");
}

// AADSTS 码与用户可执行的修复动作一一对应。表里没有的码继续走通用分支。
const AADSTS_RULES: Array<{ test: (message: string, lower: string) => boolean; code: AppErrorCode; message: string }> = [
  {
    // 应用不存在 / 未在目录中注册。用户需要换 client_id，而不是重抓 token。
    test: (message, lower) =>
      /AADSTS700016|AADSTS700011|AADSTS700022|AADSTS700024/u.test(message) ||
      lower.includes("application with identifier") ||
      lower.includes("client does not exist") ||
      lower.includes("not enabled for consumers") ||
      lower.includes("application was not found"),
    code: "INVALID_CLIENT",
    message:
      "Client ID 无效：微软找不到这个应用，或者它没有对个人（outlook.com / hotmail.com）账号启用。请核对 Client ID 是否填错，并换一个支持个人账号的公共客户端 ID。"
  },
  {
    test: (message, lower) =>
      /AADSTS7000215|AADSTS7000216|AADSTS7000218|AADSTS700027/u.test(message) || lower.includes("invalid_client"),
    code: "INVALID_CLIENT",
    message:
      "Client ID 或客户端密钥配置有问题：本工具只需要 Client ID + refresh_token，不需要 client secret。如果这个应用强制要求 secret，请换一个公共客户端 ID。"
  },
  {
    // SPA 类型的应用不能用于桌面/后端授权码流程。
    test: (message, lower) => /AADSTS9002326|AADSTS9002325/u.test(message) || lower.includes("cross-origin"),
    code: "INVALID_CLIENT",
    message:
      "该 Client ID 被注册成了「单页应用（SPA）」类型，不能用于桌面客户端的授权流程，请换一个公共客户端（Mobile and desktop application）ID。"
  },
  {
    test: (message, lower) => message.includes("AADSTS65001") || lower.includes("consent"),
    code: "SCOPE_MISSING",
    message:
      "该应用还没有获得此账号的授权（consent）：请重新走一次授权流程获取 refresh_token，并在授权页点「接受」。"
  },
  {
    test: (message) => /AADSTS50076|AADSTS50079|AADSTS50074|AADSTS50072/u.test(message),
    code: "TOKEN_EXPIRED",
    message: "该账号要求多重身份验证（MFA），已有 refresh_token 无法直接使用，请重新授权一次。"
  },
  {
    test: (message, lower) =>
      /AADSTS50173|AADSTS700082|AADSTS700084|AADSTS70008/u.test(message) || lower.includes("expired due to inactivity"),
    code: "TOKEN_EXPIRED",
    message:
      "refresh_token 已失效：可能因为密码变更、授权被撤销，或长时间（通常 90 天）未使用。请重新获取该账号的 refresh_token。"
  },
  {
    test: (message, lower) => message.includes("AADSTS500011") || lower.includes("resource principal"),
    code: "SCOPE_MISSING",
    message:
      "授权请求里的资源地址在该租户下不存在：请改用 outlook.office.com（IMAP）或 graph.microsoft.com（Graph）的 scope 重新授权。"
  }
];

function matchAadstsRule(message: string, lower: string): { code: AppErrorCode; message: string } | null {
  for (const rule of AADSTS_RULES) {
    if (rule.test(message, lower)) {
      return { code: rule.code, message: rule.message };
    }
  }

  return null;
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

  // 微软的 AADSTS 码含义各不相同，一律当成“Token 过期”会把用户引向错误的修复动作
  // （例如 700016 是 Client ID 不存在，重抓一百次 refresh_token 也没用）。
  const aadsts = matchAadstsRule(message, lower);
  if (aadsts) {
    return { code: aadsts.code, message: `${aadsts.message}原始错误：${message}` };
  }

  if (message.includes("AADSTS") || lower.includes("invalid_grant") || lower.includes("refresh token")) {
    return {
      code: "TOKEN_EXPIRED",
      message: `授权失败：refresh_token 可能无效、已过期或已被撤销。如果详情里的 AADSTS 编号是 7xxxx 系列，也可能是 Client ID 配置问题，请先核对 Client ID。原始错误：${message}`
    };
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

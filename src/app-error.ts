import type { AppErrorPayload } from "./types";

const APP_ERROR_CODES = new Set([
  "INVALID_REQUEST",
  "CANCELED",
  "STALE_CREDENTIALS",
  "THROTTLED",
  "TOKEN_EXPIRED",
  "IMAP_AUTH_FAILED",
  "SCOPE_MISSING",
  "NETWORK_ERROR",
  "MAIL_PARSE_FAILED",
  "MAIL_TOO_LARGE",
  "MAILBOX_NOT_FOUND",
  "ACCOUNT_NOT_FOUND",
  "UNKNOWN"
]);

export function isAppError(error: unknown): error is AppErrorPayload {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as Partial<AppErrorPayload>;
  const diagnosticIsValid = candidate.diagnostic === undefined || (
    candidate.diagnostic !== null &&
    typeof candidate.diagnostic === "object" &&
    (candidate.diagnostic.requestId === undefined || typeof candidate.diagnostic.requestId === "string")
  );
  return typeof candidate.code === "string" && APP_ERROR_CODES.has(candidate.code) &&
    typeof candidate.message === "string" && typeof candidate.retryable === "boolean" && diagnosticIsValid;
}

export function errorMessage(error: unknown): string {
  if (isAppError(error)) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

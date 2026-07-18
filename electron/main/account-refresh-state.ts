import type { AccountStatus, AppErrorCode } from "./types.js";

const INVALID_ACCOUNT_CODES = new Set<AppErrorCode>([
  "TOKEN_EXPIRED",
  "IMAP_AUTH_FAILED",
  "SCOPE_MISSING",
  "MAILBOX_NOT_FOUND"
]);

export function resolveRefreshTimestamps(
  lastRefreshedAt: string | null | undefined,
  attemptedAt: string,
  succeeded: boolean
) {
  return {
    lastCheckedAt: attemptedAt,
    lastRefreshedAt: succeeded ? attemptedAt : lastRefreshedAt || null
  };
}

export function resolveRefreshFailureStatus(currentStatus: AccountStatus, code: AppErrorCode): AccountStatus {
  return INVALID_ACCOUNT_CODES.has(code) ? "invalid" : currentStatus;
}

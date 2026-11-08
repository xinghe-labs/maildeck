import type { AccountStatus, AppErrorCode } from "./types.js";

const INVALID_ACCOUNT_CODES = new Set<AppErrorCode>([
  "TOKEN_EXPIRED",
  "INVALID_CLIENT",
  "IMAP_AUTH_FAILED",
  "SCOPE_MISSING",
  "MAILBOX_NOT_FOUND"
]);

export function resolveRefreshTimestamps(
  previous: { lastCheckedAt?: string | null; lastRefreshedAt?: string | null },
  attemptedAt: string,
  succeeded: boolean
) {
  // 两个时间戳都只记录「最近一次成功」：失败时保留旧值。
  // 否则网络故障也会把「上次测试」顶成刚才，而「结果」还挂着上一次成功的「可用」，
  // 时间与结果自相矛盾（体验报告 v3 问题 4）。
  return {
    lastCheckedAt: succeeded ? attemptedAt : previous.lastCheckedAt || null,
    lastRefreshedAt: succeeded ? attemptedAt : previous.lastRefreshedAt || null
  };
}

export function resolveRefreshFailureStatus(currentStatus: AccountStatus, code: AppErrorCode): AccountStatus {
  return INVALID_ACCOUNT_CODES.has(code) ? "invalid" : currentStatus;
}

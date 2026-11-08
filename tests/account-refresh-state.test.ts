import { describe, expect, it } from "vitest";
import { resolveRefreshFailureStatus, resolveRefreshTimestamps } from "../electron/main/account-refresh-state.js";

describe("resolveRefreshTimestamps", () => {
  const previousChecked = "2026-07-18T09:00:00.000Z";
  const previousRefreshed = "2026-07-17T09:00:00.000Z";
  const attempted = "2026-07-18T10:00:00.000Z";
  const previous = { lastCheckedAt: previousChecked, lastRefreshedAt: previousRefreshed };

  it("advances both timestamps after success", () => {
    expect(resolveRefreshTimestamps(previous, attempted, true)).toEqual({
      lastCheckedAt: attempted,
      lastRefreshedAt: attempted
    });
  });

  it("preserves both timestamps after failure（报告 v3 问题 4：失败不顶掉上次测试）", () => {
    expect(resolveRefreshTimestamps(previous, attempted, false)).toEqual({
      lastCheckedAt: previousChecked,
      lastRefreshedAt: previousRefreshed
    });
  });

  it("failure with no previous check stays null（首次测试就失败时不虚报时间）", () => {
    expect(
      resolveRefreshTimestamps({ lastCheckedAt: null, lastRefreshedAt: null }, attempted, false)
    ).toEqual({ lastCheckedAt: null, lastRefreshedAt: null });
  });

  it("preserves account health for transient network failures", () => {
    expect(resolveRefreshFailureStatus("valid", "NETWORK_ERROR")).toBe("valid");
    expect(resolveRefreshFailureStatus("valid", "THROTTLED")).toBe("valid");
  });

  it("marks credential and permission failures invalid", () => {
    expect(resolveRefreshFailureStatus("valid", "TOKEN_EXPIRED")).toBe("invalid");
    expect(resolveRefreshFailureStatus("valid", "SCOPE_MISSING")).toBe("invalid");
  });
});

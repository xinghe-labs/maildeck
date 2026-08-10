import { describe, expect, it } from "vitest";
import { resolveRefreshFailureStatus, resolveRefreshTimestamps } from "../electron/main/account-refresh-state.js";

describe("resolveRefreshTimestamps", () => {
  const previous = "2026-07-18T09:00:00.000Z";
  const attempted = "2026-07-18T10:00:00.000Z";

  it("advances lastRefreshedAt after success", () => {
    expect(resolveRefreshTimestamps(previous, attempted, true)).toEqual({
      lastCheckedAt: attempted,
      lastRefreshedAt: attempted
    });
  });

  it("preserves lastRefreshedAt after failure", () => {
    expect(resolveRefreshTimestamps(previous, attempted, false)).toEqual({
      lastCheckedAt: attempted,
      lastRefreshedAt: previous
    });
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

import { describe, expect, it } from "vitest";
import { calculateGraphRetryDelay } from "../electron/main/graph-retry.js";

describe("Graph retry policy", () => {
  it.each([429, 502, 503, 504])("allows retry for HTTP %s", (status) => {
    expect(calculateGraphRetryDelay({
      status,
      retryAfter: null,
      retryIndex: 0,
      nowMs: 0,
      randomValue: 0
    })).toBe(500);
  });

  it("honors Retry-After seconds with bounded jitter", () => {
    expect(calculateGraphRetryDelay({
      status: 429,
      retryAfter: "2",
      retryIndex: 0,
      nowMs: 0,
      randomValue: 0.5
    })).toBe(2_100);
  });

  it("honors an HTTP-date Retry-After value", () => {
    expect(calculateGraphRetryDelay({
      status: 503,
      retryAfter: new Date(12_000).toUTCString(),
      retryIndex: 0,
      nowMs: 10_000,
      randomValue: 0
    })).toBe(2_000);
  });

  it("uses exponential backoff and skips retry beyond the delay ceiling", () => {
    expect(calculateGraphRetryDelay({
      status: 503,
      retryAfter: null,
      retryIndex: 2,
      nowMs: 0,
      randomValue: 0
    })).toBe(2_000);
    expect(calculateGraphRetryDelay({
      status: 429,
      retryAfter: "3600",
      retryIndex: 0,
      nowMs: 0,
      randomValue: 0.9
    })).toBeNull();
  });

  it("does not retry permanent client failures", () => {
    expect(calculateGraphRetryDelay({
      status: 400,
      retryAfter: "1",
      retryIndex: 0,
      nowMs: 0,
      randomValue: 0
    })).toBeNull();
  });
});

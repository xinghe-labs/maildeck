import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateNetworkRetryDelay } from "../electron/main/graph-retry.js";
import { isNetworkError } from "../electron/main/error-utils.js";
import { RequestTimeoutError, withRequestTimeout } from "../electron/main/request-timeout.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("网络错误退避策略 calculateNetworkRetryDelay", () => {
  it("指数退避 + 抖动，封顶 30 秒", () => {
    vi.spyOn(Math, "random");
    expect(calculateNetworkRetryDelay(0, 0)).toBe(500);
    expect(calculateNetworkRetryDelay(1, 0)).toBe(1_000);
    expect(calculateNetworkRetryDelay(2, 0)).toBe(2_000);
    expect(calculateNetworkRetryDelay(10, 0)).toBe(30_000);
  });
});

describe("isNetworkError 归一化", () => {
  it("识别 ETIMEDOUT / ECONNRESET / UND_ERR 超时 / RequestTimeoutError", () => {
    expect(isNetworkError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" }))).toBe(true);
    expect(isNetworkError(new RequestTimeoutError(30_000))).toBe(true);
    expect(isNetworkError(new Error("invalid grant"))).toBe(false);
  });
});

describe("withRequestTimeout", () => {
  it("无外部 signal 时按超时时间中止并携带 RequestTimeoutError", async () => {
    vi.useFakeTimers();
    const handle = withRequestTimeout(undefined, 1_000);
    const p = new Promise<unknown>((resolve) => {
      handle.signal.addEventListener("abort", () => resolve(handle.signal.reason));
    });
    vi.advanceTimersByTime(1_000);
    const reason = await p;
    expect(reason).toBeInstanceOf(RequestTimeoutError);
    expect((reason as RequestTimeoutError).timeoutMs).toBe(1_000);
    expect((reason as RequestTimeoutError).code).toBe("ETIMEDOUT");
    handle.cleanup();
  });

  it("外部取消立即透传且携带原 reason", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const handle = withRequestTimeout(controller.signal, 60_000);
    const p = new Promise<unknown>((resolve) => {
      handle.signal.addEventListener("abort", () => resolve(handle.signal.reason));
    });
    const canceled = new Error("canceled");
    controller.abort(canceled);
    expect(await p).toBe(canceled);
    handle.cleanup();
  });

  it("提前完成时 cleanup 不触发超时", async () => {
    vi.useFakeTimers();
    const handle = withRequestTimeout(undefined, 1_000);
    let aborted = false;
    handle.signal.addEventListener("abort", () => {
      aborted = true;
    });
    handle.cleanup();
    vi.advanceTimersByTime(5_000);
    expect(aborted).toBe(false);
    expect(handle.signal.aborted).toBe(false);
  });

  it("外部 signal 已中止时返回的 signal 也已中止", () => {
    const controller = new AbortController();
    controller.abort();
    const handle = withRequestTimeout(controller.signal, 1_000);
    expect(handle.signal.aborted).toBe(true);
    handle.cleanup();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { deltaMessages, listMailFolders, refreshAccessToken } from "../electron/main/graph-client.js";
import { JobCanceledError } from "../electron/main/job-errors.js";
import { toIpcErrorPayload } from "../electron/main/error-utils.js";

function throttledResponse(retryAfter: string, requestId = "request-429") {
  return new Response(JSON.stringify({
    error: {
      code: "TooManyRequests",
      message: "Slow down",
      innerError: { "request-id": requestId }
    }
  }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": retryAfter }
  });
}

function foldersResponse() {
  return new Response(JSON.stringify({
    value: [{ id: "inbox", displayName: "Inbox", totalItemCount: 2, unreadItemCount: 1 }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Graph throttling", () => {
  it("waits for Retry-After before retrying an idempotent Graph request", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(throttledResponse("2"))
      .mockResolvedValueOnce(foldersResponse());
    vi.stubGlobal("fetch", fetchMock);

    const pending = listMailFolders("access-token");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual([{
      id: "inbox",
      displayName: "Inbox",
      totalItemCount: 2,
      unreadItemCount: 1
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops after three attempts and exposes a retryable throttling error", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn(async () => throttledResponse("0", "request-final"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = listMailFolders("access-token");
    const capturedError = pending.then(() => null, (error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(toIpcErrorPayload(await capturedError)).toEqual({
      code: "THROTTLED",
      message: expect.stringContaining("请求过于频繁"),
      retryable: true,
      diagnostic: { requestId: "request-final" }
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cancels immediately while waiting to retry", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn(async () => throttledResponse("30"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const canceled = new JobCanceledError("刷新已取消");

    const pending = listMailFolders("access-token", "", controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(canceled);

    await expect(pending).rejects.toBe(canceled);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an untrusted continuation URL before attaching authorization", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(deltaMessages(
      "access-token",
      "inbox",
      20,
      "https://attacker.example/collect",
      1
    )).rejects.toThrow("不受信任的 Graph 分页地址");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not replay a token POST through the Graph GET retry policy", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: "temporarily_unavailable",
      error_description: "Slow down"
    }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "1" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshAccessToken("client-id", "refresh-token")).rejects.toThrow("temporarily_unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });
});

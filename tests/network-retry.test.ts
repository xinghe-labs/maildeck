import { afterEach, describe, expect, it, vi } from "vitest";
import { listMailFolders, refreshAccessToken } from "../electron/main/graph-client.js";
import { refreshHotmailFallbackToken } from "../electron/main/hotmail-fallback-client.js";
import { JobCanceledError } from "../electron/main/job-errors.js";

function foldersResponse() {
  return new Response(JSON.stringify({
    value: [{ id: "inbox", displayName: "Inbox", totalItemCount: 2, unreadItemCount: 1 }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function tokenOkResponse() {
  return new Response(JSON.stringify({
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_in: 3600,
    scope: "https://graph.microsoft.com/.default"
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function tokenStatusError(status: number) {
  return new Response(JSON.stringify({
    error: "temporarily_unavailable",
    error_description: "Slow down"
  }), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("网络错误重试（fetch reject）", () => {
  it("Graph GET：网络错误后重试并成功", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(foldersResponse());
    vi.stubGlobal("fetch", fetchMock);

    const pending = listMailFolders("access-token");
    // 第一次失败后等待退避（500ms 基础延迟 + 抖动）
    await vi.advanceTimersByTimeAsync(750);

    await expect(pending).resolves.toEqual([{
      id: "inbox",
      displayName: "Inbox",
      totalItemCount: 2,
      unreadItemCount: 1
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Graph GET：连续网络错误三次后拋出最后一次错误", async () => {
    vi.useFakeTimers();
    const networkError = Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" });
    const fetchMock = vi.fn(() => Promise.reject(networkError));
    vi.stubGlobal("fetch", fetchMock);

    const pending = listMailFolders("access-token");
    // 先挂 rejection 处理器再跑定时器，避免未处理的 unhandledRejection。
    const capturedError = pending.then(() => null, (error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(await capturedError).toBe(networkError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("Graph GET：取消优先于重试等待", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Promise.reject(Object.assign(new Error("reset"), { code: "ECONNRESET" })));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const canceled = new JobCanceledError("刷新已取消");

    const pending = listMailFolders("access-token", "", controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(canceled);

    await expect(pending).rejects.toBe(canceled);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Graph token POST：网络错误重试一次后成功", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("dns fail"), { code: "ENOTFOUND" }))
      .mockResolvedValueOnce(tokenOkResponse());
    vi.stubGlobal("fetch", fetchMock);

    const pending = refreshAccessToken("client-id", "refresh-token");
    await vi.advanceTimersByTimeAsync(750);

    await expect(pending).resolves.toMatchObject({ accessToken: "at-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Graph token POST：HTTP 状态错误不触发网络重试（不重复提交失效凭据）", async () => {
    const fetchMock = vi.fn(async () => tokenStatusError(429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshAccessToken("client-id", "refresh-token")).rejects.toThrow("temporarily_unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Hotmail 兜底 token POST：网络错误重试一次后成功", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "at-imap",
        refresh_token: "rt-imap",
        expires_in: 3600,
        scope: "https://outlook.office.com/IMAP.AccessAsUser.All"
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = refreshHotmailFallbackToken("client-id", "refresh-token");
    await vi.advanceTimersByTimeAsync(750);

    await expect(pending).resolves.toMatchObject({ accessToken: "at-imap", authMode: "imap" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

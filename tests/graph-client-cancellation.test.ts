import { afterEach, describe, expect, it, vi } from "vitest";
import { listMailFolders, refreshAccessToken } from "../electron/main/graph-client.js";
import { refreshHotmailFallbackToken } from "../electron/main/hotmail-fallback-client.js";
import { JobCanceledError } from "../electron/main/job-errors.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function abortableFetch(started: ReturnType<typeof deferred<AbortSignal>>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    started.resolve(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Graph network cancellation", () => {
  it("forwards cancellation into token exchange fetch", async () => {
    const started = deferred<AbortSignal>();
    vi.stubGlobal("fetch", abortableFetch(started));
    const controller = new AbortController();
    const pending = refreshAccessToken("client-id", "refresh-token", "", controller.signal);
    const requestSignal = await started.promise;
    const canceled = new JobCanceledError("刷新已取消");

    controller.abort(canceled);

    await expect(pending).rejects.toBe(canceled);
    expect(requestSignal).toBe(controller.signal);
  });

  it("forwards cancellation into Graph API fetch", async () => {
    const started = deferred<AbortSignal>();
    vi.stubGlobal("fetch", abortableFetch(started));
    const controller = new AbortController();
    const pending = listMailFolders("access-token", "", controller.signal);
    const requestSignal = await started.promise;
    const canceled = new JobCanceledError("刷新已取消");

    controller.abort(canceled);

    await expect(pending).rejects.toBe(canceled);
    expect(requestSignal).toBe(controller.signal);
  });

  it("forwards cancellation into Hotmail fallback token exchange", async () => {
    const started = deferred<AbortSignal>();
    vi.stubGlobal("fetch", abortableFetch(started));
    const controller = new AbortController();
    const pending = refreshHotmailFallbackToken("client-id", "refresh-token", "", controller.signal);
    const requestSignal = await started.promise;
    const canceled = new JobCanceledError("刷新已取消");

    controller.abort(canceled);

    await expect(pending).rejects.toBe(canceled);
    expect(requestSignal).toBe(controller.signal);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { listMailFolders, refreshAccessToken } from "../electron/main/graph-client.js";
import { refreshHotmailFallbackToken } from "../electron/main/hotmail-fallback-client.js";
import { JobCanceledError } from "../electron/main/job-errors.js";
import { abortReasonOf } from "../electron/main/error-utils.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

// 断言请求 signal 收到了取消（withRequestTimeout 会合并外部 signal 与超时定时器，
// 转发的是合并后的新 signal，不再与 controller.signal 同一实例，因此断行为不断身份）。
async function expectCancellationPropagates(
  started: ReturnType<typeof deferred<AbortSignal>>,
  pending: Promise<unknown>,
  controller: AbortController,
  canceled: JobCanceledError
) {
  const requestSignal = await started.promise;
  const propagated = new Promise<unknown>((resolve) => {
    requestSignal.addEventListener("abort", () => resolve(requestSignal.reason), { once: true });
  });
  controller.abort(canceled);
  await expect(propagated).resolves.toBe(canceled);
  await expect(pending).rejects.toBe(canceled);
}

function abortableFetch(started: ReturnType<typeof deferred<AbortSignal>>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    started.resolve(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortReasonOf(signal)), { once: true });
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
    const canceled = new JobCanceledError("刷新已取消");

    await expectCancellationPropagates(started, pending, controller, canceled);
  });

  it("forwards cancellation into Graph API fetch", async () => {
    const started = deferred<AbortSignal>();
    vi.stubGlobal("fetch", abortableFetch(started));
    const controller = new AbortController();
    const pending = listMailFolders("access-token", "", controller.signal);
    const canceled = new JobCanceledError("刷新已取消");

    await expectCancellationPropagates(started, pending, controller, canceled);
  });

  it("forwards cancellation into Hotmail fallback token exchange", async () => {
    const started = deferred<AbortSignal>();
    vi.stubGlobal("fetch", abortableFetch(started));
    const controller = new AbortController();
    const pending = refreshHotmailFallbackToken("client-id", "refresh-token", "", controller.signal);
    const canceled = new JobCanceledError("刷新已取消");

    await expectCancellationPropagates(started, pending, controller, canceled);
  });
});

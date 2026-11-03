import { isNetworkError } from "./error-utils.js";

// 连接不稳定时的兜底：任何出站请求都不允许无限期 hang 住。
// 超时以 ETIMEDOUT 中止，下游错误归一化会归入 NETWORK_ERROR，可重试。
export const NETWORK_REQUEST_TIMEOUT_MS = 30_000;

export class RequestTimeoutError extends Error {
  override readonly name = "RequestTimeoutError";
  readonly code = "ETIMEDOUT";

  constructor(readonly timeoutMs: number) {
    super(`网络请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）`);
  }
}

export interface TimeoutSignalHandle {
  readonly signal: AbortSignal;
  cleanup(): void;
}

// 把外部 signal 与一个超时定时器合并成新的请求 signal：
// - 外部取消立即透传（携带原 reason，保证 JobCanceledError 语义不变）
// - 超时后以 RequestTimeoutError 中止
// - cleanup 必须在请求（含响应体读取）结束后调用，避免定时器泄漏
export function withRequestTimeout(
  signal: AbortSignal | undefined,
  timeoutMs = NETWORK_REQUEST_TIMEOUT_MS
): TimeoutSignalHandle {
  const controller = new AbortController();

  if (signal?.aborted) {
    controller.abort(signal.reason);
    return { signal: controller.signal, cleanup: () => undefined };
  }

  const onExternalAbort = () => {
    clearTimeout(timer);
    controller.abort(signal?.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onExternalAbort);
    controller.abort(new RequestTimeoutError(timeoutMs));
  }, timeoutMs);

  if (signal) {
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  };
}

export { isNetworkError };

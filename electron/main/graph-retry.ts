import { abortReasonOf } from "./error-utils.js";

const RETRYABLE_GRAPH_STATUSES = new Set([429, 502, 503, 504]);
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

export const GRAPH_MAX_ATTEMPTS = 3;

export interface GraphRetryInput {
  status: number;
  retryAfter: string | null;
  retryIndex: number;
  nowMs: number;
  randomValue: number;
}

function retryAfterDelayMs(value: string | null, nowMs: number): number | null {
  const normalized = value?.trim() || "";
  if (!normalized) {
    return null;
  }

  if (/^\d+$/u.test(normalized)) {
    return Number(normalized) * 1_000;
  }

  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - nowMs) : null;
}

export function calculateGraphRetryDelay(input: GraphRetryInput): number | null {
  if (!RETRYABLE_GRAPH_STATUSES.has(input.status)) {
    return null;
  }

  const serverDelay = retryAfterDelayMs(input.retryAfter, input.nowMs);
  if (serverDelay !== null && serverDelay > MAX_DELAY_MS) {
    return null;
  }
  const exponentialDelay = BASE_DELAY_MS * (2 ** Math.max(0, input.retryIndex));
  const baseDelay = serverDelay ?? exponentialDelay;
  const jitterWindow = Math.min(250, Math.max(50, Math.round(baseDelay * 0.1)));
  const boundedRandom = Math.min(Math.max(input.randomValue, 0), 1);
  const jitter = Math.floor(jitterWindow * boundedRandom);

  return Math.min(baseDelay + jitter, MAX_DELAY_MS);
}

export function waitForGraphRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();

  if (!signal) {
    return new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReasonOf(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

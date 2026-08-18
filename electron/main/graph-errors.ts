export class GraphRequestError extends Error {
  override readonly name = "GraphRequestError";

  constructor(
    readonly status: number,
    message: string,
    readonly requestId: string | null,
    readonly retryAfterMs: number | null
  ) {
    super(message);
  }
}

export function isGraphRequestError(error: unknown): error is GraphRequestError {
  return error instanceof GraphRequestError;
}

export function isGraphThrottledError(error: unknown): error is GraphRequestError {
  return isGraphRequestError(error) && error.status === 429;
}

export class GraphResponseTooLargeError extends Error {
  override readonly name = "GraphResponseTooLargeError";

  constructor(readonly limitBytes: number) {
    super(`Microsoft Graph 响应过大，超过 ${Math.floor(limitBytes / (1024 * 1024))} MiB 安全读取上限`);
  }
}

export function isGraphResponseTooLargeError(error: unknown): error is GraphResponseTooLargeError {
  return error instanceof GraphResponseTooLargeError;
}

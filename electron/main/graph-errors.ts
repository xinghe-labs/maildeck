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

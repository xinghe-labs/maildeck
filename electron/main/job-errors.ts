export class JobCanceledError extends Error {
  override readonly name = "JobCanceledError";
}

export function isJobCanceledError(error: unknown): error is JobCanceledError {
  return error instanceof JobCanceledError;
}

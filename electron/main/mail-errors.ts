export class MailContentTooLargeError extends Error {
  override readonly name = "MailContentTooLargeError";

  constructor(limitBytes: number) {
    super(`邮件正文过大，超过 ${Math.floor(limitBytes / (1024 * 1024))} MiB 安全读取上限`);
  }
}

export function isMailContentTooLargeError(error: unknown): error is MailContentTooLargeError {
  return error instanceof MailContentTooLargeError;
}

export class MailParseFailedError extends Error {
  override readonly name = "MailParseFailedError";

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`邮件解析失败：${detail}`, { cause });
  }
}

export function isMailParseFailedError(error: unknown): error is MailParseFailedError {
  return error instanceof MailParseFailedError;
}

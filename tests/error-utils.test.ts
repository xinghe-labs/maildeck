import { describe, expect, it } from "vitest";
import { formatErrorForLog, normalizeError } from "../electron/main/error-utils.js";
import { MailContentTooLargeError, MailParseFailedError } from "../electron/main/mail-errors.js";

describe("proxy credential redaction", () => {
  it("redacts HTTP proxy passwords from renderer-visible errors", () => {
    const result = normalizeError(new Error("proxy http://alice:secret@127.0.0.1:7890 failed"));

    expect(result.message).toContain("alice");
    expect(result.message).toContain("***");
    expect(result.message).not.toContain("secret");
  });

  it("redacts legacy SOCKS and URL-encoded passwords", () => {
    const result = normalizeError(
      new Error("socks5://bob:sec%3Aret@proxy.example:1080 and https://carol:p%40ss@proxy.example failed")
    );

    expect(result.message).toContain("bob");
    expect(result.message).toContain("carol");
    expect(result.message).not.toContain("sec%3Aret");
    expect(result.message).not.toContain("p%40ss");
  });

  it("redacts proxy credentials from stack strings used for process logs", () => {
    const error = new Error("request through http://alice:log-secret@proxy.example:8080 failed");
    const output = formatErrorForLog(error);

    expect(output).toContain("alice");
    expect(output).toContain("***");
    expect(output).not.toContain("log-secret");
  });

  it("classifies bounded mail reads without treating them as a retryable transport error", () => {
    expect(normalizeError(new MailContentTooLargeError(4 * 1024 * 1024))).toMatchObject({
      code: "MAIL_TOO_LARGE",
      message: expect.stringContaining("4 MiB")
    });
  });

  it("classifies parser failures by type instead of dependency message text", () => {
    expect(normalizeError(new MailParseFailedError(new Error("Max allowed child nodes exceeded")))).toMatchObject({
      code: "MAIL_PARSE_FAILED",
      message: expect.stringContaining("Max allowed child nodes exceeded")
    });
  });
});

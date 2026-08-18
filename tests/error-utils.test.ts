import { describe, expect, it } from "vitest";
import { formatErrorForLog, normalizeError, toIpcErrorPayload } from "../electron/main/error-utils.js";
import { MailContentTooLargeError, MailParseFailedError } from "../electron/main/mail-errors.js";
import { APP_ERROR_MESSAGE_MAX_CHARS } from "../electron/shared/ipc-contracts.js";
import { GraphResponseTooLargeError } from "../electron/main/graph-errors.js";

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

  it("redacts authorization headers and Microsoft token-shaped secrets", () => {
    const bearer = `eyJ${"a".repeat(80)}.${"b".repeat(80)}.${"c".repeat(80)}`;
    const refreshToken = `M.${"r".repeat(120)}`;
    const accessToken = `Ew${"x".repeat(120)}`;
    const result = normalizeError(
      new Error(
        `Authorization: Bearer ${bearer}; refresh_token=${refreshToken}; {"access_token":"${accessToken}"}`
      )
    );

    expect(result.message).toContain("***");
    expect(result.message).not.toContain(bearer);
    expect(result.message).not.toContain(refreshToken);
    expect(result.message).not.toContain(accessToken);
  });

  it("redacts quoted authorization headers and camelCase credential fields", () => {
    const result = formatErrorForLog(new Error(
      '{"Authorization":"Bearer opaque-bearer","accessToken":"opaque-access","refreshToken":"opaque-refresh","clientSecret":"opaque-client"}'
    ));

    expect(result).toContain("***");
    expect(result).not.toContain("opaque-bearer");
    expect(result).not.toContain("opaque-access");
    expect(result).not.toContain("opaque-refresh");
    expect(result).not.toContain("opaque-client");
  });

  it.each(["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ENETUNREACH"])(
    "classifies Node network error code %s as retryable",
    (code) => {
      const error = Object.assign(new Error("request failed"), { code });

      expect(toIpcErrorPayload(error)).toMatchObject({
        code: "NETWORK_ERROR",
        retryable: true
      });
    }
  );

  it("classifies a network error code from the cause chain", () => {
    const cause = Object.assign(new Error("dns lookup failed"), { code: "EAI_AGAIN" });

    expect(toIpcErrorPayload(new Error("fetch failed", { cause }))).toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true
    });
  });

  it("classifies bounded mail reads without treating them as a retryable transport error", () => {
    expect(normalizeError(new MailContentTooLargeError(4 * 1024 * 1024))).toMatchObject({
      code: "MAIL_TOO_LARGE",
      message: expect.stringContaining("4 MiB")
    });
  });

  it("classifies oversized Graph responses without treating them as retryable", () => {
    expect(toIpcErrorPayload(new GraphResponseTooLargeError(4 * 1024 * 1024))).toMatchObject({
      code: "MAIL_TOO_LARGE",
      message: expect.stringContaining("4 MiB"),
      retryable: false
    });
  });

  it("classifies parser failures by type instead of dependency message text", () => {
    expect(normalizeError(new MailParseFailedError(new Error("Max allowed child nodes exceeded")))).toMatchObject({
      code: "MAIL_PARSE_FAILED",
      message: expect.stringContaining("Max allowed child nodes exceeded")
    });
  });

  it("bounds long public error messages before they enter progress events", () => {
    const payload = toIpcErrorPayload(Object.assign(new Error("x".repeat(APP_ERROR_MESSAGE_MAX_CHARS * 2)), {
      code: "ETIMEDOUT"
    }));

    expect(payload.code).toBe("NETWORK_ERROR");
    expect(payload.message).toHaveLength(APP_ERROR_MESSAGE_MAX_CHARS);
    expect(payload.message.endsWith("...")).toBe(true);
  });
});

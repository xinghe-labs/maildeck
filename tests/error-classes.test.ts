import { describe, expect, it } from "vitest";
import {
  GraphRequestError,
  GraphResponseInvalidError,
  GraphResponseTooLargeError,
  isGraphRequestError,
  isGraphResponseInvalidError,
  isGraphResponseTooLargeError,
  isGraphThrottledError
} from "../electron/main/graph-errors.js";
import {
  isMailContentTooLargeError,
  isMailParseFailedError,
  MailContentTooLargeError,
  MailParseFailedError
} from "../electron/main/mail-errors.js";
import { isJobCanceledError, JobCanceledError } from "../electron/main/job-errors.js";

describe("typed error classification", () => {
  it("keeps stable names so logs and error envelopes stay greppable", () => {
    expect(new GraphRequestError(429, "slow down", null, null).name).toBe("GraphRequestError");
    expect(new GraphResponseTooLargeError(1024).name).toBe("GraphResponseTooLargeError");
    expect(new GraphResponseInvalidError("bad payload").name).toBe("GraphResponseInvalidError");
    expect(new MailContentTooLargeError(1024).name).toBe("MailContentTooLargeError");
    expect(new MailParseFailedError(new Error("x")).name).toBe("MailParseFailedError");
    expect(new JobCanceledError().name).toBe("JobCanceledError");
  });

  it("carries the Graph status, request id, and retry hint", () => {
    const error = new GraphRequestError(429, "slow down", "request-1", 2_000);

    expect(error.status).toBe(429);
    expect(error.requestId).toBe("request-1");
    expect(error.retryAfterMs).toBe(2_000);
    expect(error).toBeInstanceOf(Error);
  });

  it("only treats 429 as throttling", () => {
    expect(isGraphThrottledError(new GraphRequestError(429, "slow down", null, null))).toBe(true);
    expect(isGraphThrottledError(new GraphRequestError(503, "unavailable", null, null))).toBe(false);
    expect(isGraphThrottledError(new Error("slow down"))).toBe(false);
  });

  it("reports byte limits in whole MiB", () => {
    expect(new GraphResponseTooLargeError(2 * 1024 * 1024).message).toContain("2 MiB");
    expect(new MailContentTooLargeError(4 * 1024 * 1024).message).toContain("4 MiB");
  });

  it("preserves the parse failure cause for diagnostics", () => {
    const cause = new Error("unexpected end of input");
    const error = new MailParseFailedError(cause);

    expect(error.cause).toBe(cause);
    expect(error.message).toContain("unexpected end of input");
  });

  it("accepts non-Error causes without throwing", () => {
    expect(new MailParseFailedError("plain reason").message).toContain("plain reason");
  });

  it("does not classify look-alike objects from another realm", () => {
    expect(isGraphRequestError({ status: 429 })).toBe(false);
    expect(isGraphResponseTooLargeError({ limitBytes: 1 })).toBe(false);
    expect(isGraphResponseInvalidError({ message: "x" })).toBe(false);
    expect(isMailContentTooLargeError({ limitBytes: 1 })).toBe(false);
    expect(isMailParseFailedError({ message: "x" })).toBe(false);
    expect(isJobCanceledError({ name: "JobCanceledError" })).toBe(false);
    expect(isJobCanceledError(null)).toBe(false);
  });
});

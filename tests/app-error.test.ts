import { describe, expect, it } from "vitest";
import { errorMessage, isAppError } from "../src/app-error.js";

describe("renderer app errors", () => {
  it("recognizes and displays structured IPC errors", () => {
    const error = { code: "MAIL_TOO_LARGE", message: "邮件正文过大", retryable: false };

    expect(isAppError(error)).toBe(true);
    expect(errorMessage(error)).toBe("邮件正文过大");
  });

  it("recognizes throttling as a stable application error", () => {
    expect(isAppError({ code: "THROTTLED", message: "请稍后重试", retryable: true })).toBe(true);
  });

  it("still displays local renderer errors", () => {
    expect(errorMessage(new Error("界面状态更新失败"))).toBe("界面状态更新失败");
  });

  it("rejects malformed error codes from an incompatible IPC payload", () => {
    expect(isAppError({ code: "NOT_A_REAL_CODE", message: "spoofed", retryable: false })).toBe(false);
  });
});

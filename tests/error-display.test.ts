import { describe, expect, it } from "vitest";
import { splitErrorMessage } from "../src/error-display";

describe("splitErrorMessage", () => {
  it("splits the readable title from the raw provider error", () => {
    const result = splitErrorMessage(
      "Token 无效或已过期，请重新获取 refresh_token。原始错误：live(400): AADSTS50173 Trace ID: abc-123"
    );

    expect(result.title).toBe("Token 无效或已过期，请重新获取 refresh_token");
    expect(result.detail).toBe("live(400): AADSTS50173 Trace ID: abc-123");
  });

  it("keeps a short message whole without detail", () => {
    expect(splitErrorMessage("连接超时")).toEqual({ title: "连接超时", detail: "" });
    expect(splitErrorMessage("")).toEqual({ title: "", detail: "" });
    expect(splitErrorMessage("   ")).toEqual({ title: "", detail: "" });
  });

  it("splits long sentences at the first sentence boundary", () => {
    const longText = `${"网络请求失败，".repeat(20)}。原始错误在下一行`;
    const result = splitErrorMessage(longText);

    expect(result.title.length).toBeLessThanOrEqual(140);
    expect(result.title.startsWith("网络请求失败，")).toBe(true);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("truncates a very long message without any sentence boundary", () => {
    const result = splitErrorMessage("x".repeat(300));

    expect(result.title.startsWith("xxx")).toBe(true);
    expect(result.title.endsWith("…")).toBe(true);
    expect(result.detail).toBe("x".repeat(300));
  });

  it("falls back to a generic title when the marker is the whole message", () => {
    const result = splitErrorMessage("原始错误：boom");

    expect(result.title).toBe("操作失败");
    expect(result.detail).toBe("boom");
  });
});

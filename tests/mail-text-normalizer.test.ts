import { describe, expect, it } from "vitest";
import { normalizeMailContentType, normalizeMailText } from "../electron/main/mail-text-normalizer.js";

describe("mail text normalizer", () => {
  it("repairs valid UTF-8 text that was decoded through Windows-1252", () => {
    expect(normalizeMailText("ä½ å¥½ï¼Œä¸–ç•Œ")).toBe("你好，世界");
    expect(normalizeMailText("CafÃ© et FranÃ§ois")).toBe("Café et François");
  });

  it("keeps valid text and intentional replacement symbols", () => {
    const value = "Original replacement: �";
    expect(normalizeMailText("正常中文内容")).toBe("正常中文内容");
    expect(normalizeMailText(value)).toBe(value);
  });

  it("removes a leading BOM and embedded NUL characters", () => {
    expect(normalizeMailText("\uFEFF第一\u0000行")).toBe("第一行");
  });

  it("canonicalizes MIME and Graph content type variants", () => {
    expect(normalizeMailContentType("TEXT/HTML; charset=utf-8")).toBe("html");
    expect(normalizeMailContentType("html")).toBe("html");
    expect(normalizeMailContentType("text/plain; charset=utf-8")).toBe("text");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessage } from "../electron/main/graph-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Graph mail content normalization", () => {
  it("normalizes subject, preview, content type, and body text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "message-1",
      subject: "CafÃ©",
      bodyPreview: "ä½ å¥½ï¼Œä¸–ç•Œ",
      body: {
        contentType: "TEXT/HTML; charset=utf-8",
        content: "<p>ä½ å¥½ï¼Œä¸–ç•Œ</p>"
      }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    await expect(getMessage("access-token", "message-1")).resolves.toMatchObject({
      subject: "Café",
      bodyPreview: "你好，世界",
      body: {
        contentType: "html",
        content: "<p>你好，世界</p>"
      }
    });
  });
});

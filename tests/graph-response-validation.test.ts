import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listMailFolders,
  listMessages,
  refreshAccessToken
} from "../electron/main/graph-client.js";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Graph response validation", () => {
  it("rejects a malformed collection instead of trusting a TypeScript cast", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ value: { id: "inbox" } })));

    await expect(listMailFolders("access-token")).rejects.toThrow("Graph 文件夹响应格式无效");
  });

  it("rejects messages without a stable Graph id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ value: [{ subject: "missing id" }] })));

    await expect(listMessages("access-token", "inbox")).rejects.toThrow("Graph 邮件列表响应格式无效");
  });

  it("handles a malformed Graph error payload without throwing a property access error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(null, 400)));

    await expect(listMailFolders("access-token")).rejects.toThrow("Graph 请求失败 400 (unknown)");
  });

  it("normalizes valid dates and degrades invalid Graph dates to null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      value: [{
        id: "message-1",
        receivedDateTime: "invalid",
        sentDateTime: "2026-08-10T08:30:00+08:00"
      }]
    })));

    await expect(listMessages("access-token", "inbox")).resolves.toMatchObject([{
      id: "message-1",
      receivedDateTime: null,
      sentDateTime: "2026-08-10T00:30:00.000Z"
    }]);
  });

  it("rejects a successful token response with the wrong shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));

    await expect(refreshAccessToken("client-id", "refresh-token")).rejects.toThrow("Token 响应格式无效");
  });

  it("rejects a successful token response without an access token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ scope: "Mail.Read" })));

    await expect(refreshAccessToken("client-id", "refresh-token")).rejects.toThrow("Token 响应格式无效");
  });
});

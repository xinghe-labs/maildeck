import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMessage,
  GRAPH_COLLECTION_RESPONSE_MAX_BYTES,
  GRAPH_MESSAGE_DETAIL_RESPONSE_MAX_BYTES,
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

  it("rejects an oversized collection response without exposing its body", async () => {
    const secretBody = "oversized-collection-secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(secretBody, {
      headers: { "Content-Length": String(GRAPH_COLLECTION_RESPONSE_MAX_BYTES + 1) }
    })));

    const error = await listMailFolders("access-token").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("4 MiB");
    expect((error as Error).message).not.toContain(secretBody);
  });

  it("allows a message detail response larger than the collection limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "message-1",
      body: { contentType: "text", content: "detail" }
    }), {
      headers: { "Content-Length": String(GRAPH_COLLECTION_RESPONSE_MAX_BYTES + 1) }
    })));

    await expect(getMessage("access-token", "message-1")).resolves.toMatchObject({
      id: "message-1",
      body: { content: "detail" }
    });
  });

  it("rejects a message detail response above its dedicated limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oversized-detail", {
      headers: { "Content-Length": String(GRAPH_MESSAGE_DETAIL_RESPONSE_MAX_BYTES + 1) }
    })));

    await expect(getMessage("access-token", "message-1")).rejects.toThrow("16 MiB");
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

  it("rejects an oversized token response without reading or exposing its body", async () => {
    const secretBody = "must-not-appear";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(secretBody, {
      headers: { "Content-Length": String(128 * 1024 + 1) }
    })));

    const error = await refreshAccessToken("client-id", "refresh-token").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("OAuth token 响应体超过 128 KiB 限制");
    expect((error as Error).message).not.toContain(secretBody);
  });
});

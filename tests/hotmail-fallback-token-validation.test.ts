import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshHotmailFallbackToken } from "../electron/main/hotmail-fallback-client.js";

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

describe("Hotmail fallback token validation", () => {
  it("rejects a successful token response with the wrong shape", async () => {
    const request = vi.fn(async () => jsonResponse({ access_token: { value: "not-a-string" } }));
    vi.stubGlobal("fetch", request);

    await expect(refreshHotmailFallbackToken("client-id", "refresh-token")).rejects.toThrow(
      "内置 Hotmail 兜底 token 响应格式无效"
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("normalizes a valid token response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      access_token: "access-token",
      refresh_token: "rotated-token",
      expires_in: 3_600,
      scope: "https://outlook.office.com/IMAP.AccessAsUser.All"
    })));

    await expect(refreshHotmailFallbackToken("client-id", "refresh-token")).resolves.toEqual({
      accessToken: "access-token",
      refreshToken: "rotated-token",
      expiresIn: 3_600,
      scope: "https://outlook.office.com/IMAP.AccessAsUser.All",
      authMode: "imap",
      endpoint: "live"
    });
  });

  it("rejects an oversized token response before trying another endpoint", async () => {
    const request = vi.fn(async () => new Response("secret token endpoint body", {
      headers: { "Content-Length": String(128 * 1024 + 1) }
    }));
    vi.stubGlobal("fetch", request);

    await expect(refreshHotmailFallbackToken("client-id", "refresh-token")).rejects.toThrow(
      "OAuth token 响应体超过 128 KiB 限制"
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});

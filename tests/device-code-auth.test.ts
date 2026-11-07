import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEVICE_CODE_CLIENT_ID,
  DeviceCodeAuthError,
  pollDeviceCode,
  readAccountEmail,
  resolveDeviceCodeBase,
  resolveDeviceCodeClientId,
  startDeviceCode,
  type DeviceCodeSession
} from "../electron/main/device-code-auth.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const deviceCodePayload = {
  device_code: "device-abc",
  user_code: "ABCD-1234",
  verification_uri: "https://microsoft.com/devicelogin",
  expires_in: 900,
  interval: 5,
  message: "请打开页面并输入代码"
};

const session: DeviceCodeSession = {
  deviceCode: "device-abc",
  userCode: "ABCD-1234",
  verificationUri: "https://microsoft.com/devicelogin",
  expiresInSec: 900,
  intervalSec: 5,
  message: "请打开页面并输入代码",
  clientId: DEFAULT_DEVICE_CODE_CLIENT_ID,
  baseUrl: "https://login.microsoftonline.com",
  tenant: "common"
};

describe("resolveDeviceCodeClientId", () => {
  it("没填时用内置的公开客户端", () => {
    expect(resolveDeviceCodeClientId()).toBe(DEFAULT_DEVICE_CODE_CLIENT_ID);
    expect(resolveDeviceCodeClientId("   ")).toBe(DEFAULT_DEVICE_CODE_CLIENT_ID);
  });

  it("填了就用自己的 client id（自建应用场景）", () => {
    expect(resolveDeviceCodeClientId(" 11111111-2222-3333-4444-555555555555 ")).toBe(
      "11111111-2222-3333-4444-555555555555"
    );
  });
});

describe("resolveDeviceCodeBase", () => {
  it("没配时用全球版端点", () => {
    expect(resolveDeviceCodeBase()).toBe("https://login.microsoftonline.com");
    expect(resolveDeviceCodeBase("  ")).toBe("https://login.microsoftonline.com");
  });

  it("去掉结尾斜杠，保留自定义域名（世纪互联等）", () => {
    expect(resolveDeviceCodeBase("https://login.chinacloudapi.cn/")).toBe("https://login.chinacloudapi.cn");
  });

  it("不是 http(s) 或写错就回落默认，不让用户卡在错域名上", () => {
    expect(resolveDeviceCodeBase("ftp://login.example.com")).toBe("https://login.microsoftonline.com");
    expect(resolveDeviceCodeBase("not a url")).toBe("https://login.microsoftonline.com");
  });
});

describe("startDeviceCode", () => {
  it("申请成功后返回短码与有效期", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(deviceCodePayload));
    const result = await startDeviceCode({ fetchImpl });

    expect(result.userCode).toBe("ABCD-1234");
    expect(result.deviceCode).toBe("device-abc");
    expect(result.verificationUri).toBe("https://microsoft.com/devicelogin");
    expect(result.expiresInSec).toBe(900);
    expect(result.intervalSec).toBe(5);
    expect(result.clientId).toBe(DEFAULT_DEVICE_CODE_CLIENT_ID);
    const [url, init] = fetchImpl.mock.calls[0] ?? ["", undefined];
    const body = typeof init?.body === "string" ? init.body : "";
    expect(url).toContain("/common/oauth2/v2.0/devicecode");
    expect(body).toContain("client_id=14d82eec-204b-4c2f-b7e8-296a70dab67e");
    expect(body).toContain("offline_access");
  });

  it("自定义端点会同时用于申请短码和轮询 token", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/devicecode")) {
        return jsonResponse(deviceCodePayload);
      }
      return jsonResponse({ access_token: "at", refresh_token: "rt", scope: "s" });
    }) as unknown as typeof fetch;

    const custom = await startDeviceCode({
      baseUrl: "https://login.chinacloudapi.cn/",
      fetchImpl
    });
    expect(custom.baseUrl).toBe("https://login.chinacloudapi.cn");

    const tokens = await pollDeviceCode({
      session: custom,
      fetchImpl,
      sleep: async () => undefined,
      now: () => 0
    });

    expect(tokens.refreshToken).toBe("rt");
    expect(calls).toEqual([
      "https://login.chinacloudapi.cn/common/oauth2/v2.0/devicecode",
      // token 轮询必须带 tenant 段：漏掉会 404（真机踩过：start 能拿到短码，轮询永远 404）
      "https://login.chinacloudapi.cn/common/oauth2/v2.0/token"
    ]);
  });

  it("微软返回 400 时抛出带说明的错误", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "invalid_client", error_description: "AADSTS700016: 应用不存在" }, 400)
    );
    await expect(startDeviceCode({ fetchImpl })).rejects.toMatchObject({
      code: "auth_request_failed",
      message: expect.stringContaining("AADSTS700016")
    });
  });

  it("返回体缺少 device_code 时报错而不是带着空值继续", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ user_code: "ABCD" }));
    await expect(startDeviceCode({ fetchImpl })).rejects.toBeInstanceOf(DeviceCodeAuthError);
  });

  it("网络异常也归类为请求失败", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND login.microsoftonline.com");
    });
    await expect(startDeviceCode({ fetchImpl })).rejects.toMatchObject({
      code: "auth_request_failed",
      message: expect.stringContaining("ENOTFOUND")
    });
  });
});

describe("pollDeviceCode", () => {
  function createClock() {
    let current = 0;
    return {
      now: () => current,
      sleep: async (ms: number) => {
        current += ms;
      },
      advance: (ms: number) => {
        current += ms;
      }
    };
  }

  it("先 pending 后成功，返回 refresh_token", async () => {
    const clock = createClock();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(jsonResponse({ refresh_token: "M.Cxxx", access_token: "eyJ", scope: "Mail.Read" }));

    const tokens = await pollDeviceCode({ session, fetchImpl, sleep: clock.sleep, now: clock.now });

    expect(tokens.refreshToken).toBe("M.Cxxx");
    expect(tokens.accessToken).toBe("eyJ");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("slow_down 会把轮询间隔加 5 秒", async () => {
    const clock = createClock();
    const intervals: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "slow_down" }, 400))
      .mockResolvedValueOnce(jsonResponse({ refresh_token: "M.Cxxx", access_token: "eyJ", scope: "" }));

    await pollDeviceCode({
      session: { ...session, intervalSec: 2 },
      fetchImpl,
      now: clock.now,
      sleep: async (ms) => {
        intervals.push(ms);
        await clock.sleep(ms);
      }
    });

    expect(intervals).toEqual([2_000, 7_000]);
  });

  it("expired_token 归类为登录代码过期", async () => {
    const clock = createClock();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "expired_token" }, 400));
    await expect(pollDeviceCode({ session, fetchImpl, sleep: clock.sleep, now: clock.now })).rejects.toMatchObject({
      code: "auth_expired"
    });
  });

  it("用户拒绝授权时给出 auth_declined", async () => {
    const clock = createClock();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "authorization_declined" }, 400));
    await expect(pollDeviceCode({ session, fetchImpl, sleep: clock.sleep, now: clock.now })).rejects.toMatchObject({
      code: "auth_declined"
    });
  });

  it("一直 pending 到过期就停下，不会无限轮询", async () => {
    const clock = createClock();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "authorization_pending" }, 400));
    await expect(
      pollDeviceCode({ session: { ...session, expiresInSec: 30 }, fetchImpl, sleep: clock.sleep, now: clock.now })
    ).rejects.toMatchObject({ code: "auth_expired" });
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it("被取消后不再请求", async () => {
    const clock = createClock();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "authorization_pending" }, 400));

    const pending = pollDeviceCode({
      session,
      fetchImpl,
      now: clock.now,
      signal: controller.signal,
      sleep: async (ms) => {
        controller.abort();
        await clock.sleep(ms);
      }
    });

    await expect(pending).rejects.toMatchObject({ code: "auth_pending_timeout" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("登录成功但没给 refresh_token 时报错", async () => {
    const clock = createClock();
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "eyJ" }));
    await expect(pollDeviceCode({ session, fetchImpl, sleep: clock.sleep, now: clock.now })).rejects.toMatchObject({
      code: "auth_request_failed"
    });
  });
});

describe("readAccountEmail", () => {
  it("优先用 mail 字段", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ mail: "user@hotmail.com", userPrincipalName: "user@outlook.com" })
    );
    await expect(readAccountEmail({ accessToken: "eyJ", fetchImpl })).resolves.toBe("user@hotmail.com");
  });

  it("没有 mail 时退回 userPrincipalName", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ mail: null, userPrincipalName: "user@outlook.com" }));
    await expect(readAccountEmail({ accessToken: "eyJ", fetchImpl })).resolves.toBe("user@outlook.com");
  });

  it("查不到就返回 null，不让登录流程失败", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Unauthorized" }, 401));
    await expect(readAccountEmail({ accessToken: "eyJ", fetchImpl })).resolves.toBeNull();
  });

  it("没有 access token 时直接返回 null，不发请求", async () => {
    const fetchImpl = vi.fn();
    await expect(readAccountEmail({ accessToken: "", fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

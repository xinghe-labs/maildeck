/**
 * Microsoft 设备代码（Device Code）授权流程。
 *
 * 用户不需要自己找 refresh_token：应用向微软申请一个短码，用户在浏览器里输入短码并登录，
 * 主进程轮询令牌端点，拿到 refresh_token 后直接填进导入表单。
 */

const DEVICE_CODE_BASE = "https://login.microsoftonline.com";

/**
 * 允许指向其它登录端点（例如世纪互联 `https://login.chinacloudapi.cn`）。
 * 不配时用全球版；配了非法值就忽略，避免把用户卡在一个写错的域名上。
 */
export function resolveDeviceCodeBase(baseUrl?: string): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/u, "");
  if (!trimmed) {
    return DEVICE_CODE_BASE;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? trimmed : DEVICE_CODE_BASE;
  } catch {
    return DEVICE_CODE_BASE;
  }
}

/** 微软官方公开客户端（Microsoft Graph PowerShell），设备代码流程可用，不需要自建应用注册。 */
export const DEFAULT_DEVICE_CODE_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
export const DEFAULT_DEVICE_CODE_SCOPE = "https://graph.microsoft.com/Mail.Read offline_access";
/** `common` 同时支持个人微软账号与企业租户账号。 */
export const DEFAULT_DEVICE_CODE_TENANT = "common";

const DEVICE_CODE_TIMEOUT_MS = 20_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

export type DeviceCodeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface DeviceCodeSession {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSec: number;
  readonly intervalSec: number;
  readonly message: string;
  readonly clientId: string;
  readonly baseUrl: string;
  /** 与 devicecode 端点同一个租户段；token 轮询必须带上，否则 404。 */
  readonly tenant: string;
}

export interface DeviceCodeTokens {
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly scope: string;
}

export type DeviceCodeFailureCode =
  | "auth_expired"
  | "auth_declined"
  | "auth_pending_timeout"
  | "auth_request_failed";

export class DeviceCodeAuthError extends Error {
  readonly code: DeviceCodeFailureCode;

  constructor(code: DeviceCodeFailureCode, message: string) {
    super(message);
    this.name = "DeviceCodeAuthError";
    this.code = code;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return readRecord(await response.json());
  } catch {
    return null;
  }
}

function tenantSegment(tenant: string | undefined): string {
  const trimmed = tenant?.trim();
  return trimmed && /^[A-Za-z0-9.-]+$/.test(trimmed) ? trimmed : DEFAULT_DEVICE_CODE_TENANT;
}

export function resolveDeviceCodeClientId(clientId?: string): string {
  const trimmed = clientId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_DEVICE_CODE_CLIENT_ID;
}

/** 申请一个设备代码，返回需要展示给用户的短码和验证地址。 */
export async function startDeviceCode(options: {
  clientId?: string;
  tenant?: string;
  scope?: string;
  baseUrl?: string;
  fetchImpl?: DeviceCodeFetch;
  signal?: AbortSignal;
} = {}): Promise<DeviceCodeSession> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clientId = resolveDeviceCodeClientId(options.clientId);
  const baseUrl = resolveDeviceCodeBase(options.baseUrl);
  const scope = options.scope?.trim() || DEFAULT_DEVICE_CODE_SCOPE;
  const url = `${baseUrl}/${tenantSegment(options.tenant)}/oauth2/v2.0/devicecode`;
  const body = new URLSearchParams({ client_id: clientId, scope }).toString();

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: options.signal ?? AbortSignal.timeout(DEVICE_CODE_TIMEOUT_MS)
    });
  } catch (error) {
    throw new DeviceCodeAuthError(
      "auth_request_failed",
      `无法连接微软登录服务：${error instanceof Error ? error.message : String(error)}`
    );
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const description = readString(payload, "error_description") ?? readString(payload, "error") ?? `HTTP ${response.status}`;
    throw new DeviceCodeAuthError("auth_request_failed", `申请设备代码失败：${description}`);
  }

  const deviceCode = readString(payload, "device_code");
  const userCode = readString(payload, "user_code");
  if (!deviceCode || !userCode) {
    throw new DeviceCodeAuthError("auth_request_failed", "申请设备代码失败：微软返回的内容缺少 device_code/user_code。");
  }

  const verificationUri = readString(payload, "verification_uri") ?? "https://microsoft.com/devicelogin";
  const tenant = tenantSegment(options.tenant);
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresInSec: readNumber(payload, "expires_in") ?? 900,
    intervalSec: readNumber(payload, "interval") ?? 5,
    message: readString(payload, "message") ?? `请在浏览器打开 ${verificationUri} 并输入代码 ${userCode}`,
    clientId,
    baseUrl,
    tenant
  };
}

/** 轮询令牌端点，直到用户完成登录、拒绝授权、超时或被取消。 */
export async function pollDeviceCode(options: {
  session: DeviceCodeSession;
  fetchImpl?: DeviceCodeFetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<DeviceCodeTokens> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const url = `${options.session.baseUrl}/${options.session.tenant}/oauth2/v2.0/token`;
  const deadline = now() + options.session.expiresInSec * 1000;
  let intervalSec = Math.max(1, options.session.intervalSec);

  for (;;) {
    if (options.signal?.aborted) {
      throw new DeviceCodeAuthError("auth_pending_timeout", "已取消登录。");
    }
    if (now() >= deadline) {
      throw new DeviceCodeAuthError("auth_expired", "登录代码已过期，请重新获取。");
    }

    await sleep(intervalSec * 1000);

    if (options.signal?.aborted) {
      throw new DeviceCodeAuthError("auth_pending_timeout", "已取消登录。");
    }

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: options.session.deviceCode,
      client_id: options.session.clientId
    }).toString();

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new DeviceCodeAuthError(
        "auth_request_failed",
        `轮询登录结果失败：${error instanceof Error ? error.message : String(error)}`
      );
    }

    const payload = await readJson(response);
    if (response.ok) {
      const refreshToken = readString(payload, "refresh_token");
      const accessToken = readString(payload, "access_token");
      if (!refreshToken) {
        throw new DeviceCodeAuthError("auth_request_failed", "登录成功但微软没有返回 refresh_token，请确认应用权限。");
      }
      return {
        refreshToken,
        accessToken: accessToken ?? "",
        scope: readString(payload, "scope") ?? ""
      };
    }

    const errorCode = readString(payload, "error") ?? "";
    const description = readString(payload, "error_description") ?? `HTTP ${response.status}`;
    if (errorCode === "authorization_pending") {
      continue;
    }
    if (errorCode === "slow_down") {
      // 微软要求放慢轮询：按规范把间隔加 5 秒后继续。
      intervalSec += 5;
      continue;
    }
    if (errorCode === "expired_token") {
      throw new DeviceCodeAuthError("auth_expired", "登录代码已过期，请重新获取。");
    }
    if (errorCode === "authorization_declined" || errorCode === "access_denied") {
      throw new DeviceCodeAuthError("auth_declined", "你在浏览器里拒绝了授权。");
    }
    throw new DeviceCodeAuthError("auth_request_failed", `登录失败：${description}`);
  }
}

/** 用 access token 查一次 /me，尽量把邮箱地址填好，省掉用户手输。 */
export async function readAccountEmail(options: {
  accessToken: string;
  fetchImpl?: DeviceCodeFetch;
}): Promise<string | null> {
  if (!options.accessToken) {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
      method: "GET",
      headers: { authorization: `Bearer ${options.accessToken}` },
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      return null;
    }
    const payload = await readJson(response);
    return readString(payload, "mail") ?? readString(payload, "userPrincipalName");
  } catch {
    return null;
  }
}

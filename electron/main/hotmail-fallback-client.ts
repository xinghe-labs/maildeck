import { getImapMessage, listImapFolders, listImapMessages, refreshImapInbox } from "./imap-client.js";
import { proxiedFetchOptions } from "./proxy-agent.js";
import type { AccountRecord, AccessTokenResult, MailMessageDetail, MailMessageSummary } from "./types.js";
import { z } from "zod";
import { readOAuthResponseText } from "./oauth-response-reader.js";

const TOKEN_ENDPOINTS = [
  {
    name: "live",
    url: "https://login.live.com/oauth20_token.srf",
    scope: ""
  },
  {
    name: "entra-consumers-delegated",
    url: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
    scope: "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read"
  },
  {
    name: "entra-common-delegated",
    url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read"
  }
] as const;

export interface HotmailFallbackMessagesResult {
  messages: MailMessageSummary[];
  transport: string;
  nextRefreshToken: string | null;
  totalCount: number;
  inboxFolderId: string | null;
  cursor: string | null;
}

export interface HotmailFallbackMessageResult {
  detail: MailMessageDetail;
  transport: string;
  nextRefreshToken: string | null;
  inboxFolderId: string;
}

const TOKEN_VALUE_MAX_CHARS = 128 * 1024;
const TOKEN_ERROR_MAX_CHARS = 512;
const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(TOKEN_VALUE_MAX_CHARS).optional(),
  refresh_token: z.string().max(TOKEN_VALUE_MAX_CHARS).nullable().optional(),
  expires_in: z.number().finite().nonnegative().max(31_536_000).optional(),
  scope: z.string().max(16_384).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(4_096).optional()
});
type TokenResponse = z.infer<typeof tokenResponseSchema>;

function boundedTokenError(value: string) {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized.slice(0, TOKEN_ERROR_MAX_CHARS) || "token refresh failed";
}

async function parseResponse(response: Response) {
  const text = await readOAuthResponseText(response);
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error_description: "token endpoint returned a non-JSON response" };
  }
}

export function isHotmailFallbackEnabled(settings: { hotmailFallbackEnabled?: boolean }) {
  return settings.hotmailFallbackEnabled !== false;
}

export async function refreshHotmailFallbackToken(
  clientId: string,
  refreshToken: string,
  proxyUrl = "",
  signal?: AbortSignal
): Promise<AccessTokenResult & { endpoint: string }> {
  const errors: string[] = [];

  for (const endpoint of TOKEN_ENDPOINTS) {
    signal?.throwIfAborted();
    const form = new URLSearchParams();
    form.set("client_id", clientId);
    form.set("refresh_token", refreshToken);
    form.set("grant_type", "refresh_token");

    if (endpoint.scope) {
      form.set("scope", endpoint.scope);
    }

    const response = await fetch(endpoint.url, proxiedFetchOptions({
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form,
      signal
    }, proxyUrl));
    signal?.throwIfAborted();
    const rawPayload = await parseResponse(response);
    signal?.throwIfAborted();
    const parsedPayload = tokenResponseSchema.safeParse(rawPayload);
    if (response.ok && (!parsedPayload.success || !parsedPayload.data.access_token)) {
      throw new Error("内置 Hotmail 兜底 token 响应格式无效");
    }
    const payload: TokenResponse = parsedPayload.success ? parsedPayload.data : {};

    if (response.ok && payload.access_token) {
      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token || null,
        expiresIn: payload.expires_in || null,
        scope: payload.scope || "",
        authMode: "imap",
        endpoint: endpoint.name
      };
    }

    const description = boundedTokenError(payload.error_description || payload.error || "token refresh failed");
    errors.push(`${endpoint.name}(${response.status}): ${description}`);
  }

  throw new Error(`内置 Hotmail 兜底 token 刷新失败：${errors.join(" | ")}`);
}

export async function fetchHotmailFallbackMessages(
  settings: { hotmailFallbackEnabled?: boolean; proxyUrl?: string },
  account: AccountRecord,
  refreshToken: string,
  top = 20,
  signal?: AbortSignal
): Promise<HotmailFallbackMessagesResult> {
  if (!isHotmailFallbackEnabled(settings)) {
    throw new Error("内置 Hotmail 兜底未启用");
  }

  const proxyUrl = settings.proxyUrl || "";
  const token = await refreshHotmailFallbackToken(account.clientId, refreshToken, proxyUrl, signal);
  const result = await refreshImapInbox(account.email, token.accessToken, top, "", account.inboxFolderId || null, proxyUrl, signal);
  const messages = result.messages.length > 0
    ? result.messages
    : (await listImapMessages(account.email, token.accessToken, result.inboxFolderId || "INBOX", top, "", "", proxyUrl, signal)).messages;
  signal?.throwIfAborted();

  return {
    messages,
    transport: `builtin-${token.endpoint}`,
    nextRefreshToken: token.refreshToken,
    totalCount: result.totalCount || messages.length,
    inboxFolderId: result.inboxFolderId || null,
    cursor: result.cursor
  };
}

export async function fetchHotmailFallbackMessage(
  settings: { hotmailFallbackEnabled?: boolean; proxyUrl?: string },
  account: AccountRecord,
  refreshToken: string,
  messageId: string,
  signal?: AbortSignal
): Promise<HotmailFallbackMessageResult> {
  if (!isHotmailFallbackEnabled(settings)) {
    throw new Error("内置 Hotmail 兜底未启用");
  }

  const proxyUrl = settings.proxyUrl || "";
  const token = await refreshHotmailFallbackToken(account.clientId, refreshToken, proxyUrl, signal);
  const folders = await listImapFolders(account.email, token.accessToken, proxyUrl, signal);
  const cachedInbox = account.inboxFolderId
    ? folders.find((folder) => folder.id === account.inboxFolderId)
    : null;
  const discoveredInbox = folders.find((folder) => {
    const name = folder.displayName.trim().toLowerCase();
    return name === "inbox" || name.includes("收件箱");
  });
  const inboxFolderId = cachedInbox?.id || discoveredInbox?.id;
  if (!inboxFolderId) {
    throw new Error("未找到收件箱");
  }
  const detail = await getImapMessage(
    account.email,
    token.accessToken,
    inboxFolderId,
    messageId,
    proxyUrl,
    signal
  );
  signal?.throwIfAborted();

  return {
    detail,
    transport: `builtin-${token.endpoint}`,
    nextRefreshToken: token.refreshToken,
    inboxFolderId
  };
}

export async function testHotmailFallbackConnection(
  settings: { hotmailFallbackEnabled?: boolean; proxyUrl?: string },
  account: AccountRecord,
  refreshToken: string,
  top = 5,
  signal?: AbortSignal
): Promise<HotmailFallbackMessagesResult> {
  if (!isHotmailFallbackEnabled(settings)) {
    throw new Error("内置 Hotmail 兜底未启用");
  }

  const proxyUrl = settings.proxyUrl || "";
  const token = await refreshHotmailFallbackToken(account.clientId, refreshToken, proxyUrl, signal);
  const result = await refreshImapInbox(account.email, token.accessToken, top, "", account.inboxFolderId || null, proxyUrl, signal);
  const messages = result.messages.length > 0
    ? result.messages
    : (await listImapMessages(account.email, token.accessToken, result.inboxFolderId || "INBOX", top, "", "", proxyUrl, signal)).messages;
  signal?.throwIfAborted();

  return {
    messages,
    transport: `builtin-${token.endpoint}`,
    nextRefreshToken: token.refreshToken,
    totalCount: result.totalCount || messages.length,
    inboxFolderId: result.inboxFolderId || null,
    cursor: result.cursor
  };
}

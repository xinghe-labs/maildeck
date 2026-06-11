import { getImapMessage, listImapMessages, refreshImapInbox } from "./imap-client.js";
import { proxiedFetchOptions } from "./proxy-agent.js";
import type { AccountRecord, AccessTokenResult, MailMessageDetail, MailMessageSummary } from "./types.js";

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
  details: MailMessageDetail[];
  transport: string;
  nextRefreshToken: string | null;
  totalCount: number;
  inboxFolderId: string | null;
  cursor: string | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function parseResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    return { error_description: text };
  }
}

export function isHotmailFallbackEnabled(settings: { hotmailFallbackEnabled?: boolean }) {
  return settings.hotmailFallbackEnabled !== false;
}

export async function refreshHotmailFallbackToken(
  clientId: string,
  refreshToken: string,
  proxyUrl = ""
): Promise<AccessTokenResult & { endpoint: string }> {
  const errors: string[] = [];

  for (const endpoint of TOKEN_ENDPOINTS) {
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
      body: form
    }, proxyUrl));
    const payload = await parseResponse(response);

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

    errors.push(`${endpoint.name}(${response.status}): ${payload.error_description || payload.error || "token refresh failed"}`);
  }

  throw new Error(`内置 Hotmail 兜底 token 刷新失败：${errors.join(" | ")}`);
}

async function loadMessageDetails(
  account: AccountRecord,
  accessToken: string,
  folderId: string,
  messages: MailMessageSummary[],
  proxyUrl: string
) {
  const details: MailMessageDetail[] = [];

  for (const message of messages.slice(0, 10)) {
    try {
      details.push(await getImapMessage(account.email, accessToken, folderId, message.id, proxyUrl));
    } catch {
      details.push({
        ...message,
        toRecipients: [],
        ccRecipients: [],
        body: {
          contentType: "text",
          content: message.bodyPreview || ""
        }
      });
    }
  }

  return details;
}

export async function fetchHotmailFallbackMessages(
  settings: { hotmailFallbackEnabled?: boolean; proxyUrl?: string },
  account: AccountRecord,
  refreshToken: string,
  top = 20
): Promise<HotmailFallbackMessagesResult> {
  if (!isHotmailFallbackEnabled(settings)) {
    throw new Error("内置 Hotmail 兜底未启用");
  }

  const proxyUrl = settings.proxyUrl || "";
  const token = await refreshHotmailFallbackToken(account.clientId, refreshToken, proxyUrl);
  const result = await refreshImapInbox(account.email, token.accessToken, top, "", account.inboxFolderId || null, proxyUrl);
  const messages = result.messages.length > 0
    ? result.messages
    : (await listImapMessages(account.email, token.accessToken, result.inboxFolderId || "INBOX", top, "", "", proxyUrl)).messages;
  const details = result.inboxFolderId
    ? await loadMessageDetails(account, token.accessToken, result.inboxFolderId, messages, proxyUrl)
    : [];

  return {
    messages,
    details,
    transport: `builtin-${token.endpoint}`,
    nextRefreshToken: token.refreshToken,
    totalCount: result.totalCount || messages.length,
    inboxFolderId: result.inboxFolderId || null,
    cursor: result.cursor
  };
}

export async function testHotmailFallbackConnection(
  settings: { hotmailFallbackEnabled?: boolean; proxyUrl?: string },
  account: AccountRecord,
  refreshToken: string,
  top = 5
): Promise<Omit<HotmailFallbackMessagesResult, "details">> {
  if (!isHotmailFallbackEnabled(settings)) {
    throw new Error("内置 Hotmail 兜底未启用");
  }

  const proxyUrl = settings.proxyUrl || "";
  const token = await refreshHotmailFallbackToken(account.clientId, refreshToken, proxyUrl);
  const result = await refreshImapInbox(account.email, token.accessToken, top, "", account.inboxFolderId || null, proxyUrl);
  const messages = result.messages.length > 0
    ? result.messages
    : (await listImapMessages(account.email, token.accessToken, result.inboxFolderId || "INBOX", top, "", "", proxyUrl)).messages;

  return {
    messages,
    transport: `builtin-${token.endpoint}`,
    nextRefreshToken: token.refreshToken,
    totalCount: result.totalCount || messages.length,
    inboxFolderId: result.inboxFolderId || null,
    cursor: result.cursor
  };
}

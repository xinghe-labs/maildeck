import type {
  AccessTokenResult,
  MailAddress,
  MailFolder,
  MailMessageDetail,
  MailMessageSummary
} from "./types.js";
import { ProxyAgent } from "undici";

const GRAPH_ENDPOINT = "https://graph.microsoft.com/v1.0";
const TOKEN_ENDPOINTS = [
  "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
  "https://login.microsoftonline.com/organizations/oauth2/v2.0/token"
] as const;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GraphError {
  error?: {
    code?: string;
    message?: string;
    innerError?: {
      date?: string;
      "request-id"?: string;
      "client-request-id"?: string;
    };
  };
}

interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount?: number;
  unreadItemCount?: number;
}

interface GraphEmailAddress {
  emailAddress?: {
    name?: string;
    address?: string;
  };
}

interface GraphMessage {
  id: string;
  subject?: string;
  from?: GraphEmailAddress | null;
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  importance?: string;
  hasAttachments?: boolean;
  bodyPreview?: string;
  webLink?: string;
  toRecipients?: GraphEmailAddress[];
  ccRecipients?: GraphEmailAddress[];
  body?: {
    contentType?: string;
    content?: string;
  };
}

interface GraphListResponse<T> {
  value?: T[];
}

interface GraphDeltaResponse<T> extends GraphListResponse<T> {
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export interface GraphDeltaMessagesResult {
  messages: MailMessageSummary[];
  nextLink: string | null;
  deltaLink: string | null;
}

function createGraphError(status: number, payload: GraphError | string) {
  if (typeof payload === "string") {
    return new Error(`Graph 请求失败 ${status}: ${payload}`);
  }

  const code = payload.error?.code || "unknown";
  const message = payload.error?.message || `Graph 请求失败 ${status}`;
  const requestId = payload.error?.innerError?.["request-id"] || payload.error?.innerError?.["client-request-id"] || "";
  const suffix = requestId ? `，request-id: ${requestId}` : "";

  return new Error(`Graph 请求失败 ${status} (${code})：${message}${suffix}`);
}

async function parseResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function fetchOptions(init: RequestInit, proxyUrl = ""): RequestInit {
  if (!proxyUrl) {
    return init;
  }

  return {
    ...init,
    dispatcher: new ProxyAgent(proxyUrl)
  } as RequestInit;
}

async function graphFetch<T>(accessToken: string, path: string, proxyUrl = ""): Promise<T> {
  const response = await proxiedFetch(
    `${GRAPH_ENDPOINT}${path}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    },
    proxyUrl
  );

  const payload = await parseResponse(response);

  if (!response.ok) {
    throw createGraphError(response.status, payload as GraphError | string);
  }

  return payload as T;
}

async function graphFetchUrl<T>(accessToken: string, url: string, proxyUrl = ""): Promise<T> {
  const response = await proxiedFetch(
    url,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    },
    proxyUrl
  );

  const payload = await parseResponse(response);

  if (!response.ok) {
    throw createGraphError(response.status, payload as GraphError | string);
  }

  return payload as T;
}

function mapAddress(input?: GraphEmailAddress | null): MailAddress | null {
  const address = input?.emailAddress?.address || "";
  const name = input?.emailAddress?.name || "";

  if (!address && !name) {
    return null;
  }

  return { name, address };
}

function mapAddressList(input?: GraphEmailAddress[]) {
  return (input || []).map(mapAddress).filter((item): item is MailAddress => item !== null);
}

function mapMessageSummary(message: GraphMessage): MailMessageSummary {
  return {
    id: message.id,
    subject: message.subject || "(无主题)",
    from: mapAddress(message.from),
    receivedDateTime: message.receivedDateTime || null,
    sentDateTime: message.sentDateTime || null,
    isRead: Boolean(message.isRead),
    importance: message.importance || "normal",
    hasAttachments: Boolean(message.hasAttachments),
    bodyPreview: message.bodyPreview || "",
    webLink: message.webLink || null
  };
}

function detectAuthMode(scope: string) {
  if (scope.includes("https://graph.microsoft.com/")) {
    return "graph" as const;
  }

  if (scope.includes("https://outlook.office.com/")) {
    return "imap" as const;
  }

  return "graph" as const;
}

async function proxiedFetch(url: string, init: RequestInit, proxyUrl = "") {
  return fetch(url, fetchOptions(init, proxyUrl));
}

export async function refreshAccessToken(clientId: string, refreshToken: string, proxyUrl = ""): Promise<AccessTokenResult> {
  let lastError: string | null = null;

  for (const endpoint of TOKEN_ENDPOINTS) {
    const form = new URLSearchParams();
    form.set("client_id", clientId);
    form.set("refresh_token", refreshToken);
    form.set("grant_type", "refresh_token");

    const response = await proxiedFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    }, proxyUrl);

    const payload = (await parseResponse(response)) as TokenResponse;

    if (response.ok && payload.access_token) {
      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token || null,
        expiresIn: payload.expires_in || null,
        scope: payload.scope || "",
        authMode: detectAuthMode(payload.scope || "")
      };
    }

    const endpointTenant = endpoint.match(/login\.microsoftonline\.com\/([^/]+)/)?.[1] || "unknown";
    const errorCode = payload.error || `HTTP_${response.status}`;
    const description = payload.error_description || `Token 刷新失败 ${response.status}`;
    lastError = `Token 刷新失败 [${endpointTenant}/${errorCode}]：${description}`;

    // 租户不匹配时继续尝试其它端点，其它错误直接返回，避免无意义重试。
    if (!lastError.includes("AADSTS7000012")) {
      throw new Error(lastError);
    }
  }

  throw new Error(lastError || "Token 刷新失败");
}

export async function listMailFolders(accessToken: string, proxyUrl = ""): Promise<MailFolder[]> {
  const payload = await graphFetch<GraphListResponse<GraphFolder>>(
    accessToken,
    "/me/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount",
    proxyUrl
  );

  return (payload.value || []).map((folder) => ({
    id: folder.id,
    displayName: folder.displayName,
    totalItemCount: folder.totalItemCount || 0,
    unreadItemCount: folder.unreadItemCount || 0
  }));
}

export async function listMessages(
  accessToken: string,
  folderId: string,
  top = 30,
  skip = 0,
  search = "",
  since: string | null = null,
  proxyUrl = ""
): Promise<MailMessageSummary[]> {
  const params = new URLSearchParams();
  params.set("$top", String(Math.min(Math.max(top, 1), 100)));
  params.set("$skip", String(Math.max(skip, 0)));
  params.set(
    "$select",
    "id,subject,from,receivedDateTime,sentDateTime,isRead,importance,hasAttachments,bodyPreview,webLink"
  );
  params.set("$orderby", "receivedDateTime desc");

  const filters: string[] = [];
  if (search.trim()) {
    filters.push(`contains(subject,'${search.trim().replace(/'/g, "''")}')`);
  }
  if (since) {
    filters.push(`receivedDateTime gt ${since}`);
  }
  if (filters.length > 0) {
    params.set("$filter", filters.join(" and "));
  }

  const payload = await graphFetch<GraphListResponse<GraphMessage>>(
    accessToken,
    `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${params.toString()}`,
    proxyUrl
  );

  return (payload.value || []).map(mapMessageSummary);
}

export async function deltaMessages(
  accessToken: string,
  folderId: string,
  top = 20,
  deltaLink: string | null = null,
  maxPages = 1,
  proxyUrl = ""
): Promise<GraphDeltaMessagesResult> {
  const messages: MailMessageSummary[] = [];
  let nextLink: string | null = deltaLink;
  let finalDeltaLink: string | null = null;
  const pageLimit = Math.min(Math.max(maxPages, 1), 10);

  for (let page = 0; page < pageLimit; page += 1) {
    const payload = nextLink
      ? await graphFetchUrl<GraphDeltaResponse<GraphMessage>>(accessToken, nextLink, proxyUrl)
      : await graphFetch<GraphDeltaResponse<GraphMessage>>(
          accessToken,
          `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$top=${Math.min(Math.max(top, 1), 100)}&$select=id,subject,from,receivedDateTime,sentDateTime,isRead,importance,hasAttachments,bodyPreview,webLink`,
          proxyUrl
        );

    messages.push(...(payload.value || []).map(mapMessageSummary));
    finalDeltaLink = payload["@odata.deltaLink"] || null;
    nextLink = payload["@odata.nextLink"] || null;

    if (finalDeltaLink || !nextLink) {
      break;
    }
  }

  return {
    messages,
    nextLink,
    deltaLink: finalDeltaLink
  };
}

export async function getMessage(accessToken: string, messageId: string, proxyUrl = ""): Promise<MailMessageDetail> {
  const params = new URLSearchParams();
  params.set(
    "$select",
    "id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,importance,hasAttachments,bodyPreview,webLink,body"
  );

  const message = await graphFetch<GraphMessage>(accessToken, `/me/messages/${encodeURIComponent(messageId)}?${params}`, proxyUrl);
  const summary = mapMessageSummary(message);
  const content = message.body?.content || "";

  return {
    ...summary,
    toRecipients: mapAddressList(message.toRecipients),
    ccRecipients: mapAddressList(message.ccRecipients),
    body: {
      contentType: message.body?.contentType || "text",
      content
    }
  };
}

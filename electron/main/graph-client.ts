import type {
  AccessTokenResult,
  MailAddress,
  MailFolder,
  MailMessageDetail,
  MailMessageSummary
} from "./types.js";
import { z } from "zod";
import { proxiedFetchOptions } from "./proxy-agent.js";
import { GraphRequestError, GraphResponseInvalidError, GraphResponseTooLargeError } from "./graph-errors.js";
import { calculateGraphRetryDelay, GRAPH_MAX_ATTEMPTS, waitForGraphRetry } from "./graph-retry.js";
import { normalizeMailDate } from "./mail-date-normalizer.js";
import { normalizeMailContentType, normalizeMailText } from "./mail-text-normalizer.js";
import { readOAuthResponseText } from "./oauth-response-reader.js";
import { readResponseTextBounded } from "./bounded-response-reader.js";

const GRAPH_ENDPOINT = "https://graph.microsoft.com/v1.0";
export const GRAPH_ERROR_RESPONSE_MAX_BYTES = 1024 * 1024;
export const GRAPH_COLLECTION_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const GRAPH_MESSAGE_DETAIL_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const TOKEN_ENDPOINTS = [
  "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
  "https://login.microsoftonline.com/organizations/oauth2/v2.0/token"
] as const;

const graphErrorSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
    innerError: z.object({
      date: z.string().optional(),
      "request-id": z.string().optional(),
      "client-request-id": z.string().optional()
    }).optional()
  }).optional()
});

const graphFolderSchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  totalItemCount: z.number().int().nonnegative().nullable().optional(),
  unreadItemCount: z.number().int().nonnegative().nullable().optional()
});

const graphEmailAddressSchema = z.object({
  emailAddress: z.object({
    name: z.string().nullable().optional(),
    address: z.string().nullable().optional()
  }).nullable().optional()
});

const graphMessageSchema = z.object({
  id: z.string().min(1),
  subject: z.string().nullable().optional(),
  from: graphEmailAddressSchema.nullable().optional(),
  receivedDateTime: z.string().nullable().optional(),
  sentDateTime: z.string().nullable().optional(),
  isRead: z.boolean().optional(),
  importance: z.string().nullable().optional(),
  hasAttachments: z.boolean().optional(),
  bodyPreview: z.string().nullable().optional(),
  webLink: z.string().nullable().optional(),
  toRecipients: z.array(graphEmailAddressSchema).nullable().optional(),
  ccRecipients: z.array(graphEmailAddressSchema).nullable().optional(),
  body: z.object({
    contentType: z.string().nullable().optional(),
    content: z.string().nullable().optional()
  }).nullable().optional()
});

type GraphEmailAddress = z.infer<typeof graphEmailAddressSchema>;
type GraphMessage = z.infer<typeof graphMessageSchema>;

const graphFolderListSchema = z.object({ value: z.array(graphFolderSchema) });
const graphMessageListSchema = z.object({ value: z.array(graphMessageSchema) });
const graphDeltaSchema = z.object({
  value: z.array(graphMessageSchema),
  "@odata.nextLink": z.string().nullable().optional(),
  "@odata.deltaLink": z.string().nullable().optional()
});

export interface GraphDeltaMessagesResult {
  messages: MailMessageSummary[];
  nextLink: string | null;
  deltaLink: string | null;
}

function createGraphError(status: number, payload: unknown, retryAfterMs: number | null) {
  if (typeof payload === "string") {
    return new GraphRequestError(status, `Graph 请求失败 ${status}: ${payload}`, null, retryAfterMs);
  }

  const parsed = graphErrorSchema.safeParse(payload);
  const error = parsed.success ? parsed.data.error : undefined;
  const code = error?.code || "unknown";
  const message = error?.message || `Graph 请求失败 ${status}`;
  const requestId = error?.innerError?.["request-id"] || error?.innerError?.["client-request-id"] || "";
  const suffix = requestId ? `，request-id: ${requestId}` : "";

  return new GraphRequestError(
    status,
    `Graph 请求失败 ${status} (${code})：${message}${suffix}`,
    requestId || null,
    retryAfterMs
  );
}

async function parseResponse(response: Response, maxBytes: number) {
  const text = await readResponseTextBounded(
    response,
    response.ok ? maxBytes : GRAPH_ERROR_RESPONSE_MAX_BYTES,
    () => new GraphResponseTooLargeError(response.ok ? maxBytes : GRAPH_ERROR_RESPONSE_MAX_BYTES)
  );
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trustedGraphUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.origin !== "https://graph.microsoft.com" || !parsed.pathname.startsWith("/v1.0/")) {
    throw new Error("不受信任的 Graph 分页地址");
  }
  return parsed.toString();
}

function parseGraphResponse<T>(schema: z.ZodType<T>, payload: unknown, resource: string): T {
  const result = schema.safeParse(payload);
  if (result.success) {
    return result.data;
  }

  const details = result.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "response"}: ${issue.message}`)
    .join("; ");
  throw new GraphResponseInvalidError(`Graph ${resource}响应格式无效：${details}`);
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(128 * 1024).optional(),
  refresh_token: z.string().max(128 * 1024).nullable().optional(),
  expires_in: z.number().finite().nonnegative().max(31_536_000).optional(),
  token_type: z.string().max(256).optional(),
  scope: z.string().max(16_384).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(4_096).optional()
});
type TokenResponse = z.infer<typeof tokenResponseSchema>;

async function parseTokenResponse(response: Response) {
  const text = await readOAuthResponseText(response);
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

async function graphRequest(
  accessToken: string,
  url: string,
  proxyUrl = "",
  signal?: AbortSignal,
  maxResponseBytes = GRAPH_COLLECTION_RESPONSE_MAX_BYTES
): Promise<unknown> {
  for (let attempt = 0; attempt < GRAPH_MAX_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const response = await proxiedFetch(
      url,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        },
        signal
      },
      proxyUrl
    );
    const payload = await parseResponse(response, maxResponseBytes);

    if (response.ok) {
      return payload;
    }

    const retryDelay = calculateGraphRetryDelay({
      status: response.status,
      retryAfter: response.headers.get("Retry-After"),
      retryIndex: attempt,
      nowMs: Date.now(),
      randomValue: Math.random()
    });
    if (retryDelay !== null && attempt + 1 < GRAPH_MAX_ATTEMPTS) {
      await waitForGraphRetry(retryDelay, signal);
      continue;
    }

    throw createGraphError(response.status, payload, retryDelay);
  }

  throw new Error("Graph 请求重试状态异常");
}

async function graphFetch(
  accessToken: string,
  path: string,
  proxyUrl = "",
  signal?: AbortSignal,
  maxResponseBytes = GRAPH_COLLECTION_RESPONSE_MAX_BYTES
): Promise<unknown> {
  return graphRequest(accessToken, `${GRAPH_ENDPOINT}${path}`, proxyUrl, signal, maxResponseBytes);
}

async function graphFetchUrl(accessToken: string, url: string, proxyUrl = "", signal?: AbortSignal): Promise<unknown> {
  return graphRequest(accessToken, trustedGraphUrl(url), proxyUrl, signal);
}

function mapAddress(input?: GraphEmailAddress | null): MailAddress | null {
  const address = input?.emailAddress?.address || "";
  const name = input?.emailAddress?.name || "";

  if (!address && !name) {
    return null;
  }

  return { name: normalizeMailText(name), address };
}

function mapAddressList(input?: GraphEmailAddress[] | null) {
  return (input || []).map(mapAddress).filter((item): item is MailAddress => item !== null);
}

function mapMessageSummary(message: GraphMessage): MailMessageSummary {
  return {
    id: message.id,
    subject: normalizeMailText(message.subject) || "(无主题)",
    from: mapAddress(message.from),
    receivedDateTime: normalizeMailDate(message.receivedDateTime),
    sentDateTime: normalizeMailDate(message.sentDateTime),
    isRead: Boolean(message.isRead),
    importance: message.importance || "normal",
    hasAttachments: Boolean(message.hasAttachments),
    bodyPreview: normalizeMailText(message.bodyPreview),
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
  return fetch(url, proxiedFetchOptions(init, proxyUrl));
}

export async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
  proxyUrl = "",
  signal?: AbortSignal
): Promise<AccessTokenResult> {
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
      body: form,
      signal
    }, proxyUrl);

    const rawPayload = await parseTokenResponse(response);
    const parsedPayload = tokenResponseSchema.safeParse(rawPayload);
    if (response.ok && (!parsedPayload.success || !parsedPayload.data.access_token)) {
      throw new Error("Token 响应格式无效");
    }
    const payload: TokenResponse = parsedPayload.success ? parsedPayload.data : {};

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

export async function listMailFolders(accessToken: string, proxyUrl = "", signal?: AbortSignal): Promise<MailFolder[]> {
  const payload = parseGraphResponse(
    graphFolderListSchema,
    await graphFetch(
      accessToken,
      "/me/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount",
      proxyUrl,
      signal
    ),
    "文件夹"
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
  proxyUrl = "",
  signal?: AbortSignal
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

  const payload = parseGraphResponse(
    graphMessageListSchema,
    await graphFetch(
      accessToken,
      `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${params.toString()}`,
      proxyUrl,
      signal
    ),
    "邮件列表"
  );

  return (payload.value || []).map(mapMessageSummary);
}

export async function deltaMessages(
  accessToken: string,
  folderId: string,
  top = 20,
  deltaLink: string | null = null,
  maxPages = 1,
  proxyUrl = "",
  signal?: AbortSignal
): Promise<GraphDeltaMessagesResult> {
  const messages: MailMessageSummary[] = [];
  let nextLink: string | null = deltaLink;
  let finalDeltaLink: string | null = null;
  const pageLimit = Math.min(Math.max(maxPages, 1), 10);

  for (let page = 0; page < pageLimit; page += 1) {
    const payload = parseGraphResponse(
      graphDeltaSchema,
      nextLink
        ? await graphFetchUrl(accessToken, nextLink, proxyUrl, signal)
        : await graphFetch(
            accessToken,
            `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$top=${Math.min(Math.max(top, 1), 100)}&$select=id,subject,from,receivedDateTime,sentDateTime,isRead,importance,hasAttachments,bodyPreview,webLink`,
            proxyUrl,
            signal
          ),
      "邮件增量"
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

export async function getMessage(
  accessToken: string,
  messageId: string,
  proxyUrl = "",
  signal?: AbortSignal
): Promise<MailMessageDetail> {
  const params = new URLSearchParams();
  params.set(
    "$select",
    "id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,importance,hasAttachments,bodyPreview,webLink,body"
  );

  const message = parseGraphResponse(
    graphMessageSchema,
    await graphFetch(
      accessToken,
      `/me/messages/${encodeURIComponent(messageId)}?${params}`,
      proxyUrl,
      signal,
      GRAPH_MESSAGE_DETAIL_RESPONSE_MAX_BYTES
    ),
    "邮件详情"
  );
  const summary = mapMessageSummary(message);
  const content = normalizeMailText(message.body?.content);

  return {
    ...summary,
    toRecipients: mapAddressList(message.toRecipients),
    ccRecipients: mapAddressList(message.ccRecipients),
    body: {
      contentType: normalizeMailContentType(message.body?.contentType),
      content
    }
  };
}

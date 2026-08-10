import { z } from "zod";
import { formatPublicProxyUrl, parseProxyUrl } from "./proxy-security.js";

export const IMPORT_TEXT_MAX_BYTES = 10 * 1024 * 1024;
export const ACCOUNT_BATCH_MAX = 5_000;
export const MAIL_PAGE_MAX = 100;
export const SEARCH_MAX_CHARS = 500;
export const CURSOR_MAX_CHARS = 128;

export const IPC_CHANNELS = {
  accountsList: "accounts:list",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  jobsCancel: "jobs:cancel",
  accountsPreviewImportText: "accounts:previewImportText",
  accountsImportText: "accounts:importText",
  accountsImportFile: "accounts:importFile",
  accountsUpsert: "accounts:upsert",
  accountsUpdate: "accounts:update",
  accountsDelete: "accounts:delete",
  accountsTest: "accounts:test",
  accountsTestFallback: "accounts:testFallback",
  accountsTestMany: "accounts:testMany",
  mailListFolders: "mail:listFolders",
  mailListMessages: "mail:listMessages",
  mailGetMessage: "mail:getMessage",
  mailClearCache: "mail:clearCache",
  mailRefreshMany: "mail:refreshMany"
} as const;

export const IPC_EVENT_CHANNELS = {
  accountsTestProgress: "accounts:testProgress",
  mailRefreshProgress: "mail:refreshProgress"
} as const;

export type IpcInvokeChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[keyof typeof IPC_EVENT_CHANNELS];

export type AccountStatus = "untested" | "valid" | "invalid";
export type AppErrorCode =
  | "CANCELED"
  | "TOKEN_EXPIRED"
  | "IMAP_AUTH_FAILED"
  | "SCOPE_MISSING"
  | "NETWORK_ERROR"
  | "MAIL_PARSE_FAILED"
  | "MAIL_TOO_LARGE"
  | "MAILBOX_NOT_FOUND"
  | "ACCOUNT_NOT_FOUND"
  | "UNKNOWN";

export interface AccountInput {
  email: string;
  clientId: string;
  refreshToken: string;
  remark?: string;
  group?: string;
}

export interface AccountUpdateInput {
  id: string;
  email: string;
  clientId: string;
  refreshToken?: string;
  remark?: string;
  group?: string;
}

export interface AccountView {
  id: string;
  email: string;
  clientId: string;
  remark: string;
  group: string;
  authMode?: "graph" | "imap";
  status: AccountStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  lastRefreshedAt?: string | null;
  lastInboxCount?: number;
  lastMailAt?: string | null;
  lastMailCursor?: string | null;
  inboxFolderId?: string | null;
  graphDeltaLink?: string | null;
  refreshCooldownUntil?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MailFolder {
  id: string;
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
}

export interface MailAddress {
  name: string;
  address: string;
}

export interface MailMessageSummary {
  id: string;
  subject: string;
  from: MailAddress | null;
  receivedDateTime: string | null;
  sentDateTime: string | null;
  isRead: boolean;
  importance: string;
  hasAttachments: boolean;
  bodyPreview: string;
  webLink: string | null;
}

export interface MailMessageDetail extends MailMessageSummary {
  toRecipients: MailAddress[];
  ccRecipients: MailAddress[];
  body: {
    contentType: string;
    content: string;
  };
}

export interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
  accounts: AccountView[];
}

export interface ImportPreviewResult {
  total: number;
  valid: number;
  duplicates: number;
  invalid: number;
  errors: string[];
  warnings: string[];
}

export interface TestConnectionResult {
  account: AccountView;
  ok: boolean;
  message: string;
  code?: AppErrorCode;
}

export interface TestFallbackResult {
  account: AccountView | null;
  ok: boolean;
  message: string;
  code?: AppErrorCode;
  transport?: string;
  count?: number;
  elapsedMs?: number;
}

export interface TestManyResult {
  accountId: string;
  account: AccountView | null;
  ok: boolean;
  message: string;
  code?: AppErrorCode;
}

export interface RefreshMetrics {
  tokenMs: number;
  mailMs: number;
  cacheMs: number;
  stateMs: number;
  totalMs: number;
  fallback?: string;
}

export interface RefreshManyResult {
  accountId: string;
  ok: boolean;
  count: number;
  newCount?: number;
  skipped?: boolean;
  canceled?: boolean;
  error?: string;
  code?: AppErrorCode;
  metrics?: RefreshMetrics;
}

export type RefreshJobKind = "refresh" | "refreshSingle" | "refreshBackground";
export type JobKind = "test" | RefreshJobKind;

export interface ListMessagesOptions {
  accountId: string;
  top?: number;
  skip?: number;
  search?: string;
  forceRefresh?: boolean;
  cursor?: string;
  since?: string | null;
}

export interface GetMessageOptions {
  accountId: string;
  messageId: string;
}

export interface MailListResult {
  messages: MailMessageSummary[];
  nextCursor: string | null;
  totalCount?: number;
}

export interface AppSettings {
  cacheMessages: boolean;
  cacheBodies: boolean;
  proxyUrl: string;
  proxyUsername: string;
  proxyHasPassword: boolean;
  proxySupported: boolean;
  batchConcurrency: number;
  hotmailFallbackEnabled: boolean;
  autoRefreshEnabled: boolean;
  autoRefreshIntervalMinutes: number;
}

const accountIdSchema = z.string().trim().min(1).max(128);
const messageIdSchema = z.string().trim().min(1).max(2_048);
const shortOptionalTextSchema = z.string().trim().max(1_000).optional();
const refreshJobKindSchema = z.enum(["refresh", "refreshSingle", "refreshBackground"]);
const jobKindSchema = z.enum(["test", "refresh", "refreshSingle", "refreshBackground"]);

const accountInputSchema = z.strictObject({
  email: z.email().trim().max(320),
  clientId: z.string().trim().min(1).max(256),
  refreshToken: z.string().trim().min(1).max(32_768),
  remark: shortOptionalTextSchema,
  group: z.string().trim().max(200).optional()
});

const accountUpdateInputSchema = z.strictObject({
  id: accountIdSchema,
  email: z.email().trim().max(320),
  clientId: z.string().trim().min(1).max(256),
  refreshToken: z.string().trim().max(32_768).optional(),
  remark: shortOptionalTextSchema,
  group: z.string().trim().max(200).optional()
});

const accountBatchSchema = z
  .array(accountIdSchema)
  .max(ACCOUNT_BATCH_MAX)
  .transform((accountIds) => [...new Set(accountIds)]);

const importTextSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, "utf8") <= IMPORT_TEXT_MAX_BYTES, {
    message: `text must not exceed ${IMPORT_TEXT_MAX_BYTES} bytes`
  });

function normalizeProxyUrl(value: string, context: z.RefinementCtx) {
  try {
    const parsed = parseProxyUrl(value);
    if (!parsed) {
      return "";
    }
    if (parsed.username || parsed.password) {
      context.addIssue({
        code: "custom",
        message: "credentials must use the separate proxy username and password fields"
      });
      return z.NEVER;
    }
    return formatPublicProxyUrl(parsed);
  } catch {
    context.addIssue({ code: "custom", message: "proxy URL must use HTTP or HTTPS without path, query, or fragment" });
    return z.NEVER;
  }
}

export const appSettingsUpdateSchema = z.strictObject({
  cacheMessages: z.boolean().optional(),
  cacheBodies: z.boolean().optional(),
  proxyUrl: z.string().trim().max(2_048).transform(normalizeProxyUrl).optional(),
  proxyUsername: z.string().trim().max(256).optional(),
  proxyPassword: z.string().max(2_048).optional(),
  clearProxyPassword: z.boolean().optional(),
  batchConcurrency: z.number().int().min(1).max(12).optional(),
  hotmailFallbackEnabled: z.boolean().optional(),
  autoRefreshEnabled: z.boolean().optional(),
  autoRefreshIntervalMinutes: z.number().int().min(1).max(120).optional()
});

export type AppSettingsUpdate = z.input<typeof appSettingsUpdateSchema>;

const noArgsSchema = z.tuple([]).transform(() => undefined);
const singleAccountIdSchema = z.tuple([accountIdSchema]).transform(([accountId]) => accountId);

export const IPC_REQUEST_SCHEMAS = {
  accountsList: noArgsSchema,
  getSettings: noArgsSchema,
  updateSettings: z.tuple([appSettingsUpdateSchema]).transform(([settings]) => settings),
  cancelJob: z.tuple([jobKindSchema]).transform(([job]) => job),
  importText: z.tuple([importTextSchema]).transform(([text]) => text),
  importFile: noArgsSchema,
  upsertAccount: z.tuple([accountInputSchema]).transform(([input]) => input),
  updateAccount: z.tuple([accountUpdateInputSchema]).transform(([input]) => input),
  deleteAccount: singleAccountIdSchema,
  testAccount: singleAccountIdSchema,
  testFallback: singleAccountIdSchema,
  testMany: z.tuple([accountBatchSchema]).transform(([accountIds]) => accountIds),
  listFolders: singleAccountIdSchema,
  listMessages: z
    .tuple([
      z.strictObject({
        accountId: accountIdSchema,
        top: z.number().int().min(1).max(MAIL_PAGE_MAX).optional(),
        skip: z.number().int().min(0).max(1_000_000).optional(),
        search: z.string().trim().max(SEARCH_MAX_CHARS).optional(),
        forceRefresh: z.boolean().optional(),
        cursor: z.string().trim().max(CURSOR_MAX_CHARS).optional(),
        since: z.string().trim().max(64).nullable().optional()
      })
    ])
    .transform(([options]) => options),
  getMessage: z
    .tuple([z.strictObject({ accountId: accountIdSchema, messageId: messageIdSchema })])
    .transform(([options]) => options),
  clearCache: z
    .union([z.tuple([]), z.tuple([accountIdSchema])])
    .transform((args) => args[0]),
  refreshMany: z
    .union([z.tuple([accountBatchSchema]), z.tuple([accountBatchSchema, refreshJobKindSchema])])
    .transform(([accountIds, jobKind]) => ({ accountIds, jobKind: jobKind ?? "refresh" }))
} as const;

export function parseIpcRequest<Output>(schema: z.ZodType<Output>, args: unknown[]): Output {
  const result = schema.safeParse(args);
  if (result.success) {
    return result.data;
  }

  const details = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "request"}: ${issue.message}`)
    .join("; ");
  throw new Error(`IPC request rejected: ${details}`);
}

export type AccountStatus = "untested" | "valid" | "invalid";
export type AppErrorCode =
  | "TOKEN_EXPIRED"
  | "IMAP_AUTH_FAILED"
  | "SCOPE_MISSING"
  | "NETWORK_ERROR"
  | "MAIL_PARSE_FAILED"
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
  skipped?: boolean;
  error?: string;
  code?: AppErrorCode;
  metrics?: RefreshMetrics;
}

export interface ListMessagesOptions {
  accountId: string;
  top?: number;
  skip?: number;
  search?: string;
  forceRefresh?: boolean;
  cursor?: string;
  since?: string | null;
}

export interface MailListResult {
  messages: MailMessageSummary[];
  nextCursor: string | null;
}

export interface AppSettings {
  cacheMessages: boolean;
  cacheBodies: boolean;
  proxyUrl: string;
  batchConcurrency: number;
  hotmailFallbackEnabled: boolean;
}

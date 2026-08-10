import type { AccountStatus } from "../shared/ipc-contracts.js";

export type {
  AccountInput,
  AccountStatus,
  AccountUpdateInput,
  AccountView,
  AppErrorPayload,
  AppErrorCode,
  AppSettings,
  AppSettingsUpdate,
  GetMessageOptions,
  ImportPreviewResult,
  ImportResult,
  JobKind,
  ListMessagesOptions,
  MailAddress,
  MailFolder,
  MailListResult,
  MailMessageDetail,
  MailMessageSummary,
  RefreshJobKind,
  RefreshManyResult,
  RefreshMetrics,
  RefreshProgressEvent,
  TestConnectionResult,
  TestFallbackResult,
  TestManyResult,
  TestProgressEvent
} from "../shared/ipc-contracts.js";

export interface AccountRecord {
  id: string;
  email: string;
  clientId: string;
  encryptedRefreshToken: string;
  remark: string;
  group: string;
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
  credentialGeneration: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccessTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string;
  authMode: "graph" | "imap";
}

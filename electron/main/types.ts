import type { AccountStatus } from "../shared/ipc-contracts.js";

export type {
  AccountInput,
  AccountStatus,
  AccountUpdateInput,
  AccountView,
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
  TestConnectionResult,
  TestFallbackResult,
  TestManyResult
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

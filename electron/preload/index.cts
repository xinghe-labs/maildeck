import { contextBridge, ipcRenderer } from "electron";
import type {
  AccountInput,
  AccountUpdateInput,
  AccountView,
  AppErrorPayload,
  AppSettings,
  AppSettingsUpdate,
  GetMessageOptions,
  IpcEventChannel,
  IpcInvokeChannel,
  IpcResult,
  ImportResult,
  ImportPreviewResult,
  JobKind,
  ListMessagesOptions,
  MailFolder,
  MailListResult,
  MailMessageDetail,
  RefreshManyResult,
  RefreshProgressEvent,
  RefreshJobKind,
  TestConnectionResult,
  TestFallbackResult,
  TestManyResult,
  TestProgressEvent
} from "../shared/ipc-contracts.js";

const APP_ERROR_CODES = new Set([
  "INVALID_REQUEST",
  "CANCELED",
  "STALE_CREDENTIALS",
  "TOKEN_EXPIRED",
  "IMAP_AUTH_FAILED",
  "SCOPE_MISSING",
  "NETWORK_ERROR",
  "MAIL_PARSE_FAILED",
  "MAIL_TOO_LARGE",
  "MAILBOX_NOT_FOUND",
  "ACCOUNT_NOT_FOUND",
  "UNKNOWN"
]);

function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AppErrorPayload>;
  const diagnosticIsValid = candidate.diagnostic === undefined || (
    candidate.diagnostic !== null &&
    typeof candidate.diagnostic === "object" &&
    (candidate.diagnostic.requestId === undefined || typeof candidate.diagnostic.requestId === "string")
  );
  return typeof candidate.code === "string" && APP_ERROR_CODES.has(candidate.code) &&
    typeof candidate.message === "string" && typeof candidate.retryable === "boolean" && diagnosticIsValid;
}

function transportError(): AppErrorPayload {
  return { code: "UNKNOWN", message: "主进程通信失败，请重试。", retryable: true };
}

async function invoke<Output>(channel: IpcInvokeChannel, ...args: unknown[]): Promise<Output> {
  try {
    const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<Output>;
    if (result?.ok === true) {
      return result.value;
    }
    if (result?.ok === false && isAppErrorPayload(result.error)) {
      throw result.error;
    }
    throw transportError();
  } catch (error) {
    if (isAppErrorPayload(error)) {
      throw error;
    }
    throw transportError();
  }
}

function onEvent<Payload>(channel: IpcEventChannel, callback: (payload: Payload) => void) {
  const listener = (_event: Electron.IpcRendererEvent, payload: Payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  accounts: {
    list: () => invoke<AccountView[]>("accounts:list"),
    previewImportText: (text: string) => invoke<ImportPreviewResult>("accounts:previewImportText", text),
    importText: (text: string) => invoke<ImportResult>("accounts:importText", text),
    importFile: () => invoke<ImportResult | null>("accounts:importFile"),
    upsert: (input: AccountInput) => invoke<ImportResult>("accounts:upsert", input),
    update: (input: AccountUpdateInput) => invoke<AccountView>("accounts:update", input),
    delete: (accountId: string) => invoke<AccountView[]>("accounts:delete", accountId),
    test: (accountId: string) => invoke<TestConnectionResult>("accounts:test", accountId),
    testFallback: (accountId: string) => invoke<TestFallbackResult>("accounts:testFallback", accountId),
    testMany: (accountIds: string[]) => invoke<TestManyResult[]>("accounts:testMany", accountIds),
    refreshMany: (accountIds: string[], jobKind?: RefreshJobKind) =>
      jobKind
        ? invoke<RefreshManyResult[]>("mail:refreshMany", accountIds, jobKind)
        : invoke<RefreshManyResult[]>("mail:refreshMany", accountIds),
    onRefreshProgress: (callback: (event: RefreshProgressEvent) => void) => {
      return onEvent("mail:refreshProgress", callback);
    },
    onTestProgress: (callback: (event: TestProgressEvent) => void) => {
      return onEvent("accounts:testProgress", callback);
    }
  },
  mail: {
    listFolders: (accountId: string) => invoke<MailFolder[]>("mail:listFolders", accountId),
    listMessages: (options: ListMessagesOptions) => invoke<MailListResult>("mail:listMessages", options),
    getMessage: (options: GetMessageOptions) => invoke<MailMessageDetail>("mail:getMessage", options),
    clearCache: (accountId?: string) =>
      accountId
        ? invoke<{ cleared: number | "all" }>("mail:clearCache", accountId)
        : invoke<{ cleared: number | "all" }>("mail:clearCache")
  },
  settings: {
    get: () => invoke<AppSettings>("settings:get"),
    update: (settings: AppSettingsUpdate) => invoke<AppSettings>("settings:update", settings)
  },
  jobs: {
    cancel: (job: JobKind) => invoke<{ canceled: JobKind; count: number }>("jobs:cancel", job)
  }
};

contextBridge.exposeInMainWorld("outlookManager", api);

export type OutlookManagerApi = typeof api;

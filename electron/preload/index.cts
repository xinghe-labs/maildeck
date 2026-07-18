import { contextBridge, ipcRenderer } from "electron";
import type {
  AccountInput,
  AccountUpdateInput,
  AccountView,
  AppSettings,
  AppSettingsUpdate,
  GetMessageOptions,
  IpcEventChannel,
  IpcInvokeChannel,
  ImportResult,
  ImportPreviewResult,
  JobKind,
  ListMessagesOptions,
  MailFolder,
  MailListResult,
  MailMessageDetail,
  RefreshManyResult,
  RefreshJobKind,
  TestConnectionResult,
  TestFallbackResult,
  TestManyResult
} from "../shared/ipc-contracts.js";

function invoke<Output>(channel: IpcInvokeChannel, ...args: unknown[]): Promise<Output> {
  return ipcRenderer.invoke(channel, ...args) as Promise<Output>;
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
    onRefreshProgress: (
      callback: (
        event: { completed: number; total: number; ok: number; failed: number; accountId: string; error?: string; metrics?: RefreshManyResult["metrics"] }
      ) => void
    ) => {
      return onEvent("mail:refreshProgress", callback);
    },
    onTestProgress: (
      callback: (event: { completed: number; total: number; ok: number; failed: number; accountId: string; error?: string }) => void
    ) => {
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

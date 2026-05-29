import { contextBridge, ipcRenderer } from "electron";
import type {
  AccountInput,
  AccountUpdateInput,
  AccountView,
  AppSettings,
  GetMessageOptions,
  ImportResult,
  ImportPreviewResult,
  ListMessagesOptions,
  MailFolder,
  MailListResult,
  MailMessageDetail,
  MailMessageSummary,
  RefreshManyResult,
  TestConnectionResult,
  TestFallbackResult,
  TestManyResult
} from "../main/types.js";

const api = {
  accounts: {
    list: () => ipcRenderer.invoke("accounts:list") as Promise<AccountView[]>,
    previewImportText: (text: string) => ipcRenderer.invoke("accounts:previewImportText", text) as Promise<ImportPreviewResult>,
    importText: (text: string) => ipcRenderer.invoke("accounts:importText", text) as Promise<ImportResult>,
    importFile: () => ipcRenderer.invoke("accounts:importFile") as Promise<ImportResult | null>,
    upsert: (input: AccountInput) => ipcRenderer.invoke("accounts:upsert", input) as Promise<ImportResult>,
    update: (input: AccountUpdateInput) => ipcRenderer.invoke("accounts:update", input) as Promise<AccountView>,
    delete: (accountId: string) => ipcRenderer.invoke("accounts:delete", accountId) as Promise<AccountView[]>,
    test: (accountId: string) => ipcRenderer.invoke("accounts:test", accountId) as Promise<TestConnectionResult>,
    testFallback: (accountId: string) => ipcRenderer.invoke("accounts:testFallback", accountId) as Promise<TestFallbackResult>,
    testMany: (accountIds: string[]) => ipcRenderer.invoke("accounts:testMany", accountIds) as Promise<TestManyResult[]>,
    refreshMany: (accountIds: string[]) =>
      ipcRenderer.invoke("mail:refreshMany", accountIds) as Promise<RefreshManyResult[]>,
    onRefreshProgress: (
      callback: (
        event: { completed: number; total: number; ok: number; failed: number; accountId: string; error?: string; metrics?: RefreshManyResult["metrics"] }
      ) => void
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { completed: number; total: number; ok: number; failed: number; accountId: string; error?: string; metrics?: RefreshManyResult["metrics"] }
      ) => callback(payload);
      ipcRenderer.on("mail:refreshProgress", listener);
      return () => {
        ipcRenderer.removeListener("mail:refreshProgress", listener);
      };
    },
    onTestProgress: (
      callback: (event: { completed: number; total: number; ok: number; failed: number; accountId: string; error?: string }) => void
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { completed: number; total: number; ok: number; failed: number; accountId: string; error?: string }
      ) => callback(payload);
      ipcRenderer.on("accounts:testProgress", listener);
      return () => {
        ipcRenderer.removeListener("accounts:testProgress", listener);
      };
    }
  },
  mail: {
    listFolders: (accountId: string) => ipcRenderer.invoke("mail:listFolders", accountId) as Promise<MailFolder[]>,
    listMessages: (options: ListMessagesOptions) =>
      ipcRenderer.invoke("mail:listMessages", options) as Promise<MailListResult>,
    getMessage: (options: GetMessageOptions) =>
      ipcRenderer.invoke("mail:getMessage", options) as Promise<MailMessageDetail>,
    clearCache: (accountId?: string) => ipcRenderer.invoke("mail:clearCache", accountId) as Promise<{ cleared: number | "all" }>
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
    update: (settings: Partial<AppSettings>) => ipcRenderer.invoke("settings:update", settings) as Promise<AppSettings>
  },
  jobs: {
    cancel: (job: "test" | "refresh") => ipcRenderer.invoke("jobs:cancel", job) as Promise<{ canceled: "test" | "refresh" }>
  }
};

contextBridge.exposeInMainWorld("outlookManager", api);

export type OutlookManagerApi = typeof api;

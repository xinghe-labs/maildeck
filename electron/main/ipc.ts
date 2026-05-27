import { dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  clearAccountCache,
  clearAllMailCache,
  getCachedCursor,
  getCachedMessageDetail,
  getCachedMessages,
  saveCachedMessageDetail,
  saveCachedMessages
} from "./mail-cache.js";
import {
  deleteAccount,
  getAccountRecord,
  getRefreshToken,
  listAccounts,
  previewAccounts,
  updateAccount,
  updateAccountRefreshState,
  updateAccountStatus,
  upsertAccounts
} from "./account-store.js";
import { getMessage, listMailFolders, listMessages, refreshAccessToken } from "./graph-client.js";
import { getImapMessage, listImapFolders, listImapMessages, listNewImapMessages } from "./imap-client.js";
import { parseAccountImport } from "./import-parser.js";
import { getSettings, updateSettings } from "./settings-store.js";
import { normalizeError } from "./error-utils.js";
import type {
  AccessTokenResult,
  AccountInput,
  AccountUpdateInput,
  AppErrorCode,
  GetMessageOptions,
  ListMessagesOptions,
  MailListResult,
  MailMessageSummary,
  TestManyResult
} from "./types.js";

const tokenCache = new Map<
  string,
  (AccessTokenResult & {
    email: string;
    expiresAt: number;
  })
>();
const tokenRefreshes = new Map<string, Promise<AccessTokenResult & { email: string; expiresAt: number }>>();
type JobKind = "test" | "refresh";

const activeJobs = new Map<JobKind, Set<string>>();
const canceledJobIds = new Set<string>();

async function refreshAndCacheAccessToken(accountId: string): Promise<AccessTokenResult & { email: string; expiresAt: number }> {
  const account = await getAccountRecord(accountId);
  const refreshToken = await getRefreshToken(accountId);
  const settings = await getSettings();
  const token = await refreshAccessToken(account.clientId, refreshToken, settings.proxyUrl);

  if (token.refreshToken) {
    await updateAccountStatus(accountId, "valid", null, token.refreshToken);
  }

  const result = {
    ...token,
    email: account.email,
    expiresAt: Date.now() + Math.max((token.expiresIn || 300) - 60, 60) * 1000
  };

  tokenCache.set(accountId, result);
  return result;
}

async function getAccessToken(accountId: string, forceRefresh = false): Promise<AccessTokenResult & { email: string }> {
  const cached = tokenCache.get(accountId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now() + 30_000) {
    return cached;
  }

  const pending = tokenRefreshes.get(accountId);
  if (pending) {
    return pending;
  }

  const refresh = refreshAndCacheAccessToken(accountId).finally(() => {
    tokenRefreshes.delete(accountId);
  });
  tokenRefreshes.set(accountId, refresh);
  return refresh;
}

function clearTokenCache(accountIds: string[]) {
  for (const accountId of accountIds) {
    tokenCache.delete(accountId);
    tokenRefreshes.delete(accountId);
  }
}

function latestMailTime(messages: Array<{ receivedDateTime: string | null; sentDateTime: string | null }>) {
  return (
    messages
      .map((message) => message.receivedDateTime || message.sentDateTime)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null
  );
}

function nextCursorFor(messages: MailMessageSummary[]) {
  if (messages.length === 0) {
    return null;
  }

  return (
    messages
      .map((message) => Number(message.id))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b)[0]?.toString() || null
  );
}

function maxCursorFor(messages: MailMessageSummary[]) {
  if (messages.length === 0) {
    return null;
  }

  return (
    messages
      .map((message) => Number(message.id))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => b - a)[0]?.toString() || null
  );
}

function startJob(kind: JobKind) {
  const jobId = randomUUID();
  const jobs = activeJobs.get(kind) || new Set<string>();
  jobs.add(jobId);
  activeJobs.set(kind, jobs);
  return jobId;
}

function finishJob(kind: JobKind, jobId: string) {
  const jobs = activeJobs.get(kind);
  jobs?.delete(jobId);
  canceledJobIds.delete(jobId);

  if (jobs && jobs.size === 0) {
    activeJobs.delete(kind);
  }
}

function cancelJobs(kind: JobKind) {
  const jobs = activeJobs.get(kind) || new Set<string>();
  for (const jobId of jobs) {
    canceledJobIds.add(jobId);
  }

  return jobs.size;
}

function shouldCancel(jobId: string) {
  return canceledJobIds.has(jobId);
}

function cancelError(job: JobKind) {
  return job === "test" ? "批量测试已取消" : "批量刷新已取消";
}

function normalizeErrorResult(error: unknown) {
  return normalizeError(error);
}

async function runLimited<T, R>(
  items: T[],
  limit: number,
  handler: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await handler(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function pickInboxFolder<T extends { id: string; displayName: string }>(folders: T[]) {
  const validFolders = folders.filter(
    (folder) => typeof folder.id === "string" && folder.id.trim() && typeof folder.displayName === "string" && folder.displayName.trim()
  );

  return (
    validFolders.find((folder) => ["inbox", "收件箱"].includes(folder.displayName.toLowerCase())) ||
    validFolders[0] ||
    null
  );
}

async function testAccountConnection(accountId: string, forceRefresh = true): Promise<TestManyResult> {
  try {
    const token = await getAccessToken(accountId, forceRefresh);
    const settings = await getSettings();

    if (token.authMode === "imap") {
      await listImapFolders(token.email, token.accessToken, settings.proxyUrl);
    } else {
      await listMailFolders(token.accessToken, settings.proxyUrl);
    }

    const account = await updateAccountStatus(accountId, "valid", null);
    return { accountId, account, ok: true, message: "连接成功" };
  } catch (error) {
    const { code, message } = normalizeErrorResult(error);
    const account = await updateAccountStatus(accountId, "invalid", message).catch(() => null);
    return { accountId, account, ok: false, message, code };
  }
}

export function registerIpcHandlers() {
  ipcMain.handle("accounts:list", async () => listAccounts());

  ipcMain.handle("settings:get", async () => getSettings());

  ipcMain.handle(
    "settings:update",
    async (_event, settings: { cacheMessages?: boolean; cacheBodies?: boolean; proxyUrl?: string; batchConcurrency?: number }) => {
    const next = await updateSettings(settings);
    if (settings.proxyUrl !== undefined) {
      clearTokenCache(Array.from(tokenCache.keys()));
    }
    return next;
    }
  );

  ipcMain.handle("jobs:cancel", async (_event, job: JobKind) => {
    return { canceled: job, count: cancelJobs(job) };
  });

  ipcMain.handle("accounts:previewImportText", async (_event, text: string) => {
    const inputs = parseAccountImport(text);
    return previewAccounts(inputs);
  });

  ipcMain.handle("accounts:importText", async (_event, text: string) => {
    const inputs = parseAccountImport(text);
    const result = await upsertAccounts(inputs);
    clearTokenCache(result.accounts.map((account) => account.id));
    return result;
  });

  ipcMain.handle("accounts:importFile", async () => {
    const result = await dialog.showOpenDialog({
      title: "导入邮箱账号",
      filters: [
        { name: "Account files", extensions: ["csv", "txt"] },
        { name: "All files", extensions: ["*"] }
      ],
      properties: ["openFile"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const text = await readFile(result.filePaths[0], "utf8");
    const inputs = parseAccountImport(text);
    const importResult = await upsertAccounts(inputs);
    clearTokenCache(importResult.accounts.map((account) => account.id));
    return importResult;
  });

  ipcMain.handle("accounts:upsert", async (_event, input: AccountInput) => {
    const result = await upsertAccounts([input]);
    clearTokenCache(result.accounts.map((account) => account.id));
    return result;
  });

  ipcMain.handle("accounts:update", async (_event, input: AccountUpdateInput) => {
    const account = await updateAccount(input);
    clearTokenCache([account.id]);
    await clearAccountCache(account.id);
    return account;
  });

  ipcMain.handle("accounts:delete", async (_event, accountId: string) => {
    const accounts = await deleteAccount(accountId);
    clearTokenCache([accountId]);
    return accounts;
  });

  ipcMain.handle("accounts:test", async (_event, accountId: string) => {
    const result = await testAccountConnection(accountId, true);
    return {
      account: result.account,
      ok: result.ok,
      message: result.message,
      code: result.code
    };
  });

  ipcMain.handle("accounts:testMany", async (event, accountIds: string[]) => {
    const jobId = startJob("test");
    const settings = await getSettings();
    let completed = 0;
    let ok = 0;
    let failed = 0;
    const total = accountIds.length;

    try {
      return await runLimited(accountIds, settings.batchConcurrency, async (accountId) => {
        if (shouldCancel(jobId)) {
          completed += 1;
          failed += 1;
          const message = cancelError("test");
          event.sender.send("accounts:testProgress", { completed, total, ok, failed, accountId, error: message });
          return { accountId, account: null, ok: false, message, code: "UNKNOWN" as AppErrorCode };
        }

        const result = await testAccountConnection(accountId, true);
        completed += 1;

        if (result.ok) {
          ok += 1;
          event.sender.send("accounts:testProgress", { completed, total, ok, failed, accountId });
        } else {
          failed += 1;
          event.sender.send("accounts:testProgress", { completed, total, ok, failed, accountId, error: result.message });
        }

        return result;
      });
    } finally {
      finishJob("test", jobId);
    }
  });

  ipcMain.handle("mail:listFolders", async (_event, accountId: string) => {
    const token = await getAccessToken(accountId);
    const settings = await getSettings();

    if (token.authMode === "imap") {
      return listImapFolders(token.email, token.accessToken, settings.proxyUrl);
    }

    return listMailFolders(token.accessToken, settings.proxyUrl);
  });

  ipcMain.handle("mail:listMessages", async (_event, options: ListMessagesOptions) => {
    const search = options.search?.trim() || "";
    const top = options.top || 50;
    const settings = await getSettings();

    if (!options.forceRefresh && !options.cursor) {
      const cached = await getCachedMessages(options.accountId, search, top, settings.cacheMessages);
      if (cached.length > 0) {
        return {
          messages: cached,
          nextCursor: await getCachedCursor(options.accountId)
        } satisfies MailListResult;
      }
    }

    const token = await getAccessToken(options.accountId);

    if (token.authMode === "imap") {
      const folders = await listImapFolders(token.email, token.accessToken, settings.proxyUrl);
      const inbox = pickInboxFolder(folders);

      if (!inbox) {
        return { messages: [], nextCursor: null } satisfies MailListResult;
      }

      const result = await listImapMessages(
        token.email,
        token.accessToken,
        inbox.id,
        top,
        search,
        options.cursor || "",
        settings.proxyUrl
      );
      const messages = result.messages;
      const nextCursor = nextCursorFor(messages);
      if (!search) {
        await saveCachedMessages(options.accountId, messages, settings.cacheMessages, nextCursor);
        await updateAccountRefreshState(options.accountId, {
          status: "valid",
          lastError: null,
          lastInboxCount: result.totalCount,
          lastMailAt: latestMailTime(messages),
          lastMailCursor: maxCursorFor(messages)
        });
      }
      return { messages, nextCursor } satisfies MailListResult;
    }

    const folders = await listMailFolders(token.accessToken, settings.proxyUrl);
    const inbox = pickInboxFolder(folders);

    if (!inbox) {
      return { messages: [], nextCursor: null } satisfies MailListResult;
    }

    const skip = options.cursor ? Number(options.cursor) || 0 : options.skip || 0;
    const messages = await listMessages(token.accessToken, inbox.id, top, skip, search, options.since || null, settings.proxyUrl);
    const nextCursor = messages.length >= top ? String(skip + messages.length) : null;
    if (!search) {
      await saveCachedMessages(options.accountId, messages, settings.cacheMessages, nextCursor);
      await updateAccountRefreshState(options.accountId, {
        status: "valid",
        lastError: null,
        lastInboxCount: inbox.totalItemCount || messages.length,
        lastMailAt: latestMailTime(messages),
        lastMailCursor: null
      });
    }
    return { messages, nextCursor } satisfies MailListResult;
  });

  ipcMain.handle("mail:getMessage", async (_event, options: GetMessageOptions) => {
    const settings = await getSettings();
    const cached = await getCachedMessageDetail(options.accountId, options.messageId, settings.cacheBodies);
    if (cached) {
      return cached;
    }

    const token = await getAccessToken(options.accountId);

    if (token.authMode === "imap") {
      const folders = await listImapFolders(token.email, token.accessToken, settings.proxyUrl);
      const inbox = pickInboxFolder(folders);

      if (!inbox) {
        throw new Error("未找到收件箱");
      }

      const detail = await getImapMessage(token.email, token.accessToken, inbox.id, options.messageId, settings.proxyUrl);
      await saveCachedMessageDetail(options.accountId, detail, settings.cacheBodies);
      return detail;
    }

    const detail = await getMessage(token.accessToken, options.messageId, settings.proxyUrl);
    await saveCachedMessageDetail(options.accountId, detail, settings.cacheBodies);
    return detail;
  });

  ipcMain.handle("mail:clearCache", async (_event, accountId?: string) => {
    if (accountId) {
      await clearAccountCache(accountId);
      return { cleared: 1 };
    }

    await clearAllMailCache();
    return { cleared: "all" };
  });

  ipcMain.handle("mail:refreshMany", async (event, accountIds: string[]) => {
    const jobId = startJob("refresh");
    const appSettings = await getSettings();
    let completed = 0;
    let ok = 0;
    let failed = 0;
    const total = accountIds.length;

    try {
      return await runLimited(accountIds, appSettings.batchConcurrency, async (accountId) => {
        let account: Awaited<ReturnType<typeof getAccountRecord>> | null = null;

        try {
          if (shouldCancel(jobId)) {
            throw new Error(cancelError("refresh"));
          }

        account = await getAccountRecord(accountId);
        const token = await getAccessToken(accountId);
        const settings = await getSettings();

        if (token.authMode === "imap") {
          const folders = await listImapFolders(token.email, token.accessToken, settings.proxyUrl);
          const inbox = pickInboxFolder(folders);

          if (!inbox) {
            await updateAccountRefreshState(accountId, {
              status: "invalid",
              lastError: "未找到收件箱",
              lastInboxCount: account.lastInboxCount || 0,
              lastMailAt: account.lastMailAt || null,
              lastMailCursor: null
            });
            failed += 1;
            completed += 1;
            event.sender.send("mail:refreshProgress", { completed, total, ok, failed, accountId, error: "未找到收件箱", code: "MAILBOX_NOT_FOUND" });
            return { accountId, ok: false, count: 0, error: "未找到收件箱", code: "MAILBOX_NOT_FOUND" as AppErrorCode };
          }

          const result = account.lastMailCursor
            ? await listNewImapMessages(token.email, token.accessToken, inbox.id, 20, account.lastMailCursor, settings.proxyUrl)
            : await listImapMessages(token.email, token.accessToken, inbox.id, 20, "", "", settings.proxyUrl);
          const messages = result.messages;
          const cursor = maxCursorFor(messages) || account.lastMailCursor || null;
          await saveCachedMessages(accountId, messages, settings.cacheMessages, nextCursorFor(messages));
          await updateAccountRefreshState(accountId, {
            status: "valid",
            lastError: null,
            lastInboxCount: result.totalCount,
            lastMailAt: latestMailTime(messages) || account.lastMailAt || null,
            lastMailCursor: cursor
          });
          ok += 1;
          completed += 1;
          event.sender.send("mail:refreshProgress", { completed, total, ok, failed, accountId });
          return { accountId, ok: true, count: messages.length };
        }

        const folders = await listMailFolders(token.accessToken, settings.proxyUrl);
        const inbox = pickInboxFolder(folders);

        if (!inbox) {
          await updateAccountRefreshState(accountId, {
            status: "invalid",
            lastError: "未找到收件箱",
            lastInboxCount: account.lastInboxCount || 0,
            lastMailAt: account.lastMailAt || null,
            lastMailCursor: null
          });
          failed += 1;
          completed += 1;
          event.sender.send("mail:refreshProgress", { completed, total, ok, failed, accountId, error: "未找到收件箱", code: "MAILBOX_NOT_FOUND" });
          return { accountId, ok: false, count: 0, error: "未找到收件箱", code: "MAILBOX_NOT_FOUND" as AppErrorCode };
        }

        const messages = await listMessages(token.accessToken, inbox.id, 20, 0, "", account.lastMailAt || null, settings.proxyUrl);
        await saveCachedMessages(accountId, messages, settings.cacheMessages, null);
        await updateAccountRefreshState(accountId, {
          status: "valid",
          lastError: null,
          lastInboxCount: inbox.totalItemCount || account.lastInboxCount || messages.length,
          lastMailAt: latestMailTime(messages) || account.lastMailAt || null,
          lastMailCursor: null
        });
        ok += 1;
        completed += 1;
        event.sender.send("mail:refreshProgress", { completed, total, ok, failed, accountId });
        return { accountId, ok: true, count: messages.length };
        } catch (error) {
          const { code, message } = normalizeErrorResult(error);
          await updateAccountRefreshState(accountId, {
            status: "invalid",
            lastError: message,
            lastInboxCount: account?.lastInboxCount || 0,
            lastMailAt: account?.lastMailAt || null,
            lastMailCursor: null
          }).catch(() => undefined);
          failed += 1;
          completed += 1;
          event.sender.send("mail:refreshProgress", { completed, total, ok, failed, accountId, error: message, code });
          return { accountId, ok: false, count: 0, error: message, code };
        }
      });
    } finally {
      finishJob("refresh", jobId);
    }
  });
}

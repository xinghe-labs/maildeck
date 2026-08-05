import { dialog } from "electron";
import { readFile } from "node:fs/promises";
import { IPC_CHANNELS, IPC_EVENT_CHANNELS, IPC_REQUEST_SCHEMAS, parseIpcRequest } from "../shared/ipc-contracts.js";
import {
  clearAccountCache,
  clearAllMailCache,
  getCachedCursor,
  getCachedMessageDetail,
  getCachedMessages,
  saveCachedMessageDetail,
  saveCachedMessages
} from "./mail-cache.js";
import { closeProxyDispatchers } from "./proxy-agent.js";
import {
  assertAccountCredentialGeneration,
  deleteAccount,
  findAccountIdsByEmails,
  getAccountCredentials,
  getAccountRecord,
  listAccounts,
  previewAccounts,
  updateAccount,
  updateAccountRefreshFailure,
  updateAccountRefreshState,
  updateAccountStatus,
  upsertAccounts
} from "./account-store.js";
import { deltaMessages, getMessage, listMailFolders, listMessages, refreshAccessToken } from "./graph-client.js";
import { getImapMessage, listImapFolders, listImapMessages, refreshImapInbox } from "./imap-client.js";
import { fetchHotmailFallbackMessages, isHotmailFallbackEnabled, testHotmailFallbackConnection } from "./hotmail-fallback-client.js";
import { parseAccountImport } from "./import-parser.js";
import { countNewMessagesAfterRefresh, shouldCommitMailboxRefreshState } from "./mail-refresh-state.js";
import { getPublicSettings, getSettings, updateSettings } from "./settings-store.js";
import { normalizeError } from "./error-utils.js";
import { resolveRefreshFailureStatus } from "./account-refresh-state.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";
import { AccessTokenManager } from "./access-token-manager.js";
import { credentialGenerations } from "./credential-generations.js";
import { handleValidated } from "./validated-ipc.js";
import type {
  AppErrorCode,
  JobKind,
  MailListResult,
  MailMessageSummary,
  RefreshMetrics,
  TestFallbackResult,
  TestManyResult
} from "./types.js";

const refreshCoordinator = new RefreshCoordinator();
const ACCOUNT_MUTATION_LOCK = Symbol("account-mutation");
const accessTokenManager = new AccessTokenManager({
  generations: credentialGenerations,
  loadCredentials: getAccountCredentials,
  loadProxyUrl: async () => (await getSettings()).proxyUrl,
  requestAccessToken: refreshAccessToken,
  assertCredentialGeneration: assertAccountCredentialGeneration,
  commitRefreshToken: async (accountId, expectedCredentialGeneration, refreshToken, assertCurrent) => {
    await updateAccountStatus(accountId, "valid", null, refreshToken, {
      expectedCredentialGeneration,
      assertCurrent
    });
  }
});

function getAccessToken(accountId: string, forceRefresh = false) {
  return accessTokenManager.getAccessToken(accountId, forceRefresh);
}

function latestMailTime(messages: Array<{ receivedDateTime: string | null; sentDateTime: string | null }>) {
  return (
    messages
      .map((message) => message.receivedDateTime || message.sentDateTime)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null
  );
}

function nextCursorFor(messages: MailMessageSummary[], totalCount = 0) {
  if (messages.length === 0) {
    return null;
  }
  if (totalCount > 0 && messages.length >= totalCount) {
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

function cancelError(job: JobKind) {
  return job === "test" ? "批量测试已取消" : "刷新已取消";
}

function normalizeErrorResult(error: unknown) {
  return normalizeError(error);
}

function nowMs() {
  return performance.now();
}

function elapsedSince(start: number) {
  return Math.round(performance.now() - start);
}

function resolveBatchLimit(requestedLimit: number, total: number) {
  if (total <= 0) {
    return 1;
  }

  const requested = Number.isFinite(requestedLimit) ? Math.max(1, Math.round(requestedLimit)) : 4;
  const volumeCap = total >= 80 ? 6 : total >= 30 ? 8 : 12;
  return Math.min(requested, volumeCap, total);
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

  const workerCount = Math.min(Math.max(1, Math.round(limit)), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
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

function isCooldownActive(value?: string | null) {
  return Boolean(value && new Date(value).getTime() > Date.now());
}

function isCooldownError(code: AppErrorCode) {
  return ["TOKEN_EXPIRED", "IMAP_AUTH_FAILED", "SCOPE_MISSING", "MAILBOX_NOT_FOUND"].includes(code);
}

function cooldownUntilFor(code: AppErrorCode) {
  if (!isCooldownError(code)) {
    return null;
  }

  return new Date(Date.now() + 30 * 60 * 1000).toISOString();
}

async function cacheHotmailFallbackResult(
  accountId: string,
  result: Awaited<ReturnType<typeof fetchHotmailFallbackMessages>>,
  settings: Awaited<ReturnType<typeof getSettings>>,
  nextCursor: string | null = null
) {
  await saveCachedMessages(accountId, result.messages, settings.cacheMessages, nextCursor, { readBack: false });

  await Promise.all(result.details.map((detail) => saveCachedMessageDetail(accountId, detail, true)));
}

async function loadCredentialContext(accountId: string) {
  const snapshot = credentialGenerations.capture(accountId);
  const [credentials, settings] = await Promise.all([getAccountCredentials(accountId), getSettings()]);
  credentialGenerations.assertCurrent(snapshot);
  return { snapshot, credentials, settings };
}

async function fetchHotmailFallback(
  accountId: string,
  top: number,
  cause: unknown
) {
  const context = await loadCredentialContext(accountId);
  const { credentials, settings, snapshot } = context;
  if (!isHotmailFallbackEnabled(settings)) {
    throw cause;
  }

  const result = await fetchHotmailFallbackMessages(settings, credentials.account, credentials.refreshToken, top);
  credentialGenerations.assertCurrent(snapshot);
  await assertAccountCredentialGeneration(accountId, credentials.credentialGeneration);

  if (result.nextRefreshToken) {
    await updateAccountStatus(accountId, "valid", null, result.nextRefreshToken, {
      expectedCredentialGeneration: credentials.credentialGeneration,
      assertCurrent: () => credentialGenerations.assertCurrent(snapshot),
      afterCommit: () => credentialGenerations.invalidateAccounts([accountId])
    });
  } else {
    credentialGenerations.assertCurrent(snapshot);
  }

  return result;
}

function refreshStateFromFallback(
  account: Awaited<ReturnType<typeof getAccountRecord>>,
  fallback: Awaited<ReturnType<typeof fetchHotmailFallback>>
): Parameters<typeof updateAccountRefreshState>[1] {
  return {
    status: "valid",
    lastError: null,
    lastInboxCount: fallback.totalCount,
    lastMailAt: latestMailTime(fallback.messages) || account.lastMailAt || null,
    lastMailCursor: fallback.cursor || null,
    inboxFolderId: fallback.inboxFolderId || account.inboxFolderId || "INBOX",
    graphDeltaLink: null,
    refreshCooldownUntil: null
  };
}

function fallbackListResult(fallback: Awaited<ReturnType<typeof fetchHotmailFallback>>): MailListResult {
  return { messages: fallback.messages, nextCursor: null, totalCount: fallback.totalCount };
}

async function persistHotmailFallback(
  accountId: string,
  account: Awaited<ReturnType<typeof getAccountRecord>>,
  settings: Awaited<ReturnType<typeof getSettings>>,
  fallback: Awaited<ReturnType<typeof fetchHotmailFallback>>
) {
  await cacheHotmailFallbackResult(accountId, fallback, settings, null);
  await updateAccountRefreshState(accountId, refreshStateFromFallback(account, fallback));
}

async function finishWithHotmailFallback(
  accountId: string,
  account: Awaited<ReturnType<typeof getAccountRecord>>,
  settings: Awaited<ReturnType<typeof getSettings>>,
  metrics: RefreshMetrics,
  totalStart: number,
  cause: unknown
) {
  const mailStart = nowMs();
  const fallback = await fetchHotmailFallback(accountId, 20, cause);
  metrics.mailMs += elapsedSince(mailStart);
  metrics.fallback = fallback.transport;

  const cacheStart = nowMs();
  await cacheHotmailFallbackResult(accountId, fallback, settings, null);
  metrics.cacheMs += elapsedSince(cacheStart);

  const stateStart = nowMs();
  await updateAccountRefreshState(accountId, refreshStateFromFallback(account, fallback));
  metrics.stateMs += elapsedSince(stateStart);
  metrics.totalMs = elapsedSince(totalStart);

  return fallback;
}

async function discoverGraphInbox(accessToken: string, proxyUrl: string) {
  const folders = await listMailFolders(accessToken, proxyUrl);
  return pickInboxFolder(folders);
}

async function listGraphInboxMessages(
  accessToken: string,
  account: Awaited<ReturnType<typeof getAccountRecord>>,
  top: number,
  since: string | null,
  proxyUrl: string
) {
  if (account.inboxFolderId) {
    try {
      return {
        inbox: {
          id: account.inboxFolderId,
          displayName: "Inbox",
          totalItemCount: account.lastInboxCount || 0,
          unreadItemCount: 0
        },
        messages: await listMessages(accessToken, account.inboxFolderId, top, 0, "", since, proxyUrl)
      };
    } catch {
      // Folder ids may become stale; discover once and retry below.
    }
  }

  const inbox = await discoverGraphInbox(accessToken, proxyUrl);
  if (!inbox) {
    return { inbox: null, messages: [] };
  }

  return {
    inbox,
    messages: await listMessages(accessToken, inbox.id, top, 0, "", since, proxyUrl)
  };
}

async function deltaGraphInboxMessages(
  accessToken: string,
  account: Awaited<ReturnType<typeof getAccountRecord>>,
  top: number,
  proxyUrl: string
) {
  const inbox = account.inboxFolderId
    ? {
        id: account.inboxFolderId,
        displayName: "Inbox",
        totalItemCount: account.lastInboxCount || 0,
        unreadItemCount: 0
      }
    : await discoverGraphInbox(accessToken, proxyUrl);

  if (!inbox) {
    return { inbox: null, messages: [], deltaLink: account.graphDeltaLink || null };
  }

  try {
    const result = await deltaMessages(accessToken, inbox.id, top, account.graphDeltaLink || null, 3, proxyUrl);
    return {
      inbox,
      messages: result.messages,
      deltaLink: result.deltaLink || result.nextLink || account.graphDeltaLink || null
    };
  } catch {
    const fallback = await listGraphInboxMessages(accessToken, { ...account, inboxFolderId: inbox.id, graphDeltaLink: null }, top, account.lastMailAt || null, proxyUrl);
    return {
      inbox: fallback.inbox,
      messages: fallback.messages,
      deltaLink: null
    };
  }
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

async function testHotmailFallback(accountId: string): Promise<TestFallbackResult> {
  const started = Date.now();
  let account: Awaited<ReturnType<typeof getAccountRecord>> | null = null;

  try {
    const context = await loadCredentialContext(accountId);
    account = context.credentials.account;
    const result = await testHotmailFallbackConnection(
      context.settings,
      account,
      context.credentials.refreshToken,
      5
    );
    credentialGenerations.assertCurrent(context.snapshot);
    const accountView = await updateAccountStatus(
      accountId,
      "valid",
      null,
      result.nextRefreshToken || undefined,
      {
        expectedCredentialGeneration: context.credentials.credentialGeneration,
        assertCurrent: () => credentialGenerations.assertCurrent(context.snapshot),
        ...(result.nextRefreshToken
          ? { afterCommit: () => credentialGenerations.invalidateAccounts([accountId]) }
          : {})
      }
    );
    if (!result.nextRefreshToken) {
      credentialGenerations.assertCurrent(context.snapshot);
    }

    const elapsedMs = Date.now() - started;
    const count = result.totalCount || result.messages.length;

    return {
      account: accountView,
      ok: true,
      message: `兜底可用 · ${result.transport} · 收件箱 ${count} 封 · ${elapsedMs}ms`,
      transport: result.transport,
      count,
      elapsedMs
    };
  } catch (error) {
    const { code, message } = normalizeErrorResult(error);
    return {
      account: null,
      ok: false,
      message,
      code,
      elapsedMs: Date.now() - started
    };
  }
}

function runAccountMutation<T>(
  resolveAccountIds: () => Iterable<string> | Promise<Iterable<string>>,
  operation: () => Promise<T>
): Promise<T> {
  return refreshCoordinator.runAccount(ACCOUNT_MUTATION_LOCK, async () => {
    const accountIds = await resolveAccountIds();
    return refreshCoordinator.runAccounts(accountIds, operation);
  });
}

async function upsertAccountsCoordinated(inputs: Parameters<typeof upsertAccounts>[0]) {
  return runAccountMutation(
    () => findAccountIdsByEmails(inputs.map((input) => input.email)),
    async () => {
      const { affectedAccountIds: _affectedAccountIds, ...result } = await upsertAccounts(inputs);
      return result;
    }
  );
}

export function registerIpcHandlers() {
  handleValidated(IPC_CHANNELS.accountsList, IPC_REQUEST_SCHEMAS.accountsList, async () => listAccounts());

  handleValidated(IPC_CHANNELS.settingsGet, IPC_REQUEST_SCHEMAS.getSettings, async () => getPublicSettings());

  handleValidated(
    IPC_CHANNELS.settingsUpdate,
    IPC_REQUEST_SCHEMAS.updateSettings,
    async (_event, settings) => {
      const next = await updateSettings(settings);
      if (next.proxyChanged) {
        closeProxyDispatchers();
      }
      return next.settings;
    }
  );

  handleValidated(IPC_CHANNELS.jobsCancel, IPC_REQUEST_SCHEMAS.cancelJob, async (_event, job) => {
    return { canceled: job, count: refreshCoordinator.cancel(job) };
  });

  handleValidated(IPC_CHANNELS.accountsPreviewImportText, IPC_REQUEST_SCHEMAS.importText, async (_event, text) => {
    const inputs = parseAccountImport(text);
    return previewAccounts(inputs);
  });

  handleValidated(IPC_CHANNELS.accountsImportText, IPC_REQUEST_SCHEMAS.importText, async (_event, text) => {
    const inputs = parseAccountImport(text);
    return upsertAccountsCoordinated(inputs);
  });

  handleValidated(IPC_CHANNELS.accountsImportFile, IPC_REQUEST_SCHEMAS.importFile, async () => {
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

    const text = parseIpcRequest(IPC_REQUEST_SCHEMAS.importText, [await readFile(result.filePaths[0], "utf8")]);
    const inputs = parseAccountImport(text);
    return upsertAccountsCoordinated(inputs);
  });

  handleValidated(IPC_CHANNELS.accountsUpsert, IPC_REQUEST_SCHEMAS.upsertAccount, async (_event, input) => {
    return upsertAccountsCoordinated([input]);
  });

  handleValidated(IPC_CHANNELS.accountsUpdate, IPC_REQUEST_SCHEMAS.updateAccount, async (_event, input) => {
    return runAccountMutation(() => [input.id], async () => {
      const account = await updateAccount(input);
      await clearAccountCache(account.id);
      return account;
    });
  });

  handleValidated(IPC_CHANNELS.accountsDelete, IPC_REQUEST_SCHEMAS.deleteAccount, async (_event, accountId) => {
    return runAccountMutation(() => [accountId], async () => {
      const accounts = await deleteAccount(accountId);
      return accounts;
    });
  });

  handleValidated(IPC_CHANNELS.accountsTest, IPC_REQUEST_SCHEMAS.testAccount, async (_event, accountId) => {
    const result = await refreshCoordinator.runAccount(accountId, () => testAccountConnection(accountId, true));
    return {
      account: result.account,
      ok: result.ok,
      message: result.message,
      code: result.code
    };
  });

  handleValidated(IPC_CHANNELS.accountsTestFallback, IPC_REQUEST_SCHEMAS.testFallback, async (_event, accountId) =>
    refreshCoordinator.runAccount(accountId, () => testHotmailFallback(accountId))
  );

  handleValidated(IPC_CHANNELS.accountsTestMany, IPC_REQUEST_SCHEMAS.testMany, async (event, accountIds) => {
    return refreshCoordinator.runJob("test", async (job) => {
      const settings = await getSettings();
      let completed = 0;
      let ok = 0;
      let failed = 0;
      const total = accountIds.length;

      return runLimited(accountIds, resolveBatchLimit(settings.batchConcurrency, total), (accountId) =>
        job.runAccount(
          accountId,
          async () => {
            const result = await testAccountConnection(accountId, true);
            completed += 1;

            if (result.ok) {
              ok += 1;
              event.sender.send(IPC_EVENT_CHANNELS.accountsTestProgress, { completed, total, ok, failed, accountId });
            } else {
              failed += 1;
              event.sender.send(IPC_EVENT_CHANNELS.accountsTestProgress, { completed, total, ok, failed, accountId, error: result.message });
            }

            return result;
          },
          () => {
            completed += 1;
            failed += 1;
            const message = cancelError("test");
            event.sender.send(IPC_EVENT_CHANNELS.accountsTestProgress, { completed, total, ok, failed, accountId, error: message });
            return { accountId, account: null, ok: false, message, code: "CANCELED" as AppErrorCode };
          }
        )
      );
    });
  });

  handleValidated(IPC_CHANNELS.mailListFolders, IPC_REQUEST_SCHEMAS.listFolders, async (_event, accountId) => {
    const token = await getAccessToken(accountId);
    const settings = await getSettings();

    if (token.authMode === "imap") {
      return listImapFolders(token.email, token.accessToken, settings.proxyUrl);
    }

    return listMailFolders(token.accessToken, settings.proxyUrl);
  });

  handleValidated(IPC_CHANNELS.mailListMessages, IPC_REQUEST_SCHEMAS.listMessages, (_event, options) =>
    refreshCoordinator.runAccount(options.accountId, async () => {
    try {
    const search = options.search?.trim() || "";
    const top = options.top || 50;
    const settings = await getSettings();
    const account = await getAccountRecord(options.accountId);

    if (!options.forceRefresh && !options.cursor) {
      const cached = await getCachedMessages(options.accountId, search, top, settings.cacheMessages);
      if (cached.length > 0) {
        const totalCount = account.lastInboxCount || cached.length;
        const cachedCursor = cached.length < totalCount ? await getCachedCursor(options.accountId) : null;
        return {
          messages: cached,
          nextCursor: cachedCursor,
          totalCount
        } satisfies MailListResult;
      }
    }

    const token = await getAccessToken(options.accountId).catch(async (error) => {
      if (search || options.cursor) {
        throw error;
      }

      const fallback = await fetchHotmailFallback(options.accountId, top, error);
      await persistHotmailFallback(options.accountId, account, settings, fallback);

      return { fallback };
    });

    if ("fallback" in token) {
      return fallbackListResult(token.fallback);
    }

    if (token.authMode === "imap") {
      try {
        const folders = await listImapFolders(token.email, token.accessToken, settings.proxyUrl);
        const inbox = pickInboxFolder(folders);

        if (!inbox) {
          return { messages: [], nextCursor: null, totalCount: 0 } satisfies MailListResult;
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
        const nextCursor = nextCursorFor(messages, result.totalCount);
        if (shouldCommitMailboxRefreshState({ search, cursor: options.cursor })) {
          await saveCachedMessages(options.accountId, messages, settings.cacheMessages, nextCursor);
          await updateAccountRefreshState(options.accountId, {
            status: "valid",
            lastError: null,
            lastInboxCount: result.totalCount,
            lastMailAt: latestMailTime(messages),
            lastMailCursor: maxCursorFor(messages),
            inboxFolderId: inbox.id,
            graphDeltaLink: null,
            refreshCooldownUntil: null
          });
        }
        return { messages, nextCursor, totalCount: result.totalCount } satisfies MailListResult;
      } catch (error) {
        if (search || options.cursor) {
          throw error;
        }

        const fallback = await fetchHotmailFallback(options.accountId, top, error);
        await persistHotmailFallback(options.accountId, account, settings, fallback);
        return fallbackListResult(fallback);
      }
    }

    let inbox = account.inboxFolderId
      ? {
          id: account.inboxFolderId,
          displayName: "Inbox",
          totalItemCount: account.lastInboxCount || 0,
          unreadItemCount: 0
        }
      : null;
    let messages: MailMessageSummary[] = [];
    const skip = options.cursor ? Number(options.cursor) || 0 : options.skip || 0;

    try {
      if (inbox) {
        try {
          messages = await listMessages(token.accessToken, inbox.id, top, skip, search, options.since || null, settings.proxyUrl);
        } catch {
          inbox = null;
        }
      }

      if (inbox) {
        // already loaded through cached folder id
      } else {
        inbox = await discoverGraphInbox(token.accessToken, settings.proxyUrl);
        if (inbox) {
          messages = await listMessages(token.accessToken, inbox.id, top, skip, search, options.since || null, settings.proxyUrl);
        }
      }

      if (!inbox) {
        return { messages: [], nextCursor: null, totalCount: 0 } satisfies MailListResult;
      }
    } catch (error) {
      if (search || options.cursor) {
        throw error;
      }

      const fallback = await fetchHotmailFallback(options.accountId, top, error);
      await persistHotmailFallback(options.accountId, account, settings, fallback);
      return fallbackListResult(fallback);
    }

    const totalCount = inbox.totalItemCount || messages.length;
    const loadedCount = skip + messages.length;
    const nextCursor = messages.length >= top && loadedCount < totalCount ? String(loadedCount) : null;
    if (shouldCommitMailboxRefreshState({ search, cursor: options.cursor })) {
      await saveCachedMessages(options.accountId, messages, settings.cacheMessages, nextCursor);
      await updateAccountRefreshState(options.accountId, {
        status: "valid",
        lastError: null,
        lastInboxCount: totalCount,
        lastMailAt: latestMailTime(messages),
        lastMailCursor: null,
        inboxFolderId: inbox.id,
        refreshCooldownUntil: null
      });
    }
    return { messages, nextCursor, totalCount } satisfies MailListResult;
    } catch (error) {
      const { message } = normalizeErrorResult(error);
      throw new Error(message);
    }
    })
  );

  handleValidated(IPC_CHANNELS.mailGetMessage, IPC_REQUEST_SCHEMAS.getMessage, async (_event, options) => {
    const settings = await getSettings();
    const isHelperMessage = options.messageId.startsWith("helper:");
    const cached = await getCachedMessageDetail(options.accountId, options.messageId, settings.cacheBodies || isHelperMessage);
    if (cached) {
      return cached;
    }

    if (isHelperMessage) {
      throw new Error("兜底邮件正文缓存不存在，请刷新邮件后再打开");
    }

    const token = await getAccessToken(options.accountId);

    if (token.authMode === "imap") {
      const account = await getAccountRecord(options.accountId);
      const folderIds = account.inboxFolderId ? [account.inboxFolderId] : [];

      if (folderIds.length === 0) {
        const folders = await listImapFolders(token.email, token.accessToken, settings.proxyUrl);
        const inbox = pickInboxFolder(folders);
        if (inbox) {
          folderIds.push(inbox.id);
        }
      }

      if (folderIds.length === 0) {
        throw new Error("未找到收件箱");
      }

      let detail;
      try {
        detail = await getImapMessage(token.email, token.accessToken, folderIds[0], options.messageId, settings.proxyUrl);
      } catch (error) {
        if (!account.inboxFolderId) {
          throw error;
        }

        const folders = await listImapFolders(token.email, token.accessToken, settings.proxyUrl);
        const inbox = pickInboxFolder(folders);
        if (!inbox) {
          throw new Error("未找到收件箱");
        }
        detail = await getImapMessage(token.email, token.accessToken, inbox.id, options.messageId, settings.proxyUrl);
        await updateAccountRefreshState(options.accountId, {
          status: "valid",
          lastError: null,
          lastInboxCount: account.lastInboxCount || 0,
          lastMailAt: account.lastMailAt || null,
          lastMailCursor: account.lastMailCursor || null,
          inboxFolderId: inbox.id,
          graphDeltaLink: null,
          refreshCooldownUntil: null
        });
      }

      await saveCachedMessageDetail(options.accountId, detail, settings.cacheBodies);
      return detail;
    }

    const detail = await getMessage(token.accessToken, options.messageId, settings.proxyUrl);
    await saveCachedMessageDetail(options.accountId, detail, settings.cacheBodies);
    return detail;
  });

  handleValidated(IPC_CHANNELS.mailClearCache, IPC_REQUEST_SCHEMAS.clearCache, async (_event, accountId) => {
    if (accountId) {
      await clearAccountCache(accountId);
      return { cleared: 1 };
    }

    await clearAllMailCache();
    return { cleared: "all" };
  });

  handleValidated(IPC_CHANNELS.mailRefreshMany, IPC_REQUEST_SCHEMAS.refreshMany, async (event, request) => {
    const { accountIds, jobKind } = request;
    return refreshCoordinator.runJob(jobKind, async (job) => {
      const appSettings = await getSettings();
      let completed = 0;
      let ok = 0;
      let failed = 0;
      const total = accountIds.length;
      const batchLimit = resolveBatchLimit(appSettings.batchConcurrency, total);
      const canceledResult = (accountId: string, metrics: RefreshMetrics, totalStart: number) => {
        const message = cancelError(jobKind);
        failed += 1;
        completed += 1;
        metrics.totalMs = elapsedSince(totalStart);
        event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, {
          completed,
          total,
          ok,
          failed,
          accountId,
          error: message,
          code: "CANCELED",
          metrics
        });
        return {
          accountId,
          ok: false,
          canceled: true,
          count: 0,
          error: message,
          code: "CANCELED" as AppErrorCode,
          metrics
        };
      };
      const results = await runLimited(accountIds, batchLimit, (accountId) => {
        const metrics: RefreshMetrics = {
          tokenMs: 0,
          mailMs: 0,
          cacheMs: 0,
          stateMs: 0,
          totalMs: 0
        };
        const totalStart = nowMs();
        return job.runAccount(accountId, async () => {
        let account: Awaited<ReturnType<typeof getAccountRecord>> | null = null;

        try {
        account = await getAccountRecord(accountId);
        const settings = appSettings;

        if (isCooldownActive(account.refreshCooldownUntil)) {
          metrics.totalMs = elapsedSince(totalStart);
          ok += 1;
          completed += 1;
          event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
          return { accountId, ok: true, count: 0, skipped: true, metrics };
        }

        const tokenStart = nowMs();
        const token = await getAccessToken(accountId).catch(async (error) => {
          metrics.tokenMs = elapsedSince(tokenStart);
          const fallback = await finishWithHotmailFallback(accountId, account!, settings, metrics, totalStart, error);
          ok += 1;
          completed += 1;
          event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
          return { fallback };
        });
        metrics.tokenMs = metrics.tokenMs || elapsedSince(tokenStart);

        if ("fallback" in token) {
          return {
            accountId,
            ok: true,
            count: token.fallback.messages.length,
            newCount: countNewMessagesAfterRefresh(token.fallback.messages, account.lastRefreshedAt),
            metrics
          };
        }

        if (token.authMode === "imap") {
          try {
            const mailStart = nowMs();
            const result = await refreshImapInbox(
              token.email,
              token.accessToken,
              20,
              account.lastMailCursor || "",
              account.inboxFolderId || null,
              settings.proxyUrl
            );
            metrics.mailMs = elapsedSince(mailStart);

            if (!result.inboxFolderId) {
              throw new Error("未找到收件箱");
            }

            const messages = result.messages;
            const newCount = countNewMessagesAfterRefresh(messages, account.lastRefreshedAt);
            if (messages.length > 0) {
              const cacheStart = nowMs();
              await saveCachedMessages(accountId, messages, settings.cacheMessages, nextCursorFor(messages), { readBack: false });
              metrics.cacheMs = elapsedSince(cacheStart);
            }
            const stateStart = nowMs();
            await updateAccountRefreshState(accountId, {
              status: "valid",
              lastError: null,
              lastInboxCount: result.totalCount,
              lastMailAt: latestMailTime(messages) || account.lastMailAt || null,
              lastMailCursor: result.cursor || account.lastMailCursor || null,
              inboxFolderId: result.inboxFolderId,
              graphDeltaLink: null,
              refreshCooldownUntil: null
            });
            metrics.stateMs = elapsedSince(stateStart);
            metrics.totalMs = elapsedSince(totalStart);
            ok += 1;
            completed += 1;
            event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
            return { accountId, ok: true, count: messages.length, newCount, metrics };
          } catch (error) {
            const fallback = await finishWithHotmailFallback(accountId, account, settings, metrics, totalStart, error);
            const newCount = countNewMessagesAfterRefresh(fallback.messages, account.lastRefreshedAt);
            ok += 1;
            completed += 1;
            event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
            return { accountId, ok: true, count: fallback.messages.length, newCount, metrics };
          }
        }

        let graphResult: Awaited<ReturnType<typeof deltaGraphInboxMessages>> | null = null;
        try {
          const mailStart = nowMs();
          graphResult = await deltaGraphInboxMessages(token.accessToken, account, 20, settings.proxyUrl);
          metrics.mailMs = elapsedSince(mailStart);
        } catch (error) {
          const fallback = await finishWithHotmailFallback(accountId, account, settings, metrics, totalStart, error);
          const newCount = countNewMessagesAfterRefresh(fallback.messages, account.lastRefreshedAt);
          ok += 1;
          completed += 1;
          event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
          return { accountId, ok: true, count: fallback.messages.length, newCount, metrics };
        }

        const inbox = graphResult.inbox;

        if (!inbox) {
          try {
            const fallback = await finishWithHotmailFallback(accountId, account, settings, metrics, totalStart, new Error("未找到收件箱"));
            const newCount = countNewMessagesAfterRefresh(fallback.messages, account.lastRefreshedAt);
            ok += 1;
            completed += 1;
            event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
            return { accountId, ok: true, count: fallback.messages.length, newCount, metrics };
          } catch {
            const stateStart = nowMs();
            await updateAccountRefreshFailure(accountId, {
              status: resolveRefreshFailureStatus(account.status, "MAILBOX_NOT_FOUND"),
              lastError: "未找到收件箱",
              refreshCooldownUntil: cooldownUntilFor("MAILBOX_NOT_FOUND")
            });
            metrics.stateMs = elapsedSince(stateStart);
            metrics.totalMs = elapsedSince(totalStart);
            failed += 1;
            completed += 1;
            event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, error: "未找到收件箱", code: "MAILBOX_NOT_FOUND", metrics });
            return { accountId, ok: false, count: 0, error: "未找到收件箱", code: "MAILBOX_NOT_FOUND" as AppErrorCode, metrics };
          }
        }

        const messages = graphResult.messages;
        const newCount = countNewMessagesAfterRefresh(messages, account.lastRefreshedAt);
        if (messages.length > 0) {
          const cacheStart = nowMs();
          await saveCachedMessages(accountId, messages, settings.cacheMessages, null, { readBack: false });
          metrics.cacheMs = elapsedSince(cacheStart);
        }
        const stateStart = nowMs();
        await updateAccountRefreshState(accountId, {
          status: "valid",
          lastError: null,
          lastInboxCount: inbox.totalItemCount || account.lastInboxCount || messages.length,
          lastMailAt: latestMailTime(messages) || account.lastMailAt || null,
          lastMailCursor: null,
          inboxFolderId: inbox.id,
          graphDeltaLink: graphResult.deltaLink,
          refreshCooldownUntil: null
        });
        metrics.stateMs = elapsedSince(stateStart);
        metrics.totalMs = elapsedSince(totalStart);
        ok += 1;
        completed += 1;
        event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
        return { accountId, ok: true, count: messages.length, newCount, metrics };
        } catch (error) {
          const { code, message } = normalizeErrorResult(error);
          await updateAccountRefreshFailure(accountId, {
            status: resolveRefreshFailureStatus(account?.status || "untested", code),
            lastError: message,
            refreshCooldownUntil: cooldownUntilFor(code)
          }).catch(() => undefined);
          failed += 1;
          completed += 1;
          metrics.totalMs = elapsedSince(totalStart);
          event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, error: message, code, metrics });
          return { accountId, ok: false, count: 0, error: message, code, metrics };
        }
        }, () => canceledResult(accountId, metrics, totalStart));
      });
      const slowest = results
        .filter((result) => result.metrics)
        .sort((left, right) => (right.metrics?.totalMs || 0) - (left.metrics?.totalMs || 0))
        .slice(0, 5)
        .map((result) => ({
          accountId: result.accountId,
          ok: result.ok,
          count: result.count,
          metrics: result.metrics
        }));
      console.info("mail:refreshMany summary", {
        total,
        batchLimit,
        ok,
        failed,
        slowest
      });
      return results;
    });
  });
}

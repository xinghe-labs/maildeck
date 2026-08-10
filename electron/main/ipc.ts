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
  updateAccountInboxFolder,
  updateAccountRefreshFailure,
  updateAccountRefreshState,
  updateAccountStatus,
  upsertAccounts
} from "./account-store.js";
import { deltaMessages, getMessage, listMailFolders, listMessages, refreshAccessToken } from "./graph-client.js";
import { isGraphThrottledError } from "./graph-errors.js";
import { getImapMessage, listImapFolders, listImapMessages, refreshImapInbox } from "./imap-client.js";
import {
  fetchHotmailFallbackMessage,
  fetchHotmailFallbackMessages,
  isHotmailFallbackEnabled,
  testHotmailFallbackConnection
} from "./hotmail-fallback-client.js";
import { parseAccountImport } from "./import-parser.js";
import { countNewMessagesAfterRefresh, shouldCommitMailboxRefreshState } from "./mail-refresh-state.js";
import { getPublicSettings, getSettings, updateSettings } from "./settings-store.js";
import { normalizeError, reportIpcError } from "./error-utils.js";
import { resolveRefreshFailureStatus } from "./account-refresh-state.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";
import { AccessTokenManager } from "./access-token-manager.js";
import { isMailContentTooLargeError, isMailParseFailedError } from "./mail-errors.js";
import { credentialGenerations } from "./credential-generations.js";
import { handleValidated } from "./validated-ipc.js";
import type {
  AppErrorCode,
  JobKind,
  MailListResult,
  MailMessageDetail,
  MailMessageSummary,
  RefreshManyResult,
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

function getAccessToken(accountId: string, forceRefresh = false, signal?: AbortSignal) {
  return accessTokenManager.getAccessToken(accountId, forceRefresh, signal);
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

function canceledError(job: JobKind) {
  return { code: "CANCELED" as const, message: cancelError(job), retryable: false };
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

async function runConfiguredNetworkAccount<T>(
  accountId: string,
  operation: (signal: AbortSignal, settings: Awaited<ReturnType<typeof getSettings>>) => Promise<T>
) {
  const settings = await getSettings();
  refreshCoordinator.setConcurrency(settings.batchConcurrency);
  return refreshCoordinator.runNetworkAccount(accountId, (signal) => operation(signal, settings));
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
  nextCursor: string | null = null,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  await saveCachedMessages(accountId, result.messages, settings.cacheMessages, nextCursor, {
    readBack: false,
    assertCurrent: () => signal?.throwIfAborted()
  });
  signal?.throwIfAborted();
}

async function loadCredentialContext(accountId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const snapshot = credentialGenerations.capture(accountId);
  const [credentials, settings] = await Promise.all([getAccountCredentials(accountId), getSettings()]);
  signal?.throwIfAborted();
  credentialGenerations.assertCurrent(snapshot);
  return { snapshot, credentials, settings };
}

async function fetchHotmailFallback(
  accountId: string,
  top: number,
  cause: unknown,
  signal?: AbortSignal
) {
  if (isGraphThrottledError(cause)) {
    throw cause;
  }
  const context = await loadCredentialContext(accountId, signal);
  const { credentials, settings, snapshot } = context;
  if (!isHotmailFallbackEnabled(settings)) {
    throw cause;
  }

  const result = await fetchHotmailFallbackMessages(settings, credentials.account, credentials.refreshToken, top, signal);
  signal?.throwIfAborted();
  credentialGenerations.assertCurrent(snapshot);
  await assertAccountCredentialGeneration(accountId, credentials.credentialGeneration);
  signal?.throwIfAborted();

  if (result.nextRefreshToken) {
    await updateAccountStatus(accountId, "valid", null, result.nextRefreshToken, {
      expectedCredentialGeneration: credentials.credentialGeneration,
      assertCurrent: () => {
        signal?.throwIfAborted();
        credentialGenerations.assertCurrent(snapshot);
      },
      afterCommit: () => credentialGenerations.invalidateAccounts([accountId])
    });
  } else {
    credentialGenerations.assertCurrent(snapshot);
  }

  return result;
}

async function fetchHotmailFallbackDetail(
  accountId: string,
  messageId: string,
  cause: unknown,
  signal?: AbortSignal
) {
  const context = await loadCredentialContext(accountId, signal);
  const { credentials, settings, snapshot } = context;
  if (!isHotmailFallbackEnabled(settings)) {
    throw cause;
  }

  const result = await fetchHotmailFallbackMessage(
    settings,
    credentials.account,
    credentials.refreshToken,
    messageId,
    signal
  );
  signal?.throwIfAborted();
  credentialGenerations.assertCurrent(snapshot);
  await assertAccountCredentialGeneration(accountId, credentials.credentialGeneration);
  signal?.throwIfAborted();

  if (result.nextRefreshToken) {
    await updateAccountStatus(accountId, "valid", null, result.nextRefreshToken, {
      expectedCredentialGeneration: credentials.credentialGeneration,
      assertCurrent: () => {
        signal?.throwIfAborted();
        credentialGenerations.assertCurrent(snapshot);
      },
      afterCommit: () => credentialGenerations.invalidateAccounts([accountId])
    });
  } else {
    credentialGenerations.assertCurrent(snapshot);
  }

  return result;
}

function shouldTryHotmailFallbackDetail(messageId: string, error: unknown) {
  if (!/^\d+$/u.test(messageId) || isMailContentTooLargeError(error) || isMailParseFailedError(error)) {
    return false;
  }
  const { code } = normalizeErrorResult(error);
  return !["CANCELED", "STALE_CREDENTIALS", "THROTTLED", "ACCOUNT_NOT_FOUND", "MAIL_PARSE_FAILED", "MAIL_TOO_LARGE"].includes(code);
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
  fallback: Awaited<ReturnType<typeof fetchHotmailFallback>>,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  await cacheHotmailFallbackResult(accountId, fallback, settings, null, signal);
  signal?.throwIfAborted();
  await updateAccountRefreshState(accountId, refreshStateFromFallback(account, fallback), {
    assertCurrent: () => signal?.throwIfAborted()
  });
}

async function finishWithHotmailFallback(
  accountId: string,
  account: Awaited<ReturnType<typeof getAccountRecord>>,
  settings: Awaited<ReturnType<typeof getSettings>>,
  metrics: RefreshMetrics,
  totalStart: number,
  cause: unknown,
  signal?: AbortSignal
) {
  const mailStart = nowMs();
  const fallback = await fetchHotmailFallback(accountId, 20, cause, signal);
  metrics.mailMs += elapsedSince(mailStart);
  metrics.fallback = fallback.transport;

  const cacheStart = nowMs();
  await cacheHotmailFallbackResult(accountId, fallback, settings, null, signal);
  metrics.cacheMs += elapsedSince(cacheStart);

  signal?.throwIfAborted();
  const stateStart = nowMs();
  await updateAccountRefreshState(accountId, refreshStateFromFallback(account, fallback), {
    assertCurrent: () => signal?.throwIfAborted()
  });
  metrics.stateMs += elapsedSince(stateStart);
  metrics.totalMs = elapsedSince(totalStart);

  return fallback;
}

async function discoverGraphInbox(accessToken: string, proxyUrl: string, signal?: AbortSignal) {
  const folders = await listMailFolders(accessToken, proxyUrl, signal);
  return pickInboxFolder(folders);
}

async function listGraphInboxMessages(
  accessToken: string,
  account: Awaited<ReturnType<typeof getAccountRecord>>,
  top: number,
  since: string | null,
  proxyUrl: string,
  signal?: AbortSignal
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
        messages: await listMessages(accessToken, account.inboxFolderId, top, 0, "", since, proxyUrl, signal)
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (isGraphThrottledError(error)) {
        throw error;
      }
      // Folder ids may become stale; discover once and retry below.
    }
  }

  const inbox = await discoverGraphInbox(accessToken, proxyUrl, signal);
  if (!inbox) {
    return { inbox: null, messages: [] };
  }

  return {
    inbox,
    messages: await listMessages(accessToken, inbox.id, top, 0, "", since, proxyUrl, signal)
  };
}

async function deltaGraphInboxMessages(
  accessToken: string,
  account: Awaited<ReturnType<typeof getAccountRecord>>,
  top: number,
  proxyUrl: string,
  signal?: AbortSignal
) {
  const inbox = account.inboxFolderId
    ? {
        id: account.inboxFolderId,
        displayName: "Inbox",
        totalItemCount: account.lastInboxCount || 0,
        unreadItemCount: 0
      }
    : await discoverGraphInbox(accessToken, proxyUrl, signal);

  if (!inbox) {
    return { inbox: null, messages: [], deltaLink: account.graphDeltaLink || null };
  }

  try {
    const result = await deltaMessages(accessToken, inbox.id, top, account.graphDeltaLink || null, 3, proxyUrl, signal);
    return {
      inbox,
      messages: result.messages,
      deltaLink: result.deltaLink || result.nextLink || account.graphDeltaLink || null
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (isGraphThrottledError(error)) {
      throw error;
    }
    const fallback = await listGraphInboxMessages(accessToken, { ...account, inboxFolderId: inbox.id, graphDeltaLink: null }, top, account.lastMailAt || null, proxyUrl, signal);
    return {
      inbox: fallback.inbox,
      messages: fallback.messages,
      deltaLink: null
    };
  }
}

async function testAccountConnection(accountId: string, forceRefresh = true, signal?: AbortSignal): Promise<TestManyResult> {
  try {
    const token = await getAccessToken(accountId, forceRefresh, signal);
    const settings = await getSettings();
    signal?.throwIfAborted();

    if (token.authMode === "imap") {
      await listImapFolders(token.email, token.accessToken, settings.proxyUrl, signal);
    } else {
      await listMailFolders(token.accessToken, settings.proxyUrl, signal);
    }

    signal?.throwIfAborted();
    const account = await updateAccountStatus(accountId, "valid", null, undefined, {
      assertCurrent: () => signal?.throwIfAborted()
    });
    return { accountId, account, ok: true, message: "连接成功" };
  } catch (error) {
    signal?.throwIfAborted();
    const payload = reportIpcError(error, `Account connection test ${accountId}`);
    let currentStatus: Awaited<ReturnType<typeof getAccountRecord>>["status"] = "untested";
    try {
      currentStatus = (await getAccountRecord(accountId)).status;
    } catch (statusError) {
      signal?.throwIfAborted();
      reportIpcError(statusError, `Read account status ${accountId}`);
    }
    let account = null;
    try {
      account = await updateAccountStatus(
        accountId,
        resolveRefreshFailureStatus(currentStatus, payload.code),
        payload.message,
        undefined,
        {
        assertCurrent: () => signal?.throwIfAborted()
        }
      );
    } catch (statusError) {
      signal?.throwIfAborted();
      reportIpcError(statusError, `Persist account test status ${accountId}`);
    }
    signal?.throwIfAborted();
    return { accountId, account, ok: false, error: payload };
  }
}

async function testHotmailFallback(accountId: string, signal?: AbortSignal): Promise<TestFallbackResult> {
  const started = Date.now();
  let account: Awaited<ReturnType<typeof getAccountRecord>> | null = null;

  try {
    const context = await loadCredentialContext(accountId, signal);
    account = context.credentials.account;
    const result = await testHotmailFallbackConnection(
      context.settings,
      account,
      context.credentials.refreshToken,
      5,
      signal
    );
    signal?.throwIfAborted();
    credentialGenerations.assertCurrent(context.snapshot);
    const accountView = await updateAccountStatus(
      accountId,
      "valid",
      null,
      result.nextRefreshToken || undefined,
      {
        expectedCredentialGeneration: context.credentials.credentialGeneration,
        assertCurrent: () => {
          signal?.throwIfAborted();
          credentialGenerations.assertCurrent(context.snapshot);
        },
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
    signal?.throwIfAborted();
    return {
      account: null,
      ok: false,
      error: reportIpcError(error, `Hotmail fallback test ${accountId}`),
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
      refreshCoordinator.setConcurrency(next.settings.batchConcurrency);
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
    const result = await runConfiguredNetworkAccount(accountId, (signal) => testAccountConnection(accountId, true, signal));
    return result.ok
      ? { account: result.account, ok: true as const, message: result.message }
      : { account: result.account, ok: false as const, error: result.error };
  });

  handleValidated(IPC_CHANNELS.accountsTestFallback, IPC_REQUEST_SCHEMAS.testFallback, async (_event, accountId) =>
    runConfiguredNetworkAccount(accountId, (signal) => testHotmailFallback(accountId, signal))
  );

  handleValidated(IPC_CHANNELS.accountsTestMany, IPC_REQUEST_SCHEMAS.testMany, async (event, accountIds) => {
    return refreshCoordinator.runJob("test", async (job) => {
      const settings = await getSettings();
      refreshCoordinator.setConcurrency(settings.batchConcurrency);
      let completed = 0;
      let ok = 0;
      let failed = 0;
      const total = accountIds.length;

      return runLimited(accountIds, resolveBatchLimit(settings.batchConcurrency, total), (accountId) =>
        job.runAccount<TestManyResult>(
          accountId,
          async (signal) => {
            const result = await testAccountConnection(accountId, true, signal);
            completed += 1;

            if (result.ok) {
              ok += 1;
              event.sender.send(IPC_EVENT_CHANNELS.accountsTestProgress, { completed, total, ok, failed, accountId });
            } else {
              failed += 1;
              event.sender.send(IPC_EVENT_CHANNELS.accountsTestProgress, { completed, total, ok, failed, accountId, error: result.error });
            }

            return result;
          },
          () => {
            completed += 1;
            failed += 1;
            const error = canceledError("test");
            event.sender.send(IPC_EVENT_CHANNELS.accountsTestProgress, { completed, total, ok, failed, accountId, error });
            return { accountId, account: null, ok: false as const, error };
          }
        )
      );
    });
  });

  handleValidated(IPC_CHANNELS.mailListFolders, IPC_REQUEST_SCHEMAS.listFolders, async (_event, accountId) => {
    return runConfiguredNetworkAccount(accountId, async (signal, settings) => {
      const token = await getAccessToken(accountId, false, signal);

      if (token.authMode === "imap") {
        return listImapFolders(token.email, token.accessToken, settings.proxyUrl, signal);
      }

      return listMailFolders(token.accessToken, settings.proxyUrl, signal);
    });
  });

  handleValidated(IPC_CHANNELS.mailListMessages, IPC_REQUEST_SCHEMAS.listMessages, (_event, options) =>
    runConfiguredNetworkAccount(options.accountId, async (signal, settings) => {
    try {
    const search = options.search?.trim() || "";
    const top = options.top || 50;
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

    const token = await getAccessToken(options.accountId, false, signal).catch(async (error) => {
      if (search || options.cursor) {
        throw error;
      }

      signal.throwIfAborted();
      const fallback = await fetchHotmailFallback(options.accountId, top, error, signal);
      await persistHotmailFallback(options.accountId, account, settings, fallback, signal);

      return { fallback };
    });

    if ("fallback" in token) {
      return fallbackListResult(token.fallback);
    }

    if (token.authMode === "imap") {
      let loaded: {
        inboxId: string;
        result: Awaited<ReturnType<typeof listImapMessages>>;
      } | null = null;
      try {
        const folders = await listImapFolders(token.email, token.accessToken, settings.proxyUrl, signal);
        const inbox = pickInboxFolder(folders);

        if (!inbox) {
          return { messages: [], nextCursor: null, totalCount: 0 } satisfies MailListResult;
        }

        loaded = {
          inboxId: inbox.id,
          result: await listImapMessages(
            token.email,
            token.accessToken,
            inbox.id,
            top,
            search,
            options.cursor || "",
            settings.proxyUrl,
            signal
          )
        };
      } catch (error) {
        if (search || options.cursor) {
          throw error;
        }

        signal.throwIfAborted();
        const fallback = await fetchHotmailFallback(options.accountId, top, error, signal);
        await persistHotmailFallback(options.accountId, account, settings, fallback, signal);
        return fallbackListResult(fallback);
      }

      const messages = loaded.result.messages;
      const nextCursor = nextCursorFor(messages, loaded.result.totalCount);
      if (shouldCommitMailboxRefreshState({ search, cursor: options.cursor })) {
        signal.throwIfAborted();
        await saveCachedMessages(options.accountId, messages, settings.cacheMessages, nextCursor, {
          assertCurrent: () => signal.throwIfAborted()
        });
        signal.throwIfAborted();
        await updateAccountRefreshState(options.accountId, {
          status: "valid",
          lastError: null,
          lastInboxCount: loaded.result.totalCount,
          lastMailAt: latestMailTime(messages),
          lastMailCursor: maxCursorFor(messages),
          inboxFolderId: loaded.inboxId,
          graphDeltaLink: null,
          refreshCooldownUntil: null
        }, {
          assertCurrent: () => signal.throwIfAborted()
        });
      }
      return { messages, nextCursor, totalCount: loaded.result.totalCount } satisfies MailListResult;
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
          messages = await listMessages(token.accessToken, inbox.id, top, skip, search, options.since || null, settings.proxyUrl, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (isGraphThrottledError(error)) {
            throw error;
          }
          inbox = null;
        }
      }

      if (inbox) {
        // already loaded through cached folder id
      } else {
        inbox = await discoverGraphInbox(token.accessToken, settings.proxyUrl, signal);
        if (inbox) {
          messages = await listMessages(token.accessToken, inbox.id, top, skip, search, options.since || null, settings.proxyUrl, signal);
        }
      }

      if (!inbox) {
        return { messages: [], nextCursor: null, totalCount: 0 } satisfies MailListResult;
      }
    } catch (error) {
      if (search || options.cursor) {
        throw error;
      }

      signal.throwIfAborted();
      const fallback = await fetchHotmailFallback(options.accountId, top, error, signal);
      await persistHotmailFallback(options.accountId, account, settings, fallback, signal);
      return fallbackListResult(fallback);
    }

    const totalCount = inbox.totalItemCount || messages.length;
    const loadedCount = skip + messages.length;
    const nextCursor = messages.length >= top && loadedCount < totalCount ? String(loadedCount) : null;
    if (shouldCommitMailboxRefreshState({ search, cursor: options.cursor })) {
      signal.throwIfAborted();
      await saveCachedMessages(options.accountId, messages, settings.cacheMessages, nextCursor, {
        assertCurrent: () => signal.throwIfAborted()
      });
      signal.throwIfAborted();
      await updateAccountRefreshState(options.accountId, {
        status: "valid",
        lastError: null,
        lastInboxCount: totalCount,
        lastMailAt: latestMailTime(messages),
        lastMailCursor: null,
        inboxFolderId: inbox.id,
        refreshCooldownUntil: null
      }, {
        assertCurrent: () => signal.throwIfAborted()
      });
    }
    return { messages, nextCursor, totalCount } satisfies MailListResult;
    } catch (error) {
      throw error;
    }
    })
  );

  handleValidated(IPC_CHANNELS.mailGetMessage, IPC_REQUEST_SCHEMAS.getMessage, async (_event, options) => {
    return runConfiguredNetworkAccount(options.accountId, async (signal, settings) => {
      const isHelperMessage = options.messageId.startsWith("helper:");
      const cached = await getCachedMessageDetail(
        options.accountId,
        options.messageId,
        settings.cacheBodies || isHelperMessage
      );
      if (cached) {
        return cached;
      }

      if (isHelperMessage) {
        throw new Error("兜底邮件正文缓存不存在，请刷新邮件后再打开");
      }

      const cacheDetail = async (detail: MailMessageDetail) => {
        signal.throwIfAborted();
        await saveCachedMessageDetail(options.accountId, detail, settings.cacheBodies, {
          assertCurrent: () => signal.throwIfAborted()
        });
        return detail;
      };

      let detail: MailMessageDetail;
      let rediscoveredInboxId: string | null = null;
      try {
        const token = await getAccessToken(options.accountId, false, signal);

        if (token.authMode !== "imap") {
          detail = await getMessage(token.accessToken, options.messageId, settings.proxyUrl, signal);
        } else {
          const account = await getAccountRecord(options.accountId);
          const folderIds = account.inboxFolderId ? [account.inboxFolderId] : [];

          if (folderIds.length === 0) {
            const folders = await listImapFolders(token.email, token.accessToken, settings.proxyUrl, signal);
            const inbox = pickInboxFolder(folders);
            if (inbox) {
              folderIds.push(inbox.id);
            }
          }

          if (folderIds.length === 0) {
            throw new Error("未找到收件箱");
          }

          try {
            detail = await getImapMessage(
              token.email,
              token.accessToken,
              folderIds[0],
              options.messageId,
              settings.proxyUrl,
              signal
            );
          } catch (error) {
            signal.throwIfAborted();
            if (!account.inboxFolderId || isMailContentTooLargeError(error)) {
              throw error;
            }

            const folders = await listImapFolders(token.email, token.accessToken, settings.proxyUrl, signal);
            const inbox = pickInboxFolder(folders);
            if (!inbox) {
              throw new Error("未找到收件箱");
            }
            detail = await getImapMessage(
              token.email,
              token.accessToken,
              inbox.id,
              options.messageId,
              settings.proxyUrl,
              signal
            );
            rediscoveredInboxId = inbox.id;
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!shouldTryHotmailFallbackDetail(options.messageId, error)) {
          throw error;
        }
        const fallback = await fetchHotmailFallbackDetail(
          options.accountId,
          options.messageId,
          error,
          signal
        );
        detail = fallback.detail;
      }
      if (rediscoveredInboxId) {
        signal.throwIfAborted();
        await updateAccountInboxFolder(options.accountId, rediscoveredInboxId, {
          assertCurrent: () => signal.throwIfAborted()
        });
      }
      return cacheDetail(detail);
    });
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
      refreshCoordinator.setConcurrency(appSettings.batchConcurrency);
      let completed = 0;
      let ok = 0;
      let failed = 0;
      const total = accountIds.length;
      const batchLimit = resolveBatchLimit(appSettings.batchConcurrency, total);
      const canceledResult = (accountId: string, metrics: RefreshMetrics, totalStart: number): RefreshManyResult => {
        const error = canceledError(jobKind);
        failed += 1;
        completed += 1;
        metrics.totalMs = elapsedSince(totalStart);
        event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, {
          completed,
          total,
          ok,
          failed,
          accountId,
          error,
          metrics
        });
        return {
          accountId,
          ok: false,
          canceled: true,
          count: 0,
          error,
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
        return job.runAccount<RefreshManyResult>(accountId, async (signal) => {
        let account: Awaited<ReturnType<typeof getAccountRecord>> | null = null;

        try {
        signal.throwIfAborted();
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
        const token = await getAccessToken(accountId, false, signal).catch(async (error) => {
          signal.throwIfAborted();
          metrics.tokenMs = elapsedSince(tokenStart);
          const fallback = await finishWithHotmailFallback(accountId, account!, settings, metrics, totalStart, error, signal);
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
          let result: Awaited<ReturnType<typeof refreshImapInbox>>;
          try {
            const mailStart = nowMs();
            result = await refreshImapInbox(
              token.email,
              token.accessToken,
              20,
              account.lastMailCursor || "",
              account.inboxFolderId || null,
              settings.proxyUrl,
              signal
            );
            metrics.mailMs = elapsedSince(mailStart);

            if (!result.inboxFolderId) {
              throw new Error("未找到收件箱");
            }
          } catch (error) {
            signal.throwIfAborted();
            const fallback = await finishWithHotmailFallback(accountId, account, settings, metrics, totalStart, error, signal);
            const newCount = countNewMessagesAfterRefresh(fallback.messages, account.lastRefreshedAt);
            ok += 1;
            completed += 1;
            event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
            return { accountId, ok: true, count: fallback.messages.length, newCount, metrics };
          }

          const messages = result.messages;
          const newCount = countNewMessagesAfterRefresh(messages, account.lastRefreshedAt);
          if (messages.length > 0) {
            signal.throwIfAborted();
            const cacheStart = nowMs();
            await saveCachedMessages(accountId, messages, settings.cacheMessages, nextCursorFor(messages), {
              readBack: false,
              assertCurrent: () => signal.throwIfAborted()
            });
            metrics.cacheMs = elapsedSince(cacheStart);
          }
          signal.throwIfAborted();
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
          }, {
            assertCurrent: () => signal.throwIfAborted()
          });
          metrics.stateMs = elapsedSince(stateStart);
          metrics.totalMs = elapsedSince(totalStart);
          ok += 1;
          completed += 1;
          event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
          return { accountId, ok: true, count: messages.length, newCount, metrics };
        }

        let graphResult: Awaited<ReturnType<typeof deltaGraphInboxMessages>> | null = null;
        try {
          const mailStart = nowMs();
          graphResult = await deltaGraphInboxMessages(token.accessToken, account, 20, settings.proxyUrl, signal);
          metrics.mailMs = elapsedSince(mailStart);
        } catch (error) {
          signal.throwIfAborted();
          const fallback = await finishWithHotmailFallback(accountId, account, settings, metrics, totalStart, error, signal);
          const newCount = countNewMessagesAfterRefresh(fallback.messages, account.lastRefreshedAt);
          ok += 1;
          completed += 1;
          event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
          return { accountId, ok: true, count: fallback.messages.length, newCount, metrics };
        }

        const inbox = graphResult.inbox;

        if (!inbox) {
          try {
            signal.throwIfAborted();
            const fallback = await finishWithHotmailFallback(accountId, account, settings, metrics, totalStart, new Error("未找到收件箱"), signal);
            const newCount = countNewMessagesAfterRefresh(fallback.messages, account.lastRefreshedAt);
            ok += 1;
            completed += 1;
            event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
            return { accountId, ok: true, count: fallback.messages.length, newCount, metrics };
          } catch (error) {
            signal.throwIfAborted();
            const payload = reportIpcError(new Error("未找到收件箱"), `Refresh account ${accountId}`);
            const stateStart = nowMs();
            await updateAccountRefreshFailure(accountId, {
              status: resolveRefreshFailureStatus(account.status, payload.code),
              lastError: payload.message,
              refreshCooldownUntil: cooldownUntilFor(payload.code)
            }, {
              assertCurrent: () => signal.throwIfAborted()
            });
            metrics.stateMs = elapsedSince(stateStart);
            metrics.totalMs = elapsedSince(totalStart);
            failed += 1;
            completed += 1;
            event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, error: payload, metrics });
            return { accountId, ok: false as const, count: 0, error: payload, metrics };
          }
        }

        const messages = graphResult.messages;
        const newCount = countNewMessagesAfterRefresh(messages, account.lastRefreshedAt);
        if (messages.length > 0) {
          signal.throwIfAborted();
          const cacheStart = nowMs();
          await saveCachedMessages(accountId, messages, settings.cacheMessages, null, {
            readBack: false,
            assertCurrent: () => signal.throwIfAborted()
          });
          metrics.cacheMs = elapsedSince(cacheStart);
        }
        signal.throwIfAborted();
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
        }, {
          assertCurrent: () => signal.throwIfAborted()
        });
        metrics.stateMs = elapsedSince(stateStart);
        metrics.totalMs = elapsedSince(totalStart);
        ok += 1;
        completed += 1;
        event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, metrics });
        return { accountId, ok: true, count: messages.length, newCount, metrics };
        } catch (error) {
          if (signal.aborted) {
            throw signal.reason;
          }
          const payload = reportIpcError(error, `Refresh account ${accountId}`);
          try {
            await updateAccountRefreshFailure(accountId, {
              status: resolveRefreshFailureStatus(account?.status || "untested", payload.code),
              lastError: payload.message,
              refreshCooldownUntil: cooldownUntilFor(payload.code)
            }, {
              assertCurrent: () => signal.throwIfAborted()
            });
          } catch {
            signal.throwIfAborted();
          }
          signal.throwIfAborted();
          failed += 1;
          completed += 1;
          metrics.totalMs = elapsedSince(totalStart);
          event.sender.send(IPC_EVENT_CHANNELS.mailRefreshProgress, { completed, total, ok, failed, accountId, error: payload, metrics });
          return { accountId, ok: false as const, count: 0, error: payload, metrics };
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

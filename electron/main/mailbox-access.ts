import {
  getCachedCursor,
  getCachedMessageDetail,
  getCachedMessages,
  saveCachedMessageDetail,
  saveCachedMessages
} from "./mail-cache.js";
import {
  assertAccountCredentialGeneration,
  getAccountCredentials,
  getAccountRecord,
  updateAccountInboxFolder,
  updateAccountRefreshFailure,
  updateAccountRefreshState,
  updateAccountStatus
} from "./account-store.js";
import { deltaMessages, getWellKnownInboxFolder, getMessage, listMailFolders, listMessages, refreshAccessToken } from "./graph-client.js";
import { isGraphRequestError } from "./graph-errors.js";
import { getImapMessage, listImapFolders, listImapMessages, refreshImapInbox } from "./imap-client.js";
import {
  fetchHotmailFallbackMessage,
  fetchHotmailFallbackMessages,
  isHotmailFallbackEnabled,
  testHotmailFallbackConnection
} from "./hotmail-fallback-client.js";
import { countNewMessagesAfterRefresh, shouldCommitMailboxRefreshState } from "./mail-refresh-state.js";
import { normalizeError, reportIpcError } from "./error-utils.js";
import { resolveRefreshFailureStatus } from "./account-refresh-state.js";
import { AccessTokenManager, type AccessTokenRequestContext } from "./access-token-manager.js";
import { isMailContentTooLargeError, isMailParseFailedError } from "./mail-errors.js";
import {
  credentialGenerations,
  CredentialsChangedError,
  type CredentialSnapshot
} from "./credential-generations.js";
import { getSettings } from "./settings-store.js";
import type { RuntimeSettingsSnapshot } from "./settings-store.js";
import type {
  AppErrorCode,
  GetMessageOptions,
  ListMessagesOptions,
  MailFolder,
  MailListResult,
  MailMessageDetail,
  MailMessageSummary,
  RefreshManyResult,
  RefreshMetrics,
  TestFallbackResult,
  TestManyResult
} from "./types.js";

export interface MailboxAccess {
  readonly listFolders: (accountId: string, signal?: AbortSignal) => Promise<MailFolder[]>;
  readonly testConnection: (accountId: string, forceRefresh: boolean, signal?: AbortSignal) => Promise<TestManyResult>;
  readonly testFallback: (accountId: string, signal?: AbortSignal) => Promise<TestFallbackResult>;
  readonly listMessages: (options: ListMessagesOptions, signal: AbortSignal) => Promise<MailListResult>;
  readonly getMessage: (options: GetMessageOptions, signal: AbortSignal) => Promise<MailMessageDetail>;
  readonly refreshAccount: (accountId: string, signal: AbortSignal) => Promise<RefreshManyResult>;
}

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

function latestMailTime(messages: Array<{ receivedDateTime: string | null; sentDateTime: string | null }>) {
  return (
    messages
      .map((message) => message.receivedDateTime || message.sentDateTime)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null
  );
}

function nextCursorFor(messages: MailMessageSummary[], totalCount = 0) {
  if (messages.length === 0 || (totalCount > 0 && messages.length >= totalCount)) {
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

function pickInboxFolder<T extends { id: string; displayName: string }>(folders: T[]) {
  const validFolders = folders.filter(
    (folder) => typeof folder.id === "string" && folder.id.trim() && typeof folder.displayName === "string" && folder.displayName.trim()
  );

  // 只按名称匹配（英语/中文常见写法），不再退化到 validFolders[0]：
  // 取第一个文件夹会把任意文件夹当收件箱并持久化。
  return validFolders.find((folder) => ["inbox", "收件箱"].includes(folder.displayName.toLowerCase())) || null;
}

function isCooldownActive(value?: string | null) {
  return Boolean(value && new Date(value).getTime() > Date.now());
}

function isCooldownError(code: AppErrorCode) {
  return ["TOKEN_EXPIRED", "IMAP_AUTH_FAILED", "SCOPE_MISSING", "MAILBOX_NOT_FOUND"].includes(code);
}

function cooldownUntilFor(code: AppErrorCode) {
  return isCooldownError(code) ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null;
}

function nowMs() {
  return performance.now();
}

function elapsedSince(start: number) {
  return Math.round(performance.now() - start);
}

function createMetrics(): RefreshMetrics {
  return { tokenMs: 0, mailMs: 0, cacheMs: 0, stateMs: 0, totalMs: 0 };
}

const NON_FALLBACK_ERROR_CODES = new Set<AppErrorCode>([
  "INVALID_REQUEST",
  "CANCELED",
  "STALE_CREDENTIALS",
  "THROTTLED",
  "ACCOUNT_NOT_FOUND",
  "MAIL_PARSE_FAILED",
  "MAIL_TOO_LARGE"
]);

function shouldTryHotmailFallback(error: unknown) {
  return !NON_FALLBACK_ERROR_CODES.has(normalizeError(error).code);
}

function shouldRediscoverGraphMailbox(error: unknown) {
  return isGraphRequestError(error) && [400, 404, 410].includes(error.status);
}

class MailboxOperationGuard {
  private snapshot: CredentialSnapshot;

  constructor(
    private readonly accountId: string,
    private readonly proxyGeneration: number,
    private readonly proxyUrl: string,
    private readonly signal?: AbortSignal
  ) {
    this.snapshot = credentialGenerations.capture(accountId);
    this.assertCurrent();
  }

  readonly assertCurrent = () => {
    this.signal?.throwIfAborted();
    if (this.snapshot.proxyGeneration !== this.proxyGeneration) {
      throw new CredentialsChangedError();
    }
    credentialGenerations.assertCurrent(this.snapshot);
  };

  tokenContext(): AccessTokenRequestContext {
    this.assertCurrent();
    return { snapshot: this.snapshot, proxyUrl: this.proxyUrl };
  }

  currentSnapshot() {
    this.assertCurrent();
    return this.snapshot;
  }

  requestSignal() {
    return this.signal;
  }

  refreshAfterCredentialRotation() {
    this.signal?.throwIfAborted();
    const snapshot = credentialGenerations.capture(this.accountId);
    if (snapshot.proxyGeneration !== this.proxyGeneration) {
      throw new CredentialsChangedError();
    }
    this.snapshot = snapshot;
    this.assertCurrent();
  }
}

class DefaultMailboxAccess implements MailboxAccess {
  private readonly settings;
  private readonly proxyGeneration;

  constructor(settingsSnapshot: RuntimeSettingsSnapshot) {
    this.settings = settingsSnapshot.settings;
    this.proxyGeneration = settingsSnapshot.proxyGeneration;
  }

  readonly listFolders = async (accountId: string, signal?: AbortSignal) => {
    const guard = this.beginOperation(accountId, signal);
    const token = await accessTokenManager.getAccessToken(accountId, false, signal, guard.tokenContext());
    const folders = token.authMode === "imap"
      ? listImapFolders(token.email, token.accessToken, this.settings.proxyUrl, signal)
      : listMailFolders(token.accessToken, this.settings.proxyUrl, signal);
    const result = await folders;
    guard.assertCurrent();
    return result;
  };

  readonly testConnection = async (
    accountId: string,
    forceRefresh = true,
    signal?: AbortSignal
  ): Promise<TestManyResult> => {
    let guard: MailboxOperationGuard | null = null;
    try {
      guard = this.beginOperation(accountId, signal);
      const token = await accessTokenManager.getAccessToken(
        accountId,
        forceRefresh,
        signal,
        guard.tokenContext()
      );
      guard.assertCurrent();

      if (token.authMode === "imap") {
        await listImapFolders(token.email, token.accessToken, this.settings.proxyUrl, signal);
      } else {
        await listMailFolders(token.accessToken, this.settings.proxyUrl, signal);
      }

      guard.assertCurrent();
      const account = await updateAccountStatus(accountId, "valid", null, undefined, {
        assertCurrent: guard.assertCurrent
      });
      return { accountId, account, ok: true, message: "连接成功" };
    } catch (error) {
      signal?.throwIfAborted();
      const currentError = this.preferStaleOperationError(error, guard);
      const payload = reportIpcError(currentError, `Account connection test ${accountId}`);
      let currentStatus: Awaited<ReturnType<typeof getAccountRecord>>["status"] = "untested";
      try {
        currentStatus = (await getAccountRecord(accountId)).status;
      } catch (statusError) {
        signal?.throwIfAborted();
        reportIpcError(statusError, `Read account status ${accountId}`);
      }

      if (payload.code === "STALE_CREDENTIALS") {
        return { accountId, account: null, ok: false, error: payload };
      }

      let account = null;
      try {
        account = await updateAccountStatus(
          accountId,
          resolveRefreshFailureStatus(currentStatus, payload.code),
          payload.message,
          undefined,
          { assertCurrent: guard?.assertCurrent ?? (() => signal?.throwIfAborted()) }
        );
      } catch (statusError) {
        signal?.throwIfAborted();
        reportIpcError(statusError, `Persist account test status ${accountId}`);
      }
      signal?.throwIfAborted();
      return { accountId, account, ok: false, error: payload };
    }
  };

  readonly testFallback = async (accountId: string, signal?: AbortSignal): Promise<TestFallbackResult> => {
    const started = Date.now();
    let guard: MailboxOperationGuard | null = null;

    try {
      guard = this.beginOperation(accountId, signal);
      const context = await this.loadCredentialContext(accountId, guard);
      const result = await testHotmailFallbackConnection(
        context.settings,
        context.credentials.account,
        context.credentials.refreshToken,
        5,
        signal
      );
      guard.assertCurrent();
      const accountView = await updateAccountStatus(
        accountId,
        "valid",
        null,
        result.nextRefreshToken || undefined,
        {
          expectedCredentialGeneration: context.credentials.credentialGeneration,
          assertCurrent: guard.assertCurrent,
          ...(result.nextRefreshToken
            ? { afterCommit: () => credentialGenerations.invalidateAccounts([accountId]) }
            : {})
        }
      );
      if (result.nextRefreshToken) {
        guard.refreshAfterCredentialRotation();
      } else {
        guard.assertCurrent();
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
      const currentError = this.preferStaleOperationError(error, guard);
      return {
        account: null,
        ok: false,
        error: reportIpcError(currentError, `Hotmail fallback test ${accountId}`),
        elapsedMs: Date.now() - started
      };
    }
  };

  readonly listMessages = async (options: ListMessagesOptions, signal: AbortSignal): Promise<MailListResult> => {
    const guard = this.beginOperation(options.accountId, signal);
    const search = options.search?.trim() || "";
    const top = options.top || 50;
    const account = await getAccountRecord(options.accountId);

    if (!options.forceRefresh && !options.cursor && !options.skip) {
      const cached = await getCachedMessages(options.accountId, search, top, this.settings.cacheMessages);
      guard.assertCurrent();
      if (cached.length > 0) {
        const totalCount = account.lastInboxCount || cached.length;
        const cachedCursor = cached.length < totalCount ? await getCachedCursor(options.accountId) : null;
        guard.assertCurrent();
        return { messages: cached, nextCursor: cachedCursor, totalCount };
      }
    }

    const token = await accessTokenManager.getAccessToken(
      options.accountId,
      false,
      signal,
      guard.tokenContext()
    ).catch(async (error) => {
      if (search || options.cursor || options.skip) {
        throw error;
      }
      guard.assertCurrent();
      const fallback = await this.fetchHotmailFallback(options.accountId, top, error, guard);
      await this.persistHotmailFallback(options.accountId, account, fallback, guard);
      return { fallback };
    });

    if ("fallback" in token) {
      return this.fallbackListResult(token.fallback);
    }

    if (token.authMode === "imap") {
      let loaded: {
        inboxId: string;
        result: Awaited<ReturnType<typeof listImapMessages>>;
      };
      try {
        const folders = await listImapFolders(token.email, token.accessToken, this.settings.proxyUrl, signal);
        const inbox = pickInboxFolder(folders);
        if (!inbox) {
          return { messages: [], nextCursor: null, totalCount: 0 };
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
            this.settings.proxyUrl,
            signal
          )
        };
      } catch (error) {
        if (search || options.cursor || options.skip) {
          throw error;
        }
        guard.assertCurrent();
        const fallback = await this.fetchHotmailFallback(options.accountId, top, error, guard);
        await this.persistHotmailFallback(options.accountId, account, fallback, guard);
        return this.fallbackListResult(fallback);
      }

      const messages = loaded.result.messages;
      const nextCursor = nextCursorFor(messages, loaded.result.totalCount);
      if (shouldCommitMailboxRefreshState({ search, cursor: options.cursor, skip: options.skip })) {
        guard.assertCurrent();
        await saveCachedMessages(options.accountId, messages, this.settings.cacheMessages, nextCursor, {
          assertCurrent: guard.assertCurrent
        });
        guard.assertCurrent();
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
          assertCurrent: guard.assertCurrent
        });
      }
      return { messages, nextCursor, totalCount: loaded.result.totalCount };
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
          messages = await listMessages(
            token.accessToken,
            inbox.id,
            top,
            skip,
            search,
            options.since || null,
            this.settings.proxyUrl,
            signal
          );
        } catch (error) {
          guard.assertCurrent();
          if (!shouldRediscoverGraphMailbox(error)) {
            throw error;
          }
          inbox = null;
        }
      }

      if (!inbox) {
        inbox = await this.discoverGraphInbox(token.accessToken, guard);
        if (inbox) {
          messages = await listMessages(
            token.accessToken,
            inbox.id,
            top,
            skip,
            search,
            options.since || null,
            this.settings.proxyUrl,
            signal
          );
        }
      }

      if (!inbox) {
        return { messages: [], nextCursor: null, totalCount: 0 };
      }
    } catch (error) {
      if (search || options.cursor || options.skip) {
        throw error;
      }
      guard.assertCurrent();
      const fallback = await this.fetchHotmailFallback(options.accountId, top, error, guard);
      await this.persistHotmailFallback(options.accountId, account, fallback, guard);
      return this.fallbackListResult(fallback);
    }

    const totalCount = inbox.totalItemCount || messages.length;
    const loadedCount = skip + messages.length;
    const nextCursor = messages.length >= top && loadedCount < totalCount ? String(loadedCount) : null;
    if (shouldCommitMailboxRefreshState({ search, cursor: options.cursor, skip: options.skip })) {
      guard.assertCurrent();
      await saveCachedMessages(options.accountId, messages, this.settings.cacheMessages, nextCursor, {
        assertCurrent: guard.assertCurrent
      });
      guard.assertCurrent();
      await updateAccountRefreshState(options.accountId, {
        status: "valid",
        lastError: null,
        lastInboxCount: totalCount,
        lastMailAt: latestMailTime(messages),
        lastMailCursor: null,
        inboxFolderId: inbox.id,
        refreshCooldownUntil: null
      }, {
        assertCurrent: guard.assertCurrent
      });
    }
    return { messages, nextCursor, totalCount };
  };

  readonly getMessage = async (options: GetMessageOptions, signal: AbortSignal): Promise<MailMessageDetail> => {
    const guard = this.beginOperation(options.accountId, signal);
    const isHelperMessage = options.messageId.startsWith("helper:");
    const cached = await getCachedMessageDetail(
      options.accountId,
      options.messageId,
      this.settings.cacheBodies || isHelperMessage
    );
    guard.assertCurrent();
    if (cached) {
      return cached;
    }
    if (isHelperMessage) {
      throw new Error("兜底邮件正文缓存不存在，请刷新邮件后再打开");
    }

    let detail: MailMessageDetail;
    let rediscoveredInboxId: string | null = null;
    try {
      const token = await accessTokenManager.getAccessToken(
        options.accountId,
        false,
        signal,
        guard.tokenContext()
      );
      if (token.authMode !== "imap") {
        detail = await getMessage(token.accessToken, options.messageId, this.settings.proxyUrl, signal);
      } else {
        const account = await getAccountRecord(options.accountId);
        const folderIds = account.inboxFolderId ? [account.inboxFolderId] : [];
        if (folderIds.length === 0) {
          const folders = await listImapFolders(token.email, token.accessToken, this.settings.proxyUrl, signal);
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
            this.settings.proxyUrl,
            signal
          );
        } catch (error) {
          guard.assertCurrent();
          if (!account.inboxFolderId || isMailContentTooLargeError(error) || !shouldTryHotmailFallback(error)) {
            throw error;
          }
          const folders = await listImapFolders(token.email, token.accessToken, this.settings.proxyUrl, signal);
          const inbox = pickInboxFolder(folders);
          if (!inbox) {
            throw new Error("未找到收件箱");
          }
          detail = await getImapMessage(
            token.email,
            token.accessToken,
            inbox.id,
            options.messageId,
            this.settings.proxyUrl,
            signal
          );
          rediscoveredInboxId = inbox.id;
        }
      }
    } catch (error) {
      guard.assertCurrent();
      if (!this.shouldTryHotmailFallbackDetail(options.messageId, error)) {
        throw error;
      }
      detail = (await this.fetchHotmailFallbackDetail(options.accountId, options.messageId, error, guard)).detail;
    }

    if (rediscoveredInboxId) {
      guard.assertCurrent();
      await updateAccountInboxFolder(options.accountId, rediscoveredInboxId, {
        assertCurrent: guard.assertCurrent
      });
    }
    guard.assertCurrent();
    await saveCachedMessageDetail(options.accountId, detail, this.settings.cacheBodies, {
      assertCurrent: guard.assertCurrent
    });
    return detail;
  };

  readonly refreshAccount = async (accountId: string, signal: AbortSignal): Promise<RefreshManyResult> => {
    const metrics = createMetrics();
    const totalStart = nowMs();
    let account: Awaited<ReturnType<typeof getAccountRecord>> | null = null;
    let guard: MailboxOperationGuard | null = null;

    try {
      guard = this.beginOperation(accountId, signal);
      account = await getAccountRecord(accountId);
      guard.assertCurrent();
      if (isCooldownActive(account.refreshCooldownUntil)) {
        metrics.totalMs = elapsedSince(totalStart);
        return { accountId, ok: true, count: 0, skipped: true, metrics };
      }

      const tokenStart = nowMs();
      const token = await accessTokenManager.getAccessToken(
        accountId,
        false,
        signal,
        guard.tokenContext()
      ).catch(async (error) => {
        guard!.assertCurrent();
        metrics.tokenMs = elapsedSince(tokenStart);
        return {
          fallback: await this.finishWithHotmailFallback(accountId, account!, metrics, totalStart, error, guard!)
        };
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
            this.settings.proxyUrl,
            signal
          );
          metrics.mailMs = elapsedSince(mailStart);
          if (!result.inboxFolderId) {
            throw new Error("未找到收件箱");
          }
        } catch (error) {
          guard.assertCurrent();
          if (!shouldTryHotmailFallback(error)) {
            throw error;
          }
          const fallback = await this.finishWithHotmailFallback(accountId, account, metrics, totalStart, error, guard);
          return {
            accountId,
            ok: true,
            count: fallback.messages.length,
            newCount: countNewMessagesAfterRefresh(fallback.messages, account.lastRefreshedAt),
            metrics
          };
        }

        const messages = result.messages;
        const newCount = countNewMessagesAfterRefresh(messages, account.lastRefreshedAt);
        if (messages.length > 0) {
          guard.assertCurrent();
          const cacheStart = nowMs();
          await saveCachedMessages(accountId, messages, this.settings.cacheMessages, nextCursorFor(messages), {
            readBack: false,
            assertCurrent: guard.assertCurrent
          });
          metrics.cacheMs = elapsedSince(cacheStart);
        }
        guard.assertCurrent();
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
          assertCurrent: guard.assertCurrent
        });
        metrics.stateMs = elapsedSince(stateStart);
        metrics.totalMs = elapsedSince(totalStart);
        return { accountId, ok: true, count: messages.length, newCount, metrics };
      }

      let graphResult: Awaited<ReturnType<DefaultMailboxAccess["deltaGraphInboxMessages"]>>;
      try {
        const mailStart = nowMs();
        graphResult = await this.deltaGraphInboxMessages(token.accessToken, account, 20, guard);
        metrics.mailMs = elapsedSince(mailStart);
      } catch (error) {
        guard.assertCurrent();
        const fallback = await this.finishWithHotmailFallback(accountId, account, metrics, totalStart, error, guard);
        return {
          accountId,
          ok: true,
          count: fallback.messages.length,
          newCount: countNewMessagesAfterRefresh(fallback.messages, account.lastRefreshedAt),
          metrics
        };
      }

      const inbox = graphResult.inbox;
      if (!inbox) {
        try {
          guard.assertCurrent();
          const fallback = await this.finishWithHotmailFallback(
            accountId,
            account,
            metrics,
            totalStart,
            new Error("未找到收件箱"),
            guard
          );
          return {
            accountId,
            ok: true,
            count: fallback.messages.length,
            newCount: countNewMessagesAfterRefresh(fallback.messages, account.lastRefreshedAt),
            metrics
          };
        } catch {
          guard.assertCurrent();
          const payload = reportIpcError(new Error("未找到收件箱"), `Refresh account ${accountId}`);
          const stateStart = nowMs();
          await updateAccountRefreshFailure(accountId, {
            status: resolveRefreshFailureStatus(account.status, payload.code),
            lastError: payload.message,
            refreshCooldownUntil: cooldownUntilFor(payload.code)
          }, {
            assertCurrent: guard.assertCurrent
          });
          metrics.stateMs = elapsedSince(stateStart);
          metrics.totalMs = elapsedSince(totalStart);
          return { accountId, ok: false, count: 0, error: payload, metrics };
        }
      }

      const messages = graphResult.messages;
      const newCount = countNewMessagesAfterRefresh(messages, account.lastRefreshedAt);
      if (messages.length > 0) {
        guard.assertCurrent();
        const cacheStart = nowMs();
        // 增量刷新不产生分页游标；不传第 4 参以保留缓存中既有的列表游标，
        // 避免缓存命中时“加载更多”按钮消失。
        await saveCachedMessages(accountId, messages, this.settings.cacheMessages, undefined, {
          readBack: false,
          assertCurrent: guard.assertCurrent
        });
        metrics.cacheMs = elapsedSince(cacheStart);
      }
      guard.assertCurrent();
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
        assertCurrent: guard.assertCurrent
      });
      metrics.stateMs = elapsedSince(stateStart);
      metrics.totalMs = elapsedSince(totalStart);
      return { accountId, ok: true, count: messages.length, newCount, metrics };
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      const currentError = this.preferStaleOperationError(error, guard);
      const payload = reportIpcError(currentError, `Refresh account ${accountId}`);
      if (payload.code === "STALE_CREDENTIALS") {
        signal.throwIfAborted();
        metrics.totalMs = elapsedSince(totalStart);
        return { accountId, ok: false, count: 0, error: payload, metrics };
      }
      try {
        await updateAccountRefreshFailure(accountId, {
          status: resolveRefreshFailureStatus(account?.status || "untested", payload.code),
          lastError: payload.message,
          refreshCooldownUntil: cooldownUntilFor(payload.code)
        }, {
          assertCurrent: guard?.assertCurrent ?? (() => signal.throwIfAborted())
        });
      } catch {
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      metrics.totalMs = elapsedSince(totalStart);
      return { accountId, ok: false, count: 0, error: payload, metrics };
    }
  };

  private beginOperation(accountId: string, signal?: AbortSignal) {
    return new MailboxOperationGuard(accountId, this.proxyGeneration, this.settings.proxyUrl, signal);
  }

  private preferStaleOperationError(error: unknown, guard: MailboxOperationGuard | null) {
    if (!guard) {
      return error;
    }
    try {
      guard.assertCurrent();
      return error;
    } catch (currentError) {
      return currentError;
    }
  }

  private async loadCredentialContext(accountId: string, guard: MailboxOperationGuard) {
    guard.assertCurrent();
    const credentials = await getAccountCredentials(accountId);
    guard.assertCurrent();
    return { snapshot: guard.currentSnapshot(), credentials, settings: this.settings };
  }

  private async fetchHotmailFallback(
    accountId: string,
    top: number,
    cause: unknown,
    guard: MailboxOperationGuard
  ) {
    if (!shouldTryHotmailFallback(cause)) {
      throw cause;
    }
    const { credentials, settings } = await this.loadCredentialContext(accountId, guard);
    if (!isHotmailFallbackEnabled(settings)) {
      throw cause;
    }

    const result = await fetchHotmailFallbackMessages(
      settings,
      credentials.account,
      credentials.refreshToken,
      top,
      guard.requestSignal()
    );
    guard.assertCurrent();
    await assertAccountCredentialGeneration(accountId, credentials.credentialGeneration);
    guard.assertCurrent();
    if (result.nextRefreshToken) {
      await updateAccountStatus(accountId, "valid", null, result.nextRefreshToken, {
        expectedCredentialGeneration: credentials.credentialGeneration,
        assertCurrent: guard.assertCurrent,
        afterCommit: () => credentialGenerations.invalidateAccounts([accountId])
      });
      guard.refreshAfterCredentialRotation();
    } else {
      guard.assertCurrent();
    }
    return result;
  }

  private async fetchHotmailFallbackDetail(
    accountId: string,
    messageId: string,
    cause: unknown,
    guard: MailboxOperationGuard
  ) {
    if (!shouldTryHotmailFallback(cause)) {
      throw cause;
    }
    const { credentials, settings } = await this.loadCredentialContext(accountId, guard);
    if (!isHotmailFallbackEnabled(settings)) {
      throw cause;
    }
    const result = await fetchHotmailFallbackMessage(
      settings,
      credentials.account,
      credentials.refreshToken,
      messageId,
      guard.requestSignal()
    );
    guard.assertCurrent();
    await assertAccountCredentialGeneration(accountId, credentials.credentialGeneration);
    guard.assertCurrent();
    if (result.nextRefreshToken) {
      await updateAccountStatus(accountId, "valid", null, result.nextRefreshToken, {
        expectedCredentialGeneration: credentials.credentialGeneration,
        assertCurrent: guard.assertCurrent,
        afterCommit: () => credentialGenerations.invalidateAccounts([accountId])
      });
      guard.refreshAfterCredentialRotation();
    } else {
      guard.assertCurrent();
    }
    return result;
  }

  private shouldTryHotmailFallbackDetail(messageId: string, error: unknown) {
    if (!/^\d+$/u.test(messageId) || isMailContentTooLargeError(error) || isMailParseFailedError(error)) {
      return false;
    }
    return shouldTryHotmailFallback(error);
  }

  private refreshStateFromFallback(
    account: Awaited<ReturnType<typeof getAccountRecord>>,
    fallback: Awaited<ReturnType<DefaultMailboxAccess["fetchHotmailFallback"]>>
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

  private fallbackListResult(
    fallback: Awaited<ReturnType<DefaultMailboxAccess["fetchHotmailFallback"]>>
  ): MailListResult {
    return { messages: fallback.messages, nextCursor: null, totalCount: fallback.totalCount };
  }

  private async cacheHotmailFallbackResult(
    accountId: string,
    result: Awaited<ReturnType<DefaultMailboxAccess["fetchHotmailFallback"]>>,
    guard: MailboxOperationGuard
  ) {
    guard.assertCurrent();
    await saveCachedMessages(accountId, result.messages, this.settings.cacheMessages, null, {
      readBack: false,
      assertCurrent: guard.assertCurrent
    });
    guard.assertCurrent();
  }

  private async persistHotmailFallback(
    accountId: string,
    account: Awaited<ReturnType<typeof getAccountRecord>>,
    fallback: Awaited<ReturnType<DefaultMailboxAccess["fetchHotmailFallback"]>>,
    guard: MailboxOperationGuard
  ) {
    await this.cacheHotmailFallbackResult(accountId, fallback, guard);
    guard.assertCurrent();
    await updateAccountRefreshState(accountId, this.refreshStateFromFallback(account, fallback), {
      assertCurrent: guard.assertCurrent
    });
  }

  private async finishWithHotmailFallback(
    accountId: string,
    account: Awaited<ReturnType<typeof getAccountRecord>>,
    metrics: RefreshMetrics,
    totalStart: number,
    cause: unknown,
    guard: MailboxOperationGuard
  ) {
    const mailStart = nowMs();
    const fallback = await this.fetchHotmailFallback(accountId, 20, cause, guard);
    metrics.mailMs += elapsedSince(mailStart);
    metrics.fallback = fallback.transport;

    const cacheStart = nowMs();
    await this.cacheHotmailFallbackResult(accountId, fallback, guard);
    metrics.cacheMs += elapsedSince(cacheStart);

    guard.assertCurrent();
    const stateStart = nowMs();
    await updateAccountRefreshState(accountId, this.refreshStateFromFallback(account, fallback), {
      assertCurrent: guard.assertCurrent
    });
    metrics.stateMs += elapsedSince(stateStart);
    metrics.totalMs = elapsedSince(totalStart);
    return fallback;
  }

  private async discoverGraphInbox(accessToken: string, guard: MailboxOperationGuard) {
    guard.assertCurrent();
    try {
      // 优先用 Graph 已知名 /me/mailFolders/inbox 解析：displayName 随邮箱界面语言
      // 本地化，字符串匹配不可靠；也不能退化为取第一个文件夹（那可能是任意文件夹）。
      const inbox = await getWellKnownInboxFolder(accessToken, this.settings.proxyUrl, guard.requestSignal());
      guard.assertCurrent();
      return inbox;
    } catch (error) {
      guard.assertCurrent();
      // 已知名解析失败（如旧版接口差异）时回退到文件夹列表匹配；仍找不到则报
      // MAILBOX_NOT_FOUND，绝不再静默取第一个文件夹。
      const fallback = pickInboxFolder(
        await listMailFolders(accessToken, this.settings.proxyUrl, guard.requestSignal())
      );
      guard.assertCurrent();
      if (fallback) {
        return fallback;
      }
      throw error;
    }
  }

  private async listGraphInboxMessages(
    accessToken: string,
    account: Awaited<ReturnType<typeof getAccountRecord>>,
    top: number,
    since: string | null,
    guard: MailboxOperationGuard
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
          messages: await listMessages(
            accessToken,
            account.inboxFolderId,
            top,
            0,
            "",
            since,
            this.settings.proxyUrl,
            guard.requestSignal()
          )
        };
      } catch (error) {
        guard.assertCurrent();
        if (!shouldRediscoverGraphMailbox(error)) {
          throw error;
        }
      }
    }

    const inbox = await this.discoverGraphInbox(accessToken, guard);
    if (!inbox) {
      return { inbox: null, messages: [] };
    }
    return {
      inbox,
      messages: await listMessages(
        accessToken,
        inbox.id,
        top,
        0,
        "",
        since,
        this.settings.proxyUrl,
        guard.requestSignal()
      )
    };
  }

  private async deltaGraphInboxMessages(
    accessToken: string,
    account: Awaited<ReturnType<typeof getAccountRecord>>,
    top: number,
    guard: MailboxOperationGuard
  ) {
    const inbox = account.inboxFolderId
      ? {
          id: account.inboxFolderId,
          displayName: "Inbox",
          totalItemCount: account.lastInboxCount || 0,
          unreadItemCount: 0
        }
      : await this.discoverGraphInbox(accessToken, guard);
    if (!inbox) {
      return { inbox: null, messages: [], deltaLink: account.graphDeltaLink || null };
    }

    try {
      const result = await deltaMessages(
        accessToken,
        inbox.id,
        top,
        account.graphDeltaLink || null,
        3,
        this.settings.proxyUrl,
        guard.requestSignal()
      );
      return {
        inbox,
        messages: result.messages,
        deltaLink: result.deltaLink || result.nextLink || account.graphDeltaLink || null
      };
    } catch (error) {
      guard.assertCurrent();
      if (!shouldRediscoverGraphMailbox(error)) {
        throw error;
      }
      const fallback = await this.listGraphInboxMessages(
        accessToken,
        { ...account, inboxFolderId: inbox.id, graphDeltaLink: null },
        top,
        account.lastMailAt || null,
        guard
      );
      return { inbox: fallback.inbox, messages: fallback.messages, deltaLink: null };
    }
  }
}

export function createMailboxAccess(settingsSnapshot: RuntimeSettingsSnapshot): MailboxAccess {
  return new DefaultMailboxAccess(settingsSnapshot);
}

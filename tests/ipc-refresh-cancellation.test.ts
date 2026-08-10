import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from "../electron/shared/ipc-contracts.js";

const state = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();

  return {
    handlers,
    tokenStarted: null as Promise<AbortSignal> | null,
    resolveTokenStarted: null as ((signal: AbortSignal) => void) | null,
    statusWriteStarted: null as Promise<void> | null,
    resolveStatusWriteStarted: null as (() => void) | null,
    releaseStatusWrite: null as (() => void) | null,
    refreshAccessToken: vi.fn(),
    listMailFolders: vi.fn(),
    listImapFolders: vi.fn(),
    listImapMessages: vi.fn(),
    refreshImapInbox: vi.fn(),
    imapGetMessage: vi.fn(),
    graphGetMessage: vi.fn(),
    fallbackGetMessages: vi.fn(),
    fallbackGetMessage: vi.fn(),
    getCachedMessageDetail: vi.fn(),
    saveCachedMessages: vi.fn(),
    saveCachedMessageDetail: vi.fn(),
    updateAccountRefreshFailure: vi.fn(),
    updateAccountRefreshState: vi.fn(),
    updateAccountStatus: vi.fn()
  };
});

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler);
    })
  }
}));

vi.mock("../electron/main/mail-cache.js", () => ({
  clearAccountCache: vi.fn(),
  clearAllMailCache: vi.fn(),
  getCachedCursor: vi.fn(),
  getCachedMessageDetail: state.getCachedMessageDetail,
  getCachedMessages: vi.fn(),
  saveCachedMessageDetail: state.saveCachedMessageDetail,
  saveCachedMessages: state.saveCachedMessages
}));

vi.mock("../electron/main/account-store.js", () => ({
  assertAccountCredentialGeneration: vi.fn(),
  deleteAccount: vi.fn(),
  findAccountIdsByEmails: vi.fn(),
  getAccountCredentials: vi.fn(async (accountId: string) => ({
    accountId,
    email: "account@example.com",
    clientId: "client-id",
    refreshToken: "refresh-token",
    credentialGeneration: 0,
    account: {
      id: accountId,
      email: "account@example.com",
      clientId: "client-id",
      encryptedRefreshToken: "encrypted",
      remark: "",
      group: "",
      status: "valid",
      lastCheckedAt: null,
      lastError: null,
      inboxFolderId: "INBOX"
    }
  })),
  getAccountRecord: vi.fn(async (id: string) => ({
    id,
    email: "account@example.com",
    clientId: "client-id",
    encryptedRefreshToken: "encrypted",
    remark: "",
    group: "",
    status: "untested",
    lastCheckedAt: null,
    lastError: null,
    lastRefreshedAt: null,
    lastInboxCount: 0,
    lastMailAt: null,
    lastMailCursor: null,
    inboxFolderId: null,
    graphDeltaLink: null,
    refreshCooldownUntil: null
  })),
  listAccounts: vi.fn(),
  previewAccounts: vi.fn(),
  updateAccount: vi.fn(),
  updateAccountInboxFolder: vi.fn(),
  updateAccountRefreshFailure: state.updateAccountRefreshFailure,
  updateAccountRefreshState: state.updateAccountRefreshState,
  updateAccountStatus: state.updateAccountStatus,
  upsertAccounts: vi.fn()
}));

vi.mock("../electron/main/graph-client.js", () => ({
  deltaMessages: vi.fn(),
  getMessage: state.graphGetMessage,
  listMailFolders: state.listMailFolders,
  listMessages: vi.fn(),
  refreshAccessToken: state.refreshAccessToken
}));

vi.mock("../electron/main/imap-client.js", () => ({
  getImapMessage: state.imapGetMessage,
  listImapFolders: state.listImapFolders,
  listImapMessages: state.listImapMessages,
  refreshImapInbox: state.refreshImapInbox
}));

vi.mock("../electron/main/hotmail-fallback-client.js", () => ({
  fetchHotmailFallbackMessage: state.fallbackGetMessage,
  fetchHotmailFallbackMessages: state.fallbackGetMessages,
  isHotmailFallbackEnabled: vi.fn(() => true),
  testHotmailFallbackConnection: vi.fn()
}));

vi.mock("../electron/main/import-parser.js", () => ({ parseAccountImport: vi.fn() }));
vi.mock("../electron/main/proxy-agent.js", () => ({ closeProxyDispatchers: vi.fn() }));
vi.mock("../electron/main/settings-store.js", () => ({
  getPublicSettings: vi.fn(),
  getSettings: vi.fn(async () => ({
    proxyUrl: "",
    batchConcurrency: 2,
    cacheMessages: 100,
    cacheBodies: true,
    hotmailFallbackEnabled: true
  })),
  updateSettings: vi.fn()
}));

beforeEach(() => {
  state.handlers.clear();
  vi.clearAllMocks();
  state.tokenStarted = new Promise<AbortSignal>((resolve) => {
    state.resolveTokenStarted = resolve;
  });
  state.statusWriteStarted = new Promise<void>((resolve) => {
    state.resolveStatusWriteStarted = resolve;
  });
  const statusRelease = new Promise<void>((resolve) => {
    state.releaseStatusWrite = resolve;
  });
  state.refreshAccessToken.mockImplementation(
    (_clientId: string, _refreshToken: string, _proxyUrl: string, signal: AbortSignal) => {
      state.resolveTokenStarted?.(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  );
  state.listMailFolders.mockResolvedValue([]);
  state.listImapFolders.mockResolvedValue([]);
  state.listImapMessages.mockResolvedValue({ messages: [], totalCount: 0 });
  state.refreshImapInbox.mockResolvedValue({
    messages: [],
    totalCount: 0,
    inboxFolderId: "INBOX",
    cursor: null
  });
  state.imapGetMessage.mockResolvedValue(undefined);
  state.getCachedMessageDetail.mockResolvedValue(null);
  state.updateAccountStatus.mockImplementation(async (...args: unknown[]) => {
    state.resolveStatusWriteStarted?.();
    await statusRelease;
    (args[4] as { assertCurrent?: () => void } | undefined)?.assertCurrent?.();
    return { id: "account-1" };
  });
});

describe("IPC refresh cancellation", () => {
  it("aborts active token I/O without committing cache or account state", async () => {
    const { registerIpcHandlers } = await import("../electron/main/ipc.js");
    registerIpcHandlers();
    const event = { sender: { send: vi.fn() } };
    const refreshHandler = state.handlers.get(IPC_CHANNELS.mailRefreshMany);
    const cancelHandler = state.handlers.get(IPC_CHANNELS.jobsCancel);
    expect(refreshHandler).toBeTypeOf("function");
    expect(cancelHandler).toBeTypeOf("function");

    const pending = refreshHandler!(event, ["account-1"], "refresh") as Promise<Array<{ canceled?: boolean; code?: string }>>;
    const requestSignal = await state.tokenStarted!;

    await expect(cancelHandler!(event, "refresh")).resolves.toEqual({
      ok: true,
      value: { canceled: "refresh", count: 1 }
    });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      value: [{ canceled: true, error: { code: "CANCELED", retryable: false } }]
    });
    expect(requestSignal.aborted).toBe(true);
    expect(state.saveCachedMessages).not.toHaveBeenCalled();
    expect(state.saveCachedMessageDetail).not.toHaveBeenCalled();
    expect(state.updateAccountRefreshState).not.toHaveBeenCalled();
    expect(state.updateAccountRefreshFailure).not.toHaveBeenCalled();
    expect(state.updateAccountStatus).not.toHaveBeenCalled();
  });

  it("emits only canceled progress when cancellation wins inside a status write", async () => {
    state.refreshAccessToken.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: null,
      expiresIn: 3_600,
      scope: "Mail.Read",
      authMode: "graph"
    });
    state.listMailFolders.mockRejectedValue(new Error("Graph unavailable"));
    const { registerIpcHandlers } = await import("../electron/main/ipc.js");
    registerIpcHandlers();
    const event = { sender: { send: vi.fn() } };
    const testHandler = state.handlers.get(IPC_CHANNELS.accountsTestMany);
    const cancelHandler = state.handlers.get(IPC_CHANNELS.jobsCancel);

    const pending = testHandler!(event, ["account-1"]) as Promise<Array<{ code?: string }>>;
    await state.statusWriteStarted;
    await cancelHandler!(event, "test");
    state.releaseStatusWrite?.();

    await expect(pending).resolves.toMatchObject({
      ok: true,
      value: [{ error: { code: "CANCELED", retryable: false } }]
    });
    const progressEvents = event.sender.send.mock.calls.filter(
      ([channel]) => channel === "accounts:testProgress"
    );
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.[1]).toMatchObject({
      failed: 1,
      completed: 1,
      error: { code: "CANCELED", message: "批量测试已取消", retryable: false }
    });
  });

  it("loads and caches one fallback detail when a numeric IMAP message is opened", async () => {
    state.refreshAccessToken.mockResolvedValue({
      accessToken: "graph-access-token",
      refreshToken: null,
      expiresIn: 3_600,
      scope: "Mail.Read",
      authMode: "graph"
    });
    state.graphGetMessage.mockRejectedValue(new Error("Graph message unavailable"));
    const detail = {
      id: "42",
      subject: "Fallback detail",
      from: null,
      receivedDateTime: null,
      sentDateTime: null,
      isRead: false,
      importance: "normal",
      hasAttachments: false,
      bodyPreview: "detail",
      webLink: null,
      toRecipients: [],
      ccRecipients: [],
      body: { contentType: "text", content: "lazy fallback body" }
    };
    state.fallbackGetMessage.mockResolvedValue({
      detail,
      transport: "builtin-live",
      nextRefreshToken: null,
      inboxFolderId: "INBOX"
    });
    const { registerIpcHandlers } = await import("../electron/main/ipc.js");
    registerIpcHandlers();
    const handler = state.handlers.get(IPC_CHANNELS.mailGetMessage);

    await expect(handler!({ sender: { send: vi.fn() } }, {
      accountId: "account-detail",
      messageId: "42"
    })).resolves.toEqual({ ok: true, value: detail });
    expect(state.fallbackGetMessage).toHaveBeenCalledTimes(1);
    expect(state.saveCachedMessageDetail).toHaveBeenCalledWith(
      "account-detail",
      detail,
      true,
      expect.objectContaining({ assertCurrent: expect.any(Function) })
    );
  });

  it("does not start a network fallback when an IMAP list cache write fails", async () => {
    state.refreshAccessToken.mockResolvedValue({
      accessToken: "imap-access-token",
      refreshToken: null,
      expiresIn: 3_600,
      scope: "IMAP.AccessAsUser.All",
      authMode: "imap"
    });
    state.listImapFolders.mockResolvedValue([{
      id: "INBOX",
      displayName: "Inbox",
      totalItemCount: 1,
      unreadItemCount: 0
    }]);
    state.listImapMessages.mockResolvedValue({ messages: [], totalCount: 1 });
    state.saveCachedMessages.mockRejectedValueOnce(new Error("cache disk full"));
    state.fallbackGetMessages.mockResolvedValue({
      messages: [],
      transport: "builtin-live",
      nextRefreshToken: null,
      totalCount: 0,
      inboxFolderId: "INBOX",
      cursor: null
    });
    const { registerIpcHandlers } = await import("../electron/main/ipc.js");
    registerIpcHandlers();
    const handler = state.handlers.get(IPC_CHANNELS.mailListMessages);

    await expect(handler!({ sender: { send: vi.fn() } }, {
      accountId: "account-list",
      forceRefresh: true
    })).resolves.toEqual({
      ok: false,
      error: {
        code: "UNKNOWN",
        message: "操作失败，请重试；如果问题持续，请检查应用日志。",
        retryable: false
      }
    });
    expect(state.fallbackGetMessages).not.toHaveBeenCalled();
  });

  it("does not retry a typed mail parse failure through the detail fallback", async () => {
    const { MailParseFailedError } = await import("../electron/main/mail-errors.js");
    state.refreshAccessToken.mockResolvedValue({
      accessToken: "imap-access-token",
      refreshToken: null,
      expiresIn: 3_600,
      scope: "IMAP.AccessAsUser.All",
      authMode: "imap"
    });
    state.listImapFolders.mockResolvedValue([{
      id: "INBOX",
      displayName: "Inbox",
      totalItemCount: 1,
      unreadItemCount: 0
    }]);
    state.imapGetMessage.mockRejectedValue(new MailParseFailedError(
      new Error("Max allowed child nodes exceeded")
    ));
    const { registerIpcHandlers } = await import("../electron/main/ipc.js");
    registerIpcHandlers();
    const handler = state.handlers.get(IPC_CHANNELS.mailGetMessage);

    await expect(handler!({ sender: { send: vi.fn() } }, {
      accountId: "account-parse",
      messageId: "42"
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "MAIL_PARSE_FAILED",
        message: expect.stringContaining("Max allowed child nodes exceeded"),
        retryable: false
      }
    });
    expect(state.fallbackGetMessage).not.toHaveBeenCalled();
  });

  it("does not start a fallback after credentials become stale", async () => {
    const { CredentialsChangedError } = await import("../electron/main/credential-generations.js");
    state.refreshAccessToken.mockResolvedValue({
      accessToken: "imap-access-token",
      refreshToken: null,
      expiresIn: 3_600,
      scope: "IMAP.AccessAsUser.All",
      authMode: "imap"
    });
    state.listImapFolders.mockResolvedValue([{
      id: "INBOX",
      displayName: "Inbox",
      totalItemCount: 1,
      unreadItemCount: 0
    }]);
    state.imapGetMessage.mockRejectedValue(new CredentialsChangedError());
    const { registerIpcHandlers } = await import("../electron/main/ipc.js");
    registerIpcHandlers();
    const handler = state.handlers.get(IPC_CHANNELS.mailGetMessage);

    await expect(handler!({ sender: { send: vi.fn() } }, {
      accountId: "account-stale",
      messageId: "42"
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "STALE_CREDENTIALS",
        retryable: true
      }
    });
    expect(state.fallbackGetMessage).not.toHaveBeenCalled();
  });

  it("preserves stale credential errors from a searched message list", async () => {
    const { CredentialsChangedError } = await import("../electron/main/credential-generations.js");
    state.refreshAccessToken.mockRejectedValue(new CredentialsChangedError());
    const { registerIpcHandlers } = await import("../electron/main/ipc.js");
    registerIpcHandlers();
    const handler = state.handlers.get(IPC_CHANNELS.mailListMessages);

    await expect(handler!({ sender: { send: vi.fn() } }, {
      accountId: "account-stale-list",
      forceRefresh: true,
      search: "invoice"
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "STALE_CREDENTIALS",
        retryable: true
      }
    });
    expect(state.fallbackGetMessages).not.toHaveBeenCalled();
  });

  it("does not start a network fallback when an IMAP refresh cache write fails", async () => {
    state.refreshAccessToken.mockResolvedValue({
      accessToken: "imap-access-token",
      refreshToken: null,
      expiresIn: 3_600,
      scope: "IMAP.AccessAsUser.All",
      authMode: "imap"
    });
    state.refreshImapInbox.mockResolvedValue({
      messages: [{
        id: "42",
        subject: "Summary",
        from: null,
        receivedDateTime: "2026-08-10T00:00:00.000Z",
        sentDateTime: null,
        isRead: false,
        importance: "normal",
        hasAttachments: false,
        bodyPreview: "",
        webLink: null
      }],
      totalCount: 1,
      inboxFolderId: "INBOX",
      cursor: "42"
    });
    state.saveCachedMessages.mockRejectedValueOnce(new Error("refresh cache disk full"));
    state.fallbackGetMessages.mockResolvedValue({
      messages: [],
      transport: "builtin-live",
      nextRefreshToken: null,
      totalCount: 0,
      inboxFolderId: "INBOX",
      cursor: null
    });
    const { registerIpcHandlers } = await import("../electron/main/ipc.js");
    registerIpcHandlers();
    const handler = state.handlers.get(IPC_CHANNELS.mailRefreshMany);

    const event = { sender: { send: vi.fn() } };
    await expect(handler!(event, ["account-refresh"])).resolves.toMatchObject({
      ok: true,
      value: [{
        accountId: "account-refresh",
        ok: false,
        error: {
          code: "UNKNOWN",
          message: "操作失败，请重试；如果问题持续，请检查应用日志。",
          retryable: false
        }
      }]
    });
    expect(event.sender.send).toHaveBeenCalledWith(
      IPC_EVENT_CHANNELS.mailRefreshProgress,
      expect.objectContaining({
        error: {
          code: "UNKNOWN",
          message: "操作失败，请重试；如果问题持续，请检查应用日志。",
          retryable: false
        }
      })
    );
    expect(state.updateAccountRefreshFailure).toHaveBeenCalledWith(
      "account-refresh",
      expect.objectContaining({
        lastError: "操作失败，请重试；如果问题持续，请检查应用日志。"
      }),
      expect.any(Object)
    );
    expect(state.fallbackGetMessages).not.toHaveBeenCalled();
  });

  it("keeps an account usable when a connection test hits a retryable network error", async () => {
    state.refreshAccessToken.mockRejectedValue(Object.assign(new Error("request failed"), { code: "ENOTFOUND" }));
    state.updateAccountStatus.mockResolvedValue({ id: "account-network", status: "untested" });
    const { registerIpcHandlers } = await import("../electron/main/ipc.js");
    registerIpcHandlers();
    const handler = state.handlers.get(IPC_CHANNELS.accountsTest);

    await expect(handler!({ sender: { send: vi.fn() } }, "account-network")).resolves.toMatchObject({
      ok: true,
      value: {
        ok: false,
        account: { id: "account-network" },
        error: { code: "NETWORK_ERROR", retryable: true }
      }
    });
    expect(state.updateAccountStatus).toHaveBeenCalledWith(
      "account-network",
      "untested",
      expect.stringContaining("网络连接失败"),
      undefined,
      expect.any(Object)
    );
  });
});

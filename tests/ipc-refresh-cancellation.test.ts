import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../electron/shared/ipc-contracts.js";

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
  getCachedMessageDetail: vi.fn(),
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
    credentialGeneration: 0
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
  updateAccountRefreshFailure: state.updateAccountRefreshFailure,
  updateAccountRefreshState: state.updateAccountRefreshState,
  updateAccountStatus: state.updateAccountStatus,
  upsertAccounts: vi.fn()
}));

vi.mock("../electron/main/graph-client.js", () => ({
  deltaMessages: vi.fn(),
  getMessage: vi.fn(),
  listMailFolders: state.listMailFolders,
  listMessages: vi.fn(),
  refreshAccessToken: state.refreshAccessToken
}));

vi.mock("../electron/main/imap-client.js", () => ({
  getImapMessage: vi.fn(),
  listImapFolders: vi.fn(),
  listImapMessages: vi.fn(),
  refreshImapInbox: vi.fn()
}));

vi.mock("../electron/main/hotmail-fallback-client.js", () => ({
  fetchHotmailFallbackMessages: vi.fn(),
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

    await expect(cancelHandler!(event, "refresh")).resolves.toEqual({ canceled: "refresh", count: 1 });
    await expect(pending).resolves.toMatchObject([{ canceled: true, code: "CANCELED" }]);
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

    await expect(pending).resolves.toMatchObject([{ code: "CANCELED" }]);
    const progressEvents = event.sender.send.mock.calls.filter(
      ([channel]) => channel === "accounts:testProgress"
    );
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.[1]).toMatchObject({ failed: 1, completed: 1, error: "批量测试已取消" });
  });
});

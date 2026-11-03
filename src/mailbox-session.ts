import { errorMessage } from "./app-error";
import { resolveVisibleMailCursor } from "./mail-pagination";
import type {
  GetMessageOptions,
  ListMessagesOptions,
  MailFolder,
  MailListResult,
  MailMessageDetail,
  MailMessageSummary
} from "./types";

export interface MailboxSessionAdapter {
  listMessages(options: ListMessagesOptions): Promise<MailListResult>;
  getMessage(options: GetMessageOptions): Promise<MailMessageDetail>;
  listFolders(accountId: string): Promise<MailFolder[]>;
}

export interface MailboxSessionState {
  readonly accountId: string | null;
  readonly query: string;
  readonly folders: readonly MailFolder[];
  readonly selectedFolderId: string | null;
  readonly messages: readonly MailMessageSummary[];
  readonly selectedMessageId: string | null;
  readonly messageDetail: MailMessageDetail | null;
  readonly cursor: string | null;
  readonly totalCount: number | null;
  readonly loadingMessages: boolean;
  readonly loadingMore: boolean;
  readonly loadingDetail: boolean;
  readonly error: string;
}

export interface MailboxSession {
  readonly getSnapshot: () => MailboxSessionState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly selectAccount: (accountId: string | null, totalCount?: number | null) => void;
  readonly selectFolder: (folderId: string | null) => void;
  readonly reconcileAccounts: (
    accounts: readonly { id: string; lastInboxCount?: number | null }[]
  ) => void;
  readonly isCurrentAccount: (accountId: string) => boolean;
  readonly updateTotalCount: (totalCount?: number | null) => void;
  readonly search: (query: string) => Promise<void>;
  readonly reload: (forceRefresh?: boolean) => Promise<void>;
  readonly reloadIfCurrentAccount: (
    accountIds: readonly string[],
    forceRefresh?: boolean
  ) => Promise<boolean>;
  readonly loadMore: () => Promise<void>;
  readonly selectMessage: (messageId: string | null) => Promise<void>;
  readonly clearError: () => void;
  readonly dispose: () => void;
}

interface MailboxSessionOptions {
  readonly pageSize?: number;
  readonly selectionDelayMs?: number;
}

export const EMPTY_MAILBOX_SESSION_STATE: MailboxSessionState = Object.freeze({
  accountId: null,
  query: "",
  folders: [],
  selectedFolderId: null,
  messages: [],
  selectedMessageId: null,
  messageDetail: null,
  cursor: null,
  totalCount: null,
  loadingMessages: false,
  loadingMore: false,
  loadingDetail: false,
  error: ""
});

function mergeMessages(
  current: readonly MailMessageSummary[],
  incoming: readonly MailMessageSummary[]
): MailMessageSummary[] {
  const merged = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    merged.set(message.id, message);
  }
  return Array.from(merged.values());
}

class DefaultMailboxSession implements MailboxSession {
  private state: MailboxSessionState = EMPTY_MAILBOX_SESSION_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly pageSize: number;
  private readonly selectionDelayMs: number;
  private listGeneration = 0;
  private detailGeneration = 0;
  private foldersGeneration = 0;
  private listError = "";
  private detailError = "";
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly adapter: MailboxSessionAdapter,
    options: MailboxSessionOptions
  ) {
    this.pageSize = options.pageSize ?? 50;
    this.selectionDelayMs = options.selectionDelayMs ?? 180;
  }

  readonly getSnapshot = () => this.state;

  readonly subscribe = (listener: () => void) => {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly selectAccount = (accountId: string | null, totalCount: number | null = null) => {
    if (this.state.accountId === accountId) {
      this.updateTotalCount(totalCount);
      return;
    }

    this.cancelSelectionTimer();
    this.listGeneration += 1;
    this.detailGeneration += 1;
    this.foldersGeneration += 1;
    this.listError = "";
    this.detailError = "";
    this.replaceState({
      ...EMPTY_MAILBOX_SESSION_STATE,
      accountId,
      query: this.state.query,
      totalCount: totalCount ?? null
    });

    if (!accountId || this.disposed) {
      return;
    }

    void this.loadFolders(accountId);
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      void this.reload();
    }, this.selectionDelayMs);
  };

  readonly selectFolder = (folderId: string | null) => {
    const normalized = folderId?.trim() || null;
    if (this.state.selectedFolderId === normalized) {
      return;
    }

    this.cancelSelectionTimer();
    this.listGeneration += 1;
    this.detailGeneration += 1;
    this.listError = "";
    this.detailError = "";
    // 切换文件夹后列表、游标、正文详情全部失效；query 保留在当前文件夹内继续搜索。
    this.replaceState({
      ...this.state,
      selectedFolderId: normalized,
      messages: [],
      selectedMessageId: null,
      messageDetail: null,
      cursor: null,
      totalCount: null,
      loadingMessages: false,
      loadingMore: false,
      loadingDetail: false
    });

    if (!this.state.accountId || this.disposed) {
      return;
    }
    void this.reload();
  };

  private async loadFolders(accountId: string) {
    const generation = this.foldersGeneration + 1;
    this.foldersGeneration = generation;
    try {
      const folders = await this.adapter.listFolders(accountId);
      if (this.disposed || generation !== this.foldersGeneration || this.state.accountId !== accountId) {
        return;
      }
      // 列文件夹失败或为空时保持 inbox-only 状态（下拉框隐藏），不阻断邮件读取。
      this.updateState({ folders: folders.filter((folder) => folder.id.trim() && folder.displayName.trim()) });
    } catch {
      if (this.disposed || generation !== this.foldersGeneration || this.state.accountId !== accountId) {
        return;
      }
      this.updateState({ folders: [] });
    }
  }

  readonly reconcileAccounts = (
    accounts: readonly { id: string; lastInboxCount?: number | null }[]
  ) => {
    const selected = accounts.find((account) => account.id === this.state.accountId);
    if (selected) {
      this.updateTotalCount(selected.lastInboxCount);
      return;
    }
    const first = accounts[0];
    this.selectAccount(first?.id || null, first?.lastInboxCount ?? null);
  };

  readonly isCurrentAccount = (accountId: string) =>
    !this.disposed && this.state.accountId === accountId;

  readonly updateTotalCount = (totalCount: number | null = null) => {
    const nextTotalCount = totalCount ?? null;
    const cursor = resolveVisibleMailCursor({
      cursor: this.state.cursor,
      displayedCount: this.state.messages.length,
      totalCount: nextTotalCount
    });
    if (this.state.totalCount !== nextTotalCount || this.state.cursor !== cursor) {
      this.updateState({ totalCount: nextTotalCount, cursor });
    }
  };

  readonly search = async (query: string) => {
    const normalizedQuery = query.trim();
    if (this.state.query !== normalizedQuery) {
      this.updateState({ query: normalizedQuery });
    }
    await this.reload();
  };

  readonly reload = async (forceRefresh = false) => {
    this.cancelSelectionTimer();
    const accountId = this.state.accountId;
    if (!accountId || this.disposed) {
      return;
    }

    const query = this.state.query;
    const folderId = this.state.selectedFolderId;
    const generation = this.listGeneration + 1;
    this.listGeneration = generation;
    this.detailGeneration += 1;
    this.listError = "";
    this.detailError = "";
    // 防白闪：刷新期间保留旧列表、选中项和正文，只在 loadingMessages 上打标记，
    // 成功后整体替换；旧列表仍可浏览但不可换选（避免选中项被即将到来的替换清掉）。
    this.updateState({
      loadingMessages: true,
      loadingMore: false,
      ...this.errorPatch()
    });

    try {
      const result = await this.adapter.listMessages({
        accountId,
        top: this.pageSize,
        search: query,
        forceRefresh,
        ...(folderId ? { folderId } : {})
      });
      if (!this.isCurrentList(generation, accountId, query, folderId)) {
        return;
      }

      const messages = [...result.messages];
      const totalCount = result.totalCount ?? this.state.totalCount;
      // 替换旧列表后选中第一封；若旧选中项仍在断列表里则保持选中不换行，避免阅读位置跳变。
      const previousSelection = this.state.selectedMessageId;
      const selectedMessageId = previousSelection && messages.some((message) => message.id === previousSelection)
        ? previousSelection
        : messages[0]?.id || null;
      const selectionChanged = selectedMessageId !== previousSelection;
      this.updateState({
        messages,
        selectedMessageId,
        messageDetail: selectionChanged ? null : this.state.messageDetail,
        cursor: resolveVisibleMailCursor({
          cursor: result.nextCursor,
          displayedCount: messages.length,
          totalCount
        }),
        totalCount: totalCount ?? null,
        loadingMessages: false,
        ...this.errorPatch("list", "")
      });

      if (selectedMessageId && selectionChanged) {
        void this.loadDetail(accountId, selectedMessageId);
      }
    } catch (error) {
      if (this.isCurrentList(generation, accountId, query, folderId)) {
        this.updateState({
          loadingMessages: false,
          ...this.errorPatch("list", errorMessage(error))
        });
      }
    }
  };

  readonly reloadIfCurrentAccount = async (
    accountIds: readonly string[],
    forceRefresh = false
  ) => {
    const accountId = this.state.accountId;
    if (!accountId || !accountIds.includes(accountId) || this.disposed) {
      return false;
    }
    await this.reload(forceRefresh);
    return true;
  };

  readonly loadMore = async () => {
    const { accountId, cursor, loadingMore, query, selectedFolderId } = this.state;
    if (!accountId || !cursor || loadingMore || this.disposed) {
      return;
    }

    const generation = this.listGeneration;
    this.updateState({ loadingMore: true, ...this.errorPatch("list", "") });
    try {
      const result = await this.adapter.listMessages({
        accountId,
        top: this.pageSize,
        search: query,
        cursor,
        ...(selectedFolderId ? { folderId: selectedFolderId } : {})
      });
      if (!this.isCurrentList(generation, accountId, query, selectedFolderId)) {
        return;
      }

      const messages = mergeMessages(this.state.messages, result.messages);
      const totalCount = result.totalCount ?? this.state.totalCount;
      this.updateState({
        messages,
        cursor: resolveVisibleMailCursor({
          cursor: result.messages.length === 0 ? null : result.nextCursor,
          displayedCount: messages.length,
          totalCount
        }),
        totalCount: totalCount ?? null,
        loadingMore: false,
        ...this.errorPatch("list", "")
      });
    } catch (error) {
      if (this.isCurrentList(generation, accountId, query, selectedFolderId)) {
        this.updateState({
          loadingMore: false,
          ...this.errorPatch("list", errorMessage(error))
        });
      }
    }
  };

  readonly selectMessage = async (messageId: string | null) => {
    const accountId = this.state.accountId;
    if (!accountId || !messageId || this.disposed) {
      this.detailGeneration += 1;
      this.updateState({
        selectedMessageId: messageId,
        messageDetail: null,
        loadingDetail: false,
        ...this.errorPatch("detail", "")
      });
      return;
    }
    if (
      this.state.selectedMessageId === messageId &&
      (this.state.messageDetail?.id === messageId || this.state.loadingDetail)
    ) {
      return;
    }

    this.updateState({ selectedMessageId: messageId, messageDetail: null });
    await this.loadDetail(accountId, messageId);
  };
  readonly clearError = () => {
    this.listError = "";
    this.detailError = "";
    if (this.state.error) {
      this.updateState({ error: "" });
    }
  };

  readonly dispose = () => {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelSelectionTimer();
    this.listGeneration += 1;
    this.detailGeneration += 1;
    this.foldersGeneration += 1;
    this.listeners.clear();
  };

  private async loadDetail(accountId: string, messageId: string) {
    const generation = this.detailGeneration + 1;
    this.detailGeneration = generation;
    const folderId = this.state.selectedFolderId;
    this.updateState({
      loadingDetail: true,
      messageDetail: null,
      ...this.errorPatch("detail", "")
    });
    try {
      const detail = await this.adapter.getMessage({
        accountId,
        messageId,
        ...(folderId ? { folderId } : {})
      });
      if (this.isCurrentDetail(generation, accountId, messageId, folderId)) {
        this.updateState({
          messageDetail: detail,
          loadingDetail: false,
          ...this.errorPatch("detail", "")
        });
      }
    } catch (error) {
      if (this.isCurrentDetail(generation, accountId, messageId, folderId)) {
        this.updateState({
          loadingDetail: false,
          ...this.errorPatch("detail", errorMessage(error))
        });
      }
    }
  }

  private isCurrentList(generation: number, accountId: string, query: string, folderId: string | null) {
    return !this.disposed &&
      this.listGeneration === generation &&
      this.state.accountId === accountId &&
      this.state.query === query &&
      this.state.selectedFolderId === folderId;
  }

  private isCurrentDetail(generation: number, accountId: string, messageId: string, folderId: string | null) {
    return !this.disposed &&
      this.detailGeneration === generation &&
      this.state.accountId === accountId &&
      this.state.selectedMessageId === messageId &&
      this.state.selectedFolderId === folderId;
  }

  private updateState(patch: Partial<MailboxSessionState>) {
    this.replaceState({ ...this.state, ...patch });
  }

  private errorPatch(source?: "list" | "detail", error = "") {
    if (source === "list") {
      this.listError = error;
    } else if (source === "detail") {
      this.detailError = error;
    }
    return { error: this.listError || this.detailError };
  }

  private replaceState(state: MailboxSessionState) {
    if (this.disposed) {
      return;
    }
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private cancelSelectionTimer() {
    if (this.selectionTimer !== null) {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = null;
    }
  }
}

export function createMailboxSession(
  adapter: MailboxSessionAdapter,
  options: MailboxSessionOptions = {}
): MailboxSession {
  return new DefaultMailboxSession(adapter, options);
}

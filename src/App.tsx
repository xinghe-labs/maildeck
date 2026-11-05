import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountSidebar } from "./components/AccountSidebar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ErrorBanner } from "./components/ErrorBanner";
import { ImportModal } from "./components/ImportModal";
import { MailReader } from "./components/MailReader";
import { MessageList } from "./components/MessageList";
import { ModalShell } from "./components/ModalShell";
import { SettingsModal } from "./components/SettingsModal";
import { getDesktopApi } from "./desktop-api";
import { splitErrorMessage } from "./error-display";
import type {
  AccountUpdateInput,
  AccountView,
  AppSettings,
  RefreshManyResult
} from "./types";
import { accountInboxSummary } from "./ui-utils";
import { errorMessage } from "./app-error";
import { useAccountCatalogSession } from "./use-account-catalog-session";
import { useMailboxSession } from "./use-mailbox-session";
import { useRefreshJobSession } from "./use-refresh-job-session";

const defaultSettings: AppSettings = {
  cacheMessages: true,
  cacheBodies: true,
  proxyUrl: "",
  proxyUsername: "",
  proxyHasPassword: false,
  proxySupported: true,
  batchConcurrency: 4,
  hotmailFallbackEnabled: true,
  autoRefreshEnabled: false,
  autoRefreshIntervalMinutes: 10
};

function EditAccountModal({
  account,
  onClose,
  onSubmit,
  onSaved
}: {
  account: AccountView;
  onClose: () => void;
  onSubmit: (input: AccountUpdateInput) => Promise<AccountView | null>;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<AccountUpdateInput>({
    id: account.id,
    email: account.email,
    clientId: account.clientId,
    refreshToken: "",
    remark: account.remark,
    group: account.group
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const updated = await onSubmit(form);
      if (!updated) {
        return;
      }
      onSaved();
      onClose();
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <ModalShell
      title="编辑邮箱"
      subtitle="Refresh Token 留空则保持不变"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="secondary-button dark-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button dark-primary" type="submit" disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <Pencil size={16} />}
            保存修改
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>
          邮箱
          <input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
        </label>
        <label>
          Client ID
          <input value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })} required />
        </label>
        <label className="span-2">
          Refresh Token
          <textarea value={form.refreshToken} onChange={(event) => setForm({ ...form, refreshToken: event.target.value })} />
        </label>
        <label>
          备注
          <input value={form.remark} onChange={(event) => setForm({ ...form, remark: event.target.value })} />
        </label>
        <label>
          分组
          <input value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })} />
        </label>
      </div>
      {error ? <div className="error-box">{error}</div> : null}
    </ModalShell>
  );
}
export default function App() {
  const [accountQuery, setAccountQuery] = useState("");
  const [mailQuery, setMailQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "valid" | "invalid" | "untested">("all");
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AccountView | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [testMenuOpen, setTestMenuOpen] = useState(false);
  const testMenuRef = useRef<HTMLDivElement | null>(null);
  const [newMailCounts, setNewMailCounts] = useState<Record<string, number>>({});
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AccountView | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const desktopApi = getDesktopApi();
  const accountCatalog = useAccountCatalogSession(desktopApi ?? null);
  const mailbox = useMailboxSession(desktopApi?.mail ?? null);
  const refreshJobs = useRefreshJobSession(desktopApi ?? null);
  const {
    accountId: selectedAccountId,
    cursor: mailCursor,
    error: mailboxError,
    folders,
    loadingDetail,
    loadingMessages,
    loadingMore,
    messageDetail,
    messages,
    selectedFolderId,
    selectedMessageId
  } = mailbox.state;
  const {
    accounts,
    fallbackTestingAccountIds,
    loadingAccounts,
    testingAccountIds
  } = accountCatalog.state;
  const {
    anyJobRunning,
    canRetryFailedRefresh,
    failedRefreshAccountIds,
    manualRefreshRunning,
    progressText,
    busyAccountIds,
    singleRefreshBlocked,
    testRunning,
    progress,
    backgroundProgressText
  } = refreshJobs.state;
  const busyAccountIdSet = useMemo(
    () => new Set(busyAccountIds),
    [busyAccountIds]
  );
  const [bulkTestAccountIds, setBulkTestAccountIds] = useState<ReadonlySet<string>>(new Set());
  const selectedAccountTesting = Boolean(
    selectedAccountId && (
      testingAccountIds.includes(selectedAccountId) ||
      fallbackTestingAccountIds.includes(selectedAccountId) ||
      // 批量测试运行中，被测账号集合已在主进程排队；为守住“同一账号只能运行
      // 一个连接测试”的不变量，禁止对这些账号再发起单账号测试。
      (bulkTestAccountIds?.has(selectedAccountId) ?? false)
    )
  );
  const displayedError = error || mailboxError;

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) || null,
    [accounts, selectedAccountId]
  );
  const selectedMessage = useMemo(
    () => messages.find((message) => message.id === selectedMessageId) || null,
    [messages, selectedMessageId]
  );

  const filteredAccounts = useMemo(() => {
    const query = accountQuery.trim().toLowerCase();

    return accounts.filter((account) => {
      const matchStatus = statusFilter === "all" || account.status === statusFilter;
      if (!matchStatus) {
        return false;
      }

      if (!query) {
        return true;
      }

      return [account.email, account.remark, account.group, account.status].some((value) =>
        value.toLowerCase().includes(query)
      );
    });
  }, [accounts, accountQuery, statusFilter]);

  const clearErrors = useCallback(() => {
    setError("");
    mailbox.clearError();
  }, [mailbox]);

  const loadAccounts = useCallback(
    async (forceReload = true) => {
      if (!desktopApi) {
        setError("当前页面未运行在 Electron 桌面环境中，请使用 npm run dev 启动桌面应用。");
        return;
      }
      clearErrors();

      try {
        await (forceReload ? accountCatalog.reload() : accountCatalog.load());
      } catch (loadError) {
        setError(errorMessage(loadError));
      }
    },
    [accountCatalog, clearErrors, desktopApi]
  );

  const loadSettings = useCallback(async () => {
    if (!desktopApi) {
      return;
    }

    try {
      setSettings(await desktopApi.settings.get());
    } catch (settingsError) {
      setError(errorMessage(settingsError));
    }
  }, [desktopApi]);

  const importFromFile = useCallback(async () => {
    if (!desktopApi) {
      setError("文件导入需要在 Electron 桌面应用中使用。");
      return;
    }

    clearErrors();

    try {
      const result = await accountCatalog.importFile();

      if (!result) {
        return;
      }

      setToast(`导入 ${result.imported} 个，更新 ${result.updated} 个，跳过 ${result.skipped} 个`);
    } catch (importError) {
      setError(errorMessage(importError));
    }
  }, [accountCatalog, clearErrors, desktopApi]);

  const testConnection = useCallback(
    async (accountId: string) => {
      setTestMenuOpen(false);
      if (!desktopApi) {
        setError("连接测试需要在 Electron 桌面应用中使用。");
        return;
      }
      const execution = accountCatalog.testConnection(accountId);
      if (!execution) {
        return;
      }
      clearErrors();

      try {
        const result = await execution;
        if (!result) {
          return;
        }
        if (result.ok) {
          setToast(result.message);
        } else {
          setError(result.error.message);
        }
      } catch (testError) {
        setError(errorMessage(testError));
      }
    },
    [accountCatalog, clearErrors, desktopApi]
  );

  const testFallback = useCallback(
    async (accountId: string) => {
      setTestMenuOpen(false);
      if (!desktopApi) {
        setError("兜底测试需要在 Electron 桌面应用中使用。");
        return;
      }
      const execution = accountCatalog.testFallback(accountId);
      if (!execution) {
        return;
      }
      clearErrors();

      try {
        const result = await execution;
        if (!result) {
          return;
        }
        if (result.ok) {
          setToast(result.message);
        } else {
          setError(result.error.message);
        }
      } catch (fallbackError) {
        setError(errorMessage(fallbackError));
      }
    },
    [accountCatalog, clearErrors, desktopApi]
  );

  const testFilteredAccounts = useCallback(async () => {
    const accountIds = filteredAccounts.map((account) => account.id);
    if (accountIds.length === 0) {
      return;
    }

    try {
      if (!desktopApi) {
        throw new Error("桌面接口不可用");
      }
      const accountVersionsAtStart = accountCatalog.getAccountVersions();
      setBulkTestAccountIds(new Set(accountIds));
      const execution = refreshJobs.runTest(accountIds);
      if (!execution) {
        setBulkTestAccountIds(new Set());
        return;
      }
      clearErrors();
      const results = await execution;
      setBulkTestAccountIds(new Set());
      if (!results) {
        return;
      }
      const validCount = results.filter((item) => item.ok).length;
      accountCatalog.mergeTestResults(results, accountVersionsAtStart);
      setToast(`已测试 ${results.length} 个账号：可用 ${validCount}、失效 ${results.length - validCount}`);
    } catch (testError) {
      setBulkTestAccountIds(new Set());
      setError(errorMessage(testError));
    }
  }, [accountCatalog, clearErrors, desktopApi, filteredAccounts, refreshJobs]);

  const cancelBulkTest = useCallback(async () => {
    const api = getDesktopApi();
    if (!api) {
      return;
    }

    try {
      const result = await refreshJobs.cancel("test");
      if (result) {
        setToast("正在取消批量测试");
      }
    } catch (cancelError) {
      setError(errorMessage(cancelError));
    }
  }, [refreshJobs]);

  const recordNewMailCounts = useCallback((results: RefreshManyResult[]) => {
    const increments: Record<string, number> = {};

    for (const result of results) {
      if (!result.ok || result.skipped || !result.newCount || result.newCount <= 0) {
        continue;
      }

      increments[result.accountId] = result.newCount;
    }

    if (Object.keys(increments).length > 0) {
      setNewMailCounts((current) => {
        const next = { ...current };
        for (const [accountId, increment] of Object.entries(increments)) {
          next[accountId] = (next[accountId] || 0) + increment;
        }
        return next;
      });
    }

    return Object.keys(increments).length;
  }, []);

  const refreshAccounts = useCallback(
    async (accountIds: string[], doneText = "已刷新", options: { silent?: boolean } = {}) => {
      if (accountIds.length === 0) {
        return;
      }

      if (!desktopApi) {
        setError("桌面接口不可用");
        return;
      }

      const kind = options.silent ? "refreshBackground" : "refresh";
      const execution = refreshJobs.runRefresh(accountIds, kind);
      if (!execution) {
        return;
      }
      if (!options.silent) {
        clearErrors();
      }

      try {
        const results = await execution;
        if (!results) {
          return;
        }
        const okCount = results.filter((item) => item.ok).length;
        await accountCatalog.reload();
        const changedCount = options.silent ? recordNewMailCounts(results) : 0;

        if (options.silent) {
          setToast(
            changedCount > 0
              ? `定时刷新发现 ${changedCount} 个账号有新邮件`
              : `定时刷新完成：成功 ${okCount}、失败 ${results.length - okCount}`
          );
        } else {
          setToast(`${doneText} ${results.length} 个账号：成功 ${okCount}、失败 ${results.length - okCount}`);
        }

        await mailbox.reloadIfCurrentAccount(accountIds);
      } catch (refreshError) {
        const message = errorMessage(refreshError);
        if (options.silent) {
          setToast(`定时刷新失败：${message}`);
        } else {
          setError(message);
        }
      }
    },
    [accountCatalog, clearErrors, desktopApi, mailbox, recordNewMailCounts, refreshJobs]
  );

  const refreshSingleAccount = useCallback(
    async (accountId: string) => {
      if (!desktopApi) {
        setError("桌面接口不可用");
        return;
      }

      const execution = refreshJobs.runRefresh([accountId], "refreshSingle");
      if (!execution) {
        return;
      }
      clearErrors();

      try {
        const results = await execution;
        if (!results) {
          return;
        }
        const result = results[0];
        const email = accounts.find((account) => account.id === accountId)?.email || "账号";
        await accountCatalog.reload();

        if (result?.ok) {
          setToast(`已刷新 ${email}`);
          await mailbox.reloadIfCurrentAccount([accountId]);
          return;
        }

        const refreshMessage = result?.error.message || "刷新账号失败";
        if (mailbox.isCurrentAccount(accountId)) {
          setError(refreshMessage);
        } else {
          setToast(`${email} 刷新失败：${splitErrorMessage(refreshMessage).title}`);
        }
      } catch (refreshError) {
        const refreshMessage = errorMessage(refreshError);
        if (mailbox.isCurrentAccount(accountId)) {
          setError(refreshMessage);
        } else {
          const email = accounts.find((account) => account.id === accountId)?.email || "账号";
          setToast(`${email} 刷新失败：${splitErrorMessage(refreshMessage).title}`);
        }
      }
    },
    [accounts, accountCatalog, clearErrors, desktopApi, mailbox, refreshJobs]
  );

  const cancelBulkRefresh = useCallback(async () => {
    const api = getDesktopApi();
    if (!api) {
      return;
    }

    try {
      const result = await refreshJobs.cancel("refresh");
      if (result) {
        setToast("正在取消批量刷新");
      }
    } catch (cancelError) {
      setError(errorMessage(cancelError));
    }
  }, [refreshJobs]);

  const refreshFilteredAccounts = useCallback(() => {
    // Fire-and-forget: `refreshAccounts` reports its own failures through setError/setToast.
    void refreshAccounts(
      filteredAccounts.map((account) => account.id),
      "已刷新"
    );
  }, [filteredAccounts, refreshAccounts]);

  const selectAccount = useCallback(
    (accountId: string) => {
      const account = accounts.find((item) => item.id === accountId);
      clearErrors();
      mailbox.selectAccount(accountId, account?.lastInboxCount ?? null);
      setNewMailCounts((current) => {
        if (!current[accountId]) {
          return current;
        }

        const next = { ...current };
        delete next[accountId];
        return next;
      });
    },
    [accounts, clearErrors, mailbox]
  );

  const retryFailedRefresh = useCallback(() => {
    void refreshAccounts([...failedRefreshAccountIds], "已重试");
  }, [failedRefreshAccountIds, refreshAccounts]);

  const executeMailSearch = useCallback(() => {
    clearErrors();
    void mailbox.search(mailQuery);
  }, [clearErrors, mailQuery, mailbox]);

  const clearMailSearch = useCallback(() => {
    setMailQuery("");
    void mailbox.search("");
  }, [mailbox]);

  const refreshMailbox = useCallback(() => {
    clearErrors();
    void mailbox.reload(true);
  }, [clearErrors, mailbox]);

  const openImportModal = useCallback(() => setShowImportModal(true), []);
  const openSettingsModal = useCallback(() => setShowSettingsModal(true), []);
  const reloadAccounts = useCallback(() => void loadAccounts(), [loadAccounts]);

  const selectFolder = useCallback(
    (folderId: string | null) => {
      clearErrors();
      mailbox.selectFolder(folderId);
    },
    [clearErrors, mailbox]
  );

  const selectMessage = useCallback(
    (messageId: string) => {
      clearErrors();
      void mailbox.selectMessage(messageId);
    },
    [clearErrors, mailbox]
  );

  const loadMoreMessages = useCallback(() => {
    clearErrors();
    void mailbox.loadMore();
  }, [clearErrors, mailbox]);

  const requestDeleteAccount = useCallback(() => {
    if (selectedAccount) {
      setDeleteTarget(selectedAccount);
    }
  }, [selectedAccount]);

  const confirmDeleteAccount = useCallback(async () => {
    const target = deleteTarget;
    if (!target) {
      return;
    }
    if (!desktopApi) {
      setError("账号管理需要在 Electron 桌面应用中使用。");
      setDeleteTarget(null);
      return;
    }

    setDeletingAccount(true);
    try {
      const nextAccounts = await accountCatalog.deleteAccount(target.id);
      if (!nextAccounts) {
        return;
      }
      setToast(`已删除 ${target.email}`);
      setDeleteTarget(null);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
      setDeleteTarget(null);
    } finally {
      setDeletingAccount(false);
    }
  }, [accountCatalog, deleteTarget, desktopApi]);

  useEffect(() => {
    // Fire-and-forget: both loaders catch their own errors and surface them in the UI.
    // 初始化只应执行一次，不随 session 门面函数身份变化重跑。
    void loadAccounts(false);
    void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only initialization
  }, []);

  useEffect(() => {
    // mailbox 状态对象是 useSyncExternalStore 的快照，reconcileAccounts 是稳定
    // 门面方法；以 accounts 为触发源即可，随 mailbox 身份重跑反而会重复 reconcile。
    mailbox.reconcileAccounts(accounts);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconcile 由 accounts 变化驱动
  }, [accounts]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!settings.autoRefreshEnabled) {
      return;
    }

    const intervalMs = Math.max(settings.autoRefreshIntervalMinutes, 1) * 60 * 1000;
    const timer = window.setInterval(() => {
      if (anyJobRunning) {
        return;
      }

      const accountIds = accounts.filter((account) => account.status === "valid").map((account) => account.id);
      if (accountIds.length === 0) {
        return;
      }

      void refreshAccounts(accountIds, "定时刷新", { silent: true });
    }, intervalMs);

    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 定时器只跟随设置变化重建；accounts/anyJobRunning 在回调内读取最新值
  }, [accounts, anyJobRunning, settings.autoRefreshEnabled, settings.autoRefreshIntervalMinutes]);

  useEffect(() => {
    setTestMenuOpen(false);
  }, [selectedAccountId]);

  // 下拉菜单必须能用 Esc 和“点别处”关掉，否则它会一直悬在工具栏上挡住后面的按钮。
  useEffect(() => {
    if (!testMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const menu = testMenuRef.current;
      if (menu && event.target instanceof Node && !menu.contains(event.target)) {
        setTestMenuOpen(false);
      }
    }

    function handleMenuKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setTestMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleMenuKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleMenuKeyDown);
    };
  }, [testMenuOpen]);

  return (
    <div className="mail-app">
      <div className="mail-shell">
        <AccountSidebar
          accounts={accounts}
          filteredAccounts={filteredAccounts}
          selectedAccountId={selectedAccountId}
          loadingAccounts={loadingAccounts}
          accountQuery={accountQuery}
          statusFilter={statusFilter}
          onAccountQueryChange={setAccountQuery}
          onStatusFilterChange={setStatusFilter}
          onSelectAccount={selectAccount}
          onOpenImport={openImportModal}
          onImportFromFile={importFromFile}
          onReloadAccounts={reloadAccounts}
          onOpenSettings={openSettingsModal}
          newMailCounts={newMailCounts}
          busyAccountIds={busyAccountIdSet}
          refreshDisabled={singleRefreshBlocked}
          onRefreshAccount={refreshSingleAccount}
        />

        <main className="workspace">
          <header className="workspace-header">
            <div className="account-heading">
              <span>当前账号</span>
              <h2>{selectedAccount?.email || "未选择邮箱"}</h2>
              <p>
                {selectedAccount
                  ? accountInboxSummary(selectedAccount, messages.length)
                  : "选择账号后可读取文件夹和邮件"}
              </p>
            </div>
            <div className="toolbar-group">
              <div className="toolbar-menu" ref={testMenuRef}>
                <button
                  className="toolbar-button toolbar-button-main"
                  onClick={() => selectedAccountId && void testConnection(selectedAccountId)}
                  disabled={!selectedAccountId || selectedAccountTesting}
                  title="测试当前账号"
                >
                  {selectedAccountTesting ? (
                    <Loader2 size={15} className="spin" />
                  ) : (
                    <CheckCircle2 size={15} />
                  )}
                  测试
                </button>
                <button
                  className="toolbar-button toolbar-button-caret"
                  onClick={() => setTestMenuOpen((open) => !open)}
                  disabled={!selectedAccountId || selectedAccountTesting}
                  title="更多测试选项"
                  aria-label="更多测试选项"
                  aria-haspopup="menu"
                  aria-expanded={testMenuOpen}
                >
                  <ChevronDown size={13} />
                </button>
                {testMenuOpen ? (
                  <div className="toolbar-menu-popover" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setTestMenuOpen(false);
                        if (selectedAccountId) {
                          void testConnection(selectedAccountId);
                        }
                      }}
                    >
                      <CheckCircle2 size={14} />
                      测试连接
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setTestMenuOpen(false);
                        if (selectedAccountId) {
                          void testFallback(selectedAccountId);
                        }
                      }}
                    >
                      <CheckCircle2 size={14} />
                      兜底测试
                    </button>
                  </div>
                ) : null}
              </div>
              <button className="toolbar-button" onClick={testFilteredAccounts} disabled={filteredAccounts.length === 0 || anyJobRunning} title="批量测试">
                {testRunning ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
                批量测试
              </button>
              {testRunning ? (
                <button className="toolbar-button" onClick={cancelBulkTest} title="取消批量测试">
                  <X size={15} />
                  停止测试
                </button>
              ) : null}
              <button className="toolbar-button" onClick={refreshFilteredAccounts} disabled={filteredAccounts.length === 0 || anyJobRunning} title="刷新邮件">
                {manualRefreshRunning ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                刷新
              </button>
              {manualRefreshRunning ? (
                <button className="toolbar-button" onClick={cancelBulkRefresh} title="取消批量刷新">
                  <X size={15} />
                  停止刷新
                </button>
              ) : null}
              <button className="toolbar-button" onClick={() => selectedAccount && setEditingAccount(selectedAccount)} disabled={!selectedAccount} title="编辑账号">
                <Pencil size={15} />
                编辑
              </button>
              <button className="toolbar-button danger-outline" onClick={requestDeleteAccount} disabled={!selectedAccount} title="删除账号">
                <Trash2 size={15} />
                删除
              </button>
            </div>
          </header>

          {displayedError ? <ErrorBanner message={displayedError} onDismiss={clearErrors} /> : null}
          {progressText ? (
            <div className="progress-line">
              <span>{progressText}</span>
              {progress && progress.total > 0 && progress.phase !== "completed" ? (
                <span className="progress-track" aria-hidden="true">
                  <span
                    className="progress-fill"
                    style={{ width: `${Math.min(100, Math.round((progress.completed / progress.total) * 100))}%` }}
                  />
                </span>
              ) : null}
              {canRetryFailedRefresh ? (
                <button type="button" onClick={retryFailedRefresh} disabled={anyJobRunning}>
                  重试失败账号
                </button>
              ) : null}
            </div>
          ) : null}
          {backgroundProgressText ? (
            <div className="progress-line progress-line-background" role="status">
              <span>{backgroundProgressText}</span>
            </div>
          ) : null}

          <div className="workspace-content">
            <MessageList
              messages={messages}
              selectedMessageId={selectedMessageId}
              loadingMessages={loadingMessages}
              loadingMore={loadingMore}
              mailCursor={mailCursor}
              mailQuery={mailQuery}
              folders={folders}
              selectedFolderId={selectedFolderId}
              inboxFolderId={selectedAccount?.inboxFolderId ?? null}
              listError={mailbox.state.listError}
              canRefresh={Boolean(selectedAccountId)}
              onMailQueryChange={setMailQuery}
              onExecuteSearch={executeMailSearch}
              onClearSearch={clearMailSearch}
              onRefresh={refreshMailbox}
              onSelectFolder={selectFolder}
              onSelectMessage={selectMessage}
              onLoadMore={loadMoreMessages}
            />

            <MailReader selectedMessage={selectedMessage} messageDetail={messageDetail} loadingDetail={loadingDetail} />
          </div>
        </main>
      </div>

      {showImportModal ? (
        <ImportModal
          onClose={() => setShowImportModal(false)}
          onPreviewImportText={accountCatalog.previewImportText}
          onImportText={accountCatalog.importText}
          onUpsert={accountCatalog.upsert}
          onImported={(result) => {
            setToast(`导入 ${result.imported} 个，更新 ${result.updated} 个，跳过 ${result.skipped} 个`);
          }}
        />
      ) : null}

      {editingAccount ? (
        <EditAccountModal
          account={editingAccount}
          onClose={() => setEditingAccount(null)}
          onSubmit={accountCatalog.update}
          onSaved={() => {
            setToast("账号已更新");
          }}
        />
      ) : null}

      {showSettingsModal ? (
        <SettingsModal
          settings={settings}
          onClose={() => setShowSettingsModal(false)}
          onSaved={(nextSettings) => {
            setSettings(nextSettings);
            setToast("设置已保存");
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title={`删除账号 ${deleteTarget.email}`}
          subtitle="此操作不可撤销"
          confirmLabel="删除账号"
          busy={deletingAccount}
          onConfirm={() => void confirmDeleteAccount()}
          onClose={() => setDeleteTarget(null)}
        >
          <p>将一并删除：</p>
          <ul>
            <li>该账号的登录凭据（不可恢复）</li>
            <li>本地缓存的全部邮件</li>
          </ul>
          <p>如果这个账号正在测试或刷新，请先等待任务结束。</p>
        </ConfirmDialog>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

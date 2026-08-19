import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AccountSidebar } from "./components/AccountSidebar";
import { mergeTestedAccounts } from "./account-result-merge";
import { ImportModal } from "./components/ImportModal";
import { MailReader } from "./components/MailReader";
import { MessageList } from "./components/MessageList";
import { SettingsModal } from "./components/SettingsModal";
import { getDesktopApi } from "./desktop-api";
import type {
  AccountUpdateInput,
  AccountView,
  AppSettings,
  RefreshManyResult
} from "./types";
import { formatRelativeTime } from "./ui-utils";
import { errorMessage } from "./app-error";
import { shouldDisplayBulkRefreshProgress } from "./job-progress";
import { useMailboxSession } from "./use-mailbox-session";

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

function replaceAccount(accounts: AccountView[], next: AccountView) {
  return accounts.map((account) => (account.id === next.id ? next : account));
}

function EditAccountModal({
  account,
  onClose,
  onSaved
}: {
  account: AccountView;
  onClose: () => void;
  onSaved: (account: AccountView) => void;
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
    const api = getDesktopApi();
    if (!api) {
      setError("账号编辑需要在 Electron 桌面应用中使用。");
      return;
    }

    setLoading(true);
    setError("");

    try {
      onSaved(await api.accounts.update(form));
      onClose();
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal dark-modal" onSubmit={submit}>
        <div className="modal-header">
          <div>
            <h2>编辑邮箱</h2>
            <p>Refresh Token 留空则保持不变</p>
          </div>
          <button className="toolbar-icon" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
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
        <div className="modal-actions">
          <button type="button" className="secondary-button dark-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button dark-primary" type="submit" disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <Pencil size={16} />}
            保存修改
          </button>
        </div>
      </form>
    </div>
  );
}
export default function App() {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [accountQuery, setAccountQuery] = useState("");
  const [mailQuery, setMailQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "valid" | "invalid" | "untested">("all");
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AccountView | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [fallbackTestingId, setFallbackTestingId] = useState<string | null>(null);
  const [testMenuOpen, setTestMenuOpen] = useState(false);
  const [bulkTesting, setBulkTesting] = useState(false);
  const [bulkRefreshing, setBulkRefreshing] = useState(false);
  const [refreshingAccountIds, setRefreshingAccountIds] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState("");
  const [lastRefreshResults, setLastRefreshResults] = useState<RefreshManyResult[]>([]);
  const [newMailCounts, setNewMailCounts] = useState<Record<string, number>>({});
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const autoRefreshRunningRef = useRef(false);
  const silentRefreshRef = useRef(false);
  const mailbox = useMailboxSession(getDesktopApi()?.mail ?? null);
  const {
    accountId: selectedAccountId,
    cursor: mailCursor,
    error: mailboxError,
    loadingDetail,
    loadingMessages,
    loadingMore,
    messageDetail,
    messages,
    selectedMessageId
  } = mailbox.state;
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

  function applyAccounts(nextAccounts: AccountView[]) {
    setAccounts(nextAccounts);
    mailbox.reconcileAccounts(nextAccounts);
  }

  function clearErrors() {
    setError("");
    mailbox.clearError();
  }

  async function loadAccounts() {
    const api = getDesktopApi();

    if (!api) {
      setLoadingAccounts(false);
      setError("当前页面未运行在 Electron 桌面环境中，请使用 npm run dev 启动桌面应用。");
      return;
    }

    setLoadingAccounts(true);
    clearErrors();

    try {
      applyAccounts(await api.accounts.list());
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoadingAccounts(false);
    }
  }

  async function loadSettings() {
    const api = getDesktopApi();
    if (!api) {
      return;
    }

    try {
      setSettings(await api.settings.get());
    } catch (settingsError) {
      setError(errorMessage(settingsError));
    }
  }

  async function importFromFile() {
    const api = getDesktopApi();

    if (!api) {
      setError("文件导入需要在 Electron 桌面应用中使用。");
      return;
    }

    clearErrors();

    try {
      const result = await api.accounts.importFile();

      if (!result) {
        return;
      }

      applyAccounts(result.accounts);
      setToast(`导入 ${result.imported} 个，更新 ${result.updated} 个，跳过 ${result.skipped} 个`);
    } catch (importError) {
      setError(errorMessage(importError));
    }
  }

  async function testConnection(accountId: string) {
    setTestMenuOpen(false);
    const api = getDesktopApi();

    if (!api) {
      setError("连接测试需要在 Electron 桌面应用中使用。");
      return;
    }

    setTestingId(accountId);
    clearErrors();

    try {
      const result = await api.accounts.test(accountId);
      if (result.account) {
        setAccounts((current) => replaceAccount(current, result.account!));
      }
      if (result.ok) {
        setToast(result.message);
      } else {
        setError(result.error.message);
      }
    } catch (testError) {
      setError(errorMessage(testError));
    } finally {
      setTestingId(null);
    }
  }

  async function testFallback(accountId: string) {
    setTestMenuOpen(false);
    const api = getDesktopApi();

    if (!api) {
      setError("兜底测试需要在 Electron 桌面应用中使用。");
      return;
    }

    setFallbackTestingId(accountId);
    clearErrors();

    try {
      const result = await api.accounts.testFallback(accountId);
      if (result.ok) {
        setAccounts((current) => replaceAccount(current, result.account));
        setToast(result.message);
      } else {
        setError(result.error.message);
      }
    } catch (fallbackError) {
      setError(errorMessage(fallbackError));
    } finally {
      setFallbackTestingId(null);
    }
  }

  async function testFilteredAccounts() {
    if (filteredAccounts.length === 0 || bulkTesting) {
      return;
    }

    setBulkTesting(true);
    clearErrors();

    try {
      const api = getDesktopApi();
      if (!api) {
        throw new Error("桌面接口不可用");
      }

      setBulkProgress(`测试中 0/${filteredAccounts.length} · 可用 0 · 失效 0`);
      const results = await api.accounts.testMany(filteredAccounts.map((account) => account.id));
      const validCount = results.filter((item) => item.ok).length;
      setAccounts((current) => mergeTestedAccounts(current, results));
      setToast(`已测试 ${validCount}/${results.length} 个账号`);
      setBulkProgress(`测试完成 ${validCount}/${results.length}`);
    } catch (testError) {
      setError(errorMessage(testError));
    } finally {
      setBulkTesting(false);
    }
  }

  async function cancelBulkTest() {
    const api = getDesktopApi();
    if (!api) {
      return;
    }

    await api.jobs.cancel("test");
    setToast("正在取消批量测试");
  }

  async function refreshAccounts(accountIds: string[], doneText = "已刷新", options: { silent?: boolean } = {}) {
    if (accountIds.length === 0 || bulkRefreshing) {
      return;
    }

    const api = getDesktopApi();
    if (!api) {
      setError("桌面接口不可用");
      return;
    }

    setBulkRefreshing(true);
    silentRefreshRef.current = options.silent === true;
    clearErrors();
    setLastRefreshResults([]);
    if (!options.silent) {
      setBulkProgress(`刷新中 0/${accountIds.length} · 成功 0 · 失败 0`);
    }

    try {
      const results = await api.accounts.refreshMany(accountIds, options.silent ? "refreshBackground" : "refresh");
      const okCount = results.filter((item) => item.ok).length;
      setLastRefreshResults(results);
      const nextAccounts = await api.accounts.list();
      applyAccounts(nextAccounts);
      const changedCount = options.silent ? recordNewMailCounts(results) : 0;

      if (options.silent) {
        setToast(changedCount > 0 ? `定时刷新发现 ${changedCount} 个账号有新邮件` : `定时刷新完成 ${okCount}/${results.length}`);
      } else {
        setToast(`${doneText} ${okCount}/${results.length} 个账号的收件箱`);
        setBulkProgress(`刷新完成 ${okCount}/${results.length}`);
      }

      await mailbox.reloadIfCurrentAccount(accountIds);
    } catch (refreshError) {
      setError(errorMessage(refreshError));
    } finally {
      setBulkRefreshing(false);
      silentRefreshRef.current = false;
    }
  }

  async function refreshSingleAccount(accountId: string) {
    if (refreshingAccountIds.has(accountId)) {
      return;
    }

    const api = getDesktopApi();
    if (!api) {
      setError("桌面接口不可用");
      return;
    }

    setRefreshingAccountIds((current) => new Set(current).add(accountId));
    clearErrors();

    try {
      const results = await api.accounts.refreshMany([accountId], "refreshSingle");
      const result = results[0];
      const nextAccounts = await api.accounts.list();
      applyAccounts(nextAccounts);

      if (result?.ok) {
        setToast(`已刷新 ${nextAccounts.find((account) => account.id === accountId)?.email || "账号"}`);
        await mailbox.reloadIfCurrentAccount([accountId]);
        return;
      }

      const refreshMessage = result?.error.message || "刷新账号失败";
      if (mailbox.isCurrentAccount(accountId)) {
        setError(refreshMessage);
      } else {
        const email = nextAccounts.find((account) => account.id === accountId)?.email || "账号";
        setToast(`${email} 刷新失败：${refreshMessage}`);
      }
    } catch (refreshError) {
      const refreshMessage = errorMessage(refreshError);
      if (mailbox.isCurrentAccount(accountId)) {
        setError(refreshMessage);
      } else {
        const email = accounts.find((account) => account.id === accountId)?.email || "账号";
        setToast(`${email} 刷新失败：${refreshMessage}`);
      }
    } finally {
      setRefreshingAccountIds((current) => {
        const next = new Set(current);
        next.delete(accountId);
        return next;
      });
    }
  }

  function recordNewMailCounts(results: RefreshManyResult[]) {
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
  }

  async function cancelBulkRefresh() {
    const api = getDesktopApi();
    if (!api) {
      return;
    }

    await api.jobs.cancel("refresh");
    setToast("正在取消批量刷新");
  }

  function refreshFilteredAccounts() {
    refreshAccounts(
      filteredAccounts.map((account) => account.id),
      "已刷新"
    );
  }

  function selectAccount(accountId: string) {
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
  }

  function retryFailedRefresh() {
    const failedIds = lastRefreshResults.filter((item) => !item.ok && !item.canceled).map((item) => item.accountId);
    refreshAccounts(failedIds, "已重试");
  }

  function executeMailSearch() {
    clearErrors();
    void mailbox.search(mailQuery);
  }

  function refreshMailbox() {
    clearErrors();
    void mailbox.reload(true);
  }

  function selectMessage(messageId: string) {
    clearErrors();
    void mailbox.selectMessage(messageId);
  }

  function loadMoreMessages() {
    clearErrors();
    void mailbox.loadMore();
  }

  async function deleteSelectedAccount() {
    const api = getDesktopApi();

    if (!api) {
      setError("账号管理需要在 Electron 桌面应用中使用。");
      return;
    }

    if (!selectedAccountId) {
      return;
    }

    const account = accounts.find((item) => item.id === selectedAccountId);
    const confirmed = window.confirm(`删除账号 ${account?.email || ""}？`);

    if (!confirmed) {
      return;
    }

    try {
      const nextAccounts = await api.accounts.delete(selectedAccountId);
      applyAccounts(nextAccounts);
      setToast("账号已删除");
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    }
  }

  useEffect(() => {
    loadAccounts();
    loadSettings();
  }, []);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api?.accounts.onRefreshProgress) {
      return;
    }

    return api.accounts.onRefreshProgress((progress) => {
      if (silentRefreshRef.current || !shouldDisplayBulkRefreshProgress(progress)) {
        return;
      }

      setBulkProgress(`刷新中 ${progress.completed}/${progress.total} · 成功 ${progress.ok} · 失败 ${progress.failed}`);
    });
  }, []);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api?.accounts.onTestProgress) {
      return;
    }

    return api.accounts.onTestProgress((progress) => {
      setBulkProgress(`测试中 ${progress.completed}/${progress.total} · 可用 ${progress.ok} · 失效 ${progress.failed}`);
    });
  }, []);

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
      if (autoRefreshRunningRef.current || bulkRefreshing) {
        return;
      }

      const accountIds = accounts.filter((account) => account.status === "valid").map((account) => account.id);
      if (accountIds.length === 0) {
        return;
      }

      autoRefreshRunningRef.current = true;
      void refreshAccounts(accountIds, "定时刷新", { silent: true }).finally(() => {
        autoRefreshRunningRef.current = false;
      });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [accounts, bulkRefreshing, settings.autoRefreshEnabled, settings.autoRefreshIntervalMinutes]);

  useEffect(() => {
    setTestMenuOpen(false);
  }, [selectedAccountId]);

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
          onOpenImport={() => setShowImportModal(true)}
          onImportFromFile={importFromFile}
          onReloadAccounts={loadAccounts}
          onOpenSettings={() => setShowSettingsModal(true)}
          newMailCounts={newMailCounts}
          refreshingAccountIds={refreshingAccountIds}
          onRefreshAccount={refreshSingleAccount}
        />

        <main className="workspace">
          <header className="workspace-header">
            <div className="account-heading">
              <span>当前账号</span>
              <h2>{selectedAccount?.email || "未选择邮箱"}</h2>
              <p>
                {selectedAccount
                  ? `收件箱 ${selectedAccount.lastInboxCount ?? messages.length} 封 · 最新邮件 ${formatRelativeTime(
                      selectedAccount.lastMailAt
                    )}`
                  : "选择账号后可读取文件夹和邮件"}
              </p>
            </div>
            <div className="toolbar-group">
              <div className="toolbar-menu">
                <button
                  className="toolbar-button"
                  onClick={() => setTestMenuOpen((open) => !open)}
                  disabled={!selectedAccountId || testingId === selectedAccountId || fallbackTestingId === selectedAccountId}
                  title="测试当前账号"
                >
                  {testingId === selectedAccountId || fallbackTestingId === selectedAccountId ? (
                    <Loader2 size={15} className="spin" />
                  ) : (
                    <CheckCircle2 size={15} />
                  )}
                  测试
                  <ChevronDown size={13} />
                </button>
                {testMenuOpen ? (
                  <div className="toolbar-menu-popover">
                    <button type="button" onClick={() => selectedAccountId && testConnection(selectedAccountId)}>
                      <CheckCircle2 size={14} />
                      测试连接
                    </button>
                    <button type="button" onClick={() => selectedAccountId && testFallback(selectedAccountId)}>
                      <CheckCircle2 size={14} />
                      兜底测试
                    </button>
                  </div>
                ) : null}
              </div>
              <button className="toolbar-button" onClick={testFilteredAccounts} disabled={filteredAccounts.length === 0 || bulkTesting} title="批量测试">
                {bulkTesting ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
                批测
              </button>
              {bulkTesting ? (
                <button className="toolbar-button" onClick={cancelBulkTest} title="取消批量测试">
                  <X size={15} />
                  停测
                </button>
              ) : null}
              <button className="toolbar-button" onClick={refreshFilteredAccounts} disabled={filteredAccounts.length === 0 || bulkRefreshing} title="刷新邮件">
                {bulkRefreshing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                刷新
              </button>
              {bulkRefreshing ? (
                <button className="toolbar-button" onClick={cancelBulkRefresh} title="取消批量刷新">
                  <X size={15} />
                  停刷
                </button>
              ) : null}
              <button className="toolbar-button" onClick={() => selectedAccount && setEditingAccount(selectedAccount)} disabled={!selectedAccount} title="编辑账号">
                <Pencil size={15} />
                编辑
              </button>
              <button className="toolbar-button danger-outline" onClick={deleteSelectedAccount} disabled={!selectedAccountId} title="删除账号">
                <Trash2 size={15} />
                删除
              </button>
            </div>
          </header>

          {displayedError ? (
            <div className="error-banner">
              <AlertCircle size={16} />
              {displayedError}
            </div>
          ) : null}
          {bulkProgress ? (
            <div className="progress-line">
              <span>{bulkProgress}</span>
              {lastRefreshResults.some((item) => !item.ok && !item.canceled) ? (
                <button type="button" onClick={retryFailedRefresh} disabled={bulkRefreshing}>
                  重试失败
                </button>
              ) : null}
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
              canRefresh={Boolean(selectedAccountId)}
              onMailQueryChange={setMailQuery}
              onExecuteSearch={executeMailSearch}
              onRefresh={refreshMailbox}
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
          onImported={(result) => {
            applyAccounts(result.accounts);
            setToast(`导入 ${result.imported} 个，更新 ${result.updated} 个，跳过 ${result.skipped} 个`);
          }}
        />
      ) : null}

      {editingAccount ? (
        <EditAccountModal
          account={editingAccount}
          onClose={() => setEditingAccount(null)}
          onSaved={(account) => {
            setAccounts((current) => replaceAccount(current, account));
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

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

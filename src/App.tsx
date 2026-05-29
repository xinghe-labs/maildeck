import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AccountSidebar } from "./components/AccountSidebar";
import { ImportModal } from "./components/ImportModal";
import { MailReader } from "./components/MailReader";
import { MessageList } from "./components/MessageList";
import { SettingsModal } from "./components/SettingsModal";
import { getDesktopApi } from "./desktop-api";
import type {
  AccountUpdateInput,
  AccountView,
  AppSettings,
  MailListResult,
  MailMessageDetail,
  MailMessageSummary,
  RefreshManyResult
} from "./types";
import { formatRelativeTime } from "./ui-utils";

const defaultSettings: AppSettings = {
  cacheMessages: true,
  cacheBodies: true,
  proxyUrl: "",
  batchConcurrency: 4,
  hotmailFallbackEnabled: true
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
      setError(submitError instanceof Error ? submitError.message : String(submitError));
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
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MailMessageSummary[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [messageDetail, setMessageDetail] = useState<MailMessageDetail | null>(null);
  const [accountQuery, setAccountQuery] = useState("");
  const [mailQuery, setMailQuery] = useState("");
  const [activeMailQuery, setActiveMailQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "valid" | "invalid" | "untested">("all");
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AccountView | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [bulkTesting, setBulkTesting] = useState(false);
  const [bulkRefreshing, setBulkRefreshing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState("");
  const [lastRefreshResults, setLastRefreshResults] = useState<RefreshManyResult[]>([]);
  const [mailCursor, setMailCursor] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const messagesRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

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

  async function loadAccounts() {
    const api = getDesktopApi();

    if (!api) {
      setLoadingAccounts(false);
      setError("当前页面未运行在 Electron 桌面环境中，请使用 npm run dev 启动桌面应用。");
      return;
    }

    setLoadingAccounts(true);
    setError("");

    try {
      const nextAccounts = await api.accounts.list();
      setAccounts(nextAccounts);

      if (!selectedAccountId && nextAccounts.length > 0) {
        setSelectedAccountId(nextAccounts[0].id);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
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
      setError(settingsError instanceof Error ? settingsError.message : String(settingsError));
    }
  }

  async function loadMessages(accountId: string, forceRefresh = false) {
    const api = getDesktopApi();

    if (!api) {
      return;
    }

    const requestId = messagesRequestRef.current + 1;
    messagesRequestRef.current = requestId;
    detailRequestRef.current += 1;

    setLoadingMessages(true);
    setMessages([]);
    setSelectedMessageId(null);
    setMessageDetail(null);
    setError("");

    try {
      const result: MailListResult = await api.mail.listMessages({
        accountId,
        top: 50,
        search: activeMailQuery,
        forceRefresh
      });
      if (messagesRequestRef.current !== requestId) {
        return;
      }
      setMessages(result.messages);
      setMailCursor(result.nextCursor);
      setSelectedMessageId(result.messages[0]?.id || null);
    } catch (loadError) {
      if (messagesRequestRef.current !== requestId) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (messagesRequestRef.current === requestId) {
        setLoadingMessages(false);
      }
    }
  }

  async function loadMoreMessages() {
    const api = getDesktopApi();
    if (!api || !selectedAccountId || !mailCursor || loadingMore) {
      return;
    }

    setLoadingMore(true);
    setError("");
    const accountId = selectedAccountId;
    const cursor = mailCursor;
    const query = activeMailQuery;
    const requestId = messagesRequestRef.current;

    try {
      const result = await api.mail.listMessages({
        accountId,
        top: 50,
        search: query,
        cursor
      });
      if (messagesRequestRef.current !== requestId) {
        return;
      }
      setMessages((current) => {
        const merged = new Map(current.map((message) => [message.id, message]));
        for (const message of result.messages) {
          merged.set(message.id, message);
        }
        return Array.from(merged.values());
      });
      setMailCursor(result.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingMore(false);
    }
  }

  async function loadDetail(accountId: string, messageId: string) {
    const api = getDesktopApi();

    if (!api) {
      return;
    }

    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;

    setLoadingDetail(true);
    setMessageDetail(null);
    setError("");

    try {
      const detail = await api.mail.getMessage({ accountId, messageId });
      if (detailRequestRef.current !== requestId) {
        return;
      }
      setMessageDetail(detail);
    } catch (loadError) {
      if (detailRequestRef.current !== requestId) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (detailRequestRef.current === requestId) {
        setLoadingDetail(false);
      }
    }
  }

  async function importFromFile() {
    const api = getDesktopApi();

    if (!api) {
      setError("文件导入需要在 Electron 桌面应用中使用。");
      return;
    }

    setError("");

    try {
      const result = await api.accounts.importFile();

      if (!result) {
        return;
      }

      setAccounts(result.accounts);
      setToast(`导入 ${result.imported} 个，更新 ${result.updated} 个，跳过 ${result.skipped} 个`);

      if (!selectedAccountId && result.accounts.length > 0) {
        setSelectedAccountId(result.accounts[0].id);
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    }
  }

  async function testConnection(accountId: string) {
    const api = getDesktopApi();

    if (!api) {
      setError("连接测试需要在 Electron 桌面应用中使用。");
      return;
    }

    setTestingId(accountId);
    setError("");

    try {
      const result = await api.accounts.test(accountId);
      setAccounts((current) => replaceAccount(current, result.account));
      setToast(result.message);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : String(testError));
    } finally {
      setTestingId(null);
    }
  }

  async function testFilteredAccounts() {
    if (filteredAccounts.length === 0 || bulkTesting) {
      return;
    }

    setBulkTesting(true);
    setError("");

    try {
      const api = getDesktopApi();
      if (!api) {
        throw new Error("桌面接口不可用");
      }

      setBulkProgress(`测试中 0/${filteredAccounts.length} · 可用 0 · 失效 0`);
      const results = await api.accounts.testMany(filteredAccounts.map((account) => account.id));
      const validCount = results.filter((item) => item.ok).length;
      setAccounts((current) =>
        results.reduce((nextAccounts, result) => (result.account ? replaceAccount(nextAccounts, result.account) : nextAccounts), current)
      );
      setToast(`已测试 ${validCount}/${results.length} 个账号`);
      setBulkProgress(`测试完成 ${validCount}/${results.length}`);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : String(testError));
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

  async function refreshAccounts(accountIds: string[], doneText = "已刷新") {
    if (accountIds.length === 0 || bulkRefreshing) {
      return;
    }

    const api = getDesktopApi();
    if (!api) {
      setError("桌面接口不可用");
      return;
    }

    setBulkRefreshing(true);
    setError("");
    setLastRefreshResults([]);
    setBulkProgress(`刷新中 0/${accountIds.length} · 成功 0 · 失败 0`);

    try {
      const results = await api.accounts.refreshMany(accountIds);
      const okCount = results.filter((item) => item.ok).length;
      setLastRefreshResults(results);
      setToast(`${doneText} ${okCount}/${results.length} 个账号的收件箱`);
      setBulkProgress(`刷新完成 ${okCount}/${results.length}`);
      await loadAccounts();

      if (selectedAccountId) {
        await loadMessages(selectedAccountId);
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setBulkRefreshing(false);
    }
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

  function retryFailedRefresh() {
    const failedIds = lastRefreshResults.filter((item) => !item.ok).map((item) => item.accountId);
    refreshAccounts(failedIds, "已重试");
  }

  function executeMailSearch() {
    const nextQuery = mailQuery.trim();
    if (nextQuery === activeMailQuery && selectedAccountId) {
      loadMessages(selectedAccountId);
      return;
    }

    setActiveMailQuery(nextQuery);
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
      setAccounts(nextAccounts);
      setSelectedAccountId(nextAccounts[0]?.id || null);
      setToast("账号已删除");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  useEffect(() => {
    loadAccounts();
    loadSettings();
  }, []);

  useEffect(() => {
    messagesRequestRef.current += 1;
    detailRequestRef.current += 1;

    if (selectedAccountId) {
      const timer = window.setTimeout(() => {
        loadMessages(selectedAccountId);
      }, 180);

      return () => window.clearTimeout(timer);
    }
  }, [selectedAccountId, activeMailQuery]);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api?.accounts.onRefreshProgress) {
      return;
    }

    return api.accounts.onRefreshProgress((progress) => {
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
    if (selectedAccountId && selectedMessageId) {
      loadDetail(selectedAccountId, selectedMessageId);
    }
  }, [selectedAccountId, selectedMessageId]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

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
          onSelectAccount={setSelectedAccountId}
          onOpenImport={() => setShowImportModal(true)}
          onImportFromFile={importFromFile}
          onReloadAccounts={loadAccounts}
          onOpenSettings={() => setShowSettingsModal(true)}
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
              <button
                className="toolbar-button"
                onClick={() => selectedAccountId && testConnection(selectedAccountId)}
                disabled={!selectedAccountId || testingId === selectedAccountId}
              >
                {testingId === selectedAccountId ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
                测试连接
              </button>
              <button className="toolbar-button" onClick={testFilteredAccounts} disabled={filteredAccounts.length === 0 || bulkTesting}>
                {bulkTesting ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
                批量测试
              </button>
              {bulkTesting ? (
                <button className="toolbar-button" onClick={cancelBulkTest}>
                  <X size={15} />
                  取消测试
                </button>
              ) : null}
              <button className="toolbar-button" onClick={refreshFilteredAccounts} disabled={filteredAccounts.length === 0 || bulkRefreshing}>
                {bulkRefreshing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                刷新邮件
              </button>
              {bulkRefreshing ? (
                <button className="toolbar-button" onClick={cancelBulkRefresh}>
                  <X size={15} />
                  取消刷新
                </button>
              ) : null}
              <button className="toolbar-button" onClick={() => selectedAccount && setEditingAccount(selectedAccount)} disabled={!selectedAccount}>
                <Pencil size={15} />
                编辑
              </button>
              <button className="toolbar-button danger-outline" onClick={deleteSelectedAccount} disabled={!selectedAccountId}>
                <Trash2 size={15} />
                删除
              </button>
            </div>
          </header>

          {error ? (
            <div className="error-banner">
              <AlertCircle size={16} />
              {error}
            </div>
          ) : null}
          {bulkProgress ? (
            <div className="progress-line">
              <span>{bulkProgress}</span>
              {lastRefreshResults.some((item) => !item.ok) ? (
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
              onRefresh={() => selectedAccountId && loadMessages(selectedAccountId, true)}
              onSelectMessage={setSelectedMessageId}
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
            setAccounts(result.accounts);
            setToast(`导入 ${result.imported} 个，更新 ${result.updated} 个，跳过 ${result.skipped} 个`);
            if (!selectedAccountId && result.accounts.length > 0) {
              setSelectedAccountId(result.accounts[0].id);
            }
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

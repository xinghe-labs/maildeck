import DOMPurify from "dompurify";
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  FileUp,
  Inbox,
  Loader2,
  Mail,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  Trash2,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AccountInput,
  AccountUpdateInput,
  AccountView,
  AppSettings,
  ImportResult,
  ImportPreviewResult,
  MailListResult,
  MailMessageDetail,
  MailMessageSummary,
  RefreshManyResult
} from "./types";

const emptyAccountForm: AccountInput = {
  email: "",
  clientId: "",
  refreshToken: "",
  remark: "",
  group: ""
};

const defaultSettings: AppSettings = {
  cacheMessages: true,
  cacheBodies: true,
  proxyUrl: "",
  batchConcurrency: 4
};

function getDesktopApi() {
  return window.outlookManager;
}

function formatDate(value: string | null) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatDateShort(value: string | null) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const now = new Date();
  const sameDay = now.toDateString() === date.toDateString();

  return new Intl.DateTimeFormat("zh-CN", sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "2-digit", day: "2-digit" }).format(date);
}

function formatRelativeTime(value?: string | null) {
  if (!value) {
    return "未刷新";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function senderLabel(message: MailMessageSummary) {
  if (!message.from) {
    return "未知发件人";
  }

  return message.from.name || message.from.address || "未知发件人";
}

function addressList(addresses: { name: string; address: string }[]) {
  if (addresses.length === 0) {
    return "-";
  }

  return addresses.map((item) => item.name || item.address).join(", ");
}

function sanitizeMailHtml(content: string) {
  return DOMPurify.sanitize(content, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "option", "meta", "link", "base"],
    FORBID_ATTR: ["srcset"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|data:image\/(?:png|gif|jpe?g|webp);base64,)/i
  });
}

function statusMeta(account: AccountView) {
  if (account.status === "valid") {
    return { label: "可用", icon: CheckCircle2, className: "status-chip status-valid" };
  }

  if (account.status === "invalid") {
    return { label: "失效", icon: AlertCircle, className: "status-chip status-invalid" };
  }

  return { label: "未测", icon: ShieldAlert, className: "status-chip status-untested" };
}

function replaceAccount(accounts: AccountView[], next: AccountView) {
  return accounts.map((account) => (account.id === next.id ? next : account));
}

function ImportModal({
  onClose,
  onImported
}: {
  onClose: () => void;
  onImported: (result: ImportResult) => void;
}) {
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [single, setSingle] = useState<AccountInput>(emptyAccountForm);
  const [batchText, setBatchText] = useState("");
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function previewBatch() {
    const api = getDesktopApi();
    if (!api) {
      setError("导入预检需要在 Electron 桌面应用中使用。");
      return;
    }

    setError("");
    setPreview(await api.accounts.previewImportText(mode === "single" ? `${single.email},${single.clientId},${single.refreshToken}` : batchText));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const api = getDesktopApi();

    if (!api) {
      setError("导入账号需要在 Electron 桌面应用中使用。");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const result =
        mode === "single" ? await api.accounts.upsert(single) : await api.accounts.importText(batchText);

      onImported(result);
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
            <h2>导入邮箱</h2>
            <p>支持 CSV 和 email----client_id----refresh_token 格式</p>
          </div>
          <button className="toolbar-icon" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="segmented dark-segmented">
          <button type="button" className={mode === "single" ? "active" : ""} onClick={() => setMode("single")}>
            单个账号
          </button>
          <button type="button" className={mode === "batch" ? "active" : ""} onClick={() => setMode("batch")}>
            批量粘贴
          </button>
        </div>

        {mode === "single" ? (
          <div className="form-grid">
            <label>
              邮箱
              <input value={single.email} onChange={(event) => setSingle({ ...single, email: event.target.value })} required />
            </label>
            <label>
              Client ID
              <input value={single.clientId} onChange={(event) => setSingle({ ...single, clientId: event.target.value })} required />
            </label>
            <label className="span-2">
              Refresh Token
              <textarea
                value={single.refreshToken}
                onChange={(event) => setSingle({ ...single, refreshToken: event.target.value })}
                required
              />
            </label>
            <label>
              备注
              <input value={single.remark} onChange={(event) => setSingle({ ...single, remark: event.target.value })} />
            </label>
            <label>
              分组
              <input value={single.group} onChange={(event) => setSingle({ ...single, group: event.target.value })} />
            </label>
          </div>
        ) : (
          <label className="stacked-label">
            导入文本
            <textarea
              className="batch-textarea"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={"email,client_id,refresh_token,remark,group\nuser@hotmail.com,client-id,refresh-token,主号,A组"}
              required
            />
          </label>
        )}

        {preview ? (
          <div className="preview-box">
            共 {preview.total} 行 · 有效 {preview.valid} · 重复 {preview.duplicates} · 错误 {preview.invalid}
            {preview.errors.length > 0 ? <p>{preview.errors.slice(0, 3).join("；")}</p> : null}
          </div>
        ) : null}

        {error ? <div className="error-box">{error}</div> : null}

        <div className="modal-actions">
          <button type="button" className="secondary-button dark-button" onClick={previewBatch}>
            预检
          </button>
          <button type="button" className="secondary-button dark-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button dark-primary" type="submit" disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
            保存导入
          </button>
        </div>
      </form>
    </div>
  );
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

function SettingsModal({
  settings,
  onClose,
  onSaved
}: {
  settings: AppSettings;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
}) {
  const [form, setForm] = useState<AppSettings>(settings);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const api = getDesktopApi();
    if (!api) {
      setError("设置需要在 Electron 桌面应用中使用。");
      return;
    }

    setLoading(true);
    setError("");

    try {
      onSaved(await api.settings.update(form));
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
            <h2>设置</h2>
            <p>代理支持 HTTP/HTTPS/SOCKS，留空表示直连</p>
          </div>
          <button className="toolbar-icon" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="settings-grid">
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.cacheMessages}
              onChange={(event) => setForm({ ...form, cacheMessages: event.target.checked })}
            />
            缓存邮件列表
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.cacheBodies}
              onChange={(event) => setForm({ ...form, cacheBodies: event.target.checked })}
            />
            缓存邮件正文
          </label>
          <label>
            批量并发
            <input
              type="number"
              min={1}
              max={12}
              value={form.batchConcurrency}
              onChange={(event) => setForm({ ...form, batchConcurrency: Number(event.target.value) || 1 })}
            />
          </label>
          <label>
            代理地址
            <input
              value={form.proxyUrl}
              onChange={(event) => setForm({ ...form, proxyUrl: event.target.value })}
              placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
            />
          </label>
        </div>
        {error ? <div className="error-box">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button dark-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button dark-primary" type="submit" disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <Settings size={16} />}
            保存设置
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
      setMessages(result.messages);
      setMailCursor(result.nextCursor);
      setSelectedMessageId(result.messages[0]?.id || null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingMessages(false);
    }
  }

  async function loadMoreMessages() {
    const api = getDesktopApi();
    if (!api || !selectedAccountId || !mailCursor || loadingMore) {
      return;
    }

    setLoadingMore(true);
    setError("");

    try {
      const result = await api.mail.listMessages({
        accountId: selectedAccountId,
        top: 50,
        search: activeMailQuery,
        cursor: mailCursor
      });
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

    setLoadingDetail(true);
    setMessageDetail(null);
    setError("");

    try {
      setMessageDetail(await api.mail.getMessage({ accountId, messageId }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingDetail(false);
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

  const sanitizedBody =
    messageDetail?.body.contentType.toLowerCase() === "html"
      ? sanitizeMailHtml(messageDetail.body.content)
      : "";

  return (
    <div className="mail-app">
      <div className="mail-shell">
        <aside className="sidebar">
          <div className="brand-block">
            <div className="brand-icon">
              <Mail size={26} />
            </div>
            <div>
              <h1>Outlook Manager</h1>
              <p>Microsoft 邮箱工作台</p>
            </div>
          </div>

          <div className="sidebar-actions">
            <button className="import-button" onClick={() => setShowImportModal(true)}>
              <Plus size={16} />
              导入
            </button>
            <button className="square-button" onClick={importFromFile} title="导入文件">
              <FileUp size={16} />
            </button>
            <button className="square-button" onClick={loadAccounts} title="刷新账号">
              <RefreshCw size={16} />
            </button>
            <button className="square-button" onClick={() => setShowSettingsModal(true)} title="设置">
              <Settings size={16} />
            </button>
          </div>

          <div className="sidebar-search">
            <Search size={16} />
            <input value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} placeholder="搜索邮箱" />
          </div>

          <div className="sidebar-stats">
            <span>
              {filteredAccounts.length} / {accounts.length} 个邮箱
            </span>
          </div>

          <div className="segmented slim-segmented">
            <button type="button" className={statusFilter === "all" ? "active" : ""} onClick={() => setStatusFilter("all")}>
              全部
            </button>
            <button type="button" className={statusFilter === "valid" ? "active" : ""} onClick={() => setStatusFilter("valid")}>
              可用
            </button>
            <button type="button" className={statusFilter === "invalid" ? "active" : ""} onClick={() => setStatusFilter("invalid")}>
              失效
            </button>
            <button type="button" className={statusFilter === "untested" ? "active" : ""} onClick={() => setStatusFilter("untested")}>
              未测
            </button>
          </div>

          <div className="account-scroll">
            {loadingAccounts ? (
              <div className="panel-empty">
                <Loader2 size={22} className="spin" />
                <p>加载账号</p>
              </div>
            ) : null}

            {!loadingAccounts && filteredAccounts.length === 0 ? (
              <div className="panel-empty">
                <Inbox size={24} />
                <p>没有符合条件的邮箱</p>
              </div>
            ) : null}

            {filteredAccounts.map((account) => {
              const meta = statusMeta(account);
              const StatusIcon = meta.icon;

              return (
                <button
                  key={account.id}
                  className={`account-row ${account.id === selectedAccountId ? "selected" : ""}`}
                  onClick={() => setSelectedAccountId(account.id)}
                >
                  <div className="account-text">
                    <strong>{account.email}</strong>
                    <div className="account-meta-row">
                      <span>{account.remark || "Hotmail OAuth"}</span>
                      <span>
                        {account.lastInboxCount || 0} 封 · {formatRelativeTime(account.lastRefreshedAt)}
                      </span>
                    </div>
                  </div>
                  <span className={meta.className} title={meta.label}>
                    <StatusIcon size={12} />
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="workspace">
          <header className="workspace-header">
            <div className="account-heading">
              <span>当前账号</span>
              <h2>{selectedAccount?.email || "未选择邮箱"}</h2>
              <p>
                {selectedAccount
                  ? `收件箱 ${selectedAccount.lastInboxCount || messages.length} 封 · 最新邮件 ${formatRelativeTime(
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
            <section className="list-panel">
              <div className="list-header">
                <div className="folder-title">
                  <Inbox size={16} />
                  收件箱
                </div>
                <div className="list-searchbar">
                  <div className="search-box">
                    <Search size={16} />
                    <input
                      value={mailQuery}
                      onChange={(event) => setMailQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && selectedAccountId) {
                          executeMailSearch();
                        }
                      }}
                      placeholder="搜索主题，回车执行"
                    />
                  </div>
                  <button
                    className="toolbar-icon"
                    onClick={() => selectedAccountId && loadMessages(selectedAccountId, true)}
                    disabled={!selectedAccountId || loadingMessages}
                    title="强制刷新"
                  >
                    {loadingMessages ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
                  </button>
                </div>
              </div>

              <div className="message-scroll">
                {loadingMessages ? (
                  <div className="panel-empty">
                    <Loader2 size={22} className="spin" />
                    <p>正在刷新邮件</p>
                  </div>
                ) : null}

                {!loadingMessages && messages.length === 0 ? (
                  <div className="panel-empty">
                    <ClipboardList size={24} />
                    <p>没有邮件可显示</p>
                  </div>
                ) : null}

                {messages.map((message) => (
                  <button
                    key={message.id}
                    className={`message-row ${message.id === selectedMessageId ? "selected" : ""}`}
                    onClick={() => setSelectedMessageId(message.id)}
                  >
                    <div className="message-row-top">
                      <strong>{senderLabel(message)}</strong>
                      <span>{formatDateShort(message.receivedDateTime || message.sentDateTime)}</span>
                    </div>
                    <div className="message-row-subject">
                      {message.hasAttachments ? <Paperclip size={13} /> : null}
                      {message.subject}
                    </div>
                    {message.bodyPreview ? <p>{message.bodyPreview}</p> : null}
                  </button>
                ))}
                {mailCursor && !loadingMessages ? (
                  <button className="load-more-button" onClick={loadMoreMessages} disabled={loadingMore}>
                    {loadingMore ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
                    加载更多
                  </button>
                ) : null}
              </div>
            </section>

            <article className="reader-panel">
              {!selectedMessage && !loadingDetail ? (
                <div className="panel-empty">
                  <Mail size={30} />
                  <p>选择一封邮件查看正文</p>
                </div>
              ) : null}

              {loadingDetail ? (
                <div className="panel-empty">
                  <Loader2 size={24} className="spin" />
                  <p>正在读取邮件</p>
                </div>
              ) : null}

              {!loadingDetail && selectedMessage && messageDetail ? (
                <>
                  <header className="reader-header">
                    <h2>{messageDetail.subject}</h2>
                    <div className="reader-meta-head">
                      <div className="sender-pill">
                        <div>
                          <strong>{messageDetail.from?.name || messageDetail.from?.address || "-"}</strong>
                          <span>{messageDetail.from?.address || ""}</span>
                        </div>
                      </div>
                      <time>{formatDate(messageDetail.receivedDateTime || messageDetail.sentDateTime)}</time>
                    </div>
                    <div className="reader-lines">
                      <span>发送给 {addressList(messageDetail.toRecipients)}</span>
                      <span>抄送 {addressList(messageDetail.ccRecipients)}</span>
                    </div>
                  </header>

                  <div className="reader-body">
                    <div className="mail-paper">
                      {messageDetail.body.contentType.toLowerCase() === "html" ? (
                        <div dangerouslySetInnerHTML={{ __html: sanitizedBody }} />
                      ) : (
                        <pre>{messageDetail.body.content}</pre>
                      )}
                    </div>
                  </div>
                </>
              ) : null}
            </article>
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

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
import type { CSSProperties } from "react";
import { AccountSidebar } from "./components/AccountSidebar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ErrorBanner } from "./components/ErrorBanner";
import { ImportModal } from "./components/ImportModal";
import { MailReader } from "./components/MailReader";
import { MessageList } from "./components/MessageList";
import { ModalShell } from "./components/ModalShell";
import { SettingsModal } from "./components/SettingsModal";
import { getDesktopApi } from "./desktop-api";
import { isAppError } from "./app-error";
import { splitErrorMessage } from "./error-display";
import { firstErrorField, validateAccountFields } from "./form-validation";
import type { AccountField, FieldErrors } from "./form-validation";
import type {
  AccountUpdateInput,
  AccountView,
  AppErrorCode,
  AppSettings,
  ImportResult,
  RefreshManyResult
} from "./types";
import { accountInboxSummary, formatRelativeTime, statusMeta } from "./ui-utils";
import { errorMessage } from "./app-error";
import { useAccountCatalogSession } from "./use-account-catalog-session";
import { useMailboxSession } from "./use-mailbox-session";
import { useRefreshJobSession } from "./use-refresh-job-session";
import { loadVisitedMessages, messageVisitKey, saveVisitedMessages } from "./visited-messages";
import { useColumnWidths } from "./use-column-widths";

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
  autoRefreshIntervalMinutes: 10,
  refreshScope: "all",
  autoUpdateCheckEnabled: true,
  closeToTray: false,
  launchAtStartup: false
};

/** P2-5：「最近活跃」刷新范围的窗口期。 */
const REFRESH_SCOPE_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/** 导入结果的 toast 文案：带跳过原因，否则用户只知道「跳过 1 个」却不知道为什么（P16）。 */
function importResultMessage(result: ImportResult): string {
  const head = `导入 ${result.imported} 个，更新 ${result.updated} 个，跳过 ${result.skipped} 个`;
  if (result.skipped <= 0 || result.errors.length === 0) {
    return head;
  }
  return `${head}。跳过原因：${result.errors.slice(0, 2).join("；")}`;
}

function EditAccountModal({
  account,
  onClose,
  onSubmit,
  onSaved,
  onDelete
}: {
  account: AccountView;
  onClose: () => void;
  onSubmit: (input: AccountUpdateInput) => Promise<AccountView | null>;
  onSaved: () => void;
  onDelete: () => void;
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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<AccountField>>({});
  const emailInputRef = useRef<HTMLInputElement>(null);
  const clientIdInputRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");

    // 编辑时 refresh_token 允许留空（保持不变），但邮箱/Client ID 仍要说清楚（P4）。
    const errors = validateAccountFields(
      { email: form.email, clientId: form.clientId, refreshToken: form.refreshToken ?? "" },
      { requireRefreshToken: false }
    );
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      const firstField = firstErrorField(errors, ["email", "clientId"]);
      (firstField === "clientId" ? clientIdInputRef : emailInputRef).current?.focus();
      return;
    }
    setFieldErrors({});
    setLoading(true);

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
          {/* 删除放在编辑弹窗里、和「保存」隔开：报告 P1-13 指出它原来紧挨着工具栏的「编辑」，
              手滑点错就会弹删除确认。 */}
          <button type="button" className="modal-actions-danger danger-ghost toolbar-button" onClick={onDelete}>
            <Trash2 size={15} />
            删除这个账号
          </button>
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
          <input
            ref={emailInputRef}
            value={form.email}
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? "edit-email-error" : undefined}
            onChange={(event) => {
              setForm({ ...form, email: event.target.value });
              setFieldErrors((previous) => ({ ...previous, email: undefined }));
            }}
          />
          {fieldErrors.email ? (
            <span className="field-error" id="edit-email-error" role="alert">
              {fieldErrors.email}
            </span>
          ) : null}
        </label>
        <label>
          Client ID
          <input
            ref={clientIdInputRef}
            value={form.clientId}
            aria-invalid={fieldErrors.clientId ? true : undefined}
            aria-describedby={fieldErrors.clientId ? "edit-client-id-error" : undefined}
            onChange={(event) => {
              setForm({ ...form, clientId: event.target.value });
              setFieldErrors((previous) => ({ ...previous, clientId: undefined }));
            }}
          />
          {fieldErrors.clientId ? (
            <span className="field-error" id="edit-client-id-error" role="alert">
              {fieldErrors.clientId}
            </span>
          ) : null}
        </label>
        <label className="span-2">
          Refresh Token
          <textarea
            value={form.refreshToken}
            aria-invalid={fieldErrors.refreshToken ? true : undefined}
            aria-describedby={fieldErrors.refreshToken ? "edit-refresh-token-error" : undefined}
            onChange={(event) => {
              setForm({ ...form, refreshToken: event.target.value });
              setFieldErrors((previous) => ({ ...previous, refreshToken: undefined }));
            }}
          />
          {fieldErrors.refreshToken ? (
            <span className="field-error" id="edit-refresh-token-error" role="alert">
              {fieldErrors.refreshToken}
            </span>
          ) : (
            <span className="field-hint">留空则保持不变；更换新的 refresh_token 会把账号重新标记为未测。</span>
          )}
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
  // 本机打开过的邮件：用来把「未读但已看过」的行做弱化样式，避免未读圆点变成装饰品。
  const [visitedMessages, setVisitedMessages] = useState<Set<string>>(() => loadVisitedMessages());
  // 三栏宽度可拖拽（记在本机），解决窄窗口下阅读区只剩 394px 的问题。
  const { widths: columnWidths, resizing: columnsResizing, beginResize, resetWidths, nudgeColumn } =
    useColumnWidths();
  const shellStyle = useMemo(
    () => ({ "--w-sidebar": `${columnWidths.sidebar}px` }) as CSSProperties,
    [columnWidths.sidebar]
  );
  const workspaceStyle = useMemo(
    () => ({ "--w-list": `${columnWidths.list}px` }) as CSSProperties,
    [columnWidths.list]
  );
  const [statusFilter, setStatusFilter] = useState<"all" | "valid" | "invalid" | "untested">("all");
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AccountView | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [testMenuOpen, setTestMenuOpen] = useState(false);
  const testMenuRef = useRef<HTMLDivElement | null>(null);
  const [newMailCounts, setNewMailCounts] = useState<Record<string, number>>({});
  const [toast, setToast] = useState("");
  // toast 默认 6 秒；长文案（带跳过原因）给 10 秒。鼠标悬停时暂停，
  // 移开后用剩余时间续上，避免用户刚要读就消失（P15）。
  const toastTimerRef = useRef<number | null>(null);
  const toastDeadlineRef = useRef(0);
  const toastRemainingRef = useRef(0);
  // 错误横幅同时带错误码：用户报障时能直接说「NETWORK_ERROR」而不是复述一大段中文。
  const [errorState, setErrorState] = useState<{ message: string; code: AppErrorCode | null }>({
    message: "",
    code: null
  });
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
    selectedMessageId,
    totalCount: mailTotalCount
  } = mailbox.state;
  const {
    accounts,
    fallbackTestingAccountIds,
    loadingAccounts,
    testingAccountIds
  } = accountCatalog.state;

  // 打开一封邮件就记一笔（只记本机，不回写服务器）。
  useEffect(() => {
    if (!selectedAccountId || !selectedMessageId) {
      return;
    }
    setVisitedMessages((previous) => {
      const key = messageVisitKey(selectedAccountId, selectedMessageId);
      if (previous.has(key)) {
        return previous;
      }
      const next = new Set(previous);
      next.add(key);
      saveVisitedMessages(next);
      return next;
    });
  }, [selectedAccountId, selectedMessageId]);

  // 列表只关心当前账号下的邮件 id。
  const visitedMessageIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedAccountId) {
      return ids;
    }
    const prefix = `${selectedAccountId}:`;
    for (const key of visitedMessages) {
      if (key.startsWith(prefix)) {
        ids.add(key.slice(prefix.length));
      }
    }
    return ids;
  }, [selectedAccountId, visitedMessages]);
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
  // 顶部横幅与邮件列表区都渲染错误。如果两边是同一句话（同一账号的同一个失败），
  // 只保留列表区那份（它带重试按钮和完整诊断），否则看起来像出了两个问题（P12）。
  const displayedError = useMemo(() => {
    const candidate = errorState.message || mailboxError;
    if (!candidate) {
      return "";
    }
    const listError = mailbox.state.listError;
    if (listError && splitErrorMessage(listError).title === splitErrorMessage(candidate).title) {
      return "";
    }
    return candidate;
  }, [errorState, mailboxError, mailbox.state.listError]);

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
    setErrorState({ message: "", code: null });
    mailbox.clearError();
  }, [mailbox]);

  const loadAccounts = useCallback(
    async (forceReload = true) => {
      if (!desktopApi) {
        setErrorState({ message: "当前页面未运行在 Electron 桌面环境中，请使用 npm run dev 启动桌面应用。", code: null });
        return;
      }
      clearErrors();

      try {
        await (forceReload ? accountCatalog.reload() : accountCatalog.load());
      } catch (loadError) {
        setErrorState({ message: errorMessage(loadError), code: isAppError(loadError) ? loadError.code : null });
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
      setErrorState({ message: errorMessage(settingsError), code: isAppError(settingsError) ? settingsError.code : null });
    }
  }, [desktopApi]);

  const importFromFile = useCallback(async () => {
    if (!desktopApi) {
      setErrorState({ message: "文件导入需要在 Electron 桌面应用中使用。", code: null });
      return;
    }

    clearErrors();

    try {
      const result = await accountCatalog.importFile();

      if (!result) {
        return;
      }

      setToast(importResultMessage(result));
    } catch (importError) {
      setErrorState({ message: errorMessage(importError), code: isAppError(importError) ? importError.code : null });
    }
  }, [accountCatalog, clearErrors, desktopApi]);

  const testConnection = useCallback(
    async (accountId: string) => {
      setTestMenuOpen(false);
      if (!desktopApi) {
        setErrorState({ message: "连接测试需要在 Electron 桌面应用中使用。", code: null });
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
          // 失败也要留一条记录：只 setError 时，如果横幅上已经是同一句话，
          // 屏幕上就一个字都不会变（P9）。
          setErrorState({
            message: result.error.message,
            code: isAppError(result.error) ? result.error.code : null
          });
          setToast(`测试失败：${splitErrorMessage(result.error.message).title}`);
        }
      } catch (testError) {
        setErrorState({ message: errorMessage(testError), code: isAppError(testError) ? testError.code : null });
      }
    },
    [accountCatalog, clearErrors, desktopApi]
  );

  const testFallback = useCallback(
    async (accountId: string) => {
      setTestMenuOpen(false);
      if (!desktopApi) {
        setErrorState({ message: "兜底测试需要在 Electron 桌面应用中使用。", code: null });
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
          setErrorState({
            message: result.error.message,
            code: isAppError(result.error) ? result.error.code : null
          });
          setToast(`兜底测试失败：${splitErrorMessage(result.error.message).title}`);
        }
      } catch (fallbackError) {
        setErrorState({ message: errorMessage(fallbackError), code: isAppError(fallbackError) ? fallbackError.code : null });
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
      setErrorState({ message: errorMessage(testError), code: isAppError(testError) ? testError.code : null });
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
      setErrorState({ message: errorMessage(cancelError), code: isAppError(cancelError) ? cancelError.code : null });
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
        setErrorState({ message: "桌面接口不可用", code: null });
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
          setErrorState({ message, code: isAppError(refreshError) ? refreshError.code : null });
        }
      }
    },
    [accountCatalog, clearErrors, desktopApi, mailbox, recordNewMailCounts, refreshJobs]
  );

  const refreshSingleAccount = useCallback(
    async (accountId: string) => {
      if (!desktopApi) {
        setErrorState({ message: "桌面接口不可用", code: null });
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
          setErrorState({
            message: refreshMessage,
            code: result?.error && isAppError(result.error) ? result.error.code : null
          });
        } else {
          setToast(`${email} 刷新失败：${splitErrorMessage(refreshMessage).title}`);
        }
      } catch (refreshError) {
        const refreshMessage = errorMessage(refreshError);
        if (mailbox.isCurrentAccount(accountId)) {
          setErrorState({
            message: refreshMessage,
            code: isAppError(refreshError) ? refreshError.code : null
          });
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
      setErrorState({ message: errorMessage(cancelError), code: isAppError(cancelError) ? cancelError.code : null });
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
  const reloadAccounts = useCallback(
    () => {
      // 这个按钮只是从本地库重新读列表，不是重新测试账号；不给反馈时
      // 用户会以为它坏了（P10）。
      void loadAccounts().then(() => setToast("账号列表已重新加载"));
    },
    [loadAccounts]
  );

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
      setErrorState({ message: "账号管理需要在 Electron 桌面应用中使用。", code: null });
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
      setErrorState({ message: errorMessage(deleteError), code: isAppError(deleteError) ? deleteError.code : null });
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
      toastRemainingRef.current = 0;
      toastTimerRef.current = null;
      return;
    }

    const duration = toast.length > 40 ? 10000 : 6000;
    toastRemainingRef.current = duration;
    toastDeadlineRef.current = Date.now() + duration;
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast("");
    }, duration);

    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, [toast]);

  const pauseToast = useCallback(() => {
    if (toastTimerRef.current === null) {
      return;
    }
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
    toastRemainingRef.current = Math.max(0, toastDeadlineRef.current - Date.now());
  }, []);

  const resumeToast = useCallback(() => {
    if (!toast || toastTimerRef.current !== null) {
      return;
    }
    const remaining = toastRemainingRef.current > 0 ? toastRemainingRef.current : 1500;
    toastDeadlineRef.current = Date.now() + remaining;
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast("");
    }, remaining);
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

      // P2-5：范围可选。recent = 只刷最近 7 天收到过邮件的可用账号，
      // 避免 407 个账号 × 每 10 分钟把代理和微软接口压满。
      const scopedAccounts = settings.refreshScope === "recent"
        ? accounts.filter((account) => {
            if (account.status !== "valid" || !account.lastMailAt) {
              return false;
            }
            const lastMailAt = new Date(account.lastMailAt).getTime();
            return Number.isFinite(lastMailAt) && Date.now() - lastMailAt <= REFRESH_SCOPE_RECENT_MS;
          })
        : accounts.filter((account) => account.status === "valid");
      const accountIds = scopedAccounts.map((account) => account.id);
      if (accountIds.length === 0) {
        return;
      }

      void refreshAccounts(accountIds, "定时刷新", { silent: true });
    }, intervalMs);

    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 定时器只跟随设置变化重建；accounts/anyJobRunning 在回调内读取最新值
  }, [accounts, anyJobRunning, settings.autoRefreshEnabled, settings.autoRefreshIntervalMinutes, settings.refreshScope]);

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
    <div className={`mail-app${columnsResizing ? " is-resizing-columns" : ""}`}>
      <div className="mail-shell" style={shellStyle}>
        <div
          className="column-resizer column-resizer-sidebar"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整账号栏宽度（双击恢复默认）"
          tabIndex={0}
          onPointerDown={(event) => beginResize("sidebar", event)}
          onDoubleClick={resetWidths}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              nudgeColumn("sidebar", event.key === "ArrowLeft" ? -16 : 16);
            }
          }}
        />
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
          selectedAccountError={mailboxError || undefined}
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
              {/* 失败也要留痕：否则用户点完「测试」看不出到底测没测（P9）。 */}
              {selectedAccount?.lastCheckedAt ? (
                <p className="last-tested-at">
                  上次测试 {formatRelativeTime(selectedAccount.lastCheckedAt)} · 结果 {statusMeta(selectedAccount).label}
                </p>
              ) : null}
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
            </div>
          </header>

          {displayedError ? <ErrorBanner message={displayedError} code={errorState.code} onDismiss={clearErrors} /> : null}
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

          <div className="workspace-content" style={workspaceStyle}>
            <div
              className="column-resizer column-resizer-list"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整邮件列表宽度（双击恢复默认）"
              tabIndex={0}
              onPointerDown={(event) => beginResize("list", event)}
              onDoubleClick={resetWidths}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  nudgeColumn("list", event.key === "ArrowLeft" ? -16 : 16);
                }
              }}
            />
            <MessageList
              messages={messages}
              selectedMessageId={selectedMessageId}
              loadingMessages={loadingMessages}
              loadingMore={loadingMore}
              mailCursor={mailCursor}
              totalCount={mailTotalCount}
              visitedMessageIds={visitedMessageIds}
              mailQuery={mailQuery}
              folders={folders}
              selectedFolderId={selectedFolderId}
              inboxFolderId={selectedAccount?.inboxFolderId ?? null}
              listError={mailbox.state.listError}
              listStale={mailbox.state.listStale}
              listStaleReason={mailbox.state.listStaleReason}
              canRefresh={Boolean(selectedAccountId)}
              onMailQueryChange={setMailQuery}
              onExecuteSearch={executeMailSearch}
              onClearSearch={clearMailSearch}
              onRefresh={refreshMailbox}
              onSelectFolder={selectFolder}
              onSelectMessage={selectMessage}
              onLoadMore={loadMoreMessages}
            />

            <MailReader
              accountId={selectedAccountId}
              folderId={selectedFolderId}
              selectedMessage={selectedMessage}
              messageDetail={messageDetail}
              loadingDetail={loadingDetail}
              detailError={mailbox.state.detailError}
              onRetryDetail={() => void mailbox.retryDetail()}
            />
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
            setToast(importResultMessage(result));
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
          onDelete={() => {
            setEditingAccount(null);
            requestDeleteAccount();
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

      {toast ? (
        <div
          className="toast"
          role="status"
          aria-live="polite"
          onMouseEnter={pauseToast}
          onMouseLeave={resumeToast}
          onFocus={pauseToast}
          onBlur={resumeToast}
        >
          <span className="toast-text">{toast}</span>
          <button type="button" className="toast-close" onClick={() => setToast("")} aria-label="关闭提示" title="关闭提示">
            <X size={13} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

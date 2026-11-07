import { FileUp, Inbox, Loader2, Mail, Plus, RefreshCw, Search, Settings, X } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { splitErrorMessage } from "../error-display";
import { resolveFixedVirtualWindow } from "../fixed-virtual-window";
import type { AccountView } from "../types";
import { accountMailStats, statusMeta } from "../ui-utils";
import { TokenGuidePanel } from "./TokenGuidePanel";

const ACCOUNT_ROW_HEIGHT = 88;
const DEFAULT_VIEWPORT_HEIGHT = 660;

export const AccountSidebar = memo(function AccountSidebar({
  accounts,
  filteredAccounts,
  selectedAccountId,
  loadingAccounts,
  accountQuery,
  statusFilter,
  onAccountQueryChange,
  onStatusFilterChange,
  onSelectAccount,
  onOpenImport,
  onImportFromFile,
  onReloadAccounts,
  onOpenSettings,
  newMailCounts,
  busyAccountIds,
  refreshDisabled = false,
  onRefreshAccount,
  selectedAccountError
}: {
  accounts: readonly AccountView[];
  filteredAccounts: readonly AccountView[];
  selectedAccountId: string | null;
  loadingAccounts: boolean;
  accountQuery: string;
  statusFilter: "all" | "valid" | "invalid" | "untested";
  onAccountQueryChange: (value: string) => void;
  onStatusFilterChange: (value: "all" | "valid" | "invalid" | "untested") => void;
  onSelectAccount: (accountId: string) => void;
  onOpenImport: () => void;
  onImportFromFile: () => void;
  onReloadAccounts: () => void;
  onOpenSettings: () => void;
  newMailCounts?: Record<string, number>;
  busyAccountIds?: ReadonlySet<string>;
  refreshDisabled?: boolean;
  onRefreshAccount: (accountId: string) => void;
  /** 当前选中账号读邮件失败时的原因：侧栏不能一边显示 ✓ 可用一边读不出邮件。 */
  selectedAccountError?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // Ctrl+F / Cmd+F 把焦点导到侧栏搜索框，替代浏览器默认查找。放本组件内
  // 而不是 App，是为了让搜索框与其焦点行为内聚、可独立测试。
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        const input = searchInputRef.current;
        if (!input) {
          return;
        }
        event.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const virtualWindow = resolveFixedVirtualWindow({
    itemCount: filteredAccounts.length,
    itemHeight: ACCOUNT_ROW_HEIGHT,
    scrollTop,
    viewportHeight
  });
  const visibleAccounts = useMemo(
    () => filteredAccounts.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [filteredAccounts, virtualWindow.startIndex, virtualWindow.endIndex]
  );
  // 筛选标签上带数量：否则“失效”一点进去变空列表，用户不知道是没结果还是没数据。
  const statusCounts = useMemo(() => {
    const counts = { all: accounts.length, valid: 0, invalid: 0, untested: 0 };
    for (const account of accounts) {
      counts[account.status] += 1;
    }
    return counts;
  }, [accounts]);

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current;
    if (!scrollArea) {
      return;
    }

    const measure = () => {
      if (scrollArea.clientHeight > 0) {
        setViewportHeight(scrollArea.clientHeight);
      }
    };

    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(scrollArea);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current;
    if (scrollArea && scrollArea.scrollTop !== virtualWindow.scrollTop) {
      scrollArea.scrollTop = virtualWindow.scrollTop;
      setScrollTop(virtualWindow.scrollTop);
    }
  }, [virtualWindow.scrollTop]);

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current;
    if (scrollArea) {
      scrollArea.scrollTop = 0;
    }
    setScrollTop(0);
  }, [accountQuery, statusFilter]);

  return (
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
        <button className="import-button" onClick={onOpenImport}>
          <Plus size={16} />
          导入
        </button>
        <button className="square-button" onClick={onImportFromFile} title="从文件导入（.txt / .csv）" aria-label="从文件导入账号（.txt / .csv）">
          <FileUp size={16} />
        </button>
        {/* 这个按钮只是从本地库重读列表，不是重新测试账号；名字和反馈都得说清楚（P10） */}
        <button
          className="square-button"
          onClick={onReloadAccounts}
          title="重新加载账号列表（不重新测试）"
          aria-label="重新加载账号列表"
        >
          <RefreshCw size={16} />
        </button>
        <button className="square-button" onClick={onOpenSettings} title="设置" aria-label="打开设置">
          <Settings size={16} />
        </button>
      </div>

      <div className="sidebar-search">
        <Search size={16} />
        <input
          ref={searchInputRef}
          value={accountQuery}
          onChange={(event) => onAccountQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && accountQuery) {
              event.preventDefault();
              onAccountQueryChange("");
            }
          }}
          placeholder="搜索邮箱"
          aria-label="搜索邮箱账号"
        />
        {accountQuery ? (
          <button
            type="button"
            className="search-clear"
            onClick={() => onAccountQueryChange("")}
            title="清除搜索"
            aria-label="清除搜索"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>

      <div className="sidebar-stats" role="status" aria-live="polite">
        <span>
          {filteredAccounts.length} / {accounts.length} 个邮箱
        </span>
      </div>

      <div className="segmented slim-segmented">
        <button type="button" className={statusFilter === "all" ? "active" : ""} onClick={() => onStatusFilterChange("all")}>
          全部 <span className="segment-count">{statusCounts.all}</span>
        </button>
        <button type="button" className={statusFilter === "valid" ? "active" : ""} onClick={() => onStatusFilterChange("valid")}>
          可用 <span className="segment-count">{statusCounts.valid}</span>
        </button>
        <button type="button" className={statusFilter === "invalid" ? "active" : ""} onClick={() => onStatusFilterChange("invalid")}>
          失效 <span className="segment-count">{statusCounts.invalid}</span>
        </button>
        <button type="button" className={statusFilter === "untested" ? "active" : ""} onClick={() => onStatusFilterChange("untested")}>
          未测 <span className="segment-count">{statusCounts.untested}</span>
        </button>
      </div>

      <div
        ref={scrollRef}
        className="account-scroll"
        aria-busy={loadingAccounts}
        aria-label="邮箱账号"
        role="region"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {loadingAccounts ? (
          <div className="panel-empty account-scroll-state">
            <Loader2 size={22} className="spin" />
            <p>加载账号</p>
          </div>
        ) : null}

        {!loadingAccounts && filteredAccounts.length === 0 ? (
          <div className="panel-empty account-scroll-state">
            <Inbox size={24} />
            {accounts.length === 0 ? (
              <>
                <p>还没有导入任何邮箱</p>
                <p className="panel-empty-hint">
                  粘贴 refresh_token，或用左上角的「从文件导入」按钮上传 .txt / .csv，就能开始读取邮件。
                </p>
                <button type="button" className="panel-error-retry" onClick={onOpenImport}>
                  导入第一个账号
                </button>
                <TokenGuidePanel className="empty-state-guide" />
              </>
            ) : (
              <>
                <p>没有符合条件的邮箱</p>
                <button
                  type="button"
                  className="panel-error-retry"
                  onClick={() => {
                    onAccountQueryChange("");
                    onStatusFilterChange("all");
                  }}
                >
                  清除筛选
                </button>
              </>
            )}
          </div>
        ) : null}

        {filteredAccounts.length > 0 ? (
          <div className="account-virtual-space" style={{ height: virtualWindow.totalHeight }}>
            <div className="account-virtual-window" style={{ transform: `translateY(${virtualWindow.offsetTop}px)` }}>
              {visibleAccounts.map((account, visibleIndex) => {
                const meta = statusMeta(account);
                const StatusIcon = meta.icon;
                const newCount = newMailCounts?.[account.id] || 0;
                const isRefreshing = busyAccountIds?.has(account.id) || false;
                const accountIndex = virtualWindow.startIndex + visibleIndex;

                return (
                  <div
                    key={account.id}
                    className={`account-row ${account.id === selectedAccountId ? "selected" : ""}`}
                    data-account-index={accountIndex}
                    role="button"
                    tabIndex={0}
                    title={`${account.email}${account.remark ? ` · ${account.remark}` : ""}`}
                    onClick={() => onSelectAccount(account.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectAccount(account.id);
                      }
                    }}
                  >
                    <div className="account-text">
                      <strong>{account.email}</strong>
                      <div className="account-meta-row">
                        <span className="account-remark">{account.remark || account.group}</span>
                        <span className={`account-stats ${account.status === "invalid" && !account.lastRefreshedAt ? "account-stats-failed" : ""}`}>
                          {accountMailStats(account)}
                        </span>
                        {account.id === selectedAccountId && selectedAccountError ? (
                          <span className="account-load-error" title={selectedAccountError}>
                            读取失败
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="account-badges">
                      {newCount > 0 ? <span className="new-mail-chip">+{newCount}</span> : null}
                      <button
                        type="button"
                        className={`${meta.className} account-refresh-status`}
                        title={
                          account.lastError
                            ? `${meta.label}：${splitErrorMessage(account.lastError).title}（点击重新刷新）`
                            : `${meta.label}，点击刷新账号`
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          onRefreshAccount(account.id);
                        }}
                        aria-label={
                          account.lastError
                            ? `${meta.label}：${splitErrorMessage(account.lastError).title}（点击重新刷新）`
                            : `${meta.label}，点击刷新账号`
                        }
                        disabled={refreshDisabled || isRefreshing}
                      >
                        {isRefreshing ? <Loader2 size={12} className="spin" /> : <StatusIcon size={12} />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
});

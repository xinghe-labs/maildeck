import { FileUp, Inbox, Loader2, Mail, Plus, RefreshCw, Search, Settings } from "lucide-react";
import type { AccountView } from "../types";
import { accountMailStats, statusMeta } from "../ui-utils";

export function AccountSidebar({
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
  refreshingAccountIds,
  onRefreshAccount
}: {
  accounts: AccountView[];
  filteredAccounts: AccountView[];
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
  refreshingAccountIds?: Set<string>;
  onRefreshAccount: (accountId: string) => void;
}) {
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
        <button className="square-button" onClick={onImportFromFile} title="导入文件">
          <FileUp size={16} />
        </button>
        <button className="square-button" onClick={onReloadAccounts} title="刷新账号">
          <RefreshCw size={16} />
        </button>
        <button className="square-button" onClick={onOpenSettings} title="设置">
          <Settings size={16} />
        </button>
      </div>

      <div className="sidebar-search">
        <Search size={16} />
        <input value={accountQuery} onChange={(event) => onAccountQueryChange(event.target.value)} placeholder="搜索邮箱" />
      </div>

      <div className="sidebar-stats">
        <span>
          {filteredAccounts.length} / {accounts.length} 个邮箱
        </span>
      </div>

      <div className="segmented slim-segmented">
        <button type="button" className={statusFilter === "all" ? "active" : ""} onClick={() => onStatusFilterChange("all")}>
          全部
        </button>
        <button type="button" className={statusFilter === "valid" ? "active" : ""} onClick={() => onStatusFilterChange("valid")}>
          可用
        </button>
        <button type="button" className={statusFilter === "invalid" ? "active" : ""} onClick={() => onStatusFilterChange("invalid")}>
          失效
        </button>
        <button type="button" className={statusFilter === "untested" ? "active" : ""} onClick={() => onStatusFilterChange("untested")}>
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
          const newCount = newMailCounts?.[account.id] || 0;
          const isRefreshing = refreshingAccountIds?.has(account.id) || false;

          return (
            <div
              key={account.id}
              className={`account-row ${account.id === selectedAccountId ? "selected" : ""}`}
              role="button"
              tabIndex={0}
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
                  <span>{account.remark || "Hotmail OAuth"}</span>
                  <span>{accountMailStats(account)}</span>
                </div>
              </div>
              <div className="account-badges">
                {newCount > 0 ? <span className="new-mail-chip">+{newCount}</span> : null}
                <button
                  type="button"
                  className={`${meta.className} account-refresh-status`}
                  title={`${meta.label}，点击刷新账号`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRefreshAccount(account.id);
                  }}
                  disabled={isRefreshing}
                >
                  {isRefreshing ? <Loader2 size={12} className="spin" /> : <StatusIcon size={12} />}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

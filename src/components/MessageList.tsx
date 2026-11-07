import { AlertCircle, ClipboardList, Inbox, Loader2, Paperclip, Plus, RefreshCw, Search, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { splitErrorMessage } from "../error-display";
import { ErrorDetailCopy } from "./ErrorDetailCopy";
import { resolveFixedVirtualWindow } from "../fixed-virtual-window";
import { resolveMailListFooter } from "../mail-pagination";
import type { MailFolder, MailMessageSummary } from "../types";
import { formatDateShort, senderLabel } from "../ui-utils";

const MESSAGE_ROW_HEIGHT = 64;
const DEFAULT_VIEWPORT_HEIGHT = 660;
// 未传 visitedMessageIds 时（测试/其他调用方）用的空集合，避免每次 render 新建。
const EMPTY_VISITED: ReadonlySet<string> = new Set<string>();

// Graph/IMAP 返回的常用文件夹英文名映射为中文；未知名保留原文。
const FOLDER_DISPLAY_NAMES: Record<string, string> = {
  inbox: "收件箱",
  "sent items": "已发送",
  sent: "已发送",
  drafts: "草稿箱",
  "deleted items": "已删除",
  deleted: "已删除",
  junk: "垃圾邮件",
  "junk email": "垃圾邮件",
  archive: "存档",
  outbox: "发件箱",
  notes: "笔记",
  conversationhistory: "对话历史记录"
};

/**
 * 列表加载的已等待秒数。报告 P2-16：切到草稿箱后长时间只有「正在刷新邮件」，
 * 用户不知道是在加载还是卡死了。把等待时间显示出来，超过阈值再补一句说明。
 */
function useLoadingElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setSeconds(0);
    const timer = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return seconds;
}

export function folderDisplayLabel(displayName: string) {
  return FOLDER_DISPLAY_NAMES[displayName.trim().toLowerCase()] ?? displayName;
}

export const MessageList = memo(function MessageList({
  messages,
  selectedMessageId,
  loadingMessages,
  loadingMore,
  mailCursor,
  totalCount = null,
  visitedMessageIds = EMPTY_VISITED,
  mailQuery,
  folders,
  selectedFolderId,
  inboxFolderId,
  canRefresh,
  listError,
  onMailQueryChange,
  onExecuteSearch,
  onClearSearch,
  onRefresh,
  onSelectFolder,
  onSelectMessage,
  onLoadMore
}: {
  messages: readonly MailMessageSummary[];
  selectedMessageId: string | null;
  loadingMessages: boolean;
  loadingMore: boolean;
  mailCursor: string | null;
  totalCount?: number | null;
  /** 当前账号下本机已打开过的邮件 id（用来把「未读但已看过」的行弱化）。 */
  visitedMessageIds?: ReadonlySet<string>;
  mailQuery: string;
  folders: readonly MailFolder[];
  selectedFolderId: string | null;
  inboxFolderId: string | null;
  canRefresh: boolean;
  listError: string;
  onMailQueryChange: (value: string) => void;
  onExecuteSearch: () => void;
  onClearSearch: () => void;
  onRefresh: () => void;
  onSelectFolder: (folderId: string | null) => void;
  onSelectMessage: (messageId: string) => void;
  onLoadMore: () => void;
}) {
  // 文件夹多于一个才显示下拉框：只有收件箱（或列表加载失败）时保持原标题。
  const showFolderPicker = folders.length > 1;
  const trimmedQuery = mailQuery.trim();
  const listErrorDisplay = splitErrorMessage(listError);
  const loadingSeconds = useLoadingElapsed(loadingMessages);
  // 空列表必须说清楚“为什么空”：没选账号 / 搜索无结果 / 文件夹本身空，不能笼统写“没有邮件”。
  const emptyHint = !canRefresh
    ? "先在左侧选择一个邮箱"
    : trimmedQuery
      ? `没有找到匹配「${trimmedQuery}」的邮件`
      : "这个文件夹里还没有邮件";
  // Graph/IMAP 的文件夹列表本身就含收件箱，若不剔除会与内置的「收件箱」选项重复。
  const inboxFolder = useMemo(() => {
    if (inboxFolderId) {
      return folders.find((folder) => folder.id === inboxFolderId) ?? null;
    }
    return folders.find((folder) => folder.displayName.trim() === "收件箱") ?? null;
  }, [folders, inboxFolderId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // 底部计数与「还有更多」入口统一由 resolveMailListFooter 判定：
  // 总数比已显示多但没有游标时，至少还能给一个「重新加载剩余」。
  const listFooter = resolveMailListFooter({
    cursor: mailCursor,
    displayedCount: messages.length,
    totalCount
  });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const previousListKeyRef = useRef<string | null>(null);
  const virtualWindow = resolveFixedVirtualWindow({
    itemCount: messages.length,
    itemHeight: MESSAGE_ROW_HEIGHT,
    scrollTop,
    viewportHeight
  });
  const visibleMessages = useMemo(
    () => messages.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [messages, virtualWindow.startIndex, virtualWindow.endIndex]
  );

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

  // 列表重建（切换账号/文件夹/刷新）时回到顶部；“加载更多”追加不触发。
  const listKey = messages.length > 0 ? messages[0].id : null;
  useLayoutEffect(() => {
    if (listKey !== previousListKeyRef.current) {
      previousListKeyRef.current = listKey;
      const scrollArea = scrollRef.current;
      if (scrollArea) {
        scrollArea.scrollTop = 0;
      }
      setScrollTop(0);
    }
  }, [listKey]);
  return (
    <section className="list-panel">
      <div className="list-header">
        <div className="folder-title">
          <Inbox size={16} />
          {showFolderPicker ? (
            <select
              className="folder-select"
              value={selectedFolderId ?? ""}
              onChange={(event) => onSelectFolder(event.target.value || null)}
            >
              <option value="">{folderDisplayLabel(inboxFolder?.displayName ?? "收件箱")}</option>
              {folders
                .filter((folder) => folder.id !== (selectedFolderId ?? ""))
                .filter((folder) => folder.id !== inboxFolder?.id)
                .map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folderDisplayLabel(folder.displayName)}
                  </option>
                ))}
            </select>
          ) : (
            <span>收件箱</span>
          )}
        </div>
        <div className="list-searchbar">
          <div className="search-box">
            <Search size={16} />
            <input
              value={mailQuery}
              onChange={(event) => onMailQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canRefresh) {
                  onExecuteSearch();
                }
                if (event.key === "Escape" && mailQuery) {
                  event.preventDefault();
                  onClearSearch();
                }
              }}
              placeholder="搜索主题，回车执行"
              aria-label="搜索邮件主题"
            />
            {mailQuery ? (
              <button
                type="button"
                className="search-clear"
                onClick={onClearSearch}
                title="清除搜索"
                aria-label="清除搜索"
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
          <button
            className="toolbar-icon"
            onClick={onRefresh}
            disabled={!canRefresh || loadingMessages}
            title="强制刷新"
            aria-label="强制刷新邮件列表"
          >
            {loadingMessages ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={`message-scroll ${loadingMessages && messages.length > 0 ? "is-stale" : ""}`}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {loadingMessages && messages.length === 0 ? (
          <div className="panel-empty" role="status" aria-live="polite">
            <Loader2 size={22} className="spin" />
            <p>{loadingSeconds >= 3 ? `正在刷新邮件（已等待 ${loadingSeconds} 秒）` : "正在刷新邮件"}</p>
            {loadingSeconds >= 8 ? (
              <p className="panel-empty-hint">
                这个文件夹比平时慢，还在等微软返回；超过 30 秒会超时并给出失败原因。
              </p>
            ) : null}
          </div>
        ) : null}

        {!loadingMessages && messages.length === 0 && listError ? (
          <div className="panel-empty panel-error">
            <AlertCircle size={24} />
            <p>邮件列表加载失败</p>
            {listErrorDisplay.title ? <p className="panel-error-title">{listErrorDisplay.title}</p> : null}
            {listErrorDisplay.detail ? (
              <details className="panel-error-details">
                <summary>查看详情</summary>
                <pre>{listErrorDisplay.detail}</pre>
                <ErrorDetailCopy detail={listErrorDisplay.detail} />
              </details>
            ) : null}
            <button type="button" className="panel-error-retry" onClick={onRefresh} disabled={!canRefresh}>
              重试
            </button>
          </div>
        ) : null}

        {!loadingMessages && messages.length === 0 && !listError ? (
          <div className="panel-empty">
            <ClipboardList size={24} />
            <p>{emptyHint}</p>
            {trimmedQuery ? (
              <button type="button" className="panel-error-retry" onClick={onClearSearch}>
                清除搜索
              </button>
            ) : null}
          </div>
        ) : null}

        {messages.length > 0 ? (
          <div className="message-virtual-space" style={{ height: virtualWindow.totalHeight }}>
            <div
              className="message-virtual-window"
              style={{ transform: `translateY(${virtualWindow.offsetTop}px)` }}
            >
              {visibleMessages.map((message, index) => (
                <button
                  key={message.id}
                  className={`message-row ${message.id === selectedMessageId ? "selected" : ""} ${
                    message.isRead ? "" : visitedMessageIds.has(message.id) ? "is-unread is-visited" : "is-unread"
                  }`}
                  data-message-index={virtualWindow.startIndex + index}
                  disabled={loadingMessages}
                  onClick={() => onSelectMessage(message.id)}
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
            </div>
          </div>
        ) : null}
        {listFooter.action !== "none" && !loadingMessages ? (
          <div className="message-list-footer">
            {listFooter.countText ? <span className="message-list-count">{listFooter.countText}</span> : null}
            <button
              className="load-more-button"
              onClick={listFooter.action === "reload" ? onRefresh : onLoadMore}
              disabled={loadingMore}
              title={
                listFooter.action === "reload"
                  ? "服务器没有返回分页游标，重新拉取一次把剩下的邮件补齐"
                  : undefined
              }
            >
              {loadingMore ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
              {listFooter.action === "reload" ? "重新加载剩余邮件" : "加载更多"}
            </button>
          </div>
        ) : null}

        {listFooter.action === "none" && listFooter.countText && !loadingMessages ? (
          <p className="message-list-count is-footer">{listFooter.countText}</p>
        ) : null}
      </div>
    </section>
  );
});

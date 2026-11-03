import { AlertCircle, ClipboardList, Inbox, Loader2, Paperclip, Plus, RefreshCw, Search } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { resolveFixedVirtualWindow } from "../fixed-virtual-window";
import type { MailFolder, MailMessageSummary } from "../types";
import { formatDateShort, senderLabel } from "../ui-utils";

const MESSAGE_ROW_HEIGHT = 64;
const DEFAULT_VIEWPORT_HEIGHT = 660;

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

export function folderDisplayLabel(displayName: string) {
  return FOLDER_DISPLAY_NAMES[displayName.trim().toLowerCase()] ?? displayName;
}

export const MessageList = memo(function MessageList({
  messages,
  selectedMessageId,
  loadingMessages,
  loadingMore,
  mailCursor,
  mailQuery,
  folders,
  selectedFolderId,
  inboxFolderId,
  canRefresh,
  listError,
  onMailQueryChange,
  onExecuteSearch,
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
  mailQuery: string;
  folders: readonly MailFolder[];
  selectedFolderId: string | null;
  inboxFolderId: string | null;
  canRefresh: boolean;
  listError: string;
  onMailQueryChange: (value: string) => void;
  onExecuteSearch: () => void;
  onRefresh: () => void;
  onSelectFolder: (folderId: string | null) => void;
  onSelectMessage: (messageId: string) => void;
  onLoadMore: () => void;
}) {
  // 文件夹多于一个才显示下拉框：只有收件箱（或列表加载失败）时保持原标题。
  const showFolderPicker = folders.length > 1;
  // Graph/IMAP 的文件夹列表本身就含收件箱，若不剔除会与内置的「收件箱」选项重复。
  const inboxFolder = useMemo(() => {
    if (inboxFolderId) {
      return folders.find((folder) => folder.id === inboxFolderId) ?? null;
    }
    return folders.find((folder) => folder.displayName.trim() === "收件箱") ?? null;
  }, [folders, inboxFolderId]);

  const scrollRef = useRef<HTMLDivElement>(null);
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
              }}
              placeholder="搜索主题，回车执行"
            />
          </div>
          <button className="toolbar-icon" onClick={onRefresh} disabled={!canRefresh || loadingMessages} title="强制刷新">
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
          <div className="panel-empty">
            <Loader2 size={22} className="spin" />
            <p>正在刷新邮件</p>
          </div>
        ) : null}

        {!loadingMessages && messages.length === 0 && listError ? (
          <div className="panel-empty panel-error">
            <AlertCircle size={24} />
            <p>邮件列表加载失败</p>
            <p className="panel-error-detail">{listError}</p>
            <button type="button" className="panel-error-retry" onClick={onRefresh} disabled={!canRefresh}>
              重试
            </button>
          </div>
        ) : null}

        {!loadingMessages && messages.length === 0 && !listError ? (
          <div className="panel-empty">
            <ClipboardList size={24} />
            <p>没有邮件可显示</p>
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
                  className={`message-row ${message.id === selectedMessageId ? "selected" : ""} ${message.isRead ? "" : "is-unread"}`}
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
        {mailCursor && !loadingMessages ? (
          <button className="load-more-button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
            加载更多
          </button>
        ) : null}
      </div>
    </section>
  );
});

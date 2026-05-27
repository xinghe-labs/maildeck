import { ClipboardList, Inbox, Loader2, Paperclip, Plus, RefreshCw, Search } from "lucide-react";
import type { MailMessageSummary } from "../types";
import { formatDateShort, senderLabel } from "../ui-utils";

export function MessageList({
  messages,
  selectedMessageId,
  loadingMessages,
  loadingMore,
  mailCursor,
  mailQuery,
  canRefresh,
  onMailQueryChange,
  onExecuteSearch,
  onRefresh,
  onSelectMessage,
  onLoadMore
}: {
  messages: MailMessageSummary[];
  selectedMessageId: string | null;
  loadingMessages: boolean;
  loadingMore: boolean;
  mailCursor: string | null;
  mailQuery: string;
  canRefresh: boolean;
  onMailQueryChange: (value: string) => void;
  onExecuteSearch: () => void;
  onRefresh: () => void;
  onSelectMessage: (messageId: string) => void;
  onLoadMore: () => void;
}) {
  return (
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
        {mailCursor && !loadingMessages ? (
          <button className="load-more-button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
            加载更多
          </button>
        ) : null}
      </div>
    </section>
  );
}

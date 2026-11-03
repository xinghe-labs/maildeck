import { memo, useEffect, useMemo, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import type { MailMessageDetail, MailMessageSummary } from "../types";
import { buildMailHtmlDocument, isMailHtmlBody, sanitizeMailHtml } from "../mail-content-security";
import { addressList, formatDate } from "../ui-utils";

export const MailReader = memo(function MailReader({
  selectedMessage,
  messageDetail,
  loadingDetail
}: {
  selectedMessage: MailMessageSummary | null;
  messageDetail: MailMessageDetail | null;
  loadingDetail: boolean;
}) {
  // 防白闪：切换邮件时保留上一次完整渲染的内容（变暗 + 顶部加载指示），
  // 仅在没有可展示的旧内容时才退回空态 spinner。
  const [lastRendered, setLastRendered] = useState<{
    summary: MailMessageSummary;
    detail: MailMessageDetail;
  } | null>(null);
  const hasCompleteRender = !loadingDetail && Boolean(selectedMessage && messageDetail);

  useEffect(() => {
    if (hasCompleteRender && selectedMessage && messageDetail) {
      setLastRendered({ summary: selectedMessage, detail: messageDetail });
    }
  }, [hasCompleteRender, selectedMessage, messageDetail]);

  const staleRender = loadingDetail && lastRendered ? lastRendered : null;
  const shownDetail = messageDetail ?? staleRender?.detail ?? null;
  const isHtml = shownDetail ? isMailHtmlBody(shownDetail.body.contentType) : false;
  const bodyContent = shownDetail?.body.content || "";
  const mailDocument = useMemo(
    () => isHtml ? buildMailHtmlDocument(sanitizeMailHtml(bodyContent)) : "",
    [bodyContent, isHtml]
  );

  return (
    <article className={`reader-panel ${staleRender ? "is-stale" : ""}`}>
      {!loadingDetail && !shownDetail ? (
        <div className="panel-empty">
          <Mail size={30} />
          <p>选择一封邮件查看正文</p>
        </div>
      ) : null}

      {loadingDetail && !shownDetail ? (
        <div className="panel-empty">
          <Loader2 size={24} className="spin" />
          <p>正在读取邮件</p>
        </div>
      ) : null}

      {shownDetail ? (
        <>
          <header className="reader-header">
            <h2>{shownDetail.subject}</h2>
            {staleRender ? (
              <span className="reader-loading-chip">
                <Loader2 size={14} className="spin" />正在读取新邮件
              </span>
            ) : null}
            <div className="reader-meta-head">
              <div className="sender-pill">
                <div>
                  <strong>{shownDetail.from?.name || shownDetail.from?.address || "-"}</strong>
                  <span>{shownDetail.from?.address || ""}</span>
                </div>
              </div>
              <time>{formatDate(shownDetail.receivedDateTime || shownDetail.sentDateTime)}</time>
            </div>
            <div className="reader-lines">
              <span>发送给 {addressList(shownDetail.toRecipients)}</span>
              <span>抄送 {addressList(shownDetail.ccRecipients)}</span>
            </div>
          </header>

          <div className="reader-body">
            <div className="mail-paper">
              {isHtml ? (
                <iframe
                  key={shownDetail.id}
                  className="mail-content-frame"
                  title="邮件正文"
                  sandbox="allow-popups"
                  referrerPolicy="no-referrer"
                  srcDoc={mailDocument}
                />
              ) : (
                <pre>{shownDetail.body.content}</pre>
              )}
            </div>
          </div>
        </>
      ) : null}
    </article>
  );
});

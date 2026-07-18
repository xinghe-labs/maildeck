import { Loader2, Mail } from "lucide-react";
import type { MailMessageDetail, MailMessageSummary } from "../types";
import { buildMailHtmlDocument, sanitizeMailHtml } from "../mail-content-security";
import { addressList, formatDate } from "../ui-utils";

export function MailReader({
  selectedMessage,
  messageDetail,
  loadingDetail
}: {
  selectedMessage: MailMessageSummary | null;
  messageDetail: MailMessageDetail | null;
  loadingDetail: boolean;
}) {
  const isHtml = messageDetail?.body.contentType.toLowerCase() === "html";
  const mailDocument = isHtml ? buildMailHtmlDocument(sanitizeMailHtml(messageDetail.body.content)) : "";

  return (
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
              {isHtml ? (
                <iframe
                  className="mail-content-frame"
                  title="邮件正文"
                  sandbox="allow-popups"
                  referrerPolicy="no-referrer"
                  srcDoc={mailDocument}
                />
              ) : (
                <pre>{messageDetail.body.content}</pre>
              )}
            </div>
          </div>
        </>
      ) : null}
    </article>
  );
}

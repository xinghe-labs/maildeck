import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Loader2, Mail, Paperclip } from "lucide-react";
import type { MailAttachmentListResult, MailMessageDetail, MailMessageSummary } from "../types";
import { buildMailHtmlDocument, isMailHtmlBody, sanitizeMailHtmlDetailed } from "../mail-content-security";
import { errorMessage } from "../app-error";
import { getDesktopApi } from "../desktop-api";
import { addressList, formatDate } from "../ui-utils";

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export const MailReader = memo(function MailReader({
  accountId,
  folderId,
  selectedMessage,
  messageDetail,
  loadingDetail,
  detailError,
  onRetryDetail
}: {
  accountId?: string | null;
  folderId?: string | null;
  selectedMessage: MailMessageSummary | null;
  messageDetail: MailMessageDetail | null;
  loadingDetail: boolean;
  /** 正文加载失败原因（列表错误走顶部横幅，正文区单独展示以便重试）。 */
  detailError?: string;
  onRetryDetail?: () => void;
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

  // 防白闪只限「同一封邮件的后台刷新」：换邮件/换账号时旧内容必须退场，
  // 否则失败/慢网时会把上一封（甚至别的账号）的邮件一直挂着（报告 v3 问题 1）。
  const staleRender =
    loadingDetail && lastRendered && selectedMessage && lastRendered.summary.id === selectedMessage.id
      ? lastRendered
      : null;
  const shownDetail = messageDetail ?? staleRender?.detail ?? null;
  // 附件与图片策略只认「已经加载完的那一封」：陈旧渲染期间不要拿上一封的附件冒充。
  const freshDetail =
    messageDetail && selectedMessage && messageDetail.id === selectedMessage.id ? messageDetail : null;
  const isHtml = shownDetail ? isMailHtmlBody(shownDetail.body.contentType) : false;
  const bodyContent = shownDetail?.body.content || "";

  const [showRemoteImages, setShowRemoteImages] = useState(false);
  const sanitized = useMemo(
    () => (isHtml ? sanitizeMailHtmlDetailed(bodyContent, { allowRemoteImages: showRemoteImages }) : null),
    [bodyContent, isHtml, showRemoteImages]
  );
  const mailDocument = useMemo(
    () => (sanitized ? buildMailHtmlDocument(sanitized.html, { allowRemoteImages: showRemoteImages }) : ""),
    [sanitized, showRemoteImages]
  );

  // 正文 iframe 的高度跟内容走：外层只保留一条滚动条，滚轮永远滚得动正文。
  // 量高度需要读 contentDocument，所以 iframe 带 allow-same-origin；脚本仍然被两道拦住
  // （sandbox 没给 allow-scripts，正文文档 CSP 是 default-src 'none'），顶部导航也被 sandbox 挡住。
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);

  const measureMailFrame = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) {
      return;
    }
    // 先把 iframe 压到 0 高再量：否则短文档的 scrollHeight 会被夹到 iframe 自身高度，
    // 而只看 body 高度又会漏掉溢出 body 的末尾外边距（实测差 30px，多出一条内部滚动条）。
    const previous = frame.style.height;
    frame.style.height = "0px";
    const next = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
    frame.style.height = previous;
    if (next > 0) {
      setFrameHeight((current) => (current === next ? current : next));
    }
  }, []);

  useEffect(() => {
    setFrameHeight(null);
  }, [shownDetail?.id, showRemoteImages]);

  useEffect(() => {
    if (!isHtml) {
      return undefined;
    }
    // 窗口/分栏宽度变了，正文重新排版，高度要重量；图片加载完也可能变高。
    const onResize = () => measureMailFrame();
    window.addEventListener("resize", onResize);
    const timer = window.setTimeout(measureMailFrame, 60);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(timer);
    };
  }, [isHtml, measureMailFrame, shownDetail?.id, showRemoteImages, mailDocument]);
  // 「在浏览器中打开」按钮已移除（OWA 需要重新登录，体验差且用户基本不用），
  // webLink / webMail 相关逻辑一并下线。

  const [attachments, setAttachments] = useState<MailAttachmentListResult | null>(null);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const freshMessageId = freshDetail?.id ?? null;
  const freshHasAttachments = Boolean(freshDetail?.hasAttachments);

  useEffect(() => {
    setShowRemoteImages(false);
    setSaveNotice(null);
    setSavingId(null);
  }, [freshMessageId]);

  useEffect(() => {
    if (!freshMessageId || !accountId || !freshHasAttachments) {
      setAttachments(null);
      setAttachmentError(null);
      setAttachmentsLoading(false);
      return;
    }

    let canceled = false;
    setAttachments(null);
    setAttachmentError(null);
    setAttachmentsLoading(true);
    void getDesktopApi()
      .mail.listAttachments({
        accountId,
        messageId: freshMessageId,
        ...(folderId ? { folderId } : {})
      })
      .then((result) => {
        if (!canceled) {
          setAttachments(result);
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setAttachmentError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!canceled) {
          setAttachmentsLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [accountId, folderId, freshHasAttachments, freshMessageId]);

  async function saveAttachment(attachmentId: string) {
    if (!accountId || !freshMessageId) {
      return;
    }
    setSavingId(attachmentId);
    setSaveNotice(null);
    try {
      const result = await getDesktopApi().mail.saveAttachment({
        accountId,
        messageId: freshMessageId,
        attachmentId,
        ...(folderId ? { folderId } : {})
      });
      if (result.saved) {
        setSaveNotice({ kind: "ok", text: `已保存到 ${result.path || "所选位置"}` });
      }
    } catch (error) {
      setSaveNotice({ kind: "error", text: errorMessage(error) });
    } finally {
      setSavingId(null);
    }
  }

  return (
    <article className={`reader-panel ${staleRender ? "is-stale" : ""}`}>
      {!loadingDetail && !shownDetail ? (
        detailError && selectedMessage ? (
          <div className="panel-empty is-detail-error">
            <AlertTriangle size={26} />
            <p>{detailError}</p>
            <button type="button" className="secondary-button" onClick={onRetryDetail}>
              重试
            </button>
          </div>
        ) : (
          <div className="panel-empty">
            <Mail size={30} />
            <p>选择一封邮件查看正文</p>
          </div>
        )
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
            <div className="reader-title-row">
              <h2>{shownDetail.subject}</h2>
            </div>
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
              {/* 没有抄送时不占一行：之前会留一个孤零零的「抄送 -」，看着像信息缺失。 */}
              {shownDetail.ccRecipients.length > 0 ? (
                <span>抄送 {addressList(shownDetail.ccRecipients)}</span>
              ) : null}
            </div>
          </header>

          {!loadingDetail && detailError ? (
            <div className="reader-detail-error is-inline">
              <AlertTriangle size={14} />
              <span>正文刷新失败：{detailError}</span>
              <button type="button" className="link-button" onClick={onRetryDetail}>
                重试
              </button>
            </div>
          ) : null}

          <div className="reader-body">
            {sanitized && sanitized.blockedImages > 0 && !showRemoteImages ? (
              <div className="mail-image-notice">
                <span>为保护隐私，已阻止 {sanitized.blockedImages} 张外部图片。</span>
                <button type="button" className="link-button" onClick={() => setShowRemoteImages(true)}>
                  显示图片
                </button>
              </div>
            ) : null}

            {freshHasAttachments ? (
              <section className="reader-attachments" aria-label="附件">
                <header>
                  <Paperclip size={13} />
                  <span>
                    附件
                    {attachments?.supported && attachments.attachments.length > 0
                      ? ` · ${attachments.attachments.length} 个`
                      : ""}
                  </span>
                </header>

                {attachmentsLoading ? (
                  <p className="reader-attachment-hint">
                    <Loader2 size={13} className="spin" />正在读取附件…
                  </p>
                ) : null}

                {attachmentError ? (
                  <p className="reader-attachment-hint is-error">读取附件失败：{attachmentError}</p>
                ) : null}

                {attachments && !attachments.supported ? (
                  <p className="reader-attachment-hint">
                    这个账号的正文不走 Graph，应用内看不到附件；需要时可在网页版邮箱里查看。
                  </p>
                ) : null}

                {attachments?.supported && attachments.attachments.length === 0 && !attachmentsLoading ? (
                  <p className="reader-attachment-hint">邮件标记为有附件，但服务器没有返回附件列表。</p>
                ) : null}

                {attachments?.supported && attachments.attachments.length > 0 ? (
                  <ul className="reader-attachment-list">
                    {attachments.attachments.map((attachment) => (
                      <li key={attachment.id}>
                        <div className="reader-attachment-meta">
                          <strong title={attachment.name}>{attachment.name}</strong>
                          <span>
                            {[formatBytes(attachment.size), attachment.isInline ? "内嵌" : ""]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={savingId !== null}
                          onClick={() => void saveAttachment(attachment.id)}
                        >
                          {savingId === attachment.id ? (
                            <Loader2 size={13} className="spin" />
                          ) : (
                            <Download size={13} />
                          )}
                          保存
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {saveNotice ? (
                  <p className={`reader-attachment-hint ${saveNotice.kind === "error" ? "is-error" : ""}`}>
                    {saveNotice.text}
                  </p>
                ) : null}
              </section>
            ) : null}

            <div className="mail-paper">
              {isHtml ? (
                <iframe
                  key={shownDetail.id}
                  ref={frameRef}
                  className="mail-content-frame"
                  title="邮件正文"
                  sandbox="allow-popups allow-same-origin"
                  referrerPolicy="no-referrer"
                  style={frameHeight ? { height: `${frameHeight}px` } : undefined}
                  onLoad={measureMailFrame}
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

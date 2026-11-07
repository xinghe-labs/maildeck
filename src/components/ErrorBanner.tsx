import { AlertCircle, X } from "lucide-react";
import { splitErrorMessage } from "../error-display";
import type { AppErrorCode } from "../types";
import { ErrorDetailCopy } from "./ErrorDetailCopy";

/**
 * 全局错误横幅：主文案一行，原始报错（Trace ID、多 provider 尝试）收进「查看详情」，
 * 并且可以手动关闭。`role="alert"` 让读屏用户能立刻听到失败。
 *
 * `code` 是主进程归类的错误码。用户报障时把这一串英文报出来，比复述一段中文准确。
 */
export function ErrorBanner({
  message,
  code,
  onDismiss
}: {
  message: string;
  code?: AppErrorCode | null;
  onDismiss: () => void;
}) {
  const { title, detail } = splitErrorMessage(message);
  if (!title) {
    return null;
  }

  return (
    <div className="error-banner" role="alert">
      <AlertCircle size={16} />
      <div className="error-banner-body">
        <p className="error-banner-title">{title}</p>
        {code ? (
          <p className="error-banner-code" title="反馈问题时报这个错误码，比描述一大段中文更准">
            错误码：<code>{code}</code>
          </p>
        ) : null}
        {detail ? (
          <details className="error-banner-details">
            <summary>查看详情</summary>
            <pre>{detail}</pre>
            <ErrorDetailCopy detail={detail} />
          </details>
        ) : null}
      </div>
      <button
        type="button"
        className="error-banner-close"
        onClick={onDismiss}
        title="关闭提示"
        aria-label="关闭提示"
      >
        <X size={14} />
      </button>
    </div>
  );
}

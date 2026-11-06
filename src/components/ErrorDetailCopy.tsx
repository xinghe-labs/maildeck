import { ClipboardCopy } from "lucide-react";
import { useState } from "react";

/**
 * 老式复制兜底：navigator.clipboard 在没有用户手势/权限时会直接 reject，
 * 而 Electron 里 execCommand('copy') 对隐藏 textarea 仍然有效。
 */
function copyWithFallback(detail: string): Promise<void> {
  return navigator.clipboard.writeText(detail).catch(() => {
    const textarea = document.createElement("textarea");
    textarea.value = detail;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    const selection = document.getSelection();
    const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (previousRange && selection) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    if (!copied) {
      throw new Error("copy failed");
    }
  });
}

/**
 * 「复制诊断信息」按钮：用户求助时经常需要把完整原始报错贴给别人，
 * 从 `<pre>` 里手动拖选很容易漏行。
 */
export function ErrorDetailCopy({ detail }: { detail: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  return (
    <button
      type="button"
      className="error-detail-copy"
      onClick={() => {
        copyWithFallback(detail)
          .then(() => setState("copied"))
          .catch(() => setState("failed"))
          .finally(() => {
            window.setTimeout(() => setState("idle"), 2500);
          });
      }}
    >
      <ClipboardCopy size={12} />
      {state === "copied" ? "已复制" : state === "failed" ? "复制失败，请手动选择" : "复制诊断信息"}
    </button>
  );
}

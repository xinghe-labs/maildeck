import { AlertTriangle, Loader2 } from "lucide-react";
import { type FormEvent, type ReactNode } from "react";
import { ModalShell } from "./ModalShell";

/**
 * 危险操作的二次确认弹窗。
 * 默认焦点放在「取消」上（`data-autofocus`），避免用户习惯性回车直接执行不可撤销操作。
 */
export function ConfirmDialog({
  title,
  subtitle,
  children,
  confirmLabel,
  cancelLabel = "取消",
  busy = false,
  onConfirm,
  onClose
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy) {
      onConfirm();
    }
  }

  return (
    <ModalShell
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      onSubmit={submit}
      className="confirm-dialog"
      autoFocusSelector="[data-autofocus]"
      footer={
        <>
          <button
            type="button"
            className="secondary-button dark-button"
            onClick={onClose}
            data-autofocus
          >
            {cancelLabel}
          </button>
          <button type="submit" className="danger-solid" disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : <AlertTriangle size={16} />}
            {confirmLabel}
          </button>
        </>
      }
    >
      {children ? <div className="confirm-body">{children}</div> : null}
    </ModalShell>
  );
}

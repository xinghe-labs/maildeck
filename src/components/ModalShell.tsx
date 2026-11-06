import { X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef
} from "react";

// 弹窗内可聚焦元素：焦点陷阱只在这批元素之间循环。
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

// 同时打开多层弹窗时，Esc 只应关闭最上面那一层。
const modalStack: symbol[] = [];

export interface ModalShellProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  footer: ReactNode;
  className?: string;
  /** 打开时优先聚焦的元素选择器，默认聚焦第一个可聚焦元素。 */
  autoFocusSelector?: string;
}

/**
 * 所有弹窗的外壳，统一负责：
 * - `role="dialog"` + `aria-modal` + `aria-labelledby`/`aria-describedby`
 * - 打开时移入焦点、Tab 焦点陷阱、Esc 关闭、点遮罩关闭
 * - 关闭后把焦点还给打开前的元素
 */
export function ModalShell({
  title,
  subtitle,
  onClose,
  onSubmit,
  children,
  footer,
  className = "",
  autoFocusSelector
}: ModalShellProps) {
  const titleId = useId();
  const subtitleId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
    const form = formRef.current;
    if (form) {
      const preferred = autoFocusSelector ? form.querySelector<HTMLElement>(autoFocusSelector) : null;
      const target = preferred ?? form.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? form;
      target.focus();
    }
    return () => {
      restoreFocusRef.current?.focus?.();
    };
  }, [autoFocusSelector]);

  // Esc 监听挂在 document 上：焦点可能停在弹窗内的非可聚焦区域（标题、说明文字），
  // 只挂在表单上时那种情况下按 Esc 不会关闭。
  useEffect(() => {
    const token = Symbol("modal");
    modalStack.push(token);
    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      if (modalStack[modalStack.length - 1] !== token) {
        return;
      }
      event.preventDefault();
      onCloseRef.current();
    }
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
      const index = modalStack.indexOf(token);
      if (index >= 0) {
        modalStack.splice(index, 1);
      }
    };
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Tab") {
      return;
    }

    const form = formRef.current;
    if (!form) {
      return;
    }
    const focusables = Array.from(form.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusables.length === 0) {
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const current = document.activeElement;
    const insideForm = current instanceof Node && form.contains(current);

    if (event.shiftKey && (current === first || !insideForm)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && (current === last || !insideForm)) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // 只在“按下点就是遮罩本身”时关闭，避免在弹窗内拖选文本后松手误关。
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <form
        ref={formRef}
        className={`modal dark-modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(subtitle ? { "aria-describedby": subtitleId } : {})}
        // 关掉浏览器原生校验：它的气泡会飘到别的字段上方、几秒后消失，
        // 而且指不出“为什么不能提交”。各弹窗自己用内联文案校验（P4/P5）。
        noValidate
        onSubmit={onSubmit}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p id={subtitleId}>{subtitle}</p> : null}
          </div>
          <button className="toolbar-icon" type="button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        {children}
        <div className="modal-actions">{footer}</div>
      </form>
    </div>
  );
}

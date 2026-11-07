import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * 三栏宽度可调。
 *
 * 之前侧栏/列表宽度完全由 CSS 变量写死（窗口变小时 224/288px），阅读区被挤到
 * 394px，长邮件基本没法看；账号邮箱在窄栏里也被截断成 `abianowe1989@ho…`。
 * 这里让用户自己拖分隔条，并把宽度记在本机。
 */

export type ColumnKind = "sidebar" | "list";

export interface ColumnWidths {
  sidebar: number;
  list: number;
}

const STORAGE_KEY = "outlookManager.columnWidths";
/** 默认值对应 1440 宽窗口下的观感。 */
const DEFAULT_WIDTHS: ColumnWidths = { sidebar: 300, list: 384 };
const LIMITS: Record<ColumnKind, { min: number; max: number }> = {
  sidebar: { min: 200, max: 460 },
  list: { min: 260, max: 720 }
};
/** 阅读区至少保留的宽度：再窄正文就完全没法读了。 */
const READER_MIN_WIDTH = 320;
/** 两个分隔条 + 栏间距的预留。 */
const CHROME_WIDTH = 40;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadWidths(): ColumnWidths {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_WIDTHS;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_WIDTHS;
    }
    const candidate = parsed as Partial<ColumnWidths>;
    return {
      sidebar:
        typeof candidate.sidebar === "number"
          ? clamp(candidate.sidebar, LIMITS.sidebar.min, LIMITS.sidebar.max)
          : DEFAULT_WIDTHS.sidebar,
      list:
        typeof candidate.list === "number"
          ? clamp(candidate.list, LIMITS.list.min, LIMITS.list.max)
          : DEFAULT_WIDTHS.list
    };
  } catch {
    return DEFAULT_WIDTHS;
  }
}

function saveWidths(widths: ColumnWidths): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // 存不下就只在本次会话生效。
  }
}

export function useColumnWidths() {
  const [widths, setWidths] = useState<ColumnWidths>(loadWidths);
  const [resizing, setResizing] = useState<ColumnKind | null>(null);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  useEffect(() => {
    saveWidths(widths);
  }, [widths]);

  const beginResize = useCallback((kind: ColumnKind, event: ReactPointerEvent<HTMLElement>) => {
    // 只响应左键/触控，避免右键菜单和文本选择干扰。
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = widthsRef.current[kind];
    const viewport = document.documentElement.clientWidth;
    handle.setPointerCapture?.(event.pointerId);
    setResizing(kind);

    const otherWidth = kind === "sidebar" ? widthsRef.current.list : widthsRef.current.sidebar;
    const maxByLayout = viewport - otherWidth - READER_MIN_WIDTH - CHROME_WIDTH;
    const max = Math.max(LIMITS[kind].min, Math.min(LIMITS[kind].max, maxByLayout));

    const onMove = (moveEvent: PointerEvent) => {
      const next = clamp(startWidth + (moveEvent.clientX - startX), LIMITS[kind].min, max);
      setWidths((previous) => (previous[kind] === Math.round(next) ? previous : { ...previous, [kind]: Math.round(next) }));
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      setResizing(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }, []);

  const resetWidths = useCallback(() => {
    setWidths(DEFAULT_WIDTHS);
  }, []);

  /** 键盘方向键微调（分隔条可聚焦，读屏/键盘用户也能调）。 */
  const nudgeColumn = useCallback((kind: ColumnKind, delta: number) => {
    setWidths((previous) => {
      const viewport = document.documentElement.clientWidth;
      const otherWidth = kind === "sidebar" ? previous.list : previous.sidebar;
      const maxByLayout = viewport - otherWidth - READER_MIN_WIDTH - CHROME_WIDTH;
      const max = Math.max(LIMITS[kind].min, Math.min(LIMITS[kind].max, maxByLayout));
      const next = clamp(previous[kind] + delta, LIMITS[kind].min, max);
      return previous[kind] === Math.round(next) ? previous : { ...previous, [kind]: Math.round(next) };
    });
  }, []);

  return useMemo(
    () => ({
      widths,
      resizing,
      beginResize,
      resetWidths,
      nudgeColumn
    }),
    [widths, resizing, beginResize, resetWidths, nudgeColumn]
  );
}

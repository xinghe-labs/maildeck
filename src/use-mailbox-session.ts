import { useMemo, useSyncExternalStore } from "react";
import {
  createMailboxSession,
  EMPTY_MAILBOX_SESSION_STATE,
  type MailboxSession,
  type MailboxSessionAdapter
} from "./mailbox-session";
import { createStrictModeSessionHolder } from "./strict-mode-session-holder";

/**
 * 连点邮件时只发最后一次正文请求：主进程对同一账号的请求是串行的，
 * 每点一下都发一次会让最后一封排在队尾（实测 20.9s 才出来）。
 * 120ms 对人手点击无感，但能把「连点 5 下」压成 1 个请求。
 */
const DETAIL_SELECTION_DELAY_MS = 120;

export function useMailboxSession(adapter: MailboxSessionAdapter | null) {
  const holder = useMemo(
    () =>
      adapter
        ? createStrictModeSessionHolder(createMailboxSession(adapter, { detailDelayMs: DETAIL_SELECTION_DELAY_MS }))
        : null,
    [adapter]
  );
  const session: MailboxSession | null = holder?.session ?? null;

  const state = useSyncExternalStore(
    holder?.subscribe ?? (() => () => undefined),
    session?.getSnapshot ?? (() => EMPTY_MAILBOX_SESSION_STATE),
    session?.getSnapshot ?? (() => EMPTY_MAILBOX_SESSION_STATE)
  );

  return useMemo(() => ({
    state,
    selectAccount: session?.selectAccount ?? (() => undefined),
    selectFolder: session?.selectFolder ?? (() => undefined),
    reconcileAccounts: session?.reconcileAccounts ?? (() => undefined),
    isCurrentAccount: session?.isCurrentAccount ?? (() => false),
    updateTotalCount: session?.updateTotalCount ?? (() => undefined),
    search: session?.search ?? (async () => undefined),
    reload: session?.reload ?? (async () => undefined),
    reloadIfCurrentAccount: session?.reloadIfCurrentAccount ?? (async () => false),
    loadMore: session?.loadMore ?? (async () => undefined),
    selectMessage: session?.selectMessage ?? (async () => undefined),
    clearError: session?.clearError ?? (() => undefined)
  }), [session, state]);
}

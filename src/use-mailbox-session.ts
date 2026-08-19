import { useMemo, useSyncExternalStore } from "react";
import {
  createMailboxSession,
  EMPTY_MAILBOX_SESSION_STATE,
  type MailboxSession,
  type MailboxSessionAdapter
} from "./mailbox-session";
import { createStrictModeSessionHolder } from "./strict-mode-session-holder";

export function useMailboxSession(adapter: MailboxSessionAdapter | null) {
  const holder = useMemo(
    () => (adapter ? createStrictModeSessionHolder(createMailboxSession(adapter)) : null),
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

import { useMemo, useSyncExternalStore } from "react";
import {
  createMailboxSession,
  EMPTY_MAILBOX_SESSION_STATE,
  type MailboxSession,
  type MailboxSessionAdapter
} from "./mailbox-session";

function createSessionHolder(adapter: MailboxSessionAdapter) {
  const session = createMailboxSession(adapter);
  let subscribers = 0;
  let disposeTimer: ReturnType<typeof setTimeout> | null = null;

  const subscribe = (listener: () => void) => {
    if (disposeTimer !== null) {
      clearTimeout(disposeTimer);
      disposeTimer = null;
    }
    subscribers += 1;
    const unsubscribe = session.subscribe(listener);
    let subscribed = true;

    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      unsubscribe();
      subscribers -= 1;
      if (subscribers === 0) {
        // StrictMode immediately resubscribes after its development-only cleanup replay.
        disposeTimer = setTimeout(() => {
          disposeTimer = null;
          if (subscribers === 0) {
            session.dispose();
          }
        }, 0);
      }
    };
  };

  return { session, subscribe };
}

export function useMailboxSession(adapter: MailboxSessionAdapter | null) {
  const holder = useMemo(() => (adapter ? createSessionHolder(adapter) : null), [adapter]);
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

import { useMemo, useSyncExternalStore } from "react";
import type { OutlookManagerApi } from "../electron/preload/index.cjs";
import {
  createRefreshJobSession,
  EMPTY_REFRESH_JOB_SESSION_STATE,
  type RefreshJobAdapter,
  type RefreshJobSession
} from "./refresh-job-session";
import { createStrictModeSessionHolder } from "./strict-mode-session-holder";

const NO_SUBSCRIBE = () => () => undefined;
const EMPTY_SNAPSHOT = () => EMPTY_REFRESH_JOB_SESSION_STATE;

function createDesktopRefreshJobAdapter(api: OutlookManagerApi): RefreshJobAdapter {
  return {
    testMany: (accountIds) => api.accounts.testMany(accountIds),
    refreshMany: (accountIds, kind) => api.accounts.refreshMany(accountIds, kind),
    cancel: (kind) => api.jobs.cancel(kind),
    onTestProgress: (listener) => api.accounts.onTestProgress(listener),
    onRefreshProgress: (listener) => api.accounts.onRefreshProgress(listener)
  };
}

export function useRefreshJobSession(api: OutlookManagerApi | null) {
  const holder = useMemo(() => {
    if (!api) {
      return null;
    }
    const adapter = createDesktopRefreshJobAdapter(api);
    return createStrictModeSessionHolder(createRefreshJobSession(adapter));
  }, [api]);
  const session: RefreshJobSession | null = holder?.session ?? null;

  const state = useSyncExternalStore(
    holder?.subscribe ?? NO_SUBSCRIBE,
    session?.getSnapshot ?? EMPTY_SNAPSHOT,
    session?.getSnapshot ?? EMPTY_SNAPSHOT
  );

  return useMemo(
    () => ({
      state,
      runTest: session?.runTest ?? (() => null),
      runRefresh: session?.runRefresh ?? (() => null),
      cancel: session?.cancel ?? (async () => null)
    }),
    [session, state]
  );
}

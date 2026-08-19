import { useMemo, useSyncExternalStore } from "react";
import type { OutlookManagerApi } from "../electron/preload/index.cjs";
import {
  createAccountCatalogSession,
  EMPTY_ACCOUNT_CATALOG_SESSION_STATE,
  type AccountCatalogAdapter,
  type AccountCatalogSession
} from "./account-catalog-session";
import { createStrictModeSessionHolder } from "./strict-mode-session-holder";

const NO_SUBSCRIBE = () => () => undefined;
const EMPTY_SNAPSHOT = () => EMPTY_ACCOUNT_CATALOG_SESSION_STATE;

function createDesktopAccountCatalogAdapter(api: OutlookManagerApi): AccountCatalogAdapter {
  return {
    list: () => api.accounts.list(),
    previewImportText: (text) => api.accounts.previewImportText(text),
    importText: (text) => api.accounts.importText(text),
    importFile: () => api.accounts.importFile(),
    upsert: (input) => api.accounts.upsert(input),
    update: (input) => api.accounts.update(input),
    delete: (accountId) => api.accounts.delete(accountId),
    test: (accountId) => api.accounts.test(accountId),
    testFallback: (accountId) => api.accounts.testFallback(accountId)
  };
}

export function useAccountCatalogSession(api: OutlookManagerApi | null) {
  const holder = useMemo(() => {
    if (!api) {
      return null;
    }
    return createStrictModeSessionHolder(
      createAccountCatalogSession(createDesktopAccountCatalogAdapter(api))
    );
  }, [api]);
  const session: AccountCatalogSession | null = holder?.session ?? null;
  const state = useSyncExternalStore(
    holder?.subscribe ?? NO_SUBSCRIBE,
    session?.getSnapshot ?? EMPTY_SNAPSHOT,
    session?.getSnapshot ?? EMPTY_SNAPSHOT
  );

  return useMemo(() => ({
    state,
    load: session?.load ?? (async () => null),
    reload: session?.reload ?? (async () => null),
    previewImportText: session?.previewImportText ?? (async () => null),
    importText: session?.importText ?? (async () => null),
    importFile: session?.importFile ?? (async () => null),
    upsert: session?.upsert ?? (async () => null),
    update: session?.update ?? (async () => null),
    deleteAccount: session?.deleteAccount ?? (async () => null),
    testConnection: session?.testConnection ?? (() => null),
    testFallback: session?.testFallback ?? (() => null),
    mergeTestResults: session?.mergeTestResults ?? (() => undefined)
  }), [session, state]);
}

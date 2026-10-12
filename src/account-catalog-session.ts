import type {
  AccountInput,
  AccountUpdateInput,
  AccountView,
  ImportPreviewResult,
  ImportResult,
  TestConnectionResult,
  TestFallbackResult,
  TestManyResult
} from "./types";

export interface AccountCatalogAdapter {
  readonly list: () => Promise<AccountView[]>;
  readonly previewImportText: (text: string) => Promise<ImportPreviewResult>;
  readonly importText: (text: string) => Promise<ImportResult>;
  readonly importFile: () => Promise<ImportResult | null>;
  readonly upsert: (input: AccountInput) => Promise<ImportResult>;
  readonly update: (input: AccountUpdateInput) => Promise<AccountView>;
  readonly delete: (accountId: string) => Promise<AccountView[]>;
  readonly test: (accountId: string) => Promise<TestConnectionResult>;
  readonly testFallback: (accountId: string) => Promise<TestFallbackResult>;
}

export interface AccountCatalogSessionState {
  readonly accounts: readonly AccountView[];
  readonly loadingAccounts: boolean;
  readonly testingAccountIds: readonly string[];
  readonly fallbackTestingAccountIds: readonly string[];
}

export interface AccountCatalogSession {
  readonly getSnapshot: () => AccountCatalogSessionState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<AccountView[] | null>;
  readonly reload: () => Promise<AccountView[] | null>;
  readonly previewImportText: (text: string) => Promise<ImportPreviewResult | null>;
  readonly importText: (text: string) => Promise<ImportResult | null>;
  readonly importFile: () => Promise<ImportResult | null>;
  readonly upsert: (input: AccountInput) => Promise<ImportResult | null>;
  readonly update: (input: AccountUpdateInput) => Promise<AccountView | null>;
  readonly deleteAccount: (accountId: string) => Promise<AccountView[] | null>;
  readonly testConnection: (accountId: string) => Promise<TestConnectionResult | null> | null;
  readonly testFallback: (accountId: string) => Promise<TestFallbackResult | null> | null;
  readonly mergeTestResults: (results: readonly TestManyResult[], accountVersions?: ReadonlyMap<string, number>) => void;
  readonly getAccountVersions: () => ReadonlyMap<string, number>;
  readonly dispose: () => void;
}

const EMPTY_STRINGS: readonly string[] = Object.freeze([]);
const EMPTY_ACCOUNTS: readonly AccountView[] = Object.freeze([]);

export const EMPTY_ACCOUNT_CATALOG_SESSION_STATE: AccountCatalogSessionState = Object.freeze({
  accounts: EMPTY_ACCOUNTS,
  loadingAccounts: false,
  testingAccountIds: EMPTY_STRINGS,
  fallbackTestingAccountIds: EMPTY_STRINGS
});

interface ActiveTest {
  readonly token: number;
  readonly mode: "primary" | "fallback";
  readonly projectionGeneration: number;
  readonly accountVersion: number;
}

class DefaultAccountCatalogSession implements AccountCatalogSession {
  private state: AccountCatalogSessionState = {
    ...EMPTY_ACCOUNT_CATALOG_SESSION_STATE,
    loadingAccounts: true
  };
  private readonly listeners = new Set<() => void>();
  private readonly accountVersions = new Map<string, number>();
  private readonly activeTests = new Map<string, ActiveTest>();
  private activeLoad: Promise<AccountView[] | null> | null = null;
  private activeLoadToken: number | null = null;
  private nextToken = 1;
  private projectionGeneration = 0;
  private latestFullMutationToken = 0;
  private latestPreviewToken = 0;
  private disposed = false;

  constructor(private readonly adapter: AccountCatalogAdapter) {}

  readonly getSnapshot = () => this.state;

  readonly subscribe = (listener: () => void) => {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly load = () => {
    if (this.disposed) {
      return Promise.resolve(null);
    }
    if (this.activeLoad) {
      return this.activeLoad;
    }

    const projectionGeneration = this.projectionGeneration;
    const accountVersions = new Map(this.accountVersions);
    const token = this.nextToken;
    this.nextToken += 1;
    this.activeLoadToken = token;
    this.publishPatch({ loadingAccounts: true });
    const execution = this.executeLoad(token, projectionGeneration, accountVersions);
    this.activeLoad = execution;
    return execution;
  };

  readonly reload = () => {
    if (this.disposed) {
      return Promise.resolve(null);
    }
    const pending = this.activeLoad;
    if (!pending) {
      return this.load();
    }
    const loadAfterPending = () => this.disposed ? null : this.load();
    return pending.then(loadAfterPending, loadAfterPending);
  };

  readonly previewImportText = async (text: string) => {
    if (this.disposed) {
      return null;
    }
    const token = this.nextToken;
    this.nextToken += 1;
    this.latestPreviewToken = token;
    try {
      const result = await this.adapter.previewImportText(text);
      return this.disposed || this.latestPreviewToken !== token ? null : result;
    } catch (error) {
      if (this.disposed || this.latestPreviewToken !== token) {
        return null;
      }
      throw error;
    }
  };

  readonly importText = (text: string) =>
    this.runFullMutation(() => this.adapter.importText(text), (result) => result.accounts);

  readonly importFile = () =>
    this.runFullMutation(() => this.adapter.importFile(), (result) => result?.accounts ?? null);

  readonly upsert = (input: AccountInput) =>
    this.runFullMutation(() => this.adapter.upsert(input), (result) => result.accounts);

  readonly update = (input: AccountUpdateInput) => {
    if (this.disposed) {
      return Promise.resolve(null);
    }
    const accountVersion = this.incrementAccountVersion(input.id);
    const projectionGeneration = this.projectionGeneration;
    return this.runAccountProjection(
      input.id,
      accountVersion,
      projectionGeneration,
      () => this.adapter.update(input),
      (account) => this.replaceAccount(account)
    );
  };

  readonly deleteAccount = (accountId: string) =>
    this.runFullMutation(() => this.adapter.delete(accountId), (accounts) => accounts);

  readonly testConnection = (accountId: string) =>
    this.startTest(accountId, "primary", () => this.adapter.test(accountId));

  readonly testFallback = (accountId: string) =>
    this.startTest(accountId, "fallback", () => this.adapter.testFallback(accountId));

  readonly mergeTestResults = (results: readonly TestManyResult[], accountVersionsAtStart?: ReadonlyMap<string, number>) => {
    if (this.disposed) {
      return;
    }
    const updates = new Map<string, AccountView>();
    for (const result of results) {
      if (!result.account) {
        continue;
      }
      // 批测运行期间账号可能已被编辑/重导入：只应用批测开始后版本未前进的账号快照，
      // 避免迟到的批测结果把较新的编辑从 UI 上抹掉。
      if (accountVersionsAtStart) {
        const versionAtStart = accountVersionsAtStart.get(result.accountId) ?? 0;
        const currentVersion = this.accountVersions.get(result.accountId) ?? 0;
        if (currentVersion !== versionAtStart) {
          continue;
        }
      }
      this.incrementAccountVersion(result.account.id);
      updates.set(result.account.id, result.account);
    }
    if (updates.size === 0) {
      return;
    }
    const accounts = this.state.accounts.map((account) => updates.get(account.id) ?? account);
    this.publishPatch({ accounts });
  };

  readonly dispose = () => {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.projectionGeneration += 1;
    this.latestFullMutationToken += 1;
    this.latestPreviewToken += 1;
    this.activeLoad = null;
    this.activeLoadToken = null;
    this.activeTests.clear();
    this.listeners.clear();
  };

  private async executeLoad(
    token: number,
    projectionGeneration: number,
    accountVersionsAtStart: ReadonlyMap<string, number>
  ) {
    try {
      await Promise.resolve();
      const incoming = await this.adapter.list();
      if (
        this.disposed ||
        this.activeLoadToken !== token ||
        this.projectionGeneration !== projectionGeneration
      ) {
        return null;
      }

      const currentById = new Map(this.state.accounts.map((account) => [account.id, account]));
      const accounts = incoming.map((account) => {
        const versionAtStart = accountVersionsAtStart.get(account.id) ?? 0;
        const currentVersion = this.accountVersions.get(account.id) ?? 0;
        return currentVersion === versionAtStart ? account : currentById.get(account.id) ?? account;
      });
      this.publishPatch({ accounts });
      return accounts;
    } catch (error) {
      if (this.disposed || this.activeLoadToken !== token || this.projectionGeneration !== projectionGeneration) {
        return null;
      }
      throw error;
    } finally {
      if (this.activeLoadToken === token) {
        this.activeLoadToken = null;
        this.activeLoad = null;
        if (!this.disposed) {
          this.publishPatch({ loadingAccounts: false });
        }
      }
    }
  }

  private async runFullMutation<Result>(
    invoke: () => Promise<Result>,
    accountsFromResult: (result: Result) => readonly AccountView[] | null
  ): Promise<Result | null> {
    if (this.disposed) {
      return null;
    }
    const token = this.nextToken;
    this.nextToken += 1;
    this.latestFullMutationToken = token;
    try {
      const result = await invoke();
      if (this.disposed || this.latestFullMutationToken !== token) {
        return null;
      }
      const accounts = accountsFromResult(result);
      if (accounts) {
        this.applyFullProjection(accounts);
      }
      return result;
    } catch (error) {
      if (this.disposed || this.latestFullMutationToken !== token) {
        return null;
      }
      throw error;
    }
  }

  private startTest<Result extends TestConnectionResult | TestFallbackResult>(
    accountId: string,
    mode: ActiveTest["mode"],
    invoke: () => Promise<Result>
  ): Promise<Result | null> | null {
    if (this.disposed || this.activeTests.has(accountId)) {
      return null;
    }
    const token = this.nextToken;
    this.nextToken += 1;
    const activeTest: ActiveTest = {
      token,
      mode,
      projectionGeneration: this.projectionGeneration,
      accountVersion: this.incrementAccountVersion(accountId)
    };
    this.activeTests.set(accountId, activeTest);
    this.publishBusyTests();
    return this.executeTest(accountId, activeTest, invoke);
  }

  private async executeTest<Result extends TestConnectionResult | TestFallbackResult>(
    accountId: string,
    activeTest: ActiveTest,
    invoke: () => Promise<Result>
  ) {
    try {
      const result = await invoke();
      if (!this.isCurrentTest(accountId, activeTest)) {
        return null;
      }
      if (result.account) {
        this.replaceAccount(result.account);
      }
      return result;
    } catch (error) {
      if (!this.isCurrentTest(accountId, activeTest)) {
        return null;
      }
      throw error;
    } finally {
      if (this.activeTests.get(accountId)?.token === activeTest.token) {
        this.activeTests.delete(accountId);
        this.publishBusyTests();
      }
    }
  }

  private async runAccountProjection<Result>(
    accountId: string,
    accountVersion: number,
    projectionGeneration: number,
    invoke: () => Promise<Result>,
    apply: (result: Result) => void
  ): Promise<Result | null> {
    try {
      const result = await invoke();
      if (!this.isCurrentAccountProjection(accountId, accountVersion, projectionGeneration)) {
        return null;
      }
      apply(result);
      return result;
    } catch (error) {
      if (!this.isCurrentAccountProjection(accountId, accountVersion, projectionGeneration)) {
        return null;
      }
      throw error;
    }
  }

  private isCurrentTest(accountId: string, activeTest: ActiveTest) {
    return !this.disposed &&
      this.activeTests.get(accountId)?.token === activeTest.token &&
      this.isCurrentAccountProjection(
        accountId,
        activeTest.accountVersion,
        activeTest.projectionGeneration
      );
  }

  private isCurrentAccountProjection(
    accountId: string,
    accountVersion: number,
    projectionGeneration: number
  ) {
    return !this.disposed &&
      this.projectionGeneration === projectionGeneration &&
      this.accountVersions.get(accountId) === accountVersion;
  }

  private applyFullProjection(accounts: readonly AccountView[]) {
    this.projectionGeneration += 1;
    this.accountVersions.clear();
    this.publishPatch({ accounts: [...accounts] });
  }

  readonly getAccountVersions = () => new Map(this.accountVersions);

  private replaceAccount(next: AccountView) {
    const accounts = this.state.accounts.map((account) => account.id === next.id ? next : account);
    this.publishPatch({ accounts });
  }

  private incrementAccountVersion(accountId: string) {
    const version = (this.accountVersions.get(accountId) ?? 0) + 1;
    this.accountVersions.set(accountId, version);
    return version;
  }

  private publishBusyTests() {
    const testingAccountIds: string[] = [];
    const fallbackTestingAccountIds: string[] = [];
    for (const [accountId, operation] of this.activeTests) {
      if (operation.mode === "primary") {
        testingAccountIds.push(accountId);
      } else {
        fallbackTestingAccountIds.push(accountId);
      }
    }
    this.publishPatch({ testingAccountIds, fallbackTestingAccountIds });
  }

  private publishPatch(patch: Partial<AccountCatalogSessionState>) {
    if (this.disposed) {
      return;
    }
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function createAccountCatalogSession(adapter: AccountCatalogAdapter): AccountCatalogSession {
  return new DefaultAccountCatalogSession(adapter);
}

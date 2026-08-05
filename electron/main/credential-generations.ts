export interface CredentialSnapshot {
  readonly accountId: string;
  readonly accountGeneration: number;
  readonly proxyGeneration: number;
}

export type CredentialInvalidation =
  | { readonly scope: "accounts"; readonly accountIds: readonly string[] }
  | { readonly scope: "proxy" };

export class CredentialsChangedError extends Error {
  override readonly name = "CredentialsChangedError";

  constructor() {
    super("账号凭据或代理已更新，请重试");
  }
}

export function isCredentialsChangedError(error: unknown): error is CredentialsChangedError {
  return error instanceof CredentialsChangedError;
}

export class CredentialGenerations {
  private readonly accountGenerations = new Map<string, number>();
  private readonly listeners = new Set<(event: CredentialInvalidation) => void>();
  private proxyGeneration = 0;

  onInvalidated(listener: (event: CredentialInvalidation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  capture(accountId: string): CredentialSnapshot {
    return {
      accountId,
      accountGeneration: this.accountGenerations.get(accountId) ?? 0,
      proxyGeneration: this.proxyGeneration
    };
  }

  isCurrent(snapshot: CredentialSnapshot): boolean {
    return (
      (this.accountGenerations.get(snapshot.accountId) ?? 0) === snapshot.accountGeneration &&
      this.proxyGeneration === snapshot.proxyGeneration
    );
  }

  assertCurrent(snapshot: CredentialSnapshot): void {
    if (!this.isCurrent(snapshot)) {
      throw new CredentialsChangedError();
    }
  }

  invalidateAccounts(accountIds: Iterable<string>): void {
    const uniqueAccountIds = [...new Set(accountIds)];
    for (const accountId of uniqueAccountIds) {
      this.accountGenerations.set(accountId, (this.accountGenerations.get(accountId) ?? 0) + 1);
    }
    if (uniqueAccountIds.length > 0) {
      this.emit({ scope: "accounts", accountIds: uniqueAccountIds });
    }
  }

  invalidateProxy(): void {
    this.proxyGeneration += 1;
    this.emit({ scope: "proxy" });
  }

  private emit(event: CredentialInvalidation): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export const credentialGenerations = new CredentialGenerations();

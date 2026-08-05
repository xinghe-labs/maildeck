import type { AccessTokenResult } from "./types.js";
import {
  type CredentialGenerations,
  type CredentialSnapshot,
  isCredentialsChangedError
} from "./credential-generations.js";

export interface AccountCredentials {
  accountId: string;
  email: string;
  clientId: string;
  refreshToken: string;
  credentialGeneration: number;
}

export interface ManagedAccessToken extends AccessTokenResult {
  email: string;
  expiresAt: number;
}

interface AccessTokenManagerDependencies {
  generations: CredentialGenerations;
  loadCredentials(accountId: string): Promise<AccountCredentials>;
  loadProxyUrl(): Promise<string>;
  requestAccessToken(clientId: string, refreshToken: string, proxyUrl: string): Promise<AccessTokenResult>;
  assertCredentialGeneration(accountId: string, expectedGeneration: number): Promise<void>;
  commitRefreshToken(
    accountId: string,
    expectedGeneration: number,
    refreshToken: string,
    assertCurrent: () => void
  ): Promise<void>;
  now?: () => number;
}

interface CachedToken {
  readonly snapshot: CredentialSnapshot;
  readonly value: ManagedAccessToken;
}

interface PendingToken {
  readonly snapshot: CredentialSnapshot;
  readonly promise: Promise<ManagedAccessToken>;
}

const MAX_STALE_RETRIES = 2;

export class AccessTokenManager {
  private readonly cache = new Map<string, CachedToken>();
  private readonly pending = new Map<string, PendingToken>();
  private readonly now: () => number;

  constructor(private readonly dependencies: AccessTokenManagerDependencies) {
    this.now = dependencies.now ?? Date.now;
    dependencies.generations.onInvalidated((event) => {
      if (event.scope === "proxy") {
        this.cache.clear();
        this.pending.clear();
        return;
      }
      for (const accountId of event.accountIds) {
        this.cache.delete(accountId);
        this.pending.delete(accountId);
      }
    });
  }

  async getAccessToken(accountId: string, forceRefresh = false): Promise<ManagedAccessToken> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.getForCurrentGeneration(accountId, forceRefresh);
      } catch (error) {
        if (!isCredentialsChangedError(error) || attempt >= MAX_STALE_RETRIES) {
          throw error;
        }
      }
    }
  }

  private getForCurrentGeneration(accountId: string, forceRefresh: boolean): Promise<ManagedAccessToken> {
    const snapshot = this.dependencies.generations.capture(accountId);
    const cached = this.cache.get(accountId);
    if (
      !forceRefresh &&
      cached &&
      this.dependencies.generations.isCurrent(cached.snapshot) &&
      cached.value.expiresAt > this.now() + 30_000
    ) {
      return Promise.resolve(cached.value);
    }
    if (cached) {
      this.cache.delete(accountId);
    }

    const pending = this.pending.get(accountId);
    if (pending && this.dependencies.generations.isCurrent(pending.snapshot)) {
      return pending.promise;
    }

    let entry!: PendingToken;
    const promise = this.refresh(accountId, snapshot).finally(() => {
      if (this.pending.get(accountId) === entry) {
        this.pending.delete(accountId);
      }
    });
    entry = { snapshot, promise };
    this.pending.set(accountId, entry);
    return promise;
  }

  private async refresh(accountId: string, snapshot: CredentialSnapshot): Promise<ManagedAccessToken> {
    const [credentials, proxyUrl] = await Promise.all([
      this.dependencies.loadCredentials(accountId),
      this.dependencies.loadProxyUrl()
    ]);
    this.dependencies.generations.assertCurrent(snapshot);

    let token: AccessTokenResult;
    try {
      token = await this.dependencies.requestAccessToken(
        credentials.clientId,
        credentials.refreshToken,
        proxyUrl
      );
    } catch (error) {
      this.dependencies.generations.assertCurrent(snapshot);
      throw error;
    }
    this.dependencies.generations.assertCurrent(snapshot);
    await this.dependencies.assertCredentialGeneration(accountId, credentials.credentialGeneration);

    if (token.refreshToken) {
      await this.dependencies.commitRefreshToken(
        accountId,
        credentials.credentialGeneration,
        token.refreshToken,
        () => this.dependencies.generations.assertCurrent(snapshot)
      );
    }
    this.dependencies.generations.assertCurrent(snapshot);

    const value: ManagedAccessToken = {
      ...token,
      email: credentials.email,
      expiresAt: this.now() + Math.max((token.expiresIn || 300) - 60, 60) * 1_000
    };
    this.cache.set(accountId, { snapshot, value });
    return value;
  }
}

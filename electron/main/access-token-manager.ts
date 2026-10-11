import type { AccessTokenResult } from "./types.js";
import { abortReasonOf } from "./error-utils.js";
import {
  type CredentialGenerations,
  type CredentialSnapshot,
  CredentialsChangedError,
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
  requestAccessToken(
    clientId: string,
    refreshToken: string,
    proxyUrl: string,
    signal: AbortSignal
  ): Promise<AccessTokenResult>;
  assertCredentialGeneration(accountId: string, expectedGeneration: number): Promise<void>;
  commitRefreshToken(
    accountId: string,
    expectedGeneration: number,
    refreshToken: string,
    assertCurrent: () => void
  ): Promise<void>;
  now?: () => number;
}

export interface AccessTokenRequestContext {
  readonly snapshot: CredentialSnapshot;
  readonly proxyUrl: string;
}

interface CachedToken {
  readonly snapshot: CredentialSnapshot;
  readonly value: ManagedAccessToken;
}

interface PendingToken {
  readonly snapshot: CredentialSnapshot;
  readonly controller: AbortController;
  readonly promise: Promise<ManagedAccessToken>;
  waiters: number;
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
        for (const entry of this.pending.values()) {
          entry.controller.abort(new CredentialsChangedError());
        }
        this.pending.clear();
        return;
      }
      for (const accountId of event.accountIds) {
        this.cache.delete(accountId);
        this.pending.get(accountId)?.controller.abort(new CredentialsChangedError());
        this.pending.delete(accountId);
      }
    });
  }

  async getAccessToken(
    accountId: string,
    forceRefresh = false,
    signal?: AbortSignal,
    context?: AccessTokenRequestContext
  ): Promise<ManagedAccessToken> {
    if (context) {
      if (context.snapshot.accountId !== accountId) {
        throw new CredentialsChangedError();
      }
      signal?.throwIfAborted();
      this.dependencies.generations.assertCurrent(context.snapshot);
      return this.getForCurrentGeneration(accountId, forceRefresh, signal, context);
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        signal?.throwIfAborted();
        return await this.getForCurrentGeneration(accountId, forceRefresh, signal);
      } catch (error) {
        if (!isCredentialsChangedError(error) || attempt >= MAX_STALE_RETRIES) {
          throw error;
        }
      }
    }
  }

  private getForCurrentGeneration(
    accountId: string,
    forceRefresh: boolean,
    signal?: AbortSignal,
    context?: AccessTokenRequestContext
  ): Promise<ManagedAccessToken> {
    const snapshot = context?.snapshot ?? this.dependencies.generations.capture(accountId);
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
      return this.awaitPending(accountId, pending, signal);
    }

    const controller = new AbortController();
    // `entry` must be declared before the promise closure can observe it, so it
    // cannot be a `const` bound to its single assignment below.
    // eslint-disable-next-line prefer-const -- closure captures `entry` before construction
    let entry!: PendingToken;
    const promise = this.refresh(accountId, snapshot, controller.signal, context?.proxyUrl).finally(() => {
      if (this.pending.get(accountId) === entry) {
        this.pending.delete(accountId);
      }
    });
    entry = { snapshot, controller, promise, waiters: 0 };
    this.pending.set(accountId, entry);
    return this.awaitPending(accountId, entry, signal);
  }

  private awaitPending(
    accountId: string,
    entry: PendingToken,
    signal?: AbortSignal
  ): Promise<ManagedAccessToken> {
    entry.waiters += 1;
    return this.awaitWithSignal(entry.promise, signal).finally(() => {
      entry.waiters -= 1;
      if (signal?.aborted && entry.waiters === 0 && this.pending.get(accountId) === entry) {
        entry.controller.abort(signal.reason);
      }
    });
  }

  private awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
      return promise;
    }
    if (signal.aborted) {
      return Promise.reject(abortReasonOf(signal));
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortReasonOf(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private async refresh(
    accountId: string,
    snapshot: CredentialSnapshot,
    signal: AbortSignal,
    proxyUrlOverride?: string
  ): Promise<ManagedAccessToken> {
    const [credentials, proxyUrl] = await Promise.all([
      this.dependencies.loadCredentials(accountId),
      proxyUrlOverride === undefined ? this.dependencies.loadProxyUrl() : Promise.resolve(proxyUrlOverride)
    ]);
    signal.throwIfAborted();
    this.dependencies.generations.assertCurrent(snapshot);

    let token: AccessTokenResult;
    try {
      token = await this.dependencies.requestAccessToken(
        credentials.clientId,
        credentials.refreshToken,
        proxyUrl,
        signal
      );
    } catch (error) {
      this.dependencies.generations.assertCurrent(snapshot);
      signal.throwIfAborted();
      throw error;
    }
    signal.throwIfAborted();
    this.dependencies.generations.assertCurrent(snapshot);
    await this.dependencies.assertCredentialGeneration(accountId, credentials.credentialGeneration);
    signal.throwIfAborted();

    if (token.refreshToken) {
      await this.dependencies.commitRefreshToken(
        accountId,
        credentials.credentialGeneration,
        token.refreshToken,
        () => {
          signal.throwIfAborted();
          this.dependencies.generations.assertCurrent(snapshot);
        }
      );
    }
    signal.throwIfAborted();
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

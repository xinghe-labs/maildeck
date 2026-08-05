import { describe, expect, it } from "vitest";
import { AccessTokenManager, type AccountCredentials } from "../electron/main/access-token-manager.js";
import { CredentialGenerations, CredentialsChangedError } from "../electron/main/credential-generations.js";
import type { AccessTokenResult } from "../electron/main/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, rejectNext) => {
    resolve = next;
    reject = rejectNext;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}

function token(accessToken: string, refreshToken: string | null = null): AccessTokenResult {
  return {
    accessToken,
    refreshToken,
    expiresIn: 3_600,
    scope: "Mail.Read",
    authMode: "graph"
  };
}

interface Harness {
  readonly manager: AccessTokenManager;
  readonly generations: CredentialGenerations;
  credentials: AccountCredentials;
  proxyUrl: string;
  readonly requests: Array<{ clientId: string; refreshToken: string; proxyUrl: string }>;
  readonly committedRefreshTokens: string[];
  requestAccessToken: (clientId: string, refreshToken: string, proxyUrl: string) => Promise<AccessTokenResult>;
}

function createHarness(
  requestAccessToken: Harness["requestAccessToken"]
): Harness {
  const generations = new CredentialGenerations();
  const requests: Harness["requests"] = [];
  const committedRefreshTokens: string[] = [];
  const harness = {
    generations,
    credentials: {
      accountId: "account-1",
      email: "person@example.com",
      clientId: "client-1",
      refreshToken: "refresh-1",
      credentialGeneration: 1
    },
    proxyUrl: "http://proxy-one.example:8080",
    requests,
    committedRefreshTokens,
    requestAccessToken,
    manager: null as unknown as AccessTokenManager
  } satisfies Harness;

  harness.manager = new AccessTokenManager({
    generations,
    loadCredentials: async () => ({ ...harness.credentials }),
    loadProxyUrl: async () => harness.proxyUrl,
    requestAccessToken: async (clientId, refreshToken, proxyUrl) => {
      requests.push({ clientId, refreshToken, proxyUrl });
      return requestAccessToken(clientId, refreshToken, proxyUrl);
    },
    assertCredentialGeneration: async (_accountId, expectedGeneration) => {
      if (harness.credentials.credentialGeneration !== expectedGeneration) {
        throw new CredentialsChangedError();
      }
    },
    commitRefreshToken: async (_accountId, expectedGeneration, refreshToken, assertCurrent) => {
      if (harness.credentials.credentialGeneration !== expectedGeneration) {
        throw new CredentialsChangedError();
      }
      assertCurrent();
      committedRefreshTokens.push(refreshToken);
      harness.credentials.refreshToken = refreshToken;
    },
    now: () => 1_000
  });

  return harness;
}

describe("AccessTokenManager", () => {
  it("coalesces concurrent refreshes and keeps access tokens in memory", async () => {
    const requested = deferred<AccessTokenResult>();
    const harness = createHarness(async () => requested.promise);

    const first = harness.manager.getAccessToken("account-1");
    const second = harness.manager.getAccessToken("account-1");
    await waitFor(() => harness.requests.length === 1);
    expect(harness.requests).toHaveLength(1);

    requested.resolve(token("access-1"));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.accessToken).toBe("access-1");
    expect(secondResult).toBe(firstResult);
    await expect(harness.manager.getAccessToken("account-1")).resolves.toBe(firstResult);
    expect(harness.requests).toHaveLength(1);
  });

  it("rejects an old account generation and retries with the new credentials", async () => {
    const firstRequest = deferred<AccessTokenResult>();
    const harness = createHarness(async (_clientId, refreshToken) => {
      if (refreshToken === "refresh-1") {
        return firstRequest.promise;
      }
      return token("access-2", "rotated-2");
    });

    const pending = harness.manager.getAccessToken("account-1");
    await waitFor(() => harness.requests.length === 1);
    harness.credentials = {
      ...harness.credentials,
      clientId: "client-2",
      refreshToken: "refresh-2",
      credentialGeneration: 2
    };
    harness.generations.invalidateAccounts(["account-1"]);
    firstRequest.resolve(token("access-old", "rotated-old"));

    await expect(pending).resolves.toMatchObject({ accessToken: "access-2" });
    expect(harness.requests.map((request) => request.refreshToken)).toEqual(["refresh-1", "refresh-2"]);
    expect(harness.committedRefreshTokens).toEqual(["rotated-2"]);
  });

  it("rejects a token fetched through an obsolete proxy and retries", async () => {
    const firstRequest = deferred<AccessTokenResult>();
    const harness = createHarness(async (_clientId, _refreshToken, proxyUrl) => {
      if (proxyUrl.includes("proxy-one")) {
        return firstRequest.promise;
      }
      return token("access-through-new-proxy");
    });

    const pending = harness.manager.getAccessToken("account-1");
    await waitFor(() => harness.requests.length === 1);
    harness.proxyUrl = "https://proxy-two.example:8443";
    harness.generations.invalidateProxy();
    firstRequest.resolve(token("access-through-old-proxy"));

    await expect(pending).resolves.toMatchObject({ accessToken: "access-through-new-proxy" });
    expect(harness.requests.map((request) => request.proxyUrl)).toEqual([
      "http://proxy-one.example:8080",
      "https://proxy-two.example:8443"
    ]);
  });

  it("retries with current credentials when an obsolete request rejects", async () => {
    const firstRequest = deferred<AccessTokenResult>();
    const harness = createHarness(async (_clientId, refreshToken) => {
      if (refreshToken === "refresh-1") {
        return firstRequest.promise;
      }
      return token("access-after-error");
    });

    const pending = harness.manager.getAccessToken("account-1");
    await waitFor(() => harness.requests.length === 1);
    harness.credentials = {
      ...harness.credentials,
      refreshToken: "refresh-2",
      credentialGeneration: 2
    };
    harness.generations.invalidateAccounts(["account-1"]);
    firstRequest.reject(new Error("old proxy disconnected"));

    await expect(pending).resolves.toMatchObject({ accessToken: "access-after-error" });
    expect(harness.requests.map((request) => request.refreshToken)).toEqual(["refresh-1", "refresh-2"]);
  });

  it("physically evicts sensitive cached tokens when a generation changes", async () => {
    const harness = createHarness(async () => token("access-sensitive"));
    await harness.manager.getAccessToken("account-1");
    const internals = harness.manager as unknown as { cache: Map<string, unknown> };
    expect(internals.cache.size).toBe(1);

    harness.generations.invalidateAccounts(["account-1"]);

    expect(internals.cache.size).toBe(0);
  });

  it("bounds retries when credentials keep changing", async () => {
    let harness!: Harness;
    harness = createHarness(async () => {
      harness.generations.invalidateAccounts(["account-1"]);
      return token("never-current");
    });

    await expect(harness.manager.getAccessToken("account-1")).rejects.toThrow("凭据或代理已更新");
    expect(harness.requests).toHaveLength(3);
  });
});

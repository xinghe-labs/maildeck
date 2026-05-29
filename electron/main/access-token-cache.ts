import { getDatabase, transaction } from "./database.js";
import { decryptSecret, encryptSecret } from "./token-crypto.js";
import type { AccessTokenResult } from "./types.js";

interface AccessTokenCacheRow {
  encrypted_access_token: string;
  expires_at: number;
  scope: string;
  auth_mode: AccessTokenResult["authMode"];
}

export interface CachedAccessToken extends AccessTokenResult {
  expiresAt: number;
}

function nowIso() {
  return new Date().toISOString();
}

export function getPersistedAccessToken(accountId: string): CachedAccessToken | null {
  const row = getDatabase()
    .prepare(
      `
        SELECT encrypted_access_token, expires_at, scope, auth_mode
        FROM access_token_cache
        WHERE account_id = ?
      `
    )
    .get(accountId) as AccessTokenCacheRow | undefined;

  if (!row || row.expires_at <= Date.now() + 30_000) {
    return null;
  }

  try {
    return {
      accessToken: decryptSecret(row.encrypted_access_token),
      refreshToken: null,
      expiresIn: Math.max(0, Math.floor((row.expires_at - Date.now()) / 1000)),
      expiresAt: row.expires_at,
      scope: row.scope || "",
      authMode: row.auth_mode === "imap" ? "imap" : "graph"
    };
  } catch {
    clearPersistedAccessTokens([accountId]);
    return null;
  }
}

export function savePersistedAccessToken(accountId: string, token: AccessTokenResult, expiresAt: number) {
  transaction(() => {
    getDatabase()
      .prepare(
        `
          INSERT INTO access_token_cache (
            account_id, encrypted_access_token, expires_at, scope, auth_mode, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            encrypted_access_token = excluded.encrypted_access_token,
            expires_at = excluded.expires_at,
            scope = excluded.scope,
            auth_mode = excluded.auth_mode,
            updated_at = excluded.updated_at
        `
      )
      .run(accountId, encryptSecret(token.accessToken), expiresAt, token.scope || "", token.authMode, nowIso());
  });
}

export function clearPersistedAccessTokens(accountIds?: string[]) {
  transaction(() => {
    const db = getDatabase();

    if (!accountIds || accountIds.length === 0) {
      db.prepare("DELETE FROM access_token_cache").run();
      return;
    }

    const deleteToken = db.prepare("DELETE FROM access_token_cache WHERE account_id = ?");
    for (const accountId of accountIds) {
      deleteToken.run(accountId);
    }
  });
}

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ACCOUNT_VIEW_COLUMNS } from "../electron/main/account-view-projection.js";
import { applyDatabaseMigrations } from "../electron/main/database-migrations.js";

describe("account view database projection", () => {
  it("does not load persisted credentials for renderer account lists", () => {
    expect(ACCOUNT_VIEW_COLUMNS).not.toContain("encrypted_refresh_token");
    expect(ACCOUNT_VIEW_COLUMNS).not.toContain("credential_generation");
    expect(ACCOUNT_VIEW_COLUMNS).toContain("client_id");
    expect(ACCOUNT_VIEW_COLUMNS).toContain("last_inbox_count");
  });

  it("lets SQLite return the existing renderer contract without a JavaScript copy pass", () => {
    const database = new DatabaseSync(":memory:");
    applyDatabaseMigrations(database);
    database.prepare(`
      INSERT INTO accounts (
        id, email, client_id, encrypted_refresh_token, remark, group_name, status,
        credential_generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "account-1",
      "person@example.com",
      "client-id",
      "safe:secret",
      "Primary",
      "Team",
      "valid",
      1,
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z"
    );

    const row = database.prepare(`SELECT ${ACCOUNT_VIEW_COLUMNS} FROM accounts`).get();
    database.close();

    expect(row).toEqual({
      id: "account-1",
      email: "person@example.com",
      clientId: "client-id",
      remark: "Primary",
      group: "Team",
      status: "valid",
      lastCheckedAt: null,
      lastError: null,
      lastRefreshedAt: null,
      lastInboxCount: 0,
      lastMailAt: null,
      lastMailCursor: null,
      inboxFolderId: null,
      graphDeltaLink: null,
      refreshCooldownUntil: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z"
    });
  });
});

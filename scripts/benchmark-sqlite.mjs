import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { applyDatabaseMigrations } from "../dist-electron/main/database-migrations.js";
import { ACCOUNT_VIEW_COLUMNS } from "../dist-electron/main/account-view-projection.js";

const ACCOUNT_COUNT = 5_000;
const MESSAGES_PER_ACCOUNT = 100;
const WARMUP_RUNS = 5;
const MEASURED_RUNS = 30;
const accountId = "account-02500";

if (!process.versions.electron) {
  throw new Error(
    "Run this benchmark with Electron: set ELECTRON_RUN_AS_NODE=1, then invoke node_modules/.bin/electron.cmd scripts/benchmark-sqlite.mjs"
  );
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function seedDatabase(database) {
  applyDatabaseMigrations(database);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");

  const now = new Date().toISOString();
  const insertAccount = database.prepare(`
    INSERT INTO accounts (
      id, email, client_id, encrypted_refresh_token, remark, group_name, status,
      last_checked_at, last_error, last_refreshed_at, last_inbox_count, last_mail_at,
      last_mail_cursor, inbox_folder_id, graph_delta_link, refresh_cooldown_until,
      credential_generation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMeta = database.prepare(
    "INSERT INTO mail_cache_meta (account_id, next_cursor, updated_at) VALUES (?, ?, ?)"
  );
  const insertMessage = database.prepare(`
    INSERT INTO mail_messages (
      account_id, message_id, subject, from_name, from_address, received_date_time,
      sent_date_time, is_read, importance, has_attachments, body_preview, web_link, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  database.exec("BEGIN IMMEDIATE");
  try {
    for (let accountIndex = 0; accountIndex < ACCOUNT_COUNT; accountIndex += 1) {
      const currentAccountId = `account-${String(accountIndex).padStart(5, "0")}`;
      const email = `person${accountIndex}@example.com`;
      insertAccount.run(
        currentAccountId,
        email,
        "00000000-0000-4000-8000-000000000000",
        "enc:test",
        "",
        "",
        "valid",
        now,
        null,
        now,
        MESSAGES_PER_ACCOUNT,
        now,
        `uid-${accountIndex}`,
        "INBOX",
        null,
        null,
        1,
        now,
        now
      );
      insertMeta.run(currentAccountId, `cursor-${accountIndex}`, now);

      for (let messageIndex = 0; messageIndex < MESSAGES_PER_ACCOUNT; messageIndex += 1) {
        const receivedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, messageIndex)).toISOString();
        insertMessage.run(
          currentAccountId,
          `message-${String(messageIndex).padStart(3, "0")}`,
          `Subject ${messageIndex}`,
          "Sender",
          "sender@example.com",
          receivedAt,
          receivedAt,
          messageIndex % 2,
          "normal",
          messageIndex % 10 === 0 ? 1 : 0,
          "Preview text",
          null,
          now
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function measure(name, operation) {
  for (let index = 0; index < WARMUP_RUNS; index += 1) {
    operation();
    await new Promise((resolve) => setImmediate(resolve));
  }

  const samples = [];
  for (let index = 0; index < MEASURED_RUNS; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }

  return {
    name,
    p50Ms: Number(percentile(samples, 50).toFixed(2)),
    p95Ms: Number(percentile(samples, 95).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2))
  };
}

const directory = await mkdtemp(path.join(tmpdir(), "outlook-manager-sqlite-benchmark-"));
const databasePath = path.join(directory, "benchmark.db");
const database = new DatabaseSync(databasePath);

try {
  const startedAt = performance.now();
  seedDatabase(database);
  const seedMs = performance.now() - startedAt;
  const listAccountsSync = database.prepare(`SELECT ${ACCOUNT_VIEW_COLUMNS} FROM accounts ORDER BY email ASC`);
  const listMessages = database.prepare(`
    SELECT * FROM mail_messages
    WHERE account_id = ?
    ORDER BY COALESCE(received_date_time, sent_date_time, updated_at) DESC
    LIMIT ?
  `);
  const findAccount = database.prepare("SELECT * FROM accounts WHERE email = ?");
  const upsertMessage = database.prepare(`
    INSERT INTO mail_messages (
      account_id, message_id, subject, from_name, from_address, received_date_time,
      sent_date_time, is_read, importance, has_attachments, body_preview, web_link, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, message_id) DO UPDATE SET
      subject = excluded.subject,
      is_read = excluded.is_read,
      updated_at = excluded.updated_at
  `);
  const updateMeta = database.prepare(`
    INSERT INTO mail_cache_meta (account_id, next_cursor, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      next_cursor = excluded.next_cursor,
      updated_at = excluded.updated_at
  `);
  const benchmarkWrite = () => {
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let messageIndex = 0; messageIndex < MESSAGES_PER_ACCOUNT; messageIndex += 1) {
        const receivedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, messageIndex)).toISOString();
        upsertMessage.run(
          accountId,
          `message-${String(messageIndex).padStart(3, "0")}`,
          `Subject ${messageIndex}`,
          "Sender",
          "sender@example.com",
          receivedAt,
          receivedAt,
          messageIndex % 2,
          "normal",
          0,
          "Preview text",
          null,
          now
        );
      }
      updateMeta.run(accountId, "cursor-benchmark", now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const synchronousResults = [
    await measure("listAccounts", () => {
      const accounts = listAccountsSync.all();
      if (accounts.length !== ACCOUNT_COUNT || accounts[0]?.id !== "account-00000") {
        throw new Error(`Synchronous account query returned an invalid benchmark result: ${accounts.length}`);
      }
    }),
    await measure("listCachedMessages", () => listMessages.all(accountId, MESSAGES_PER_ACCOUNT)),
    await measure("findAccountByEmail", () => findAccount.get("person2500@example.com")),
    await measure("write100CachedMessages", benchmarkWrite)
  ];
  const results = synchronousResults;

  const report = {
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron || null,
      modules: process.versions.modules,
      sqlite: process.versions.sqlite || null
    },
    workload: { accounts: ACCOUNT_COUNT, messagesPerAccount: MESSAGES_PER_ACCOUNT },
    seedMs: Number(seedMs.toFixed(2)),
    results,
    thresholds: { operationP95Ms: 50, eventLoopBlockMs: 100 }
  };
  console.log(JSON.stringify(report, null, 2));

  const regressions = synchronousResults.filter((result) => result.p95Ms > 50 || result.maxMs > 100);
  if (regressions.length > 0) {
    console.error(`SQLite performance threshold exceeded: ${regressions.map((result) => result.name).join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  database.close();
  await rm(directory, { recursive: true, force: true });
}

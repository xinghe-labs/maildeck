import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  applyDatabaseMigrations,
  CURRENT_SCHEMA_VERSION,
  readSchemaVersion
} from "./database-migrations.js";

export { applyDatabaseMigrations } from "./database-migrations.js";

let database: DatabaseSync | null = null;

function hasExistingSchema(target: DatabaseSync) {
  return Boolean(
    target
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
      .get()
  );
}

function createMigrationBackup(target: DatabaseSync, userDataPath: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = path.join(
    userDataPath,
    `outlook-manager.pre-v${CURRENT_SCHEMA_VERSION}.${timestamp}.${randomUUID()}.db.bak`
  );
  target.prepare("VACUUM INTO ?").run(backupPath);
  return backupPath;
}

export function getDatabase() {
  if (database) {
    return database;
  }

  const userDataPath = app.getPath("userData");
  mkdirSync(userDataPath, { recursive: true });
  const databasePath = path.join(userDataPath, "outlook-manager.db");
  const candidate = new DatabaseSync(databasePath);
  let backupPath: string | null = null;

  try {
    candidate.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);

    const existingSchema = hasExistingSchema(candidate);
    let schemaVersion: number;
    try {
      schemaVersion = readSchemaVersion(candidate);
    } catch (error) {
      if (existingSchema) {
        backupPath = createMigrationBackup(candidate, userDataPath);
      }
      throw error;
    }
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${schemaVersion} is newer than the supported version ${CURRENT_SCHEMA_VERSION}`
      );
    }

    if (schemaVersion < CURRENT_SCHEMA_VERSION && existingSchema) {
      backupPath = createMigrationBackup(candidate, userDataPath);
    }

    applyDatabaseMigrations(candidate);
    candidate.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);
    database = candidate;
    return database;
  } catch (error) {
    candidate.close();
    if (backupPath) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Database migration failed; backup preserved at ${backupPath}. ${reason}`, { cause: error });
    }
    throw error;
  }
}

export function closeDatabase() {
  if (!database) {
    return;
  }

  database.close();
  database = null;
}

export function transaction<T>(operation: () => T): T {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  applyDatabaseMigrations,
  CURRENT_SCHEMA_VERSION,
  readSchemaVersion
} from "./database-migrations.js";
import { DATABASE_FILE_NAME, resolveDatabaseFilePath } from "./user-data-path.js";

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
    `${DATABASE_FILE_NAME}.pre-v${CURRENT_SCHEMA_VERSION}.${timestamp}.${randomUUID()}.db.bak`
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
  // 旧版本叫 outlook-manager.db：改名后首次启动会就地改成 maildeck.db，改不动就用旧文件。
  const databasePath = resolveDatabaseFilePath(userDataPath, { existsSync, renameSync });
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
    // WAL 下把 synchronous 从默认的 FULL 降到 NORMAL。
    // 实测（真实库副本，逐条提交，与刷新时写账号状态的路径一致）：
    // FULL 1308µs/次提交，NORMAL 75µs/次，461 个账号批量刷新省掉约 0.6s 的 fsync 等待。
    // 代价：操作系统崩溃/断电时可能丢掉最后几个已提交事务（库本身不会损坏，应用崩溃不丢）；
    // 对"缓存 + 刷新状态"这类可重建数据，这个取舍是合适的。
    candidate.exec("PRAGMA synchronous = NORMAL;");
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
    // SQLITE_FULL/IOERR/BUSY/NOMEM 时 SQLite 已自动回滚，再执行 ROLLBACK 会抛
    // "no transaction is active" 并覆盖真实错误；吞掉回滚异常，保留原始原因。
    try {
      db.exec("ROLLBACK");
    } catch {
      // 事务已不存在，无需处理。
    }
    throw error;
  }
}

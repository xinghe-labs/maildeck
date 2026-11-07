import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  DATABASE_FILE_NAME,
  LEGACY_DATABASE_FILE_NAME,
  LEGACY_USER_DATA_DIR_NAME,
  migrateLegacyUserDataDirectory,
  readUserDataOverride,
  resolveDatabaseFilePath,
  type FileSystemPort
} from "../electron/main/user-data-path.js";

const APP_DATA = path.join("C:", "Users", "someone", "AppData", "Roaming");
const DEFAULT_USER_DATA = path.join(APP_DATA, "maildeck");
const LEGACY_USER_DATA = path.join(APP_DATA, LEGACY_USER_DATA_DIR_NAME);

function createFakeFileSystem(initial: string[], options: { failRename?: boolean } = {}) {
  const files = new Set(initial);
  const renames: Array<[string, string]> = [];
  const fs: FileSystemPort = {
    existsSync: (target) => files.has(target),
    renameSync: (from, to) => {
      if (options.failRename) {
        throw new Error("EPERM");
      }
      files.delete(from);
      files.add(to);
      renames.push([from, to]);
    }
  };
  return { fs, files, renames };
}

describe("readUserDataOverride", () => {
  it("优先使用新名字的环境变量", () => {
    expect(readUserDataOverride({ MAILDECK_USER_DATA_DIR: "D:/a", OUTLOOK_MANAGER_USER_DATA_DIR: "D:/b" })).toBe("D:/a");
  });

  it("兼容旧名字的环境变量", () => {
    expect(readUserDataOverride({ OUTLOOK_MANAGER_USER_DATA_DIR: "D:/b" })).toBe("D:/b");
  });

  it("忽略空白值", () => {
    expect(readUserDataOverride({ MAILDECK_USER_DATA_DIR: "   " })).toBeNull();
  });

  it("都没设置时返回 null", () => {
    expect(readUserDataOverride({})).toBeNull();
  });
});

describe("migrateLegacyUserDataDirectory", () => {
  it("新目录已存在时不动旧目录", () => {
    const { fs, renames } = createFakeFileSystem([DEFAULT_USER_DATA, LEGACY_USER_DATA]);
    expect(migrateLegacyUserDataDirectory({ defaultPath: DEFAULT_USER_DATA, fs })).toBeNull();
    expect(renames).toEqual([]);
  });

  it("只有旧目录时整体改名到新目录", () => {
    const { fs, files } = createFakeFileSystem([LEGACY_USER_DATA]);
    expect(migrateLegacyUserDataDirectory({ defaultPath: DEFAULT_USER_DATA, fs })).toBeNull();
    expect(files.has(DEFAULT_USER_DATA)).toBe(true);
    expect(files.has(LEGACY_USER_DATA)).toBe(false);
  });

  it("两个目录都不存在时不报错", () => {
    const { fs, renames } = createFakeFileSystem([]);
    expect(migrateLegacyUserDataDirectory({ defaultPath: DEFAULT_USER_DATA, fs })).toBeNull();
    expect(renames).toEqual([]);
  });

  it("改名失败时退回旧目录，不让用户的数据看起来消失", () => {
    const { fs } = createFakeFileSystem([LEGACY_USER_DATA], { failRename: true });
    const errors: unknown[] = [];
    expect(
      migrateLegacyUserDataDirectory({ defaultPath: DEFAULT_USER_DATA, fs, onError: (error) => errors.push(error) })
    ).toBe(LEGACY_USER_DATA);
    expect(errors).toHaveLength(1);
  });
});

describe("resolveDatabaseFilePath", () => {
  const target = path.join(DEFAULT_USER_DATA, DATABASE_FILE_NAME);
  const legacy = path.join(DEFAULT_USER_DATA, LEGACY_DATABASE_FILE_NAME);

  it("两个文件都不存在时用新文件名", () => {
    const { fs, renames } = createFakeFileSystem([]);
    expect(resolveDatabaseFilePath(DEFAULT_USER_DATA, fs)).toBe(target);
    expect(renames).toEqual([]);
  });

  it("只有旧文件时就地改名成新文件名", () => {
    const { fs, files } = createFakeFileSystem([legacy]);
    expect(resolveDatabaseFilePath(DEFAULT_USER_DATA, fs)).toBe(target);
    expect(files.has(target)).toBe(true);
    expect(files.has(legacy)).toBe(false);
  });

  it("WAL/SHM 边车文件一起改名，避免留下孤儿日志", () => {
    const { fs, files } = createFakeFileSystem([legacy, `${legacy}-wal`, `${legacy}-shm`]);
    resolveDatabaseFilePath(DEFAULT_USER_DATA, fs);
    expect(files.has(`${target}-wal`)).toBe(true);
    expect(files.has(`${target}-shm`)).toBe(true);
    expect(files.has(`${legacy}-wal`)).toBe(false);
  });

  it("新文件已存在时保留新文件，不覆盖", () => {
    const { fs, files, renames } = createFakeFileSystem([legacy, target]);
    expect(resolveDatabaseFilePath(DEFAULT_USER_DATA, fs)).toBe(target);
    expect(renames).toEqual([]);
    expect(files.has(legacy)).toBe(true);
  });

  it("改名失败时继续用旧文件名，保证库还能打开", () => {
    const { fs } = createFakeFileSystem([legacy], { failRename: true });
    expect(resolveDatabaseFilePath(DEFAULT_USER_DATA, fs)).toBe(legacy);
  });
});

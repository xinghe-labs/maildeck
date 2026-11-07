import path from "node:path";

// 应用从 Outlook Manager 改名为 MailDeck 之后，默认数据目录会从
// %APPDATA%/outlook-manager 变成 %APPDATA%/maildeck，数据库文件也换名。
// 老用户（可能存着几百个账号）不能因为改名就看不到自己的数据，所以这里集中处理
// 环境变量别名、目录改名、数据库文件改名三件事，并且都能单测。

export const USER_DATA_ENV_KEYS = ["MAILDECK_USER_DATA_DIR", "OUTLOOK_MANAGER_USER_DATA_DIR"] as const;
export const LEGACY_USER_DATA_DIR_NAME = "outlook-manager";
export const DATABASE_FILE_NAME = "maildeck.db";
export const LEGACY_DATABASE_FILE_NAME = "outlook-manager.db";
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

export type FileSystemPort = {
  existsSync: (target: string) => boolean;
  renameSync: (from: string, to: string) => void;
};

export function readUserDataOverride(env: NodeJS.ProcessEnv): string | null {
  for (const key of USER_DATA_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * 新目录不存在、旧目录存在时，把旧目录整体改名过来。
 * 返回需要额外 setPath 的目录；返回 null 表示用默认目录即可。
 * 改名失败时退回旧目录：宁可目录名不一致，也不能让用户的数据“消失”。
 */
export function migrateLegacyUserDataDirectory(options: {
  defaultPath: string;
  fs: FileSystemPort;
  onError?: (error: unknown) => void;
}): string | null {
  const { defaultPath, fs, onError } = options;
  if (fs.existsSync(defaultPath)) {
    return null;
  }
  const legacyPath = path.join(path.dirname(defaultPath), LEGACY_USER_DATA_DIR_NAME);
  if (!fs.existsSync(legacyPath)) {
    return null;
  }
  try {
    fs.renameSync(legacyPath, defaultPath);
    return null;
  } catch (error) {
    onError?.(error);
    return legacyPath;
  }
}

/**
 * 解析数据库文件路径，必要时把旧文件名改过来。
 * -wal/-shm 一起改：只改主库会留下孤儿日志文件，看起来像“数据丢了”。
 */
export function resolveDatabaseFilePath(userDataPath: string, fs: FileSystemPort): string {
  const target = path.join(userDataPath, DATABASE_FILE_NAME);
  const legacy = path.join(userDataPath, LEGACY_DATABASE_FILE_NAME);
  if (fs.existsSync(target) || !fs.existsSync(legacy)) {
    return target;
  }
  try {
    fs.renameSync(legacy, target);
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      if (fs.existsSync(`${legacy}${suffix}`)) {
        fs.renameSync(`${legacy}${suffix}`, `${target}${suffix}`);
      }
    }
    return target;
  } catch {
    // 改不动就继续用旧文件名，保证老用户还能打开自己的库。
    return legacy;
  }
}

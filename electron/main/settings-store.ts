import { app } from "electron";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSettings, AppSettingsUpdate } from "../shared/ipc-contracts.js";
import {
  applySettingsUpdate,
  createDefaultSettingsFile,
  migrateSettingsFile,
  projectPublicSettings,
  projectRuntimeSettings,
  type RuntimeAppSettings,
  type SettingsCrypto,
  type SettingsFileV2
} from "./settings-model.js";
import { decryptSecret, encryptSecret } from "./token-crypto.js";
import { credentialGenerations } from "./credential-generations.js";
import { FileTooLargeError, readUtf8FileBounded } from "./bounded-file-reader.js";

export const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;

const settingsCrypto: SettingsCrypto = {
  encrypt: encryptSecret,
  decrypt: decryptSecret
};

let settingsQueue = Promise.resolve();

async function withSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = settingsQueue;
  let release!: () => void;
  settingsQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release();
  }
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function recoverBrokenSettings(filePath: string) {
  await copyFile(filePath, `${filePath}.broken-${Date.now()}.bak`);
  return { file: createDefaultSettingsFile(), migrated: true } as const;
}

async function readSettingsFile(): Promise<{ file: SettingsFileV2; migrated: boolean }> {
  const filePath = getSettingsPath();
  let raw: string;
  try {
    raw = await readUtf8FileBounded(filePath, SETTINGS_FILE_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { file: createDefaultSettingsFile(), migrated: false };
    }
    if (error instanceof FileTooLargeError) {
      return recoverBrokenSettings(filePath);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return recoverBrokenSettings(filePath);
    }
    throw error;
  }

  const input = asRecord(parsed);
  if (!input) {
    return recoverBrokenSettings(filePath);
  }
  const hasVersion = Object.prototype.hasOwnProperty.call(input, "version");
  if (hasVersion && typeof input.version === "number" && input.version > 2) {
    throw new Error(`Settings file version ${input.version} is newer than the supported version 2`);
  }
  if (hasVersion && input.version !== 1 && input.version !== 2) {
    return recoverBrokenSettings(filePath);
  }
  if (input.version !== 2 && !asRecord(input.settings)) {
    return recoverBrokenSettings(filePath);
  }

  try {
    return migrateSettingsFile(input, settingsCrypto);
  } catch (error) {
    if (input.version === 2) {
      return recoverBrokenSettings(filePath);
    }
    throw error;
  }
}

async function writeSettingsFile(file: SettingsFileV2) {
  const filePath = getSettingsPath();
  const tempPath = `${filePath}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function readAndPersistMigration() {
  const result = await readSettingsFile();
  if (result.migrated) {
    await writeSettingsFile(result.file);
  }
  return result.file;
}

export async function getSettings(): Promise<RuntimeAppSettings> {
  return withSettingsLock(async () => projectRuntimeSettings(await readAndPersistMigration(), settingsCrypto));
}

export async function getPublicSettings(): Promise<AppSettings> {
  return withSettingsLock(async () => projectPublicSettings(await readAndPersistMigration()));
}

export async function updateSettings(
  next: AppSettingsUpdate
): Promise<{ settings: AppSettings; proxyChanged: boolean }> {
  return withSettingsLock(async () => {
    const { file } = await readSettingsFile();
    const updated = applySettingsUpdate(file, next, settingsCrypto);
    if (updated.proxyChanged) {
      credentialGenerations.invalidateProxy();
    }
    try {
      await writeSettingsFile(updated.file);
    } finally {
      if (updated.proxyChanged) {
        credentialGenerations.invalidateProxy();
      }
    }
    return {
      settings: projectPublicSettings(updated.file),
      proxyChanged: updated.proxyChanged
    };
  });
}

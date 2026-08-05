import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

async function readSettingsFile(): Promise<{ file: SettingsFileV2; migrated: boolean }> {
  let raw: string;
  try {
    raw = await readFile(getSettingsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { file: createDefaultSettingsFile(), migrated: false };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { file: createDefaultSettingsFile(), migrated: false };
    }
    throw error;
  }
  return migrateSettingsFile(parsed, settingsCrypto);
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

import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSettings } from "./types.js";

const SETTINGS_VERSION = 1;

interface SettingsFile {
  version: number;
  settings: AppSettings;
}

const defaultSettings: AppSettings = {
  cacheMessages: true,
  cacheBodies: true,
  proxyUrl: "",
  batchConcurrency: 4
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

function normalizeSettings(input?: Partial<AppSettings>): AppSettings {
  const batchConcurrency = Number(input?.batchConcurrency);

  return {
    cacheMessages: input?.cacheMessages !== false,
    cacheBodies: input?.cacheBodies !== false,
    proxyUrl: input?.proxyUrl?.trim() || "",
    batchConcurrency: Number.isFinite(batchConcurrency) ? Math.min(Math.max(Math.round(batchConcurrency), 1), 12) : 4
  };
}

async function readSettingsFile(): Promise<SettingsFile> {
  try {
    const raw = await readFile(getSettingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SettingsFile>;
    return {
      version: parsed.version || SETTINGS_VERSION,
      settings: normalizeSettings(parsed.settings)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return {
        version: SETTINGS_VERSION,
        settings: defaultSettings
      };
    }

    throw error;
  }
}

async function writeSettingsFile(file: SettingsFile) {
  const filePath = getSettingsPath();
  const tempPath = `${filePath}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function getSettings(): Promise<AppSettings> {
  const file = await readSettingsFile();
  return file.settings;
}

export async function updateSettings(next: Partial<AppSettings>): Promise<AppSettings> {
  return withSettingsLock(async () => {
    const file = await readSettingsFile();
    file.settings = normalizeSettings({
      ...file.settings,
      ...next
    });
    file.version = SETTINGS_VERSION;
    await writeSettingsFile(file);
    return file.settings;
  });
}

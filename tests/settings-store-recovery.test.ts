import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({ userDataPath: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronState.userDataPath
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => {
      if (value === "fail-encryption") {
        throw new Error("system credential service unavailable");
      }
      return Buffer.from(value, "utf8");
    },
    decryptString: (value: Buffer) => value.toString("utf8")
  }
}));

const temporaryDirectories: string[] = [];

async function createTemporaryUserData() {
  const directory = await mkdtemp(path.join(tmpdir(), "outlook-manager-settings-recovery-"));
  temporaryDirectories.push(directory);
  electronState.userDataPath = directory;
  vi.resetModules();
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function expectRepairedSettings(directory: string, original: string) {
  const settingsPath = path.join(directory, "settings.json");
  const repaired = JSON.parse(await readFile(settingsPath, "utf8")) as { version: number; proxy: unknown };
  expect(repaired).toMatchObject({ version: 2, proxy: null });

  const backupName = (await readdir(directory)).find((name) => /^settings\.json\.broken-.*\.bak$/u.test(name));
  expect(backupName).toBeDefined();
  await expect(readFile(path.join(directory, backupName!), "utf8")).resolves.toBe(original);
}

describe("settings store recovery", () => {
  it("backs up invalid JSON before replacing it with defaults", async () => {
    const directory = await createTemporaryUserData();
    const original = "{";
    await writeFile(path.join(directory, "settings.json"), original, "utf8");
    const settingsStore = await import("../electron/main/settings-store.js");

    await expect(settingsStore.getPublicSettings()).resolves.toMatchObject({
      cacheMessages: true,
      proxyUrl: ""
    });
    await expectRepairedSettings(directory, original);
  });

  it("backs up an oversized settings file before self-healing", async () => {
    const directory = await createTemporaryUserData();
    const settingsStore = await import("../electron/main/settings-store.js");
    const original = "x".repeat(settingsStore.SETTINGS_FILE_MAX_BYTES + 1);
    await writeFile(path.join(directory, "settings.json"), original, "utf8");

    await expect(settingsStore.getPublicSettings()).resolves.toMatchObject({ proxyUrl: "" });
    await expectRepairedSettings(directory, original);
  });

  it("backs up an invalid version 2 shape before self-healing", async () => {
    const directory = await createTemporaryUserData();
    const original = JSON.stringify({
      version: 2,
      settings: {},
      proxy: { protocol: "file:", hostname: "local", port: "", username: "", encryptedPassword: "" }
    });
    await writeFile(path.join(directory, "settings.json"), original, "utf8");
    const settingsStore = await import("../electron/main/settings-store.js");

    await expect(settingsStore.getPublicSettings()).resolves.toMatchObject({ proxyUrl: "" });
    await expectRepairedSettings(directory, original);
  });

  it("does not overwrite legacy settings when encryption is temporarily unavailable", async () => {
    const directory = await createTemporaryUserData();
    const settingsPath = path.join(directory, "settings.json");
    const original = JSON.stringify({
      version: 1,
      settings: { proxyUrl: "http://user:fail-encryption@proxy.example:8080" }
    });
    await writeFile(settingsPath, original, "utf8");
    const settingsStore = await import("../electron/main/settings-store.js");

    await expect(settingsStore.getPublicSettings()).rejects.toThrow("system credential service unavailable");
    await expect(readFile(settingsPath, "utf8")).resolves.toBe(original);
    expect((await readdir(directory)).filter((name) => name.includes(".broken-"))).toEqual([]);
  });

  it("refuses to downgrade a settings file from a newer application version", async () => {
    const directory = await createTemporaryUserData();
    const settingsPath = path.join(directory, "settings.json");
    const original = JSON.stringify({ version: 3, settings: { cacheMessages: false }, proxy: null });
    await writeFile(settingsPath, original, "utf8");
    const settingsStore = await import("../electron/main/settings-store.js");

    await expect(settingsStore.getPublicSettings()).rejects.toThrow("newer than the supported version 2");
    await expect(readFile(settingsPath, "utf8")).resolves.toBe(original);
  });

  it("treats an invalid string version as damage instead of legacy settings", async () => {
    const directory = await createTemporaryUserData();
    const original = JSON.stringify({ version: "3", settings: { cacheMessages: false }, proxy: null });
    await writeFile(path.join(directory, "settings.json"), original, "utf8");
    const settingsStore = await import("../electron/main/settings-store.js");

    await expect(settingsStore.getPublicSettings()).resolves.toMatchObject({ cacheMessages: true });
    await expectRepairedSettings(directory, original);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8")
  }
}));
import {
  LEGACY_ACCOUNT_STORE_MAX_BYTES
} from "../electron/main/account-store.js";
import {
  LEGACY_MAIL_CACHE_MAX_BYTES
} from "../electron/main/mail-cache.js";
import {
  SETTINGS_FILE_MAX_BYTES
} from "../electron/main/settings-store.js";

const accountStoreSource = readFileSync(new URL("../electron/main/account-store.ts", import.meta.url), "utf8");
const mailCacheSource = readFileSync(new URL("../electron/main/mail-cache.ts", import.meta.url), "utf8");
const settingsStoreSource = readFileSync(new URL("../electron/main/settings-store.ts", import.meta.url), "utf8");

describe("persisted JSON file boundaries", () => {
  it("uses conservative limits for settings and one-time legacy migrations", () => {
    expect(SETTINGS_FILE_MAX_BYTES).toBe(1024 * 1024);
    expect(LEGACY_ACCOUNT_STORE_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(LEGACY_MAIL_CACHE_MAX_BYTES).toBe(128 * 1024 * 1024);
  });

  it.each([
    ["account store", accountStoreSource],
    ["mail cache", mailCacheSource],
    ["settings store", settingsStoreSource]
  ])("routes the %s through the shared bounded reader", (_label, source) => {
    expect(source).toContain("readUtf8FileBounded");
    expect(source).not.toMatch(/\breadFile\s*\(/u);
  });
});

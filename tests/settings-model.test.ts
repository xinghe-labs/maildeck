import { describe, expect, it } from "vitest";
import {
  applySettingsUpdate,
  migrateSettingsFile,
  projectPublicSettings,
  projectRuntimeSettings,
  type SettingsCrypto
} from "../electron/main/settings-model.js";

const crypto: SettingsCrypto = {
  encrypt: (value) => `encrypted:${Buffer.from(value, "utf8").toString("base64")}`,
  decrypt: (value) => Buffer.from(value.slice("encrypted:".length), "base64").toString("utf8")
};

function v1Settings(proxyUrl: string) {
  return {
    version: 1,
    settings: {
      cacheMessages: true,
      cacheBodies: false,
      proxyUrl,
      batchConcurrency: 6,
      hotmailFallbackEnabled: true,
      autoRefreshEnabled: true,
      autoRefreshIntervalMinutes: 15
    }
  };
}

describe("settings v2 model", () => {
  it("migrates HTTP credentials without persisting the plaintext password", () => {
    const { file, migrated } = migrateSettingsFile(
      v1Settings("http://alice:secret@proxy.example:8080"),
      crypto
    );

    expect(migrated).toBe(true);
    expect(file.version).toBe(2);
    expect(JSON.stringify(file)).not.toContain("secret");
    expect(projectPublicSettings(file)).toMatchObject({
      proxyUrl: "http://proxy.example:8080",
      proxyUsername: "alice",
      proxyHasPassword: true,
      proxySupported: true
    });
    expect(projectRuntimeSettings(file, crypto).proxyUrl).toBe(
      "http://alice:secret@proxy.example:8080"
    );
  });

  it("preserves legacy SOCKS metadata but refuses to use it at runtime", () => {
    const { file } = migrateSettingsFile(v1Settings("socks5://alice:secret@proxy.example:1080"), crypto);

    expect(file.proxy).toMatchObject({ protocol: "socks5:", hostname: "proxy.example", port: "1080" });
    expect(projectPublicSettings(file)).toMatchObject({
      proxyUrl: "socks5://proxy.example:1080",
      proxyUsername: "alice",
      proxyHasPassword: true,
      proxySupported: false
    });
    expect(() => projectRuntimeSettings(file, crypto)).toThrow("HTTP/HTTPS");
  });

  it("preserves an encrypted password when endpoint and username are unchanged", () => {
    const { file } = migrateSettingsFile(v1Settings("http://alice:secret@proxy.example:8080"), crypto);
    const encryptedPassword = file.proxy?.encryptedPassword;
    const updated = applySettingsUpdate(
      file,
      {
        proxyUrl: "http://proxy.example:8080",
        proxyUsername: "alice",
        proxyPassword: ""
      },
      crypto
    );

    expect(updated.file.proxy?.encryptedPassword).toBe(encryptedPassword);
    expect(updated.proxyChanged).toBe(false);
  });

  it("clears the old password when endpoint or username changes", () => {
    const { file } = migrateSettingsFile(v1Settings("http://alice:secret@proxy.example:8080"), crypto);

    const endpointChanged = applySettingsUpdate(
      file,
      { proxyUrl: "https://proxy.example:8443", proxyUsername: "alice", proxyPassword: "" },
      crypto
    );
    expect(endpointChanged.file.proxy?.encryptedPassword).toBe("");
    expect(endpointChanged.proxyChanged).toBe(true);

    const usernameChanged = applySettingsUpdate(
      file,
      { proxyUrl: "http://proxy.example:8080", proxyUsername: "bob", proxyPassword: "" },
      crypto
    );
    expect(usernameChanged.file.proxy?.encryptedPassword).toBe("");
    expect(usernameChanged.proxyChanged).toBe(true);
  });

  it("supports explicit password replacement and clearing", () => {
    const { file } = migrateSettingsFile(v1Settings("https://alice:secret@proxy.example:8443"), crypto);
    const replaced = applySettingsUpdate(
      file,
      { proxyPassword: "new-secret", clearProxyPassword: false },
      crypto
    );

    expect(JSON.stringify(replaced.file)).not.toContain("new-secret");
    expect(projectRuntimeSettings(replaced.file, crypto).proxyUrl).toContain("new-secret");

    const cleared = applySettingsUpdate(replaced.file, { clearProxyPassword: true }, crypto);
    expect(cleared.file.proxy?.encryptedPassword).toBe("");
    expect(projectPublicSettings(cleared.file).proxyHasPassword).toBe(false);
  });

  it("stores direct mode as a null proxy", () => {
    const { file } = migrateSettingsFile(v1Settings("http://alice:secret@proxy.example:8080"), crypto);
    const updated = applySettingsUpdate(file, { proxyUrl: "", proxyUsername: "", proxyPassword: "" }, crypto);

    expect(updated.file.proxy).toBeNull();
    expect(projectPublicSettings(updated.file)).toMatchObject({
      proxyUrl: "",
      proxyUsername: "",
      proxyHasPassword: false,
      proxySupported: true
    });
    expect(projectRuntimeSettings(updated.file, crypto).proxyUrl).toBe("");
  });
});

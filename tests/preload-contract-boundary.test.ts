import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from "../electron/shared/ipc-contracts.js";

const preloadSource = readFileSync(new URL("../electron/preload/index.cts", import.meta.url), "utf8");

describe("sandboxed preload contract boundary", () => {
  it("keeps every non-Electron import type-only", () => {
    const imports = [...preloadSource.matchAll(/import(?:\s+type)?[\s\S]*?\sfrom\s+["']([^"']+)["'];/gu)];

    expect(imports.length).toBeGreaterThan(0);
    for (const [statement, moduleName] of imports) {
      if (moduleName !== "electron") {
        expect(statement.trimStart().startsWith("import type")).toBe(true);
      }
    }
    expect(preloadSource).not.toMatch(/from\s+["']zod(?:\/[^"']*)?["']/u);
  });

  it("type-checks invoke and event channel literals against shared unions", () => {
    expect(preloadSource).toContain("IpcInvokeChannel");
    expect(preloadSource).toContain("IpcEventChannel");
  });

  it("defines unique invoke and event channels", () => {
    const invokeChannels = Object.values(IPC_CHANNELS);
    const eventChannels = Object.values(IPC_EVENT_CHANNELS);

    expect(new Set(invokeChannels).size).toBe(invokeChannels.length);
    expect(new Set(eventChannels).size).toBe(eventChannels.length);
    expect(invokeChannels).not.toEqual(expect.arrayContaining(eventChannels));
  });
});

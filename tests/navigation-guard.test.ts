import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  openExternal: vi.fn()
}));

vi.mock("electron", () => ({ shell: electron }));

import { guardExternalNavigation } from "../electron/main/navigation-guard.js";

afterEach(() => {
  vi.restoreAllMocks();
  electron.openExternal.mockReset();
});

describe("external navigation guard", () => {
  it("handles a rejected external protocol launch at the navigation boundary", async () => {
    electron.openExternal.mockRejectedValue(new Error("no mail handler"));
    const windowOpenHandlers: Array<(details: { url: string }) => { action: string }> = [];
    const listeners = new Map<string, (event: { preventDefault(): void }, url: string) => void>();
    const window = {
      webContents: {
        setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
          windowOpenHandlers.push(handler);
        },
        on(event: string, listener: (event: { preventDefault(): void }, url: string) => void) {
          listeners.set(event, listener);
        }
      }
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    guardExternalNavigation(window as never, "file://app", null);
    expect(windowOpenHandlers[0]?.({ url: "mailto:user@example.com" })).toEqual({ action: "deny" });
    await Promise.resolve();

    expect(electron.openExternal).toHaveBeenCalledWith("mailto:user@example.com");
    expect(warning).toHaveBeenCalledWith("External navigation failed", expect.stringContaining("no mail handler"));
    expect(listeners.has("will-navigate")).toBe(true);
  });
});

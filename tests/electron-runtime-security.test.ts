import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { configureSessionPermissions } from "../electron/main/session-security.js";

const mainSource = readFileSync(new URL("../electron/main/index.ts", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("Electron runtime security", () => {
  it("denies Chromium permission checks, requests, and device permissions by default", () => {
    let checkHandler: ((...args: unknown[]) => boolean) | null = null;
    let requestHandler: ((...args: unknown[]) => void) | null = null;
    let deviceHandler: ((...args: unknown[]) => boolean) | null = null;
    const target = {
      setPermissionCheckHandler: vi.fn((handler) => {
        checkHandler = handler;
      }),
      setPermissionRequestHandler: vi.fn((handler) => {
        requestHandler = handler;
      }),
      setDevicePermissionHandler: vi.fn((handler) => {
        deviceHandler = handler;
      })
    };

    configureSessionPermissions(target as never);

    expect(checkHandler?.()).toBe(false);
    const callback = vi.fn();
    requestHandler?.(null, "geolocation", callback, {});
    expect(callback).toHaveBeenCalledWith(false);
    expect(deviceHandler?.()).toBe(false);
  });

  it("installs the deny-by-default policy before creating a window", () => {
    const permissionIndex = mainSource.indexOf("configureSessionPermissions(session.defaultSession)");
    const windowIndex = mainSource.indexOf("createWindow();");

    expect(permissionIndex).toBeGreaterThan(-1);
    expect(permissionIndex).toBeLessThan(windowIndex);
  });

  it("never resumes after an uncaught main-process failure based on message text", () => {
    expect(mainSource).not.toContain("isRecoverableNetworkError");
    expect(mainSource).not.toContain("Suppressed recoverable");
    expect(mainSource.match(/process\.on\("(?:uncaughtException|unhandledRejection)"/gu)).toHaveLength(2);
    expect(mainSource.match(/exitAfterFatal\(/gu)).toHaveLength(3);
    expect(mainSource.match(/app\.exit\(1\)/gu)).toHaveLength(2);
  });

  it("does not expose arbitrary localhost WebSocket connections in the application CSP", () => {
    const csp = indexHtml.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/)?.[1] || "";

    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/wss?:\/\//u);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { configureSessionPermissions } from "../electron/main/session-security.js";

const mainSource = readFileSync(new URL("../electron/main/index.ts", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("Electron runtime security", () => {
  it("denies Chromium permission checks, requests, and device permissions by default", () => {
    // Handlers are captured on an object rather than in `let` bindings: the
    // assignments happen inside nested callbacks, so control-flow analysis would
    // keep narrowing a bare binding to its initial `null` value.
    const captured: {
      check: ((...args: unknown[]) => boolean) | null;
      request: ((...args: unknown[]) => void) | null;
      device: ((...args: unknown[]) => boolean) | null;
    } = { check: null, request: null, device: null };
    const target = {
      setPermissionCheckHandler: vi.fn((handler: (...args: unknown[]) => boolean) => {
        captured.check = handler;
      }),
      setPermissionRequestHandler: vi.fn((handler: (...args: unknown[]) => void) => {
        captured.request = handler;
      }),
      setDevicePermissionHandler: vi.fn((handler: (...args: unknown[]) => boolean) => {
        captured.device = handler;
      })
    };

    configureSessionPermissions(target);

    expect(captured.check?.()).toBe(false);
    const callback = vi.fn();
    captured.request?.(null, "geolocation", callback, {});
    expect(callback).toHaveBeenCalledWith(false);
    expect(captured.device?.()).toBe(false);
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
    expect(mainSource.match(/exitAfterFatal\(/gu)).toHaveLength(4);
    expect(mainSource.match(/app\.exit\(1\)/gu)).toHaveLength(2);
  });

  it("shows a recovery message when the local database cannot be opened or upgraded", () => {
    expect(mainSource).toMatch(/dialog\.showErrorBox\(\s*"数据库启动失败"/u);
    expect(mainSource).toContain("数据库备份");
    expect(mainSource).toMatch(/try\s*\{\s*getDatabase\(\);\s*\}\s*catch/u);
  });

  it("does not expose arbitrary localhost WebSocket connections in the application CSP", () => {
    const csp = indexHtml.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/)?.[1] || "";

    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/wss?:\/\//u);
  });
});

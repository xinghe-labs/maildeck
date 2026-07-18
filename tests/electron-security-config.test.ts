import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SECURE_WEB_PREFERENCES } from "../electron/main/window-security.js";

describe("renderer security configuration", () => {
  it("enables isolation and sandboxing without Node integration", () => {
    expect(SECURE_WEB_PREFERENCES).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    });
  });

  it("places a restrictive CSP before the application script", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    const cspIndex = html.indexOf('http-equiv="Content-Security-Policy"');
    const scriptIndex = html.indexOf('<script type="module"');
    const csp = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/)?.[1] || "";

    expect(cspIndex).toBeGreaterThan(-1);
    expect(cspIndex).toBeLessThan(scriptIndex);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp.match(/script-src[^;]*/)?.[0]).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
  });
});

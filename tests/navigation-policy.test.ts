import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isAllowedAppNavigation, isAllowedExternalUrl } from "../electron/main/navigation-policy.js";

describe("isAllowedExternalUrl", () => {
  it.each(["https://example.com", "http://example.com", "mailto:user@example.com", "tel:+10000000000"])(
    "allows approved external URL %s",
    (url) => expect(isAllowedExternalUrl(url)).toBe(true)
  );

  it.each(["javascript:alert(1)", "data:text/html,hello", "file:///tmp/a", "httpsx://example.com", "not a URL"])(
    "rejects unsafe external URL %s",
    (url) => expect(isAllowedExternalUrl(url)).toBe(false)
  );
});

describe("isAllowedAppNavigation", () => {
  it("allows only the exact packaged file", () => {
    const allowedPath = path.resolve("dist/index.html");
    expect(isAllowedAppNavigation(pathToFileURL(allowedPath).href, null, allowedPath)).toBe(true);
    expect(isAllowedAppNavigation(pathToFileURL(path.resolve("dist/other.html")).href, null, allowedPath)).toBe(false);
  });

  it("allows only the exact development origin", () => {
    expect(isAllowedAppNavigation("http://127.0.0.1:5173/inbox", "http://127.0.0.1:5173", null)).toBe(true);
    expect(isAllowedAppNavigation("http://127.0.0.1.evil.test:5173/", "http://127.0.0.1:5173", null)).toBe(false);
  });
});

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderer performance invariants", () => {
  it("reuses Intl date formatters across list rows", async () => {
    vi.resetModules();
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    let formatterConstructions = 0;
    class CountingDateTimeFormat extends OriginalDateTimeFormat {
      constructor(...parameters: ConstructorParameters<typeof OriginalDateTimeFormat>) {
        formatterConstructions += 1;
        super(...parameters);
      }
    }
    Object.defineProperty(Intl, "DateTimeFormat", { configurable: true, value: CountingDateTimeFormat });

    try {
      const { formatDate, formatDateShort, formatRelativeTime } = await import("../src/ui-utils");
      const timestamp = "2026-08-10T12:00:00.000Z";

      for (let index = 0; index < 10; index += 1) {
        formatDate(timestamp);
        formatDateShort(timestamp);
        formatRelativeTime(timestamp);
      }

      expect(formatterConstructions).toBeLessThanOrEqual(4);
    } finally {
      Object.defineProperty(Intl, "DateTimeFormat", { configurable: true, value: OriginalDateTimeFormat });
    }
  });

  it("defers layout and paint for offscreen account and message rows", async () => {
    const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
    const accountRule = css.match(/\.account-row\s*\{([^}]*)\}/u)?.[1] || "";
    const messageRule = css.match(/\.message-row\s*\{([^}]*)\}/u)?.[1] || "";

    expect(accountRule).toContain("content-visibility: auto");
    expect(accountRule).toContain("contain-intrinsic-size:");
    expect(messageRule).toContain("content-visibility: auto");
    expect(messageRule).toContain("contain-intrinsic-size:");
  });

  it("lets the fixed Electron shell fit the actual content viewport", async () => {
    const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
    const bodyRule = css.match(/body\s*\{([^}]*)\}/u)?.[1] || "";

    expect(bodyRule).toContain("min-height: 100vh");
    expect(bodyRule).not.toContain("min-height: 760px");
  });
});

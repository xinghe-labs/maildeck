import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const preloadSource = readFileSync(new URL("../electron/preload/index.cts", import.meta.url), "utf8");

describe("sandbox preload IPC errors", () => {
  it("unwraps successful structured results", () => {
    expect(preloadSource).toContain("result?.ok === true");
    expect(preloadSource).toContain("return result.value");
  });

  it("rejects with structured main-process errors", () => {
    expect(preloadSource).toContain("isAppErrorPayload(result.error)");
    expect(preloadSource).toContain("throw result.error");
  });

  it("does not expose raw Electron transport failures", () => {
    expect(preloadSource).toContain("主进程通信失败，请重试。");
    expect(preloadSource).toContain("throw transportError()");
  });
});

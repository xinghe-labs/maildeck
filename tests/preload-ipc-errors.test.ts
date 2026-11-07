import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const preloadSource = readFileSync(new URL("../electron/preload/index.cts", import.meta.url), "utf8");
const contractsSource = readFileSync(new URL("../electron/shared/ipc-contracts.ts", import.meta.url), "utf8");
const appErrorSource = readFileSync(new URL("../src/app-error.ts", import.meta.url), "utf8");

function extractUnionCodes(source: string, typeName: string): string[] {
  const start = source.indexOf(`export type ${typeName} =`);
  const end = source.indexOf(";", start);
  return [...source.slice(start, end).matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]);
}

function extractSetCodes(source: string): string[] {
  const start = source.indexOf("const APP_ERROR_CODES = new Set([");
  const end = source.indexOf("]);", start);
  return [...source.slice(start, end).matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]);
}

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

  // 预加载脚本在沙箱里不能 require 本地模块，所以错误码列表在三处各有一份。
  // 少写一个码的后果是：主进程的归类被当成“非法载荷”丢掉，用户看到的是
  // 「主进程通信失败，请重试」——实测就是这么被吞掉的（GRAPH_NOT_FOUND）。
  it("keeps every error code accepted by the preload and the renderer guard", () => {
    const declared = extractUnionCodes(contractsSource, "AppErrorCode");
    expect(declared.length).toBeGreaterThan(10);

    const preloadCodes = extractSetCodes(preloadSource);
    const rendererCodes = extractSetCodes(appErrorSource);
    expect(preloadCodes.length).toBeGreaterThan(10);
    expect(rendererCodes.length).toBeGreaterThan(10);

    expect([...declared].sort()).toEqual([...preloadCodes].sort());
    expect([...declared].sort()).toEqual([...rendererCodes].sort());
  });
});

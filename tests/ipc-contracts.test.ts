import { describe, expect, it } from "vitest";
import {
  IMPORT_TEXT_MAX_BYTES,
  IPC_EVENT_CHANNELS,
  IPC_EVENT_SCHEMAS,
  IPC_REQUEST_SCHEMAS,
  parseIpcEvent,
  parseIpcRequest
} from "../electron/shared/ipc-contracts.js";

describe("IPC request contracts", () => {
  it("bounds import text at 10 MiB", () => {
    expect(parseIpcRequest(IPC_REQUEST_SCHEMAS.importText, ["a".repeat(IMPORT_TEXT_MAX_BYTES)])).toHaveLength(
      IMPORT_TEXT_MAX_BYTES
    );
    expect(() =>
      parseIpcRequest(IPC_REQUEST_SCHEMAS.importText, ["a".repeat(IMPORT_TEXT_MAX_BYTES + 1)])
    ).toThrow("IPC request rejected");
  });

  it("deduplicates bounded account batches", () => {
    expect(parseIpcRequest(IPC_REQUEST_SCHEMAS.testMany, [[" a ", "a", "b"]])).toEqual(["a", "b"]);
    expect(() =>
      parseIpcRequest(
        IPC_REQUEST_SCHEMAS.testMany,
        [Array.from({ length: 5_001 }, (_, index) => String(index))]
      )
    ).toThrow();
  });

  it("normalizes and bounds mail list requests", () => {
    expect(
      parseIpcRequest(IPC_REQUEST_SCHEMAS.listMessages, [
        { accountId: " a ", top: 100, search: " subject " }
      ])
    ).toMatchObject({ accountId: "a", top: 100, search: "subject" });
    expect(() =>
      parseIpcRequest(IPC_REQUEST_SCHEMAS.listMessages, [{ accountId: "a", top: 101 }])
    ).toThrow();
    expect(() =>
      parseIpcRequest(IPC_REQUEST_SCHEMAS.listMessages, [{ accountId: "a", cursor: "x".repeat(129) }])
    ).toThrow();
  });

  it("accepts only closed job kinds and strict setting keys", () => {
    expect(parseIpcRequest(IPC_REQUEST_SCHEMAS.cancelJob, ["refreshBackground"])).toBe("refreshBackground");
    expect(() => parseIpcRequest(IPC_REQUEST_SCHEMAS.cancelJob, ["other"])).toThrow();
    expect(() =>
      parseIpcRequest(IPC_REQUEST_SCHEMAS.updateSettings, [{ batchConcurrency: 4, unexpected: true }])
    ).toThrow();
  });

  it("normalizes supported proxy URLs in settings updates", () => {
    expect(
      parseIpcRequest(IPC_REQUEST_SCHEMAS.updateSettings, [
        { proxyUrl: " HTTPS://Proxy.Example:8443 ", proxyUsername: " alice " }
      ])
    ).toMatchObject({ proxyUrl: "https://proxy.example:8443", proxyUsername: "alice" });
    expect(() =>
      parseIpcRequest(IPC_REQUEST_SCHEMAS.updateSettings, [{ proxyUrl: "socks5://proxy.example:1080" }])
    ).toThrow("IPC request rejected");
  });

  it("maps every event channel to a runtime schema", () => {
    expect(Object.keys(IPC_EVENT_SCHEMAS).sort()).toEqual(Object.values(IPC_EVENT_CHANNELS).sort());
  });

  it("accepts internally consistent progress events", () => {
    expect(parseIpcEvent(IPC_EVENT_CHANNELS.accountsTestProgress, {
      jobId: " job-1 ",
      kind: "test",
      completed: 2,
      total: 3,
      ok: 1,
      failed: 1,
      accountId: " account-1 "
    })).toMatchObject({ jobId: "job-1", accountId: "account-1", completed: 2 });

    expect(parseIpcEvent(IPC_EVENT_CHANNELS.mailRefreshProgress, {
      jobId: "job-2",
      kind: "refreshBackground",
      completed: 1,
      total: 2,
      ok: 0,
      failed: 1,
      accountId: "account-2",
      error: { code: "NETWORK_ERROR", message: "network unavailable", retryable: true },
      metrics: { tokenMs: 1, mailMs: 2, cacheMs: 3, stateMs: 4, totalMs: 10 }
    })).toMatchObject({ kind: "refreshBackground", failed: 1 });
  });

  it("rejects malformed or contradictory progress events", () => {
    const base = {
      jobId: "job-1",
      kind: "test",
      completed: 2,
      total: 1,
      ok: 1,
      failed: 0,
      accountId: "account-1"
    };

    expect(() => parseIpcEvent(IPC_EVENT_CHANNELS.accountsTestProgress, base)).toThrow("IPC event rejected");
    expect(() => parseIpcEvent(IPC_EVENT_CHANNELS.accountsTestProgress, {
      ...base,
      completed: 1,
      total: 1,
      unexpected: true
    })).toThrow("IPC event rejected");
  });
});

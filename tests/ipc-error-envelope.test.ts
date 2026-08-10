import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IPC_CHANNELS } from "../electron/shared/ipc-contracts.js";
import { MailContentTooLargeError } from "../electron/main/mail-errors.js";

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronState.handlers.set(channel, handler);
    })
  }
}));

beforeEach(() => {
  electronState.handlers.clear();
});

describe("structured IPC responses", () => {
  it("wraps successful handler values", async () => {
    const { handleValidated } = await import("../electron/main/validated-ipc.js");
    handleValidated(IPC_CHANNELS.settingsGet, z.tuple([]).transform(() => undefined), async () => ({ ready: true }));

    await expect(electronState.handlers.get(IPC_CHANNELS.settingsGet)?.({})).resolves.toEqual({
      ok: true,
      value: { ready: true }
    });
  });

  it("returns stable non-retryable codes for typed mail errors", async () => {
    const { handleValidated } = await import("../electron/main/validated-ipc.js");
    handleValidated(IPC_CHANNELS.mailGetMessage, z.tuple([]).transform(() => undefined), async () => {
      throw new MailContentTooLargeError(4 * 1024 * 1024);
    });

    await expect(electronState.handlers.get(IPC_CHANNELS.mailGetMessage)?.({})).resolves.toMatchObject({
      ok: false,
      error: {
        code: "MAIL_TOO_LARGE",
        message: expect.stringContaining("4 MiB"),
        retryable: false
      }
    });
  });

  it("marks network failures retryable without exposing unknown internal errors", async () => {
    const { handleValidated } = await import("../electron/main/validated-ipc.js");
    handleValidated(IPC_CHANNELS.mailListFolders, z.tuple([]).transform(() => undefined), async () => {
      throw new Error("socket ECONNRESET");
    });
    handleValidated(IPC_CHANNELS.accountsList, z.tuple([]).transform(() => undefined), async () => {
      throw new Error("C:\\Users\\person\\private-cache.db is corrupt");
    });

    await expect(electronState.handlers.get(IPC_CHANNELS.mailListFolders)?.({})).resolves.toMatchObject({
      ok: false,
      error: { code: "NETWORK_ERROR", retryable: true }
    });
    await expect(electronState.handlers.get(IPC_CHANNELS.accountsList)?.({})).resolves.toEqual({
      ok: false,
      error: {
        code: "UNKNOWN",
        message: "操作失败，请重试；如果问题持续，请检查应用日志。",
        retryable: false
      }
    });
  });

  it("classifies invalid positional arguments without invoking business logic", async () => {
    const { handleValidated } = await import("../electron/main/validated-ipc.js");
    const businessHandler = vi.fn();
    handleValidated(IPC_CHANNELS.settingsGet, z.tuple([]).transform(() => undefined), businessHandler);

    await expect(electronState.handlers.get(IPC_CHANNELS.settingsGet)?.({}, "unexpected")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringContaining("IPC request rejected"),
        retryable: false
      }
    });
    expect(businessHandler).not.toHaveBeenCalled();
  });
});

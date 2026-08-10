import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { parseIpcRequest, type IpcInvokeChannel, type IpcResult } from "../shared/ipc-contracts.js";
import { reportIpcError } from "./error-utils.js";

export function handleValidated<Output>(
  channel: IpcInvokeChannel,
  schema: z.ZodType<Output>,
  handler: (event: IpcMainInvokeEvent, request: Output) => unknown | Promise<unknown>
) {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
    try {
      const value = await handler(event, parseIpcRequest(schema, args));
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: reportIpcError(error, `IPC ${channel}`) };
    }
  });
}

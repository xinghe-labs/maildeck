import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { parseIpcRequest, type IpcInvokeChannel } from "../shared/ipc-contracts.js";

export function handleValidated<Output>(
  channel: IpcInvokeChannel,
  schema: z.ZodType<Output>,
  handler: (event: IpcMainInvokeEvent, request: Output) => unknown | Promise<unknown>
) {
  ipcMain.handle(channel, (event, ...args) => handler(event, parseIpcRequest(schema, args)));
}

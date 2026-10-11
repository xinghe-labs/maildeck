import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { z } from "zod";
import {
  parseIpcEvent,
  parseIpcRequest,
  type IpcEventChannel,
  type IpcEventPayloadMap,
  type IpcInvokeChannel,
  type IpcResult
} from "../shared/ipc-contracts.js";
import { reportIpcError } from "./error-utils.js";

export function handleValidated<Output>(
  channel: IpcInvokeChannel,
  schema: z.ZodType<Output>,
  handler: (event: IpcMainInvokeEvent, request: Output) => unknown
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

export function sendValidatedEvent<Channel extends IpcEventChannel>(
  target: Pick<WebContents, "send">,
  channel: Channel,
  payload: IpcEventPayloadMap[Channel]
) {
  target.send(channel, parseIpcEvent(channel, payload));
}

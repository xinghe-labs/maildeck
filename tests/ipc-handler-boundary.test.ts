import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from "../electron/shared/ipc-contracts.js";

const ipcSource = readFileSync(new URL("../electron/main/ipc.ts", import.meta.url), "utf8");
const validatedIpcUrl = new URL("../electron/main/validated-ipc.ts", import.meta.url);
const validatedIpcSource = existsSync(validatedIpcUrl) ? readFileSync(validatedIpcUrl, "utf8") : "";

describe("validated IPC handler boundary", () => {
  it("keeps direct ipcMain.handle calls out of business handlers", () => {
    expect(ipcSource).not.toContain("ipcMain.handle(");
  });

  it("parses positional arguments before invoking a handler", () => {
    expect(validatedIpcSource).toMatch(/ipcMain\.handle\(channel,[\s\S]*parseIpcRequest\(schema,\s*args\)/u);
    expect(validatedIpcSource).toMatch(/handler\(event,\s*parseIpcRequest\(schema,\s*args\)\)/u);
    expect(validatedIpcSource).toContain("ok: true");
    expect(validatedIpcSource).toContain("ok: false");
  });

  it("registers every public invoke channel through handleValidated", () => {
    for (const key of Object.keys(IPC_CHANNELS) as Array<keyof typeof IPC_CHANNELS>) {
      expect(ipcSource).toMatch(new RegExp(`handleValidated\\(\\s*IPC_CHANNELS\\.${key}\\s*,`, "u"));
    }

    expect(ipcSource.match(/handleValidated\(/gu)).toHaveLength(Object.keys(IPC_CHANNELS).length);
  });

  it("sends every public event through the validated event boundary", () => {
    expect(ipcSource).not.toContain("event.sender.send(");
    expect(validatedIpcSource).toMatch(/target\.send\(channel,\s*parseIpcEvent\(channel,\s*payload\)\)/u);

    for (const key of Object.keys(IPC_EVENT_CHANNELS) as Array<keyof typeof IPC_EVENT_CHANNELS>) {
      expect(ipcSource).toMatch(new RegExp(
        `sendValidatedEvent\\(\\s*event\\.sender,\\s*IPC_EVENT_CHANNELS\\.${key}\\s*,`,
        "u"
      ));
    }

    expect(ipcSource.match(/sendValidatedEvent\(/gu)).toHaveLength(Object.keys(IPC_EVENT_CHANNELS).length);
  });

  it("bounds account import files before parsing their contents", () => {
    expect(ipcSource).toContain("readUtf8FileBounded");
    expect(ipcSource).toContain("IMPORT_TEXT_MAX_BYTES");
    expect(ipcSource).toContain("FileTooLargeError");
  });
});

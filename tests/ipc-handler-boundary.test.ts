import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from "../electron/shared/ipc-contracts.js";

const ipcSource = readFileSync(new URL("../electron/main/ipc.ts", import.meta.url), "utf8");
const appUpdaterSource = readFileSync(new URL("../electron/main/app-updater.ts", import.meta.url), "utf8");
const validatedIpcUrl = new URL("../electron/main/validated-ipc.ts", import.meta.url);
const validatedIpcSource = existsSync(validatedIpcUrl) ? readFileSync(validatedIpcUrl, "utf8") : "";

// 更新通道注册在 app-updater.ts（同样只走 handleValidated / sendValidatedEvent），
// 其余通道在 ipc.ts；两个文件合起来构成完整的主进程边界。
const mainSources = [
  { name: "ipc.ts", source: ipcSource },
  { name: "app-updater.ts", source: appUpdaterSource }
];
const combinedMainSource = mainSources.map((entry) => entry.source).join("\n");

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
      const registered = mainSources.filter((entry) =>
        new RegExp(`handleValidated\\(\\s*IPC_CHANNELS\\.${key}\\s*,`, "u").test(entry.source)
      );
      expect(registered.map((entry) => entry.name)).toHaveLength(1);
    }

    // 每个通道恰好注册一次：不许多处重复挂 handler。
    expect(combinedMainSource.match(/handleValidated\(/gu)).toHaveLength(Object.keys(IPC_CHANNELS).length);
  });

  it("sends every public event through the validated event boundary", () => {
    expect(ipcSource).not.toContain("event.sender.send(");
    expect(validatedIpcSource).toMatch(/target\.send\(channel,\s*parseIpcEvent\(channel,\s*payload\)\)/u);

    for (const key of Object.keys(IPC_EVENT_CHANNELS) as Array<keyof typeof IPC_EVENT_CHANNELS>) {
      const senderPattern = new RegExp(`sendValidatedEvent\\([^,]*,\\s*IPC_EVENT_CHANNELS\\.${key}\\s*,`, "u");
      const matched = mainSources.filter((entry) => senderPattern.test(entry.source));
      expect(matched.map((entry) => entry.name)).toHaveLength(1);
    }

    expect(combinedMainSource.match(/sendValidatedEvent\(/gu)).toHaveLength(
      Object.keys(IPC_EVENT_CHANNELS).length
    );
  });

  it("bounds account import files before parsing their contents", () => {
    expect(ipcSource).toContain("readUtf8FileBounded");
    expect(ipcSource).toContain("IMPORT_TEXT_MAX_BYTES");
    expect(ipcSource).toContain("FileTooLargeError");
  });
});

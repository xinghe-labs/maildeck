import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getDatabase } from "./database.js";
import { registerIpcHandlers } from "./ipc.js";
import { guardExternalNavigation } from "./navigation-guard.js";
import { closeProxyDispatchers } from "./proxy-agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

function isRecoverableNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("socket hang up") ||
    lower.includes("tlswrap") ||
    lower.includes("network")
  );
}

process.on("uncaughtException", (error) => {
  if (isRecoverableNetworkError(error)) {
    console.warn("Suppressed recoverable network exception", error);
    return;
  }

  console.error("Uncaught exception", error);
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (isRecoverableNetworkError(reason)) {
    console.warn("Suppressed recoverable network rejection", reason);
    return;
  }

  console.error("Unhandled rejection", reason);
});

if (process.env.OUTLOOK_MANAGER_USER_DATA_DIR) {
  app.setPath("userData", process.env.OUTLOOK_MANAGER_USER_DATA_DIR);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: "Outlook Manager",
    icon: path.join(__dirname, "../../build/icon.ico"),
    backgroundColor: "#eef2f1",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const indexFilePath = path.join(__dirname, "../../dist/index.html");
  guardExternalNavigation(window, isDev ? new URL(process.env.VITE_DEV_SERVER_URL!).origin : null, isDev ? null : indexFilePath);

  if (isDev) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL!);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    window.loadFile(indexFilePath);
  }
}

app.whenReady().then(() => {
  getDatabase();
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  closeProxyDispatchers();
  closeDatabase();
});

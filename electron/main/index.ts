import { app, BrowserWindow, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getDatabase } from "./database.js";
import { formatErrorForLog } from "./error-utils.js";
import { registerIpcHandlers } from "./ipc.js";
import { guardExternalNavigation } from "./navigation-guard.js";
import { closeProxyDispatchers } from "./proxy-agent.js";
import { SECURE_WEB_PREFERENCES } from "./window-security.js";
import { configureSessionPermissions } from "./session-security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

let fatalExitStarted = false;

function exitAfterFatal(label: string, error: unknown) {
  if (fatalExitStarted) {
    app.exit(1);
    return;
  }
  fatalExitStarted = true;
  try {
    console.error(label, formatErrorForLog(error));
  } catch {
    // Fatal logging must never prevent process termination.
  }

  try {
    closeProxyDispatchers();
  } catch (cleanupError) {
    console.error("Failed to close proxy dispatchers", formatErrorForLog(cleanupError));
  }
  try {
    closeDatabase();
  } catch (cleanupError) {
    console.error("Failed to close database", formatErrorForLog(cleanupError));
  }
  app.exit(1);
}

process.on("uncaughtException", (error) => {
  exitAfterFatal("Uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  exitAfterFatal("Unhandled rejection", reason);
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
      preload: path.join(__dirname, "../preload/index.cjs"),
      ...SECURE_WEB_PREFERENCES
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
  configureSessionPermissions(session.defaultSession);
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

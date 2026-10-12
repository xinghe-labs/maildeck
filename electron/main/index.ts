import { app, BrowserWindow, dialog, session } from "electron";
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

// userData 目录必须在申请单实例锁之前确定：锁的身份取自调用时刻的 userData 路径。
// 同一 userData 目录下不允许第二个进程（node:sqlite 不支持多进程并发写入，双开会触发
// database is locked 甚至互相覆盖账号状态）；不同数据目录（如发布冒烟测试的隔离目录）
// 互不影响。第二个实例直接退出。
if (process.env.OUTLOOK_MANAGER_USER_DATA_DIR) {
  app.setPath("userData", process.env.OUTLOOK_MANAGER_USER_DATA_DIR);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [existingWindow] = BrowserWindow.getAllWindows();
    if (existingWindow) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }
      existingWindow.focus();
    }
  });
}

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
    void window.loadURL(process.env.VITE_DEV_SERVER_URL!);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadFile(indexFilePath);
  }
}

if (app.hasSingleInstanceLock()) {
  // 未拿到单实例锁时上面的 app.quit() 已排队，这里不能再初始化数据库和窗口。
  void app.whenReady().then(() => {
    configureSessionPermissions(session.defaultSession);
    try {
      getDatabase();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        dialog.showErrorBox(
          "数据库启动失败",
          `无法打开或升级本地数据库，应用将退出。数据库文件未被覆盖；如果错误信息中包含数据库备份路径，请保留该文件用于恢复。\n\n${reason}`
        );
      } catch (dialogError) {
        console.error("Failed to show database recovery dialog", formatErrorForLog(dialogError));
      }
      exitAfterFatal("Database startup failed", error);
      return;
    }
    registerIpcHandlers();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  closeProxyDispatchers();
  closeDatabase();
});

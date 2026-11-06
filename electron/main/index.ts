import { app, BrowserWindow, dialog, Menu, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getDatabase } from "./database.js";
import { formatErrorForLog } from "./error-utils.js";
import { registerIpcHandlers } from "./ipc.js";
import { guardExternalNavigation } from "./navigation-guard.js";
import { closeProxyDispatchers } from "./proxy-agent.js";
import { SECURE_WEB_PREFERENCES } from "./window-security.js";
import { configureSessionPermissions } from "./session-security.js";
import { TOKEN_GUIDE_TEXT, TOKEN_GUIDE_TITLE } from "../shared/token-guide.js";

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
    // 125% 缩放的 1440×900 笔记本，可用高度只有约 652 个 CSS 像素。
    // 原来的 1440×920 / minHeight 720 会超出屏幕：窗口底部的 toast 被裁掉，
    // 用户也看不到完整界面。初始尺寸和下限都按这个场景放小一档。
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "Outlook Manager",
    icon: path.join(__dirname, "../../build/icon.ico"),
    backgroundColor: "#fafafa", // 与 --bg-app 一致：窗口映射到首帧之间不留异色
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

// 默认菜单把 DevTools/重新加载/强制重新加载 摆在一个键就能点到的地方，
// 普通用户很容易误触；这里换成只保留“编辑/视图/帮助”，开发菜单只在 dev 下挂载。
function buildApplicationMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (isDev) {
    template.push({
      label: "开发",
      submenu: [{ role: "toggleDevTools" }, { role: "reload" }]
    });
  }

  template.push(
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "帮助",
      submenu: [
        {
          // 应用不内置微软登录流程，所以“去哪拿 refresh_token”必须有个入口可查，
          // 否则新手只能在导入弹窗里对着两个空字段猜。
          label: TOKEN_GUIDE_TITLE,
          click: () => {
            const [window] = BrowserWindow.getAllWindows();
            const options = {
              type: "info" as const,
              title: TOKEN_GUIDE_TITLE,
              message: TOKEN_GUIDE_TITLE,
              detail: TOKEN_GUIDE_TEXT,
              buttons: ["知道了"]
            };
            if (window) {
              void dialog.showMessageBox(window, options);
            } else {
              void dialog.showMessageBox(options);
            }
          }
        },
        { type: "separator" },
        {
          label: "关于 Outlook Manager",
          click: () => {
            const [window] = BrowserWindow.getAllWindows();
            const options = {
              type: "info" as const,
              title: "关于",
              message: `Outlook Manager v${app.getVersion()}`,
              detail: `Microsoft 邮箱工作台\n\nElectron ${process.versions.electron}\nNode ${process.versions.node}\n\n数据目录：${app.getPath("userData")}`,
              buttons: ["好"]
            };
            if (window) {
              void dialog.showMessageBox(window, options);
            } else {
              void dialog.showMessageBox(options);
            }
          }
        }
      ]
    }
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
    buildApplicationMenu();
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

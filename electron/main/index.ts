import { app, BrowserWindow, dialog, Menu, session } from "electron";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getDatabase } from "./database.js";
import { formatErrorForLog } from "./error-utils.js";
import { registerIpcHandlers } from "./ipc.js";
import { guardExternalNavigation } from "./navigation-guard.js";
import { closeProxyDispatchers } from "./proxy-agent.js";
import { startAppUpdater } from "./app-updater.js";
import { getSettings } from "./settings-store.js";
import { SECURE_WEB_PREFERENCES } from "./window-security.js";
import { configureSessionPermissions } from "./session-security.js";
import { migrateLegacyUserDataDirectory, readUserDataOverride } from "./user-data-path.js";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

let fatalExitStarted = false;

// userData 目录必须在申请单实例锁之前确定：锁的身份取自调用时刻的 userData 路径。
// 同一 userData 目录下不允许第二个进程（node:sqlite 不支持多进程并发写入，双开会触发
// database is locked 甚至互相覆盖账号状态）；不同数据目录（如发布冒烟测试的隔离目录）
// 互不影响。第二个实例直接退出。
const userDataOverride = readUserDataOverride(process.env);
if (userDataOverride) {
  app.setPath("userData", userDataOverride);
} else {
  const migratedPath = migrateLegacyUserDataDirectory({
    defaultPath: app.getPath("userData"),
    fs: { existsSync, renameSync },
    onError: (error) => console.error("Failed to migrate legacy userData directory", formatErrorForLog(error))
  });
  if (migratedPath) {
    app.setPath("userData", migratedPath);
  }
}

// 开启 RendererCodeIntegrity：阻止第三方 DLL（搜狗输入法 SogouPY.ime、Mactype 等）注入渲染进程。
// 真机踩坑：搜狗的 IME DLL 注入渲染进程后自身触发 0xC0000005，整个渲染进程启动即崩，
// 且用户装了搜狗就必崩、无从排查。Chrome 默认开启此特性，Electron 历史上默认关闭。
app.commandLine.appendSwitch("enable-features", "RendererCodeIntegrity");

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

function createWindow() {
  const window = new BrowserWindow({
    // 125% 缩放的 1440×900 笔记本，可用高度只有约 652 个 CSS 像素。
    // 原来的 1440×920 / minHeight 720 会超出屏幕：窗口底部的 toast 被裁掉，
    // 用户也看不到完整界面。初始尺寸和下限都按这个场景放小一档。
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "MailDeck",
    icon: path.join(__dirname, "../../build/icon.ico"),
    backgroundColor: "#fafafa", // 与 --bg-app 一致：窗口映射到首帧之间不留异色
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      ...SECURE_WEB_PREFERENCES
    }
  });
  const indexFilePath = path.join(__dirname, "../../dist/index.html");
  // dev server URL 来自本地环境变量，一般不会错；但 new URL 对畸形输入直接抛，
  // 不能让它把整个窗口创建炸掉——坏 URL 就当作没有外部导航白名单。
  let devServerOrigin: string | null = null;
  if (isDev) {
    try {
      devServerOrigin = new URL(process.env.VITE_DEV_SERVER_URL ?? "").origin;
    } catch (error) {
      console.error("Invalid VITE_DEV_SERVER_URL:", formatErrorForLog(error));
    }
  }
  guardExternalNavigation(window, devServerOrigin, isDev ? null : indexFilePath);

  if (isDev) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL!);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadFile(indexFilePath);
  }
}

// 不挂应用菜单：顶部菜单栏（编辑/视图/帮助）去掉，窗口更干净。
// 代价与补偿：编辑快捷键 Windows 下由 Chromium 原生处理不受影响；
// token 获取指南仍由渲染层的 TokenGuidePanel/侧栏卡片承载；版本号在设置页可见。

if (app.hasSingleInstanceLock()) {
  // 未拿到单实例锁时上面的 app.quit() 已排队，这里不能再初始化数据库和窗口。
  void app.whenReady().then(async () => {
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
    Menu.setApplicationMenu(null);
    createWindow();

    // 更新器放在窗口创建之后：广播目标是 BrowserWindow 列表，且启动 8 秒后才
    // 真正联网检查，不抸慢首屏。设置读取失败时按「开启自动检查」的保守默认不合适
    // （用户明确关过就不该被打扰），所以读失败就直接不调度，只保留手动检查入口。
    try {
      const settings = await getSettings();
      const updateController = startAppUpdater({
        isDev,
        env: process.env,
        autoUpdateCheckEnabled: settings.autoUpdateCheckEnabled
      });
      // 启动自动检查已并入 startAppUpdater（内部会真正调用 runner，之前的版本只切状态不发请求）。
      void updateController;
    } catch (error) {
      console.error("Failed to start app updater", formatErrorForLog(error));
    }

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

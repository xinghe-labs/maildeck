import { app, Menu, nativeImage, Tray, type BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 托盘常驻 + 关闭/最小化到托盘。生命周期：
// - syncTray(enabled) 按设置创建/销毁托盘；设置页开关切换时实时生效。
// - shouldHideOnClose() 在窗口 close 事件里判断：托盘开启且非真实退出 → 隐藏而不是关窗。
// - markQuitting() 由 before-quit 调用，之后 close 一律放行（真正退出）。
// 气泡：notifyNewMail 仅 Windows（displayBalloon 是 Win32 专属 API），其他平台静默跳过。

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TrayHooks {
  /** 托盘菜单「立即收信」触发，由 ipc 层注入。 */
  onRefreshAll?: () => void;
}

let tray: Tray | null = null;
let quitting = false;
let enabled = false;
let mainWindow: BrowserWindow | null = null;
let hooks: TrayHooks = {};

export function markQuitting() {
  quitting = true;
}

export function isTrayEnabled() {
  return enabled && tray !== null;
}

/** 窗口 close 事件：返回 true 表示已拦截为「隐藏到托盘」。 */
export function shouldHideOnClose() {
  return !quitting && enabled && tray !== null;
}

export function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function buildTrayIcon() {
  const iconPath = path.join(__dirname, "../../build/icon.ico");
  const icon = nativeImage.createFromPath(iconPath);
  // 图标读取失败不至于砸挂托盘：Electron 会用默认空白图标顶上。
  return icon.isEmpty() ? undefined : icon;
}

export function syncTray(options: { enabled: boolean; window: BrowserWindow; hooks?: TrayHooks }) {
  enabled = options.enabled;
  mainWindow = options.window;
  if (options.hooks) {
    hooks = options.hooks;
  }

  if (!enabled) {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    return;
  }
  if (tray) {
    return;
  }
  const nextTray = new Tray(buildTrayIcon() ?? nativeImage.createEmpty());
  nextTray.setToolTip("MailDeck");
  nextTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开 MailDeck",
        click: () => showMainWindow()
      },
      {
        label: "立即收信",
        click: () => {
          showMainWindow();
          hooks.onRefreshAll?.();
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          markQuitting();
          app.quit();
        }
      }
    ])
  );
  nextTray.on("double-click", () => showMainWindow());
  tray = nextTray;
}

export function notifyNewMail(payload: { email: string; newCount: number }) {
  if (!tray || process.platform !== "win32" || typeof tray.displayBalloon !== "function") {
    return;
  }
  try {
    tray.displayBalloon({
      iconType: "info",
      title: "MailDeck 有新邮件",
      content: `${payload.email} 收到 ${payload.newCount} 封新邮件`
    });
  } catch (error) {
    console.error("Failed to show tray balloon", error);
  }
}

/** 开机自启：打包版注册自身 exe，带 --hidden 让托盘模式下启动即隐藏。 */
export function applyLaunchAtStartup(enabled: boolean) {
  if (process.defaultApp) {
    // 开发模式下注册 electron.exe 没有意义，跳过。
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: ["--hidden"]
  });
}

export function shouldStartHiddenFromArgv(argv: string[]) {
  return argv.includes("--hidden");
}

export function resetTrayForTest() {
  tray = null;
  quitting = false;
  enabled = false;
  mainWindow = null;
  hooks = {};
}

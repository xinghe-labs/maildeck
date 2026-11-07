import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

// tray-controller 直接 new Tray / Menu.buildFromTemplate；vitest 里没有真 electron，全 mock。
// 注意 vi.mock 工厂会被提升：FakeTray 必须定义在工厂内部，用静态数组收集实例供断言。
const trayState = vi.hoisted(() => ({
  instances: [] as Array<{
    destroyed: boolean;
    menu: unknown;
    balloons: unknown[];
    setToolTip: (t: string) => void;
    setContextMenu: (m: unknown) => void;
    on: (event: string, handler: () => void) => void;
    destroy: () => void;
    displayBalloon: (payload: unknown) => void;
  }>,
  app: { quit: vi.fn(), setLoginItemSettings: vi.fn() }
}));

vi.mock("electron", () => {
  class FakeTray {
    destroyed = false;
    tooltip = "";
    menu: unknown = null;
    doubleClickHandlers: Array<() => void> = [];
    balloons: unknown[] = [];

    constructor() {
      trayState.instances.push(this);
    }
    setToolTip(tooltip: string) {
      this.tooltip = tooltip;
    }
    setContextMenu(menu: unknown) {
      this.menu = menu;
    }
    on(_event: string, handler: () => void) {
      this.doubleClickHandlers.push(handler);
    }
    destroy() {
      this.destroyed = true;
    }
    displayBalloon(payload: unknown) {
      this.balloons.push(payload);
    }
  }

  return {
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template: unknown) => template },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => false }),
      createEmpty: () => ({ isEmpty: () => true })
    },
    app: {
      quit: trayState.app.quit,
      setLoginItemSettings: trayState.app.setLoginItemSettings
    }
  };
});

function fakeWindow() {
  // syncTray 只用到 isDestroyed/isMinimized/show/hide/focus/restore，
  // BrowserWindow 的其余成员在测试里无用，用 as 断言收缩类型。
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn()
  } as unknown as BrowserWindow;
}

function firstTray() {
  const tray = trayState.instances[0];
  if (!tray) {
    throw new Error("tray not created");
  }
  return tray;
}

function menuItems(tray: ReturnType<typeof firstTray>) {
  return (tray.menu as Array<{ label: string; click?: () => void }>) ?? [];
}

import {
  applyLaunchAtStartup,
  isTrayEnabled,
  markQuitting,
  notifyNewMail,
  resetTrayForTest,
  shouldHideOnClose,
  showMainWindow,
  syncTray
} from "../electron/main/tray-controller.js";

describe("tray-controller", () => {
  beforeEach(() => {
    resetTrayForTest();
    trayState.instances = [];
    vi.mocked(trayState.app.quit).mockClear();
    vi.mocked(trayState.app.setLoginItemSettings).mockClear();
  });

  it("按设置创建/销毁托盘，重复开启不叠加", () => {
    const window = fakeWindow();
    syncTray({ enabled: true, window });
    expect(trayState.instances).toHaveLength(1);
    expect(isTrayEnabled()).toBe(true);

    syncTray({ enabled: true, window });
    expect(trayState.instances).toHaveLength(1);

    syncTray({ enabled: false, window });
    expect(trayState.instances[0]?.destroyed).toBe(true);
    expect(isTrayEnabled()).toBe(false);
  });

  it("托盘开启时 close 拦截为隐藏，退出后放行", () => {
    const window = fakeWindow();
    syncTray({ enabled: true, window });
    expect(shouldHideOnClose()).toBe(true);

    markQuitting();
    expect(shouldHideOnClose()).toBe(false);
  });

  it("托盘菜单「立即收信」触发注入的刷新钩子并显示窗口", () => {
    const onRefreshAll = vi.fn();
    const window = fakeWindow();
    syncTray({ enabled: true, window, hooks: { onRefreshAll } });

    const item = menuItems(firstTray()).find((entry) => entry.label === "立即收信");
    item?.click?.();

    expect(onRefreshAll).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("托盘菜单「退出」置退出标志并退出应用", () => {
    const window = fakeWindow();
    syncTray({ enabled: true, window });

    const item = menuItems(firstTray()).find((entry) => entry.label === "退出");
    item?.click?.();

    expect(trayState.app.quit).toHaveBeenCalledTimes(1);
    expect(shouldHideOnClose()).toBe(false);
  });

  it("showMainWindow 恢复最小化窗口并抢焦点", () => {
    const window = fakeWindow();
    syncTray({ enabled: true, window });

    showMainWindow();
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("Windows 上新邮件弹托盘气泡；未开托盘时静默跳过", () => {
    // 未创建托盘：不应抛错。
    expect(() => notifyNewMail({ email: "a@x.com", newCount: 2 })).not.toThrow();

    const window = fakeWindow();
    syncTray({ enabled: true, window });
    notifyNewMail({ email: "a@x.com", newCount: 3 });

    const tray = firstTray();
    // 当前测试平台是 win32（本项目只在 Windows 打包），displayBalloon 应被调用。
    if (process.platform === "win32") {
      expect(tray.balloons).toHaveLength(1);
      expect(tray.balloons[0]).toMatchObject({ title: "MailDeck 有新邮件", content: "a@x.com 收到 3 封新邮件" });
    } else {
      expect(tray.balloons).toHaveLength(0);
    }
  });

  it("开机自启注册 exe 并带 --hidden；关闭时取消注册", () => {
    applyLaunchAtStartup(true);
    expect(trayState.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, args: ["--hidden"] });

    applyLaunchAtStartup(false);
    expect(trayState.app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false, args: ["--hidden"] });
  });
});

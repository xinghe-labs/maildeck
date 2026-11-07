import { describe, expect, it, vi } from "vitest";
import {
  UpdateController,
  classifyUpdateError,
  isPortableRuntime,
  resolveUpdateMode,
  type UpdateMode
} from "../electron/main/update-controller.js";
import { startAppUpdater, UPDATE_CHECK_TIMEOUT_MS, type UpdateRunner } from "../electron/main/app-updater.js";

// startAppUpdater 会注册 IPC 并广播状态；vitest 里没有真 electron，mock 掉。
const electronState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}));
vi.mock("electron", () => ({
  ipcMain: {
    removeHandler: vi.fn((channel: string) => electronState.handlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronState.handlers.set(channel, handler);
    })
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}));

function makeController(mode: UpdateMode = "background") {
  const controller = new UpdateController(mode);
  const seen: string[] = [];
  controller.subscribe((state) => seen.push(state.phase));
  return { controller, seen };
}

describe("resolveUpdateMode", () => {
  it("开发模式永远不接更新器", () => {
    expect(resolveUpdateMode({ isDev: true, isPortable: false, autoUpdateCheckEnabled: true })).toBe("disabled-dev");
    expect(resolveUpdateMode({ isDev: true, isPortable: true, autoUpdateCheckEnabled: false })).toBe("disabled-dev");
  });

  it("绿色版只引导去发布页，即使开着自动检查", () => {
    expect(resolveUpdateMode({ isDev: false, isPortable: true, autoUpdateCheckEnabled: true })).toBe(
      "disabled-portable"
    );
  });

  it("安装版按设置开关决定后台自动还是仅手动", () => {
    expect(resolveUpdateMode({ isDev: false, isPortable: false, autoUpdateCheckEnabled: true })).toBe("background");
    expect(resolveUpdateMode({ isDev: false, isPortable: false, autoUpdateCheckEnabled: false })).toBe("manual");
  });
});

describe("isPortableRuntime", () => {
  it("识别 electron-builder portable 注入的环境变量", () => {
    expect(isPortableRuntime({ PORTABLE_EXECUTABLE_DIR: "D:/x" })).toBe(true);
    expect(isPortableRuntime({ PORTABLE_EXECUTABLE_FILE: "D:/x/app.exe" })).toBe(true);
    expect(isPortableRuntime({})).toBe(false);
  });
});

describe("classifyUpdateError", () => {
  it("网络类错误归 UPDATE_NETWORK", () => {
    expect(classifyUpdateError("getaddrinfo ENOTFOUND github.com")).toBe("UPDATE_NETWORK");
    expect(classifyUpdateError("socket hang up")).toBe("UPDATE_NETWORK");
  });

  it("其它错误归检查失败", () => {
    expect(classifyUpdateError("release name not found")).toBe("UPDATE_CHECK_FAILED");
  });
});

describe("UpdateController", () => {
  it("绿色版初始就是 unsupported 并带发布页链接", () => {
    const { controller } = makeController("disabled-portable");
    expect(controller.getState()).toMatchObject({ phase: "unsupported", reason: "portable" });
    expect(controller.getState().phase === "unsupported" && controller.getState().releaseUrl).toBeTruthy();
  });

  it("检查→无更新：版本为当前版本", () => {
    const { controller } = makeController();
    controller.requestCheck();
    controller.checkNoUpdate("0.3.0");
    expect(controller.getState()).toEqual({ phase: "not-available", version: "0.3.0" });
  });

  it("检查→发现新版本→下载进度→就绪，状态按顺序广播", () => {
    const { controller, seen } = makeController();
    controller.requestCheck();
    controller.checkFoundUpdate("0.4.0");
    expect(controller.getState()).toMatchObject({ phase: "available", version: "0.4.0" });
    controller.downloadStarted("0.4.0");
    controller.downloadProgress({ percent: 42.44, transferred: 10, total: 100, bytesPerSecond: 5 });
    expect(controller.getState()).toMatchObject({
      phase: "downloading",
      percent: 42.4,
      transferredBytes: 10,
      totalBytes: 100
    });
    controller.downloadFinished("0.4.0");
    expect(controller.getState()).toMatchObject({ phase: "downloaded", version: "0.4.0" });
    expect(seen).toEqual(["checking", "available", "downloading", "downloading", "downloaded"]);
  });

  it("乱序事件被丢弃：下载中途又报 available 不会回退状态", () => {
    const { controller } = makeController();
    controller.requestCheck();
    controller.checkFoundUpdate("0.4.0");
    controller.downloadStarted("0.4.0");
    controller.checkFoundUpdate("0.4.1");
    controller.downloadFinished("0.4.0");
    expect(controller.getState()).toMatchObject({ phase: "downloaded", version: "0.4.0" });
  });

  it("checking 期间重复 requestCheck 幂等", () => {
    const { controller, seen } = makeController();
    controller.requestCheck();
    const again = controller.requestCheck();
    expect(again.phase).toBe("checking");
    expect(seen).toEqual(["checking"]);
  });

  it("下载完成后重新检查允许再次走流程", () => {
    const { controller } = makeController();
    controller.requestCheck();
    controller.checkFoundUpdate("0.4.0");
    controller.downloadStarted("0.4.0");
    controller.downloadFinished("0.4.0");
    expect(controller.requestCheck().phase).toBe("checking");
  });

  it("检查失败带网络错误码与截断后的消息", () => {
    const { controller } = makeController();
    controller.requestCheck();
    controller.checkFailed(`getaddrinfo ENOTFOUND api.github.com ${"x".repeat(500)}`);
    const state = controller.getState();
    expect(state.phase).toBe("error");
    if (state.phase === "error") {
      expect(state.code).toBe("UPDATE_NETWORK");
      expect(state.message?.length).toBeLessThanOrEqual(401);
      expect(state.message?.endsWith("…")).toBe(true);
    }
  });

  it("下载失败回到 error 且保留发布页出口", () => {
    const { controller } = makeController();
    controller.requestCheck();
    controller.checkFoundUpdate("0.4.0");
    controller.downloadStarted("0.4.0");
    controller.downloadFailed("sha256 checksum mismatch");
    expect(controller.getState()).toMatchObject({ phase: "error", code: "UPDATE_DOWNLOAD_FAILED" });
    expect(controller.getState().phase === "error" && controller.getState().releaseUrl).toBeTruthy();
  });

  it("未就绪时请求安装被拒绝，就绪后才放行", () => {
    const { controller } = makeController();
    expect(controller.requestInstall()).toMatchObject({ started: false });
    controller.requestCheck();
    controller.checkFoundUpdate("0.4.0");
    controller.downloadStarted("0.4.0");
    controller.downloadFinished("0.4.0");
    expect(controller.requestInstall().started).toBe(true);
  });

  it("未变化的状态不重复广播", () => {
    const { controller, seen } = makeController();
    controller.checkNoUpdate("0.3.0"); // 没有 checking，直接忽略
    expect(seen).toEqual([]);
    controller.requestCheck();
    controller.checkNoUpdate("0.3.0");
    expect(seen).toEqual(["checking", "not-available"]);
  });
});

describe("UpdateController subscribe", () => {
  it("退订后不再收到广播", () => {
    const controller = new UpdateController("background");
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    unsubscribe();
    controller.requestCheck();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("startAppUpdater", () => {
  function makeRunner(): UpdateRunner & { fireNotAvailable(version: string): void } {
    let onNotAvailableListener: ((version: string) => void) | null = null;
    return {
      checkForUpdates: vi.fn(() => new Promise(() => undefined)),
      download: vi.fn(() => new Promise(() => undefined)),
      quitAndInstall: vi.fn(),
      onChecking: () => undefined,
      onAvailable: () => undefined,
      onNotAvailable: (listener) => {
        onNotAvailableListener = listener;
      },
      onProgress: () => undefined,
      onDownloaded: () => undefined,
      onError: () => undefined,
      fireNotAvailable(version: string) {
        onNotAvailableListener?.(version);
      }
    };
  }

  it("启动延迟后真正调用 runner 检查（回归：旧版只切状态不发请求）", async () => {
    vi.useFakeTimers();
    try {
      const runner = makeRunner();
      const controller = startAppUpdater({
        isDev: false,
        env: {},
        autoUpdateCheckEnabled: true,
        runner,
        startupCheckDelayMs: 1000
      });
      expect(runner.checkForUpdates).not.toHaveBeenCalled();
      expect(controller.getState().phase).toBe("idle");

      await vi.advanceTimersByTimeAsync(1000);
      expect(runner.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(controller.getState().phase).toBe("checking");

      runner.fireNotAvailable("0.3.0");
      expect(controller.getState().phase).toBe("not-available");
    } finally {
      vi.useRealTimers();
    }
  });

  it("绿色版 / 关闭自动检查时不调度启动检查", async () => {
    vi.useFakeTimers();
    try {
      const portableRunner = makeRunner();
      startAppUpdater({
        isDev: false,
        env: { PORTABLE_EXECUTABLE_DIR: "D:/x" },
        autoUpdateCheckEnabled: true,
        runner: portableRunner,
        startupCheckDelayMs: 1000
      });
      const disabledRunner = makeRunner();
      startAppUpdater({
        isDev: false,
        env: {},
        autoUpdateCheckEnabled: false,
        runner: disabledRunner,
        startupCheckDelayMs: 1000
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(portableRunner.checkForUpdates).not.toHaveBeenCalled();
      expect(disabledRunner.checkForUpdates).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("检查请求悬挂时超时 reject 中文文案，且归类为网络错误", async () => {
    vi.useFakeTimers();
    try {
      const { withCheckTimeout } = await import("../electron/main/app-updater.js");
      const hung = new Promise(() => undefined);
      const guarded = withCheckTimeout(hung, UPDATE_CHECK_TIMEOUT_MS);
      const assertion = expect(guarded).rejects.toThrow("检查更新超时（30 秒）");
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS + 10);
      await assertion;

      // 中文超时文案必须被归类为网络问题，用户才能看到「检查网络」的指引。
      expect(classifyUpdateError("检查更新超时（30 秒），请检查网络后重试")).toBe("UPDATE_NETWORK");
    } finally {
      vi.useRealTimers();
    }
  });
});

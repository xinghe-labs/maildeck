import { BrowserWindow, ipcMain } from "electron";
import * as electronUpdaterNs from "electron-updater";

// electron-updater 是 CJS 包，静态 named import（`import { autoUpdater }`）会被
// ESM 互操作的导出列表校验拒绝（加载即炸，窗口都建不出来）；必须从 default 上解构。
// SAFETY: d.ts 只声明了 ESM named exports，没有 default；但 CJS 互操作保证运行时
// `import * as ns` 的 ns.default === module.exports，其上的 autoUpdater 就是 AppUpdater 实例。
// 注意两点：不能在模块顶层访问 autoUpdater（getter 首次访问就要 electron app，
// vitest/纯 node 里导入本模块会直接炸）；也不能用 require（主进程是 ESM，没有 require）。
let cachedAutoUpdater: electronUpdaterNs.AppUpdater | null = null;
function getAutoUpdater(): electronUpdaterNs.AppUpdater {
  if (!cachedAutoUpdater) {
    // SAFETY: CJS 互操作在运行时给 namespace 挂上 default（= module.exports），类型层看不见，
    // 只能经 unknown 中转；autoUpdater 的实际类型沿 d.ts 的 AppUpdater 保留。
    const mod = (electronUpdaterNs as unknown as { default?: typeof electronUpdaterNs }).default ?? electronUpdaterNs;
    cachedAutoUpdater = mod.autoUpdater;
  }
  return cachedAutoUpdater;
}
import {
  IPC_CHANNELS,
  IPC_EVENT_CHANNELS,
  IPC_REQUEST_SCHEMAS,
  type UpdateStateEvent
} from "../shared/ipc-contracts.js";
import { handleValidated, sendValidatedEvent } from "./validated-ipc.js";
import { UpdateController, isPortableRuntime, resolveUpdateMode } from "./update-controller.js";

function broadcastUpdateState(state: UpdateStateEvent) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      // 窗口销毁竞态留给 try：isDestroyed 和 send 之间仍有微小窗口期。
      try {
        sendValidatedEvent(window.webContents, IPC_EVENT_CHANNELS.updateState, state);
      } catch {
        // 单个窗口广播失败不影响其它窗口。
      }
    }
  }
}

export interface UpdateRunner {
  checkForUpdates(): Promise<unknown>;
  download(): Promise<unknown>;
  quitAndInstall(): void;
  onChecking(listener: () => void): void;
  onAvailable(listener: (version: string) => void): void;
  onNotAvailable(listener: (currentVersion: string) => void): void;
  onProgress(listener: (progress: UpdateProgressView) => void): void;
  onDownloaded(listener: (version: string) => void): void;
  onError(listener: (rawMessage: string) => void): void;
}

export interface UpdateProgressView {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

/** 检查请求很小，30 秒足够；网络被墙时不能让 UI 永远停在「正在检查更新…」。 */
export const UPDATE_CHECK_TIMEOUT_MS = 30_000;

export function withCheckTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`检查更新超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络后重试`)),
      timeoutMs
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function createElectronUpdaterRunner(): UpdateRunner {
  const autoUpdater = getAutoUpdater();
  // 关掉 autoDownload：下载时机由状态机在 available 后显式发起，行为可测试。
  autoUpdater.autoDownload = false;
  // 用户即使忽略提示，退出时也会静默装新版本，避免永远停在旧版。
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  return {
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    download: () => autoUpdater.downloadUpdate(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    onChecking: (listener) => autoUpdater.on("checking-for-update", () => listener()),
    onAvailable: (listener) =>
      autoUpdater.on("update-available", (info) => listener(readVersion(info))),
    onNotAvailable: (listener) =>
      autoUpdater.on("update-not-available", (info) => listener(readVersion(info))),
    onProgress: (listener) =>
      autoUpdater.on("download-progress", (progress) =>
        listener({
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond
        })
      ),
    onDownloaded: (listener) =>
      autoUpdater.on("update-downloaded", (info) => listener(readVersion(info))),
    onError: (listener) => autoUpdater.on("error", (error: Error) => listener(error?.message ?? String(error)))
  };
}

function readVersion(info: unknown): string {
  const version = (info as { version?: unknown } | null)?.version;
  return typeof version === "string" && version.trim() ? version.trim() : "未知版本";
}

function registerUpdateIpc(controller: UpdateController, runner: UpdateRunner) {
  // 测试里可能对同一进程多次调用 startAppUpdater，重复注册会抛
  // "Attempted to register a second handler"，先摘旧的再挂新的。
  for (const channel of [IPC_CHANNELS.updateGetState, IPC_CHANNELS.updateCheck, IPC_CHANNELS.updateInstall]) {
    ipcMain.removeHandler(channel);
  }
  handleValidated(IPC_CHANNELS.updateGetState, IPC_REQUEST_SCHEMAS.updateGetState, () => controller.getState());
  handleValidated(IPC_CHANNELS.updateCheck, IPC_REQUEST_SCHEMAS.updateCheck, async () => {
    const state = controller.requestCheck();
    if (state.phase === "checking") {
      try {
        await withCheckTimeout(runner.checkForUpdates(), UPDATE_CHECK_TIMEOUT_MS);
      } catch (error) {
        // error 事件监听也会收到这次失败，这里只是同步兜底，保证 invoke 返回终态。
        controller.checkFailed(error instanceof Error ? error.message : String(error));
      }
    }
    return controller.getState();
  });
  handleValidated(IPC_CHANNELS.updateInstall, IPC_REQUEST_SCHEMAS.updateInstall, () => {
    const decision = controller.requestInstall();
    if (decision.started) {
      // 先应答 IPC 再退出：同步 quitAndInstall 会让渲染层拿不到返回值。
      setTimeout(() => runner.quitAndInstall(), 0);
    }
    return { started: decision.started, state: decision.state };
  });
}

/**
 * 启动应用内更新器并返回控制器。职责边界：
 * - electron-updater 只负责网络与安装（在 runner 适配层）；
 * - 状态收敛与准入判断全部走 UpdateController；
 * - 模式判定（dev/绿色版/设置开关）在这里完成，调用方只传环境与设置。
 */
export function startAppUpdater(options: {
  isDev: boolean;
  env?: NodeJS.ProcessEnv;
  autoUpdateCheckEnabled: boolean;
  /** 供测试注入假 updater；生产路径走 electron-updater 单例。 */
  runner?: UpdateRunner;
  /** 启动自动检查延迟；传 null 禁用（测试用）。默认 8 秒。 */
  startupCheckDelayMs?: number | null;
}): UpdateController {
  const env = options.env ?? process.env;
  const mode = resolveUpdateMode({
    isDev: options.isDev,
    isPortable: isPortableRuntime(env),
    autoUpdateCheckEnabled: options.autoUpdateCheckEnabled
  });
  const controller = new UpdateController(mode);
  controller.subscribe(broadcastUpdateState);

  if (mode === "disabled-dev") {
    // 开发模式不注册 IPC，也不启动 updater；更不调度自动检查。
    return controller;
  }

  const runner = options.runner ?? createElectronUpdaterRunner();
  runner.onChecking(() => {
    // electron-updater 发出 checking 说明一次新的检查真正开始了；
    // requestCheck 里对重复 checking 幂等，这里直接推进状态机。
    if (controller.getState().phase !== "checking") {
      controller.requestCheck();
    }
  });
  runner.onAvailable((version) => {
    controller.checkFoundUpdate(version);
    controller.downloadStarted(version);
    void runner.download().catch((error: unknown) => {
      controller.downloadFailed(error instanceof Error ? error.message : String(error));
    });
  });
  runner.onNotAvailable((version) => controller.checkNoUpdate(version));
  runner.onProgress((progress) => controller.downloadProgress(progress));
  runner.onDownloaded((version) => controller.downloadFinished(version));
  runner.onError((rawMessage) => {
    if (controller.getState().phase === "downloading") {
      controller.downloadFailed(rawMessage);
    } else {
      controller.checkFailed(rawMessage);
    }
  });

  registerUpdateIpc(controller, runner);
  scheduleStartupCheck(controller, runner, options.startupCheckDelayMs ?? 8_000);
  return controller;
}
/**
 * 启动延迟后自动检查一次（仅 background 模式）。此前版本的 bug：只把状态机切到
 * checking 而从没调用 runner，导致 UI 永远停在「正在检查更新…」——检查请求必须
 * 真正发出去；超时由 IPC 路径的 withCheckTimeout 兜底，这里只需处理 reject。
 */
function scheduleStartupCheck(controller: UpdateController, runner: UpdateRunner, delayMs: number): void {
  if (controller.getMode() !== "background" || !(delayMs >= 0)) {
    return;
  }
  const timer = setTimeout(() => {
    const state = controller.requestCheck();
    if (state.phase === "checking") {
      runner
        .checkForUpdates()
        .catch((error: unknown) => {
          controller.checkFailed(error instanceof Error ? error.message : String(error));
        });
    }
  }, delayMs);
  // 应用若在延迟期内退出，别让这个 timer 拖住进程。
  timer.unref?.();
}

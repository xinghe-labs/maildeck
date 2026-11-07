import type { UpdateErrorCode, UpdatePhase, UpdateStateEvent } from "../shared/ipc-contracts.js";

/**
 * 更新器运行模式：
 * - background：随启动自动检查，发现新版本自动下载（NSIS 安装版）。
 * - manual：不自动检查，用户在设置里手动点「检查更新」（关闭了自动检查开关）。
 * - disabled-portable：绿色版无法自更新（electron-updater 不支持 portable 目标），
 *   只能引导去 Releases 页手动下载。
 * - disabled-dev：开发模式不接更新器，避免打扰与误装。
 */
export type UpdateMode = "background" | "manual" | "disabled-portable" | "disabled-dev";

export function resolveUpdateMode(options: {
  isDev: boolean;
  isPortable: boolean;
  autoUpdateCheckEnabled: boolean;
}): UpdateMode {
  if (options.isDev) {
    return "disabled-dev";
  }
  if (options.isPortable) {
    return "disabled-portable";
  }
  return options.autoUpdateCheckEnabled ? "background" : "manual";
}

export function isPortableRuntime(env: NodeJS.ProcessEnv): boolean {
  // electron-builder 的 portable 目标启动时会注入这三个变量。
  return env.PORTABLE_EXECUTABLE_DIR !== undefined || env.PORTABLE_EXECUTABLE_FILE !== undefined;
}

/** 把底层报错归成少数几个用户能看懂的码，文案在渲染层按码展示细节。 */
export function classifyUpdateError(rawMessage: string): UpdateErrorCode {
  const message = rawMessage.toLowerCase();
  const networkHints = [
    "enotfound",
    "eai_again",
    "econnrefused",
    "econnreset",
    "etimedout",
    "timeout",
    "超时",
    "enetdown",
    "enetunreach",
    "net::err_",
    "getaddrinfo",
    "certificate",
    "self signed",
    "socket hang up"
  ];
  return networkHints.some((hint) => message.includes(hint)) ? "UPDATE_NETWORK" : "UPDATE_CHECK_FAILED";
}

export interface UpdateDownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export const RELEASES_URL = "https://github.com/xinghe-labs/maildeck/releases/latest";

type Listener = (state: UpdateStateEvent) => void;

/**
 * 更新状态机。electron-updater 的事件是碎片化的（checking/available/progress/…），
 * 这里收敛成单一 state 快照并只在变化时对外广播；顺序错乱的事件（如下载中途又来
 * available）按状态机规则丢弃，渲染层不需要自己防抖。
 */
export class UpdateController {
  private state: UpdateStateEvent = { phase: "idle" satisfies UpdatePhase };
  private readonly listeners = new Set<Listener>();

  constructor(private readonly mode: UpdateMode) {
    if (mode === "disabled-portable") {
      this.state = { phase: "unsupported", reason: "portable", releaseUrl: RELEASES_URL };
    }
  }

  getMode(): UpdateMode {
    return this.mode;
  }

  getState(): UpdateStateEvent {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private transition(next: UpdateStateEvent) {
    if (sameState(this.state, next)) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  /** 发起检查。返回处理后的最新状态，供 IPC invoke 直接回给发起方。 */
  requestCheck(): UpdateStateEvent {
    if (this.mode === "disabled-dev") {
      return this.state;
    }
    if (this.mode === "disabled-portable") {
      // 重新赋值一次 releaseUrl，防住未来 state 被别处改掉的意外。
      this.transition({ phase: "unsupported", reason: "portable", releaseUrl: RELEASES_URL });
      return this.state;
    }
    if (this.state.phase === "checking") {
      return this.state;
    }
    // 已下载完成后允许重新检查（用户想看有没有更新的版本），但要清掉旧版本的
    // downloaded 状态：安装器只认最后一次下载的结果。
    this.transition({ phase: "checking" });
    return this.state;
  }

  checkFoundUpdate(version: string) {
    if (this.state.phase !== "checking") {
      return;
    }
    this.transition({ phase: "available", version, releaseUrl: RELEASES_URL });
  }

  checkNoUpdate(currentVersion: string) {
    if (this.state.phase !== "checking") {
      return;
    }
    this.transition({ phase: "not-available", version: currentVersion });
  }

  /** 发现新版本后开始下载；available → downloading 由主进程在拿到 runner 后触发。 */
  downloadStarted(version: string) {
    if (this.state.phase !== "available") {
      return;
    }
    this.transition({ phase: "downloading", version, percent: 0, transferredBytes: 0, totalBytes: 0, bytesPerSecond: 0 });
  }

  downloadProgress(progress: UpdateDownloadProgress) {
    if (this.state.phase !== "downloading") {
      return;
    }
    this.transition({
      phase: "downloading",
      version: this.state.version,
      percent: clampPercent(progress.percent),
      transferredBytes: Math.max(0, Math.round(progress.transferred)),
      totalBytes: Math.max(0, Math.round(progress.total)),
      bytesPerSecond: Math.max(0, Math.round(progress.bytesPerSecond))
    });
  }

  downloadFinished(version: string) {
    if (this.state.phase !== "downloading") {
      return;
    }
    this.transition({ phase: "downloaded", version, releaseUrl: RELEASES_URL });
  }

  checkFailed(rawMessage: string) {
    this.transition({
      phase: "error",
      code: classifyUpdateError(rawMessage),
      message: truncateMessage(rawMessage)
    });
  }

  downloadFailed(rawMessage: string) {
    // 下载失败回到 error 态但保留「去 Releases 手动下载」的出口。
    this.transition({
      phase: "error",
      code: "UPDATE_DOWNLOAD_FAILED",
      message: truncateMessage(rawMessage),
      releaseUrl: RELEASES_URL
    });
  }

  /** 用户点「重启更新」。只有在已下载完成时才允许真正退出并安装。 */
  requestInstall(): { started: boolean; state: UpdateStateEvent } {
    if (this.state.phase !== "downloaded") {
      return { started: false, state: this.state };
    }
    return { started: true, state: this.state };
  }
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function truncateMessage(message: string) {
  const trimmed = message.trim();
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}

function sameState(left: UpdateStateEvent, right: UpdateStateEvent) {
  return JSON.stringify(left) === JSON.stringify(right);
}

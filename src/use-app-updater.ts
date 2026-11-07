import { useCallback, useEffect, useState } from "react";
import { getDesktopApi } from "./desktop-api";
import type { UpdateStateEvent } from "./types";

/**
 * 应用内更新的渲染层状态。只在 bridge 可用时工作；主进程处于 dev / 绿色版模式时
 * state 会停在 idle / unsupported，设置页据此渲染对应文案。
 */
export function useAppUpdater() {
  const [state, setState] = useState<UpdateStateEvent>({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const api = getDesktopApi();
    // 老版本 preload / 测试桩可能没有 update 段：缺了就当不支持，UI 隐藏入口。
    if (!api?.update || typeof api.update.getState !== "function") {
      setSupported(false);
      return;
    }
    let active = true;
    api.update
      .getState()
      .then((initial) => {
        if (active) {
          setState(initial);
        }
      })
      .catch(() => {
        if (active) {
          setSupported(false);
        }
      });
    const unsubscribe = api.update.onState((event) => {
      if (active) {
        setState(event);
      }
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const check = useCallback(async () => {
    const api = getDesktopApi();
    if (!api?.update || busy) {
      return;
    }
    setBusy(true);
    try {
      setState(await api.update.check());
    } catch {
      // 状态机会通过事件广播 error 态；这里不再叠加本地错误，避免双份提示。
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const install = useCallback(async () => {
    const api = getDesktopApi();
    if (!api?.update || busy) {
      return;
    }
    setBusy(true);
    try {
      const result = await api.update.install();
      if (!result.started) {
        // 未处于 downloaded 态时主进程拒绝安装，同步本地状态保持一致。
        setState(result.state);
      }
    } finally {
      setBusy(false);
    }
  }, [busy]);

  return { state, busy, supported, check, install };
}

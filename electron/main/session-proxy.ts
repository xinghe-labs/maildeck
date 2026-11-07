import { session } from "electron";

/**
 * 把用户在设置里配的应用内代理同步给 Chromium 默认 session（P1-1）。
 *
 * electron-updater 走 Electron net 栈，只看默认 session 的代理解析，不认
 * Graph 请求用的 undici per-request dispatcher；不设这里，直连 GitHub 的
 * 机器上更新检查会一直挂在网络上（手动检查有 30s 超时兜底，但结果永远是
 * 超时，等于功能不可用）。
 *
 * 未配置代理时不碰 session：保持 Chromium 默认的系统代理解析行为不变，
 * 避免影响无代理用户的现有网络路径。
 */
export async function applySessionProxy(proxyUrl: string): Promise<void> {
  const rules = proxyUrl.trim();
  if (!rules) {
    return;
  }
  await session.defaultSession.setProxy({ proxyRules: rules });
}

import { ProxyAgent } from "undici";

// undici 的 ProxyAgent 自带 keep-alive 连接池。每次请求都 new 一个会泄漏 socket，
// 批量刷新成百上千次请求时尤其严重。这里按 proxyUrl 缓存复用同一实例，
// 代理设置变更时再统一关闭旧实例。
const dispatchers = new Map<string, ProxyAgent>();

function getDispatcher(proxyUrl: string): ProxyAgent {
  let dispatcher = dispatchers.get(proxyUrl);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(proxyUrl);
    dispatchers.set(proxyUrl, dispatcher);
  }

  return dispatcher;
}

export function proxiedFetchOptions(init: RequestInit, proxyUrl = ""): RequestInit {
  if (!proxyUrl) {
    return init;
  }

  return {
    ...init,
    dispatcher: getDispatcher(proxyUrl)
  } as RequestInit;
}

export function closeProxyDispatchers() {
  for (const dispatcher of dispatchers.values()) {
    dispatcher.close().catch(() => undefined);
  }

  dispatchers.clear();
}

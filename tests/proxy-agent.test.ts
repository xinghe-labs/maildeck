import { afterEach, describe, expect, it } from "vitest";
import { closeProxyDispatchers, proxiedFetchOptions } from "../electron/main/proxy-agent.js";

interface DispatcherCarrier {
  dispatcher?: { close: () => Promise<void> };
}

function dispatcherOf(init: RequestInit) {
  return (init as DispatcherCarrier).dispatcher;
}

function requireDispatcher(init: RequestInit) {
  const dispatcher = dispatcherOf(init);
  if (!dispatcher) {
    throw new Error("expected proxiedFetchOptions to attach a dispatcher");
  }
  return dispatcher;
}

// `close` lives on ProxyAgent.prototype, so vi.spyOn would install one shared spy
// for every instance. An own property keeps the call count per dispatcher.
function trackClose(dispatcher: { close: () => Promise<void> }) {
  const calls = { count: 0 };
  Object.defineProperty(dispatcher, "close", {
    configurable: true,
    writable: true,
    value: () => {
      calls.count += 1;
      return Promise.resolve();
    }
  });
  return calls;
}

afterEach(() => {
  // The dispatcher cache is module state; every test starts from a cold cache.
  closeProxyDispatchers();
});

describe("proxy dispatcher reuse", () => {
  it("returns the caller's request untouched when no proxy is configured", () => {
    const init: RequestInit = { method: "GET" };

    expect(proxiedFetchOptions(init)).toBe(init);
    expect(proxiedFetchOptions(init, "")).toBe(init);
    expect(dispatcherOf(proxiedFetchOptions(init, ""))).toBeUndefined();
  });

  it("preserves request options while attaching a dispatcher", () => {
    const init: RequestInit = { method: "POST", headers: { Authorization: "Bearer token" } };
    const proxied = proxiedFetchOptions(init, "http://127.0.0.1:7890");

    expect(proxied).not.toBe(init);
    expect(proxied.method).toBe("POST");
    expect(proxied.headers).toEqual({ Authorization: "Bearer token" });
    expect(dispatcherOf(proxied)).toBeDefined();
  });

  it("shares one dispatcher across requests that use the same proxy", () => {
    const first = requireDispatcher(proxiedFetchOptions({}, "http://127.0.0.1:7890"));
    const second = requireDispatcher(proxiedFetchOptions({}, "http://127.0.0.1:7890"));

    // Reusing the agent keeps undici's keep-alive socket pool; creating a new
    // ProxyAgent per request leaks sockets across a large batch refresh.
    expect(second).toBe(first);
  });

  it("keeps a separate dispatcher per proxy URL", () => {
    const first = requireDispatcher(proxiedFetchOptions({}, "http://127.0.0.1:7890"));
    const second = requireDispatcher(proxiedFetchOptions({}, "http://127.0.0.1:7891"));

    expect(second).not.toBe(first);
  });

  it("closes every cached dispatcher and rebuilds instead of reusing a closed one", async () => {
    const first = requireDispatcher(proxiedFetchOptions({}, "http://127.0.0.1:7890"));
    const second = requireDispatcher(proxiedFetchOptions({}, "http://127.0.0.1:7891"));
    const firstClose = trackClose(first);
    const secondClose = trackClose(second);

    closeProxyDispatchers();
    await Promise.resolve();

    expect(firstClose.count).toBe(1);
    expect(secondClose.count).toBe(1);

    const rebuilt = requireDispatcher(proxiedFetchOptions({}, "http://127.0.0.1:7890"));
    expect(rebuilt).not.toBe(first);
  });

  it("is safe to close when nothing has been cached", () => {
    expect(() => closeProxyDispatchers()).not.toThrow();
    expect(() => closeProxyDispatchers()).not.toThrow();
  });
});

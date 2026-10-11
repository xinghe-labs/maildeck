import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStrictModeSessionHolder } from "../src/strict-mode-session-holder";

function createSession() {
  const listeners = new Set<() => void>();
  const session = {
    disposed: 0,
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    dispose: vi.fn(() => {
      session.disposed += 1;
    }),
    listenerCount: () => listeners.size
  };
  return session;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("strict mode session holder", () => {
  it("forwards subscriptions to the underlying session", () => {
    const session = createSession();
    const holder = createStrictModeSessionHolder(session);
    const listener = () => undefined;

    const unsubscribe = holder.subscribe(listener);

    expect(session.subscribe).toHaveBeenCalledWith(listener);
    expect(session.listenerCount()).toBe(1);

    unsubscribe();
    expect(session.listenerCount()).toBe(0);
  });

  it("defers disposal until after the last listener leaves", () => {
    const session = createSession();
    const holder = createStrictModeSessionHolder(session);

    const first = holder.subscribe(() => undefined);
    const second = holder.subscribe(() => undefined);

    first();
    expect(session.disposed).toBe(0);

    second();
    // Disposal is deferred so React StrictMode's development-only cleanup replay
    // does not tear the session down between its two mount passes.
    expect(session.disposed).toBe(0);

    vi.runAllTimers();
    expect(session.disposed).toBe(1);
  });

  it("cancels a pending disposal when StrictMode resubscribes immediately", () => {
    const session = createSession();
    const holder = createStrictModeSessionHolder(session);

    holder.subscribe(() => undefined)();
    holder.subscribe(() => undefined);

    vi.runAllTimers();

    expect(session.disposed).toBe(0);
    expect(session.listenerCount()).toBe(1);
  });

  it("disposes again only after a later teardown", () => {
    const session = createSession();
    const holder = createStrictModeSessionHolder(session);

    holder.subscribe(() => undefined)();
    vi.runAllTimers();
    expect(session.disposed).toBe(1);

    holder.subscribe(() => undefined)();
    vi.runAllTimers();
    expect(session.disposed).toBe(2);
  });

  it("rolls back the subscriber count and disposes when subscribing throws", () => {
    const failure = new Error("listener registration failed");
    const session = {
      disposed: 0,
      subscribe: vi.fn(() => {
        throw failure;
      }),
      dispose: vi.fn(() => {
        session.disposed += 1;
      })
    };
    const holder = createStrictModeSessionHolder(session);

    expect(() => holder.subscribe(() => undefined)).toThrow(failure);
    // The failed attempt must not leave a phantom subscriber behind, otherwise the
    // session would never be disposed.
    expect(session.disposed).toBe(1);
  });

  it("ignores a repeated unsubscribe", () => {
    const session = createSession();
    const holder = createStrictModeSessionHolder(session);
    const unsubscribe = holder.subscribe(() => undefined);

    unsubscribe();
    unsubscribe();

    vi.runAllTimers();
    expect(session.disposed).toBe(1);
    expect(session.listenerCount()).toBe(0);
  });

  it("keeps the session alive while another listener remains", () => {
    const session = createSession();
    const holder = createStrictModeSessionHolder(session);
    const first = holder.subscribe(() => undefined);
    holder.subscribe(() => undefined);

    first();
    vi.runAllTimers();

    expect(session.disposed).toBe(0);
  });
});

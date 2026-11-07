/** @vitest-environment jsdom */

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "../src/components/SettingsModal";
import type { AppSettings, AppSettingsUpdate, MailCacheStats } from "../src/types";

type SettingsUpdate = (settings: AppSettingsUpdate) => Promise<AppSettings>;

interface DesktopApiStub {
  settings: { update: SettingsUpdate };
  mail: {
    cacheStats: () => Promise<MailCacheStats>;
    clearCache: (accountId?: string) => Promise<void>;
  };
}

function cacheStats(overrides: Partial<MailCacheStats> = {}): MailCacheStats {
  return { accountCount: 1, messageCount: 12, bodyCount: 3, approximateBytes: 1536, ...overrides };
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    cacheMessages: true,
    cacheBodies: true,
    proxyUrl: "",
    proxyUsername: "",
    proxyHasPassword: false,
    proxySupported: true,
    batchConcurrency: 4,
    hotmailFallbackEnabled: true,
    autoRefreshEnabled: false,
    autoRefreshIntervalMinutes: 10,
    ...overrides
  };
}

function setDesktopApi(update: SettingsUpdate | undefined, mail?: DesktopApiStub["mail"]) {
  // `window.maildeck` is declared non-optional for the packaged app; tests
  // install or remove it to cover both the Electron and browser-only paths.
  (window as unknown as { maildeck?: DesktopApiStub }).maildeck = update
    ? {
        settings: { update },
        // 默认给一份可用桩：缓存行会主动读统计，缺方法会让整个弹窗报错。
        mail: mail ?? { cacheStats: async () => cacheStats(), clearCache: async () => undefined }
      }
    : undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  setDesktopApi(undefined);
});

function renderModal(
  props: Partial<ComponentProps<typeof SettingsModal>> = {},
  initial: AppSettings = settings()
) {
  const handlers = { onClose: vi.fn(), onSaved: vi.fn() };
  const merged = { settings: initial, ...handlers, ...props };

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(SettingsModal, merged));
  });

  return { ...handlers, ...props };
}

function queryProxyUrlInput() {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="http://127.0.0.1:7890"]');
  if (!input) {
    throw new Error("proxy url input not rendered");
  }
  return input;
}

function queryProxyUsernameInput() {
  const input = container.querySelector<HTMLInputElement>('input[autocomplete="username"]');
  if (!input) {
    throw new Error("proxy username input not rendered");
  }
  return input;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function submitForm() {
  const form = container.querySelector("form");
  if (!form) {
    throw new Error("settings form not rendered");
  }
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function flushSubmit() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function errorText() {
  // Two boxes can be present at once: the live protocol warning and the submit error.
  return Array.from(container.querySelectorAll(".error-box"))
    .map((box) => box.textContent ?? "")
    .join(" | ");
}

describe("SettingsModal", () => {
  it("explains that settings need the desktop bridge when it is missing", async () => {
    renderModal();

    submitForm();
    await flushSubmit();

    expect(errorText()).toContain("设置需要在 Electron 桌面应用中使用。");
  });

  it("refuses a non-HTTP proxy URL before calling the main process", async () => {
    const update = vi.fn<SettingsUpdate>(async (next) => settings(next));
    setDesktopApi(update);
    renderModal();

    act(() => setInputValue(queryProxyUrlInput(), "socks5://127.0.0.1:1080"));
    expect(container.textContent).toContain("当前代理协议不受支持");

    submitForm();
    await flushSubmit();

    expect(update).not.toHaveBeenCalled();
    expect(errorText()).toContain("代理仅支持 HTTP 或 HTTPS。请修改代理地址，或清空后使用直连。");
  });

  it("trims the proxy endpoint and reports the saved settings", async () => {
    const saved = settings({ proxyUrl: "http://127.0.0.1:7890", proxyUsername: "user" });
    const update = vi.fn<SettingsUpdate>(async () => saved);
    setDesktopApi(update);
    const handlers = renderModal();

    act(() => setInputValue(queryProxyUrlInput(), "  http://127.0.0.1:7890  "));
    act(() => setInputValue(queryProxyUsernameInput(), "  user  "));

    submitForm();
    await flushSubmit();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      proxyUrl: "http://127.0.0.1:7890",
      proxyUsername: "user",
      batchConcurrency: 4
    });
    expect(handlers.onSaved).toHaveBeenCalledWith(saved);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("drops proxy credentials when the proxy address is cleared", async () => {
    const update = vi.fn<SettingsUpdate>(async () => settings());
    setDesktopApi(update);
    renderModal({}, settings({ proxyUrl: "http://127.0.0.1:7890", proxyUsername: "user" }));

    act(() => setInputValue(queryProxyUrlInput(), ""));
    submitForm();
    await flushSubmit();

    expect(update.mock.calls[0]?.[0]).toMatchObject({
      proxyUrl: "",
      proxyUsername: "",
      proxyPassword: "",
      clearProxyPassword: false
    });
  });

  it("surfaces a save failure and stays open", async () => {
    const update = vi.fn<SettingsUpdate>(async () => {
      throw new Error("proxy unreachable");
    });
    setDesktopApi(update);
    const handlers = renderModal();

    submitForm();
    await flushSubmit();

    expect(errorText()).toContain("proxy unreachable");
    expect(handlers.onSaved).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("offers to clear a stored proxy password only when one exists", () => {
    renderModal();
    expect(container.textContent).not.toContain("清除已保存的代理密码");

    act(() => root.unmount());
    renderModal({}, settings({ proxyHasPassword: true }));
    expect(container.textContent).toContain("清除已保存的代理密码");
  });

  it("disables the proxy identity fields until an endpoint is present", () => {
    renderModal();

    expect(queryProxyUsernameInput().disabled).toBe(true);

    act(() => setInputValue(queryProxyUrlInput(), "http://127.0.0.1:7890"));
    expect(queryProxyUsernameInput().disabled).toBe(false);
  });

  it("closes without saving when cancelled", () => {
    const update = vi.fn<SettingsUpdate>(async () => settings());
    setDesktopApi(update);
    const handlers = renderModal();

    // 按文案找“取消”：footer 里还有哪个 secondary 按钮不该成为这个断言的偶发依赖。
    const cancel = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "取消"
    );
    act(() => cancel?.click());

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("shows how much cache is on disk and clears it on demand", async () => {
    let stats = cacheStats({ messageCount: 40, bodyCount: 9, approximateBytes: 2 * 1024 * 1024 });
    const clearCache = vi.fn(async () => {
      stats = cacheStats({ messageCount: 0, bodyCount: 0, approximateBytes: 0 });
    });
    setDesktopApi(vi.fn<SettingsUpdate>(async () => settings()), {
      cacheStats: async () => stats,
      clearCache
    });
    renderModal();
    await flushSubmit();

    // 关掉缓存开关之前，用户得先能看到到底占了多少（P6）。
    expect(container.textContent).toContain("缓存占用：2.0 MB（邮件 40 条 · 正文 9 封 · 1 个账号）");

    const clearButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "清空邮件缓存"
    );
    expect(clearButton).toBeTruthy();
    await act(async () => {
      clearButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("缓存占用：0 B（邮件 0 条 · 正文 0 封 · 1 个账号）");
    expect(container.textContent).toContain("邮件缓存已清空");
  });
});

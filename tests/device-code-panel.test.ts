/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DeviceCodePanel } from "../src/components/DeviceCodePanel";
import type { DeviceCodeStateEvent } from "../electron/shared/ipc-contracts";

let container: HTMLDivElement;
let root: Root;
let listeners: Array<(event: DeviceCodeStateEvent) => void>;
let unsubscribed: boolean;

const startDeviceCode = vi.fn();
const cancelDeviceCode = vi.fn();
const openExternal = vi.fn();

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  listeners = [];
  unsubscribed = false;
  vi.clearAllMocks();
});

function installBridge() {
  listeners = [];
  unsubscribed = false;
  startDeviceCode.mockResolvedValue({
    userCode: "ABCD-1234",
    verificationUri: "https://microsoft.com/devicelogin",
    expiresInSec: 900,
    clientId: "client-1"
  });
  cancelDeviceCode.mockResolvedValue({ canceled: true });
  openExternal.mockResolvedValue({ opened: true });

  Object.defineProperty(window, "maildeck", {
    configurable: true,
    value: {
      auth: {
        startDeviceCode,
        cancelDeviceCode,
        onDeviceCodeState: (callback: (event: DeviceCodeStateEvent) => void) => {
          listeners.push(callback);
          return () => {
            unsubscribed = true;
            listeners = listeners.filter((entry) => entry !== callback);
          };
        }
      },
      app: { openExternal }
    }
  });
}

async function render(onAuthorized = vi.fn()) {
  installBridge();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(DeviceCodePanel, { onAuthorized }));
  });
  return onAuthorized;
}

async function clickByText(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((element) =>
    element.textContent?.includes(text)
  );
  expect(button, `找不到按钮：${text}`).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function emit(event: DeviceCodeStateEvent) {
  await act(async () => {
    for (const listener of listeners) {
      listener(event);
    }
  });
}

describe("DeviceCodePanel", () => {
  it("默认只给一个登录入口，不显示短码", async () => {
    await render();
    expect(container.textContent).toContain("用微软账号登录，自动获取 token");
    expect(container.querySelector(".device-code-value")).toBeNull();
  });

  it("点击登录后展示短码、登录页和倒计时", async () => {
    await render();
    await clickByText("用微软账号登录");

    expect(startDeviceCode).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".device-code-value")?.textContent).toBe("ABCD-1234");
    expect(container.querySelector(".device-code-url")?.textContent).toBe("https://microsoft.com/devicelogin");
    expect(container.textContent).toContain("等待你在浏览器完成登录");
    expect(container.textContent).toContain("15:00");
  });

  it("授权成功后把 clientId / refresh_token / 邮箱回传给表单", async () => {
    const onAuthorized = await render();
    await clickByText("用微软账号登录");

    await emit({
      phase: "authorized",
      clientId: "client-1",
      refreshToken: "M.Cxxx",
      email: "user@hotmail.com",
      scope: "Mail.Read"
    });

    expect(onAuthorized).toHaveBeenCalledWith({
      clientId: "client-1",
      refreshToken: "M.Cxxx",
      email: "user@hotmail.com"
    });
    expect(container.textContent).toContain("已登录：user@hotmail.com");
  });

  it("拿不到邮箱时也能成功回填，只是不显示地址", async () => {
    const onAuthorized = await render();
    await clickByText("用微软账号登录");
    await emit({ phase: "authorized", clientId: "client-1", refreshToken: "M.Cxxx", email: null, scope: "" });

    expect(onAuthorized).toHaveBeenCalledWith({ clientId: "client-1", refreshToken: "M.Cxxx", email: null });
    expect(container.textContent).toContain("已拿到 token");
  });

  it("失败时显示原因并允许重来", async () => {
    await render();
    await clickByText("用微软账号登录");
    await emit({ phase: "failed", code: "DEVICE_CODE_EXPIRED", message: "登录代码已过期，请重新获取。" });

    expect(container.textContent).toContain("登录代码已过期，请重新获取。");
    await clickByText("重新登录");
    expect(startDeviceCode).toHaveBeenCalledTimes(2);
  });

  it("点取消会通知主进程并回到初始态", async () => {
    await render();
    await clickByText("用微软账号登录");
    await clickByText("取消");

    expect(cancelDeviceCode).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("用微软账号登录，自动获取 token");
  });

  it("点「打开登录页」走主进程的 openExternal", async () => {
    await render();
    await clickByText("用微软账号登录");
    await clickByText("打开登录页");
    expect(openExternal).toHaveBeenCalledWith("https://microsoft.com/devicelogin");
  });

  it("点「注册」打开微软注册页并提示回应用内收尾", async () => {
    await render();
    await clickByText("没有微软账号？注册一个");

    expect(openExternal).toHaveBeenCalledWith("https://signup.live.com/signup?lic=1");
    expect(container.textContent).toContain("回到这里点「用微软账号登录」收尾");
    // 注册入口不影响登录流程本身
    await clickByText("用微软账号登录，自动获取 token");
    expect(startDeviceCode).toHaveBeenCalledTimes(1);
  });

  it("卸载时退订事件，避免窗口关掉后还往死组件里塞状态", async () => {
    await render();
    expect(unsubscribed).toBe(false);
    act(() => root.unmount());
    expect(unsubscribed).toBe(true);
    // 阻止 afterEach 再 unmount 一次
    root = createRoot(document.createElement("div"));
  });
});

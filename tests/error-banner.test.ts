/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ErrorBanner } from "../src/components/ErrorBanner";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function render(props: { message: string; code?: string | null }) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(ErrorBanner, { ...props, code: props.code as never, onDismiss: () => {} }));
  });
  return container;
}

describe("ErrorBanner", () => {
  // 报告 P2-14：用户看到「操作失败，请重试」却没有任何可报给支持的标识。
  it("有错误码时把错误码显示出来", () => {
    const el = render({ message: "操作失败，请重试。", code: "NETWORK_ERROR" });

    expect(el.querySelector(".error-banner-code")?.textContent).toContain("NETWORK_ERROR");
  });

  it("没有错误码时不渲染空行", () => {
    const el = render({ message: "文件导入需要在 Electron 桌面应用中使用。" });

    expect(el.querySelector(".error-banner-code")).toBeNull();
  });

  it("关闭按钮回传 onDismiss", () => {
    const onDismiss = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(ErrorBanner, { message: "失败", onDismiss }));
    });

    act(() => {
      (container.querySelector(".error-banner-close") as HTMLButtonElement).click();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

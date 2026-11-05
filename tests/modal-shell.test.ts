/** @vitest-environment jsdom */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { ModalShell } from "../src/components/ModalShell";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function shell(overrides: Partial<Parameters<typeof ModalShell>[0]> = {}) {
  return createElement(ModalShell, {
    title: "导入账号",
    subtitle: "支持 JSON 文件",
    onClose: vi.fn(),
    children: createElement("input", { placeholder: "搜索" }),
    footer: createElement("button", { type: "button" }, "保存"),
    ...overrides
  });
}

describe("ModalShell", () => {
  it("exposes dialog semantics", () => {
    const element = render(shell());
    const dialog = element.querySelector('[role="dialog"]');

    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog?.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(element.querySelector(`#${labelledBy}`)?.textContent).toBe("导入账号");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(shell({ onClose }));

    act(() => {
      document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked but not when the panel is clicked", () => {
    const onClose = vi.fn();
    const element = render(shell({ onClose }));
    const backdrop = element.querySelector(".modal-backdrop")!;
    const panel = element.querySelector(".modal")!;

    act(() => {
      panel.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      backdrop.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab focus inside the dialog", () => {
    const element = render(shell());
    const focusables = Array.from(
      element.querySelectorAll<HTMLElement>("input, button")
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    act(() => {
      last.focus();
      last.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
      );
    });
    expect(document.activeElement).toBe(first);

    act(() => {
      first.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });
    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the trigger element after closing", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    render(shell());
    act(() => root!.unmount());
    root = null;

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe("ConfirmDialog", () => {
  function confirm(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
    return createElement(ConfirmDialog, {
      title: "删除账号",
      confirmLabel: "删除",
      onConfirm: vi.fn(),
      onClose: vi.fn(),
      children: createElement("p", null, "删除后需重新授权。"),
      ...overrides
    });
  }

  it("focuses the cancel button so Enter cannot destroy data", () => {
    const element = render(confirm());
    const cancel = element.querySelector<HTMLButtonElement>(".secondary-button");
    const danger = element.querySelector<HTMLButtonElement>(".danger-solid");

    expect(cancel).not.toBeNull();
    expect(danger).not.toBeNull();
    expect(document.activeElement).toBe(cancel);
  });

  it("renders the destructive action with the solid danger style", () => {
    const element = render(confirm());
    const danger = element.querySelector<HTMLButtonElement>(".danger-solid");

    expect(danger?.textContent).toContain("删除");
    expect(element.querySelector(".confirm-dialog")).not.toBeNull();
  });

  it("runs the confirm handler and blocks it while busy", () => {
    const onConfirm = vi.fn();
    const element = render(confirm({ onConfirm }));
    const danger = element.querySelector<HTMLButtonElement>(".danger-solid")!;

    act(() => danger.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);

    act(() => root!.unmount());
    root = null;
    const busyElement = render(confirm({ onConfirm: vi.fn(), busy: true }));
    const busyDanger = busyElement.querySelector<HTMLButtonElement>(".danger-solid")!;
    expect(busyDanger.disabled).toBe(true);
  });
});

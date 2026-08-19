/** @vitest-environment jsdom */

import { act, createElement, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ImportModal } from "../src/components/ImportModal";
import type { ImportPreviewResult } from "../src/types";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderImportModal(
  onPreviewImportText: ComponentProps<typeof ImportModal>["onPreviewImportText"]
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(
      StrictMode,
      null,
      createElement(ImportModal, {
        onClose: vi.fn(),
        onImported: vi.fn(),
        onPreviewImportText,
        onImportText: vi.fn(async () => null),
        onUpsert: vi.fn(async () => null)
      })
    ));
  });
}

function changeInput(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ImportModal", () => {
  it("renders a successful preview in StrictMode", async () => {
    renderImportModal(vi.fn(async () => ({
      total: 2,
      valid: 1,
      duplicates: 0,
      invalid: 1,
      errors: ["第 2 行无效"],
      warnings: []
    })));
    const previewButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "预检");

    await act(async () => {
      previewButton!.click();
    });

    expect(container.querySelector(".preview-box")?.textContent).toContain("共 2 行");
    expect(container.querySelector(".preview-box")?.textContent).toContain("第 2 行无效");
    expect(previewButton!.disabled).toBe(false);
  });

  it("renders a rejected preview as an inline error instead of an unhandled rejection", async () => {
    renderImportModal(vi.fn(async () => {
      throw new Error("预检失败");
    }));
    const previewButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "预检");
    expect(previewButton).toBeDefined();

    await act(async () => {
      previewButton!.click();
    });

    expect(container.querySelector(".error-box")?.textContent).toBe("预检失败");
    expect(previewButton!.disabled).toBe(false);
  });

  it("does not display a preview produced for older form input", async () => {
    const preview = deferred<ImportPreviewResult>();
    renderImportModal(vi.fn(() => preview.promise));
    const emailInput = container.querySelector<HTMLInputElement>('input[required]')!;
    const previewButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "预检")!;

    act(() => {
      changeInput(emailInput, "old@example.com");
    });
    act(() => {
      previewButton.click();
    });
    act(() => {
      changeInput(emailInput, "new@example.com");
    });
    await act(async () => {
      preview.resolve({
        total: 1,
        valid: 1,
        duplicates: 0,
        invalid: 0,
        errors: [],
        warnings: []
      });
      await preview.promise;
    });

    expect(container.querySelector(".preview-box")).toBeNull();
    expect(emailInput.value).toBe("new@example.com");
  });
});

/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MailAttachmentListResult, MailMessageDetail, MailMessageSummary } from "../src/types";

vi.mock("../src/mail-content-security", () => ({
  sanitizeMailHtml: (value: string) => value,
  sanitizeMailHtmlDetailed: (value: string) => ({ html: value, blockedImages: 0 }),
  buildMailHtmlDocument: (value: string) => `<!doctype html><body>${value}</body>`,
  isMailHtmlBody: (contentType: string) => contentType.toLowerCase() === "html"
}));

import { MailReader } from "../src/components/MailReader";

const summary: MailMessageSummary = {
  id: "message-1",
  subject: "带附件的邮件",
  from: null,
  receivedDateTime: null,
  sentDateTime: null,
  isRead: false,
  importance: "normal",
  hasAttachments: true,
  bodyPreview: "",
  webLink: null
};

function detail(overrides: Partial<MailMessageDetail> = {}): MailMessageDetail {
  return {
    ...summary,
    toRecipients: [],
    ccRecipients: [],
    body: { contentType: "text", content: "正文" },
    ...overrides
  };
}

interface StubOptions {
  listAttachments?: ListFn;
  saveAttachment?: SaveFn;
  openExternal?: OpenExternalFn;
}

type OpenExternalFn = (url: string) => Promise<void>;
type SaveFn = (args: { attachmentId: string }) => Promise<{
  saved: boolean;
  canceled: boolean;
  path: string | null;
}>;
type ListFn = () => Promise<MailAttachmentListResult>;

let openExternal = vi.fn<OpenExternalFn>(async () => undefined);
let saveAttachment = vi.fn<SaveFn>(async () => ({ saved: true, canceled: false, path: "D:/tmp/a.pdf" }));
let listAttachments = vi.fn<ListFn>(async () => ({
  supported: true,
  attachments: [
    { id: "att-1", name: "invoice.pdf", contentType: "application/pdf", size: 2048, isInline: false },
    { id: "att-2", name: "logo.png", contentType: "image/png", size: 512, isInline: true }
  ]
}));

function installApi(overrides: StubOptions = {}) {
  openExternal = vi.fn<OpenExternalFn>(overrides.openExternal ?? (async () => undefined));
  saveAttachment = vi.fn<SaveFn>(
    overrides.saveAttachment ?? (async () => ({ saved: true, canceled: false, path: "D:/tmp/a.pdf" }))
  );
  listAttachments = vi.fn<ListFn>(overrides.listAttachments ?? (async () => ({ supported: true, attachments: [] })));
  (window as unknown as { outlookManager?: unknown }).outlookManager = {
    mail: { listAttachments, saveAttachment },
    app: { openExternal }
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  delete (window as unknown as { outlookManager?: unknown }).outlookManager;
});

async function render(props: {
  messageDetail: MailMessageDetail | null;
  accountEmail?: string | null;
  accountId?: string | null;
  folderId?: string | null;
}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(MailReader, {
        selectedMessage: summary,
        loadingDetail: false,
        accountId: "account-1",
        folderId: "INBOX",
        accountEmail: "someone@outlook.com",
        ...props
      })
    );
    // 让 listAttachments 的 promise 落地
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MailReader 附件与网页版入口", () => {
  it("列出 Graph 附件并提供逐个保存", async () => {
    installApi({
      listAttachments: async () => ({
        supported: true,
        attachments: [
          { id: "att-1", name: "invoice.pdf", contentType: "application/pdf", size: 2048, isInline: false },
          { id: "att-2", name: "logo.png", contentType: "image/png", size: 512, isInline: true }
        ]
      })
    });
    await render({ messageDetail: detail() });

    const items = container.querySelectorAll(".reader-attachment-list li");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("invoice.pdf");
    expect(items[0].textContent).toContain("2.0 KB");
    // 内嵌附件要标出来，避免用户以为是普通附件
    expect(items[1].textContent).toContain("内嵌");

    const saveButtons = container.querySelectorAll(".reader-attachment-list button");
    expect(saveButtons.length).toBe(2);

    await act(async () => {
      (saveButtons[0] as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-1", messageId: "message-1", attachmentId: "att-1" })
    );
    expect(container.textContent).toContain("已保存到 D:/tmp/a.pdf");
  });

  it("保存失败时把原因显示在附件区", async () => {
    installApi({
      listAttachments: async () => ({
        supported: true,
        attachments: [{ id: "att-1", name: "big.zip", contentType: "application/zip", size: 99, isInline: false }]
      }),
      saveAttachment: async () => {
        throw new Error("附件超过 25 MB 上限");
      }
    });
    await render({ messageDetail: detail() });

    await act(async () => {
      (container.querySelector(".reader-attachment-list button") as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("附件超过 25 MB 上限");
  });

  it("非 Graph 账号说明应用内看不到附件，并指向网页版", async () => {
    installApi({ listAttachments: async () => ({ supported: false, attachments: [] }) });
    await render({ messageDetail: detail() });

    const hint = container.querySelector(".reader-attachments")?.textContent ?? "";
    expect(hint).toContain("应用内看不到附件");
    expect(hint).toContain("网页版");
  });

  it("没有附件时不请求附件列表", async () => {
    installApi();
    await render({ messageDetail: detail({ hasAttachments: false }) });
    expect(listAttachments).not.toHaveBeenCalled();
    expect(container.querySelector(".reader-attachments")).toBeNull();
  });

  it("webLink 是 Outlook 地址时给「在浏览器中打开」", async () => {
    installApi();
    await render({
      messageDetail: detail({ hasAttachments: false, webLink: "https://outlook.office365.com/owa/?ItemID=x" })
    });

    const button = container.querySelector<HTMLButtonElement>(".reader-open-external");
    expect(button?.textContent).toContain("在浏览器中打开");
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(openExternal).toHaveBeenCalledWith("https://outlook.office365.com/owa/?ItemID=x");
  });

  it("没有 webLink 时退回网页版收件箱，恶意地址则不给入口", async () => {
    installApi();
    await render({ messageDetail: detail({ hasAttachments: false }) });

    const button = container.querySelector<HTMLButtonElement>(".reader-open-external");
    expect(button?.textContent).toContain("网页版");
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("outlook.live.com"));

    await act(async () => root.unmount());
    container.remove();

    installApi();
    await render({
      messageDetail: detail({ hasAttachments: false, webLink: "https://evil.example/phish" }),
      accountEmail: null
    });
    expect(container.querySelector(".reader-open-external")).toBeNull();
  });
});

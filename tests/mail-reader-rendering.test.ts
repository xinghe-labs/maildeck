/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MailMessageDetail, MailMessageSummary } from "../src/types";

const mailPolicy = vi.hoisted(() => ({
  sanitize: vi.fn((value: string) => `sanitized:${value}`),
  buildDocument: vi.fn((value: string) => `<!doctype html><body>${value}</body>`)
}));

vi.mock("../src/mail-content-security", () => ({
  sanitizeMailHtml: mailPolicy.sanitize,
  buildMailHtmlDocument: mailPolicy.buildDocument,
  isMailHtmlBody: (contentType: string) => contentType.toLowerCase() === "html"
}));

import { MailReader } from "../src/components/MailReader";

const summary: MailMessageSummary = {
  id: "message-1",
  subject: "Subject",
  from: null,
  receivedDateTime: null,
  sentDateTime: null,
  isRead: false,
  importance: "normal",
  hasAttachments: false,
  bodyPreview: "",
  webLink: null
};

function detail(content: string): MailMessageDetail {
  return {
    ...summary,
    toRecipients: [],
    ccRecipients: [],
    body: { contentType: "html", content }
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
  mailPolicy.sanitize.mockClear();
  mailPolicy.buildDocument.mockClear();
});

function reader(messageDetail: MailMessageDetail) {
  return createElement(MailReader, {
    selectedMessage: summary,
    messageDetail,
    loadingDetail: false
  });
}

describe("MailReader rendering cost", () => {
  it("does not sanitize unchanged HTML again when its parent rerenders", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const messageDetail = detail("<p>Hello</p>");

    act(() => root.render(reader(messageDetail)));
    act(() => root.render(reader(messageDetail)));

    expect(mailPolicy.sanitize).toHaveBeenCalledTimes(1);
    expect(mailPolicy.buildDocument).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the isolated document when the message body changes", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => root.render(reader(detail("<p>First</p>"))));
    act(() => root.render(reader(detail("<p>Second</p>"))));

    expect(mailPolicy.sanitize).toHaveBeenCalledTimes(2);
    expect(mailPolicy.buildDocument).toHaveBeenCalledTimes(2);
  });

  it("reuses the sanitized document when only the detail object identity changes", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => root.render(reader(detail("<p>Stable</p>"))));
    act(() => root.render(reader(detail("<p>Stable</p>"))));

    expect(mailPolicy.sanitize).toHaveBeenCalledTimes(1);
    expect(mailPolicy.buildDocument).toHaveBeenCalledTimes(1);
  });
});

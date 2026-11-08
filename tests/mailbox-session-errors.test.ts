import { describe, expect, it, vi } from "vitest";
import { createMailboxSession, type MailboxSessionAdapter } from "../src/mailbox-session";
import type { MailListResult, MailMessageDetail, MailMessageSummary } from "../src/types";

function summary(id: string): MailMessageSummary {
  return {
    id,
    subject: id,
    from: { name: "Sender", address: "sender@example.com" },
    receivedDateTime: "2026-08-19T08:00:00.000Z",
    sentDateTime: null,
    isRead: true,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: `${id} preview`,
    webLink: null
  };
}

function listResult(messages: MailMessageSummary[]): MailListResult {
  return { messages, nextCursor: null, totalCount: messages.length };
}

function adapterWithList(listMessages: MailboxSessionAdapter["listMessages"]): MailboxSessionAdapter {
  return {
    listFolders: vi.fn(async () => []),
    listMessages,
    getMessage: vi.fn(async (options) => ({
      ...summary(options.messageId),
      toRecipients: [],
      ccRecipients: [],
      body: { contentType: "text" as const, content: "body" }
    }))
  };
}

function detailOf(id: string): MailMessageDetail {
  return {
    ...summary(id),
    toRecipients: [],
    ccRecipients: [],
    body: { contentType: "text" as const, content: "body" }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mailbox session error persistence", () => {
  it("keeps the list failure after the banner is dismissed", async () => {
    const adapter = adapterWithList(vi.fn(async () => {
      throw new Error("连接超时");
    }));
    const session = createMailboxSession(adapter);

    session.selectAccount("account-a");
    await session.reload();

    expect(session.getSnapshot().listError).toBe("连接超时");
    expect(session.getSnapshot().error).toBe("连接超时");

    // 关闭横幅（例如用户点了“关闭提示”或触发了批量测试）不能把失败态抹成空列表。
    session.clearError();

    expect(session.getSnapshot().error).toBe("");
    expect(session.getSnapshot().listError).toBe("连接超时");

    session.dispose();
  });

  it("clears the list failure only after a successful reload", async () => {
    const listMessages = vi.fn()
      .mockRejectedValueOnce(new Error("连接超时"))
      .mockResolvedValueOnce(listResult([summary("message-a")]));
    const session = createMailboxSession(adapterWithList(listMessages));

    session.selectAccount("account-a");
    await session.reload();
    expect(session.getSnapshot().listError).toBe("连接超时");

    await session.reload();

    expect(session.getSnapshot().listError).toBe("");
    expect(session.getSnapshot().error).toBe("");
    expect(session.getSnapshot().messages).toHaveLength(1);

    session.dispose();
  });

  it("resets the list failure when another folder is selected", async () => {
    const listMessages = vi.fn()
      .mockRejectedValueOnce(new Error("连接超时"))
      .mockResolvedValue(listResult([]));
    const session = createMailboxSession(adapterWithList(listMessages));

    session.selectAccount("account-a");
    await session.reload();
    expect(session.getSnapshot().listError).toBe("连接超时");

    session.selectFolder("folder-archive");
    await session.reload();

    expect(session.getSnapshot().listError).toBe("");
    session.dispose();
  });
});

describe("mailbox session detail watchdog", () => {
  it("times out a hung detail load instead of spinning forever", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<MailMessageDetail>();
      const adapter = adapterWithList(vi.fn(async () => listResult([summary("message-1")])));
      adapter.getMessage = vi.fn(() => pending.promise);
      const session = createMailboxSession(adapter);

      session.selectAccount("account-a");
      await session.reload();
      void session.selectMessage("message-1");
      await vi.advanceTimersByTimeAsync(500);
      expect(session.getSnapshot().loadingDetail).toBe(true);

      // 看门狗到点：不再永远转圈，走失败路径（可重试）
      await vi.advanceTimersByTimeAsync(45_000);
      expect(session.getSnapshot().loadingDetail).toBe(false);
      expect(session.getSnapshot().messageDetail).toBeNull();
      expect(session.getSnapshot().error).toContain("超时");

      // 迟到的真实响应不得覆盖超时态（用户可能已经点了重试别的邮件）
      pending.resolve(detailOf("message-1"));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.getSnapshot().error).toContain("超时");
      expect(session.getSnapshot().messageDetail).toBeNull();

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire when the detail resolves before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<MailMessageDetail>();
      const adapter = adapterWithList(vi.fn(async () => listResult([summary("message-1")])));
      adapter.getMessage = vi.fn(() => pending.promise);
      const session = createMailboxSession(adapter);

      session.selectAccount("account-a");
      await session.reload();
      void session.selectMessage("message-1");
      await vi.advanceTimersByTimeAsync(500);

      await vi.advanceTimersByTimeAsync(44_000);
      pending.resolve(detailOf("message-1"));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(session.getSnapshot()).toMatchObject({
        loadingDetail: false,
        error: "",
        messageDetail: detailOf("message-1")
      });

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

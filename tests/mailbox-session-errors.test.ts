import { describe, expect, it, vi } from "vitest";
import { createMailboxSession, type MailboxSessionAdapter } from "../src/mailbox-session";
import type { MailListResult, MailMessageSummary } from "../src/types";

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

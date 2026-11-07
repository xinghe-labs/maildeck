import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailMessageDetail, MailMessageSummary } from "../electron/shared/ipc-contracts.js";

const electronState = vi.hoisted(() => ({ userDataPath: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronState.userDataPath
  }
}));

const temporaryDirectories: string[] = [];

async function createTemporaryUserData() {
  const directory = await mkdtemp(path.join(tmpdir(), "maildeck-cache-stats-"));
  temporaryDirectories.push(directory);
  electronState.userDataPath = directory;
  vi.resetModules();
  return directory;
}

afterEach(async () => {
  const { closeDatabase } = await import("../electron/main/database.js");
  closeDatabase();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function summary(id: string, subject: string): MailMessageSummary {
  return {
    id,
    subject,
    from: { address: "sender@example.com", name: "Sender" },
    receivedDateTime: "2026-01-01T00:00:00Z",
    sentDateTime: "2026-01-01T00:00:00Z",
    isRead: false,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: "preview text",
    webLink: null
  };
}

function messageDetail(id: string, content: string): MailMessageDetail {
  return {
    id,
    subject: "subject",
    from: null,
    receivedDateTime: null,
    sentDateTime: null,
    isRead: false,
    importance: "normal",
    hasAttachments: false,
    bodyPreview: "",
    webLink: null,
    toRecipients: [],
    ccRecipients: [],
    body: { contentType: "text", content }
  };
}

describe("getMailCacheStats", () => {
  it("reports real counts and a byte estimate the settings page can show", async () => {
    await createTemporaryUserData();
    const mailCache = await import("../electron/main/mail-cache.js");

    expect(await mailCache.getMailCacheStats()).toMatchObject({
      accountCount: 0,
      messageCount: 0,
      bodyCount: 0,
      approximateBytes: 0
    });

    const longBody = "x".repeat(500);
    await mailCache.saveCachedMessages(
      "account-a",
      [summary("m1", "subject one"), summary("m2", "subject two")],
      true
    );
    await mailCache.saveCachedMessages("account-b", [summary("m3", "subject three")], true);
    await mailCache.saveCachedMessageDetail("account-a", messageDetail("m1", longBody), true);

    const stats = await mailCache.getMailCacheStats();

    // 两个账号、三条摘要、一封正文——设置里「邮件 N 条 · 正文 M 封 · K 个账号」要真的对得上。
    expect(stats.accountCount).toBe(2);
    expect(stats.messageCount).toBe(3);
    expect(stats.bodyCount).toBe(1);
    // 正文长 500 字符，近似体积必须把正文算进去，否则设置的「缓存占用」会报成 0。
    expect(stats.approximateBytes).toBeGreaterThan(500);

    await mailCache.clearAccountCache("account-a");
    expect(await mailCache.getMailCacheStats()).toMatchObject({
      accountCount: 1,
      messageCount: 1,
      bodyCount: 0
    });

    await mailCache.clearAllMailCache();
    expect(await mailCache.getMailCacheStats()).toMatchObject({
      accountCount: 0,
      messageCount: 0,
      bodyCount: 0,
      approximateBytes: 0
    });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailMessageDetail } from "../electron/shared/ipc-contracts.js";
import { JobCanceledError } from "../electron/main/job-errors.js";

const electronState = vi.hoisted(() => ({ userDataPath: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronState.userDataPath
  }
}));

const temporaryDirectories: string[] = [];

async function createTemporaryUserData() {
  const directory = await mkdtemp(path.join(tmpdir(), "outlook-manager-mail-cache-"));
  temporaryDirectories.push(directory);
  electronState.userDataPath = directory;
  vi.resetModules();
  return directory;
}

function detail(contentType: string, content: string): MailMessageDetail {
  return {
    id: "message-1",
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
    body: { contentType, content }
  };
}

afterEach(async () => {
  const { closeDatabase } = await import("../electron/main/database.js");
  closeDatabase();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("mail detail cache format", () => {
  it("preserves literal HTML-looking plaintext in version 2 cache entries", async () => {
    await createTemporaryUserData();
    const cache = await import("../electron/main/mail-cache.js");
    const { getDatabase } = await import("../electron/main/database.js");
    const expected = detail("text", "<p>literal plaintext</p>");

    await cache.saveCachedMessageDetail("account-1", expected);
    const row = getDatabase()
      .prepare("SELECT detail_json FROM mail_details WHERE account_id = ? AND message_id = ?")
      .get("account-1", expected.id) as { detail_json: string };

    expect(JSON.parse(row.detail_json)).toMatchObject({ version: 2, detail: expected });
    await expect(cache.getCachedMessageDetail("account-1", expected.id)).resolves.toEqual(expected);
  });

  it("normalizes mailparser textAsHtml only for unversioned legacy entries", async () => {
    await createTemporaryUserData();
    const { getDatabase } = await import("../electron/main/database.js");
    const legacy = detail("text", "<p>first line<br/>second line</p>");
    getDatabase()
      .prepare("INSERT INTO mail_details (account_id, message_id, detail_json, updated_at) VALUES (?, ?, ?, ?)")
      .run("account-1", legacy.id, JSON.stringify(legacy), new Date().toISOString());
    const cache = await import("../electron/main/mail-cache.js");

    await expect(cache.getCachedMessageDetail("account-1", legacy.id)).resolves.toMatchObject({
      body: {
        contentType: "html",
        content: legacy.body.content
      }
    });
  });

  it("checks cancellation inside the cache lock before writing", async () => {
    await createTemporaryUserData();
    const cache = await import("../electron/main/mail-cache.js");
    const expected = detail("text", "must not be cached");
    const controller = new AbortController();
    const canceled = new JobCanceledError("刷新已取消");
    controller.abort(canceled);

    await expect(
      cache.saveCachedMessageDetail("account-1", expected, true, {
        assertCurrent: () => controller.signal.throwIfAborted()
      })
    ).rejects.toBe(canceled);
    await expect(cache.getCachedMessageDetail("account-1", expected.id)).resolves.toBeNull();
  });
});

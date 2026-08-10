import { afterEach, describe, expect, it, vi } from "vitest";

const imap = vi.hoisted(() => ({
  getMessage: vi.fn(),
  listFolders: vi.fn(async () => ([{
    id: "INBOX",
    displayName: "INBOX",
    totalItemCount: 0,
    unreadItemCount: 0
  }])),
  refreshInbox: vi.fn(async () => ({
    messages: [
      {
        id: "42",
        subject: "Fallback summary",
        from: null,
        receivedDateTime: null,
        sentDateTime: null,
        isRead: false,
        importance: "normal",
        hasAttachments: false,
        bodyPreview: "summary only",
        webLink: null
      }
    ],
    totalCount: 1,
    inboxFolderId: "INBOX",
    cursor: "42"
  }))
}));

vi.mock("../electron/main/imap-client.js", () => ({
  getImapMessage: imap.getMessage,
  listImapFolders: imap.listFolders,
  listImapMessages: vi.fn(),
  refreshImapInbox: imap.refreshInbox
}));

import {
  fetchHotmailFallbackMessage,
  fetchHotmailFallbackMessages
} from "../electron/main/hotmail-fallback-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Hotmail fallback message loading", () => {
  it("returns summaries without eagerly opening one IMAP connection per detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "access-token",
      expires_in: 3_600
    }), { status: 200 })));
    const account = {
      id: "account-1",
      email: "person@example.com",
      clientId: "client-id",
      encryptedRefreshToken: "encrypted",
      remark: "",
      group: "",
      status: "untested" as const,
      lastCheckedAt: null,
      lastError: null,
      inboxFolderId: "INBOX"
    };

    const result = await fetchHotmailFallbackMessages(
      { hotmailFallbackEnabled: true, proxyUrl: "" },
      account,
      "refresh-token"
    );

    expect(result.messages).toHaveLength(1);
    expect(result).not.toHaveProperty("details");
    expect(imap.getMessage).not.toHaveBeenCalled();
  });

  it("loads one fallback detail only when the message is opened", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "access-token",
      refresh_token: "rotated-token",
      expires_in: 3_600
    }), { status: 200 })));
    const detail = {
      id: "42",
      subject: "Fallback detail",
      from: null,
      receivedDateTime: null,
      sentDateTime: null,
      isRead: false,
      importance: "normal",
      hasAttachments: false,
      bodyPreview: "detail",
      webLink: null,
      toRecipients: [],
      ccRecipients: [],
      body: { contentType: "text", content: "detail body" }
    };
    imap.getMessage.mockResolvedValue(detail);
    const account = {
      id: "account-1",
      email: "person@example.com",
      clientId: "client-id",
      encryptedRefreshToken: "encrypted",
      remark: "",
      group: "",
      status: "valid" as const,
      lastCheckedAt: null,
      lastError: null,
      inboxFolderId: "INBOX"
    };

    const result = await fetchHotmailFallbackMessage(
      { hotmailFallbackEnabled: true, proxyUrl: "" },
      account,
      "refresh-token",
      "42"
    );

    expect(result).toMatchObject({ detail, nextRefreshToken: "rotated-token", inboxFolderId: "INBOX" });
    expect(imap.getMessage).toHaveBeenCalledWith(
      "person@example.com",
      "access-token",
      "INBOX",
      "42",
      "",
      undefined
    );
  });

  it("does not pass a persisted Graph folder id to IMAP detail loading", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "access-token",
      expires_in: 3_600
    }), { status: 200 })));
    const detail = {
      id: "42",
      subject: "Fallback detail",
      from: null,
      receivedDateTime: null,
      sentDateTime: null,
      isRead: false,
      importance: "normal",
      hasAttachments: false,
      bodyPreview: "detail",
      webLink: null,
      toRecipients: [],
      ccRecipients: [],
      body: { contentType: "text", content: "detail body" }
    };
    imap.getMessage.mockResolvedValue(detail);

    const result = await fetchHotmailFallbackMessage(
      { hotmailFallbackEnabled: true, proxyUrl: "" },
      {
        id: "account-graph-folder",
        email: "person@example.com",
        clientId: "client-id",
        encryptedRefreshToken: "encrypted",
        remark: "",
        group: "",
        status: "valid",
        lastCheckedAt: null,
        lastError: null,
        inboxFolderId: "AAMkAGraphOpaqueFolderId"
      },
      "refresh-token",
      "42"
    );

    expect(imap.listFolders).toHaveBeenCalledWith("person@example.com", "access-token", "", undefined);
    expect(imap.getMessage).toHaveBeenCalledWith(
      "person@example.com",
      "access-token",
      "INBOX",
      "42",
      "",
      undefined
    );
    expect(result.inboxFolderId).toBe("INBOX");
  });
});

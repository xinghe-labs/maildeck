import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The fixture is mutated between cases (null charset, alternate body structures),
// so it is declared through an interface instead of inline type assertions.
interface FakeImapState {
  fetchQueries: Array<Record<string, unknown>>;
  summaryFetchQueries: Array<Record<string, unknown>>;
  downloadParts: Array<string | undefined>;
  downloadOptions: Array<Record<string, unknown>>;
  messageSize: number;
  downloadedBody: Buffer;
  downloadContentType: string;
  downloadCharset: string | null;
  partBodies: Map<string, Buffer>;
  partContentTypes: Map<string, string>;
  partCharsets: Map<string, string | null>;
  summaryDate: Date;
  bodyStructure: Record<string, unknown>;
  source: Buffer;
}

const fakeImap = vi.hoisted((): FakeImapState => ({
  fetchQueries: [],
  summaryFetchQueries: [],
  downloadParts: [],
  downloadOptions: [],
  messageSize: 25 * 1024 * 1024,
  downloadedBody: Buffer.from("<p>large message body</p>", "utf8"),
  downloadContentType: "text/html",
  downloadCharset: "utf-8",
  partBodies: new Map<string, Buffer>(),
  partContentTypes: new Map<string, string>(),
  partCharsets: new Map<string, string | null>(),
  summaryDate: new Date("2026-08-10T00:00:00.000Z"),
  bodyStructure: {
    type: "multipart/alternative",
    childNodes: [
      { part: "1", type: "text/plain", size: 64 },
      { part: "2", type: "text/html", size: 96 }
    ]
  },
  source: Buffer.from("Subject: Small\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nsmall body", "utf8")
}));

vi.mock("imapflow", async () => {
  const { Readable } = await import("node:stream");
  return {
    ImapFlow: class {
      mailbox = { exists: 1 };
      on() {}
      async connect() {}
      async close() {}
      async logout() {}
      async getMailboxLock() {
        return { release() {} };
      }
      async *fetch(_range: string, query: Record<string, unknown>) {
        fakeImap.summaryFetchQueries.push(query);
        yield {
          uid: 42,
          flags: [],
          envelope: { subject: "Summary" },
          internalDate: fakeImap.summaryDate,
          bodyStructure: { part: "1", type: "text/plain", size: 64 }
        };
      }
      async fetchOne(_messageId: string, query: Record<string, unknown>) {
        fakeImap.fetchQueries.push(query);
        if (query.bodyParts) {
          const bodyParts = new Map<string, Buffer>();
          let headers: Buffer | undefined;
          for (const requestedPart of query.bodyParts as Array<string | { key: string }>) {
            const key = typeof requestedPart === "string" ? requestedPart : requestedPart.key;
            if (key === "header" || key.endsWith(".mime")) {
              const partKey = key === "header" ? "text" : key.slice(0, -".mime".length);
              const declaredCharset = fakeImap.partCharsets.has(partKey)
                ? fakeImap.partCharsets.get(partKey)
                : fakeImap.downloadCharset;
              const charset = declaredCharset ? `; charset=${declaredCharset}` : "";
              const contentType = fakeImap.partContentTypes.get(partKey) || fakeImap.downloadContentType;
              const headerValue = Buffer.from(
                `Content-Type: ${contentType}${charset}\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`,
                "ascii"
              );
              if (key === "header") {
                headers = headerValue;
              } else {
                bodyParts.set(key, headerValue);
              }
            } else {
              bodyParts.set(key, fakeImap.partBodies.get(key) || fakeImap.downloadedBody);
            }
          }
          return { uid: 42, bodyParts, headers };
        }
        if (query.source) {
          return { uid: 42, source: fakeImap.source };
        }
        return {
          uid: 42,
          flags: [],
          envelope: { subject: "Large message" },
          internalDate: new Date("2026-08-10T00:00:00.000Z"),
          size: fakeImap.messageSize,
          bodyStructure: fakeImap.bodyStructure
        };
      }
      async download(_messageId: string, part: string | undefined, options: Record<string, unknown>) {
        fakeImap.downloadParts.push(part);
        fakeImap.downloadOptions.push(options);
        if (!part) {
          return {
            meta: { expectedSize: fakeImap.source.byteLength, contentType: "message/rfc822" },
            content: Readable.from([fakeImap.source])
          };
        }
        return {
          meta: {
            expectedSize: fakeImap.messageSize,
            contentType: fakeImap.downloadContentType,
            ...(fakeImap.downloadCharset ? { charset: fakeImap.downloadCharset } : {})
          },
          content: Readable.from([
            fakeImap.downloadCharset && !["utf-8", "utf8", "ascii", "us-ascii"].includes(fakeImap.downloadCharset)
              ? Buffer.from(new TextDecoder(fakeImap.downloadCharset).decode(fakeImap.downloadedBody), "utf8")
              : fakeImap.downloadedBody
          ])
        };
      }
    }
  };
});

import { getImapMessage, listImapMessages } from "../electron/main/imap-client.js";

const imapClientSource = readFileSync(new URL("../electron/main/imap-client.ts", import.meta.url), "utf8");

beforeEach(() => {
  fakeImap.fetchQueries = [];
  fakeImap.summaryFetchQueries = [];
  fakeImap.downloadParts = [];
  fakeImap.downloadOptions = [];
  fakeImap.messageSize = 25 * 1024 * 1024;
  fakeImap.downloadedBody = Buffer.from("<p>large message body</p>", "utf8");
  fakeImap.downloadContentType = "text/html";
  fakeImap.downloadCharset = "utf-8";
  fakeImap.partBodies = new Map();
  fakeImap.partContentTypes = new Map();
  fakeImap.partCharsets = new Map();
  fakeImap.summaryDate = new Date("2026-08-10T00:00:00.000Z");
  fakeImap.bodyStructure = {
    type: "multipart/alternative",
    childNodes: [
      { part: "1", type: "text/plain", size: 64 },
      { part: "2", type: "text/html", size: 96 }
    ]
  };
  fakeImap.source = Buffer.from(
    "Subject: Small\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nsmall body",
    "utf8"
  );
});

describe("bounded IMAP message detail reads", () => {
  it("never requests full message sources while listing summaries", async () => {
    fakeImap.summaryFetchQueries = [];

    await listImapMessages("person@example.com", "access-token", "INBOX", 20);

    expect(fakeImap.summaryFetchQueries).toHaveLength(1);
    expect(fakeImap.summaryFetchQueries[0]).not.toHaveProperty("source");
    expect(imapClientSource).not.toContain("source: { maxLength: 0 }");
  });

  it("degrades an invalid IMAP date without failing the message list", async () => {
    fakeImap.summaryDate = new Date("invalid");

    const result = await listImapMessages("person@example.com", "access-token", "INBOX", 20);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.receivedDateTime).toBeNull();
  });

  it("downloads only the preferred text part when attachments make the full message large", async () => {
    fakeImap.fetchQueries = [];
    fakeImap.downloadParts = [];
    fakeImap.downloadOptions = [];
    fakeImap.messageSize = 25 * 1024 * 1024;
    fakeImap.downloadedBody = Buffer.from("<p>large message body</p>", "utf8");
    fakeImap.downloadContentType = "text/html";
    fakeImap.downloadCharset = "utf-8";

    const detail = await getImapMessage("person@example.com", "access-token", "INBOX", "42");

    expect(fakeImap.fetchQueries[0]).toMatchObject({ size: true, bodyStructure: true });
    expect(fakeImap.downloadParts).toEqual([]);
    expect(fakeImap.fetchQueries[1]).toMatchObject({
      bodyParts: [
        { key: "2.mime", maxLength: 64 * 1024 + 1 },
        { key: "2", maxLength: 12 * 1024 * 1024 + 1 }
      ]
    });
    expect(detail.body).toMatchObject({ contentType: "html", content: "<p>large message body</p>" });
  });

  it("rejects a selected text part larger than four MiB", async () => {
    fakeImap.fetchQueries = [];
    fakeImap.downloadParts = [];
    fakeImap.downloadOptions = [];
    fakeImap.messageSize = 25 * 1024 * 1024;
    fakeImap.downloadedBody = Buffer.alloc(4 * 1024 * 1024 + 1, 97);
    fakeImap.downloadContentType = "text/html";
    fakeImap.downloadCharset = "utf-8";

    await expect(
      getImapMessage("person@example.com", "access-token", "INBOX", "42")
    ).rejects.toThrow("邮件正文过大");
  });

  it("repairs a missing charset after downloading a large text part", async () => {
    fakeImap.fetchQueries = [];
    fakeImap.downloadParts = [];
    fakeImap.downloadOptions = [];
    fakeImap.messageSize = 25 * 1024 * 1024;
    fakeImap.downloadedBody = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    fakeImap.downloadContentType = "text/plain";
    fakeImap.downloadCharset = null;

    const detail = await getImapMessage("person@example.com", "access-token", "INBOX", "42");

    expect(detail.body).toMatchObject({ contentType: "text", content: "你好" });
  });

  it("repairs a wrong declared charset from the raw large text part", async () => {
    fakeImap.downloadedBody = Buffer.from("你好", "utf8");
    fakeImap.downloadContentType = "text/plain";
    fakeImap.downloadCharset = "iso-8859-1";

    const detail = await getImapMessage("person@example.com", "access-token", "INBOX", "42");

    expect(detail.body).toMatchObject({ contentType: "text", content: "你好" });
  });

  it("does not select named HTML attachments or forwarded message bodies", async () => {
    fakeImap.downloadedBody = Buffer.from("outer body", "utf8");
    fakeImap.downloadContentType = "text/plain";
    fakeImap.downloadCharset = "utf-8";
    fakeImap.bodyStructure = {
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain", size: 64 },
        { part: "2", type: "text/html", size: 96, parameters: { name: "report.html" } },
        {
          part: "3",
          type: "message/rfc822",
          size: 128,
          childNodes: [{ part: "3.1", type: "text/html", size: 64 }]
        }
      ]
    };

    const detail = await getImapMessage("person@example.com", "access-token", "INBOX", "42");

    expect(fakeImap.fetchQueries[1]).toMatchObject({
      bodyParts: [
        { key: "1.mime", maxLength: 64 * 1024 + 1 },
        { key: "1", maxLength: 12 * 1024 * 1024 + 1 }
      ]
    });
    expect(detail.hasAttachments).toBe(true);
    expect(detail.body).toMatchObject({ contentType: "text", content: "outer body" });
  });

  it("falls back to the plain alternative when the preferred HTML part is too large", async () => {
    fakeImap.partBodies.set("2", Buffer.alloc(4 * 1024 * 1024 + 1, 97));
    fakeImap.partBodies.set("1", Buffer.from("plain fallback", "utf8"));
    fakeImap.partContentTypes.set("2", "text/html");
    fakeImap.partContentTypes.set("1", "text/plain");

    const detail = await getImapMessage("person@example.com", "access-token", "INBOX", "42");

    expect(fakeImap.fetchQueries).toHaveLength(3);
    expect(fakeImap.fetchQueries[1]).toMatchObject({
      bodyParts: expect.arrayContaining([{ key: "2", maxLength: 12 * 1024 * 1024 + 1 }])
    });
    expect(fakeImap.fetchQueries[2]).toMatchObject({
      bodyParts: expect.arrayContaining([{ key: "1", maxLength: 12 * 1024 * 1024 + 1 }])
    });
    expect(detail.body).toMatchObject({ contentType: "text", content: "plain fallback" });
  });

  it("reads a large single-node message through HEADER and TEXT sections", async () => {
    fakeImap.bodyStructure = { type: "text/plain", size: 64 };
    fakeImap.downloadedBody = Buffer.from("single-node body", "utf8");
    fakeImap.downloadContentType = "text/plain";

    const detail = await getImapMessage("person@example.com", "access-token", "INBOX", "42");

    expect(fakeImap.fetchQueries[1]).toMatchObject({
      bodyParts: [
        { key: "header", maxLength: 64 * 1024 + 1 },
        { key: "text", maxLength: 12 * 1024 * 1024 + 1 }
      ]
    });
    expect(detail.body).toMatchObject({ contentType: "text", content: "single-node body" });
  });

  it("rejects an oversized full source when the server underreports its size", async () => {
    fakeImap.fetchQueries = [];
    fakeImap.downloadParts = [];
    fakeImap.downloadOptions = [];
    fakeImap.messageSize = 0;
    fakeImap.source = Buffer.alloc(10 * 1024 * 1024 + 1, 97);

    await expect(
      getImapMessage("person@example.com", "access-token", "INBOX", "42")
    ).rejects.toThrow("邮件正文过大");
    expect(fakeImap.downloadParts).toEqual([undefined]);
  });

  it("keeps full MIME charset repair for bounded small messages", async () => {
    fakeImap.fetchQueries = [];
    fakeImap.downloadParts = [];
    fakeImap.downloadOptions = [];
    fakeImap.source = Buffer.concat([
      Buffer.from("Subject: Small\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: 8bit\r\n\r\n", "ascii"),
      Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
    ]);
    fakeImap.messageSize = fakeImap.source.byteLength;

    const detail = await getImapMessage("person@example.com", "access-token", "INBOX", "42");

    expect(detail.body).toMatchObject({ contentType: "text", content: "你好" });
    expect(fakeImap.downloadParts).toEqual([undefined]);
    expect(fakeImap.downloadOptions).toEqual([{
      uid: true,
      maxBytes: 10 * 1024 * 1024 + 1
    }]);
  });
});

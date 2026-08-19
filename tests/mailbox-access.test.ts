import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ipcSource = readFileSync(new URL("../electron/main/ipc.ts", import.meta.url), "utf8");
const mailboxAccessSource = readFileSync(new URL("../electron/main/mailbox-access.ts", import.meta.url), "utf8");

describe("mailbox access boundary", () => {
  it("keeps transport adapters behind the mailbox access module", () => {
    expect(ipcSource).not.toMatch(/from "\.\/(?:graph-client|imap-client|hotmail-fallback-client)\.js"/u);
    expect(ipcSource).not.toMatch(/(?:fetchHotmailFallback|deltaGraphInboxMessages|listGraphInboxMessages)/u);
    expect(mailboxAccessSource).toMatch(/from "\.\/graph-client\.js"/u);
    expect(mailboxAccessSource).toMatch(/from "\.\/imap-client\.js"/u);
    expect(mailboxAccessSource).toMatch(/from "\.\/hotmail-fallback-client\.js"/u);
  });

  it("exposes mailbox operations instead of transport details", () => {
    for (const operation of [
      "listFolders",
      "testConnection",
      "testFallback",
      "listMessages",
      "getMessage",
      "refreshAccount"
    ]) {
      expect(mailboxAccessSource).toMatch(new RegExp(`readonly ${operation}:`, "u"));
    }

    expect(mailboxAccessSource).toContain("export interface MailboxAccess");
    expect(mailboxAccessSource).not.toMatch(/export .*\b(?:Graph|Imap|Hotmail)\b/u);
  });

  it("keeps refresh job ownership in IPC", () => {
    expect(ipcSource.match(/refreshCoordinator\.runJob\(/gu)).toHaveLength(2);
    expect(ipcSource.match(/job\.runAccount(?:<[^>]+>)?\(\s*accountId/gu)).toHaveLength(2);
    expect(mailboxAccessSource).not.toContain("RefreshCoordinator");
    expect(mailboxAccessSource).not.toContain("sendValidatedEvent");
  });
});

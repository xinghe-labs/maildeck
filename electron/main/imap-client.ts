import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { MailFolder, MailMessageDetail, MailMessageSummary } from "./types.js";

interface ImapMessageListResult {
  messages: MailMessageSummary[];
  totalCount: number;
}

interface ImapRefreshResult extends ImapMessageListResult {
  inboxFolderId: string;
  cursor: string | null;
}

function cleanText(value: string | undefined | null) {
  return (value || "").replace(/\r/g, "").trim();
}

function headerAddress(address: { name?: string; address?: string } | undefined | null) {
  if (!address) {
    return null;
  }

  return {
    name: address.name || "",
    address: address.address || ""
  };
}

function headerAddressList(items: Array<{ name?: string; address?: string }> | undefined) {
  return (items || []).map((item) => ({
    name: item.name || "",
    address: item.address || ""
  }));
}

function toIsoString(value: string | Date | undefined | null) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function withClient<T>(email: string, accessToken: string, handler: (client: ImapFlow) => Promise<T>, proxyUrl = "") {
  const client = new ImapFlow({
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    proxy: proxyUrl || undefined,
    auth: {
      user: email,
      accessToken
    },
    logger: false
  });
  const deferredErrors: Error[] = [];

  client.on("error", (error) => {
    deferredErrors.push(error instanceof Error ? error : new Error(String(error)));
  });

  await client.connect();

  try {
    const result = await handler(client);
    if (deferredErrors.length > 0) {
      throw deferredErrors[0];
    }
    return result;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function listImapFolders(email: string, accessToken: string, proxyUrl = ""): Promise<MailFolder[]> {
  return withClient(email, accessToken, async (client) => {
    const mailboxes = await client.list();
    return mailboxes
      .filter((mailbox) => typeof mailbox.path === "string" && mailbox.path.trim().length > 0)
      .map((mailbox) => ({
        id: mailbox.path,
        displayName: mailbox.path,
        totalItemCount: 0,
        unreadItemCount: 0
      }));
  }, proxyUrl);
}

export async function listImapMessages(
  email: string,
  accessToken: string,
  folderId: string,
  top = 30,
  search = "",
  cursor = "",
  proxyUrl = ""
): Promise<ImapMessageListResult> {
  return withClient(email, accessToken, async (client) => {
    const lock = await client.getMailboxLock(folderId);

    try {
      const exists = client.mailbox && client.mailbox.exists ? client.mailbox.exists : 0;
      if (exists === 0) {
        return { messages: [], totalCount: 0 };
      }

      const limit = Math.min(Math.max(top, 1), 100);
      const query = search.trim();
      const nextUid = client.mailbox && client.mailbox.uidNext ? client.mailbox.uidNext : exists + 1;
      const beforeUid = Math.max(Number(cursor) || nextUid, 1);
      const matchedUids = query ? await client.search({ subject: query }, { uid: true }) : null;
      const selectedUids = matchedUids
        ? matchedUids.filter((uid) => uid < beforeUid).slice(-limit)
        : [];

      const fetchRange = (() => {
        if (matchedUids) {
          return selectedUids.length > 0 ? selectedUids.join(",") : "";
        }

        const endUid = beforeUid - 1;
        if (endUid < 1) {
          return "";
        }

        const windowSize = Math.max(limit * 5, 100);
        const startUid = Math.max(1, endUid - windowSize + 1);
        return `${startUid}:${endUid}`;
      })();

      if (!fetchRange) {
        return { messages: [], totalCount: exists };
      }

      const messages: MailMessageSummary[] = [];

      for await (const message of client.fetch(
        fetchRange,
        {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          internalDate: true,
          source: { maxLength: 0 }
        },
        { uid: true }
      )) {
        const subject = cleanText(message.envelope?.subject) || "(无主题)";
        messages.push({
          id: String(message.uid),
          subject,
          from: headerAddress(message.envelope?.from?.[0]),
          receivedDateTime: toIsoString(message.internalDate),
          sentDateTime: toIsoString(message.envelope?.date),
          isRead: Array.isArray(message.flags) ? message.flags.includes("\\Seen") : false,
          importance: "normal",
          hasAttachments: Boolean(message.bodyStructure?.childNodes?.some((part) => part.disposition === "attachment")),
          bodyPreview: "",
          webLink: null
        });
      }

      return {
        messages: messages.sort((a, b) => {
          const left = a.receivedDateTime ? new Date(a.receivedDateTime).getTime() : 0;
          const right = b.receivedDateTime ? new Date(b.receivedDateTime).getTime() : 0;
          return right - left;
        }).slice(0, limit),
        totalCount: exists
      };
    } finally {
      lock.release();
    }
  }, proxyUrl);
}

export async function listNewImapMessages(
  email: string,
  accessToken: string,
  folderId: string,
  top = 30,
  afterUid = "",
  proxyUrl = ""
): Promise<ImapMessageListResult> {
  return withClient(email, accessToken, async (client) => {
    const lock = await client.getMailboxLock(folderId);

    try {
      const exists = client.mailbox && client.mailbox.exists ? client.mailbox.exists : 0;
      if (exists === 0) {
        return { messages: [], totalCount: 0 };
      }

      const lastUid = Number(afterUid) || 0;
      const matchedUids = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
      const selectedUids = (Array.isArray(matchedUids) ? matchedUids : []).slice(-Math.min(Math.max(top, 1), 100));

      if (selectedUids.length === 0) {
        return { messages: [], totalCount: exists };
      }

      const messages: MailMessageSummary[] = [];
      for await (const message of client.fetch(
        selectedUids.join(","),
        {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          internalDate: true,
          source: { maxLength: 0 }
        },
        { uid: true }
      )) {
        messages.push({
          id: String(message.uid),
          subject: cleanText(message.envelope?.subject) || "(无主题)",
          from: headerAddress(message.envelope?.from?.[0]),
          receivedDateTime: toIsoString(message.internalDate),
          sentDateTime: toIsoString(message.envelope?.date),
          isRead: Array.isArray(message.flags) ? message.flags.includes("\\Seen") : false,
          importance: "normal",
          hasAttachments: Boolean(message.bodyStructure?.childNodes?.some((part) => part.disposition === "attachment")),
          bodyPreview: "",
          webLink: null
        });
      }

      return {
        messages: messages.sort((a, b) => {
          const left = Number(a.id) || 0;
          const right = Number(b.id) || 0;
          return right - left;
        }),
        totalCount: exists
      };
    } finally {
      lock.release();
    }
  }, proxyUrl);
}

function isInboxCandidate(folderId: string) {
  const normalized = folderId.toLowerCase();
  return normalized === "inbox" || normalized.includes("收件箱");
}

async function resolveInboxPath(client: ImapFlow, cachedFolderId?: string | null) {
  if (cachedFolderId) {
    try {
      const lock = await client.getMailboxLock(cachedFolderId);
      lock.release();
      return cachedFolderId;
    } catch {
      // Cached folder ids can become stale after mailbox localization or server changes.
    }
  }

  const mailboxes = await client.list();
  const inbox = mailboxes.find((mailbox) => typeof mailbox.path === "string" && isInboxCandidate(mailbox.path));
  return inbox?.path || "";
}

async function fetchImapSummaries(client: ImapFlow, uidRange: string, limit: number) {
  const messages: MailMessageSummary[] = [];

  for await (const message of client.fetch(
    uidRange,
    {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
      internalDate: true,
      source: { maxLength: 0 }
    },
    { uid: true }
  )) {
    messages.push({
      id: String(message.uid),
      subject: cleanText(message.envelope?.subject) || "(无主题)",
      from: headerAddress(message.envelope?.from?.[0]),
      receivedDateTime: toIsoString(message.internalDate),
      sentDateTime: toIsoString(message.envelope?.date),
      isRead: Array.isArray(message.flags) ? message.flags.includes("\\Seen") : false,
      importance: "normal",
      hasAttachments: Boolean(message.bodyStructure?.childNodes?.some((part) => part.disposition === "attachment")),
      bodyPreview: "",
      webLink: null
    });
  }

  return messages.sort((a, b) => {
    const left = Number(a.id) || 0;
    const right = Number(b.id) || 0;
    return right - left;
  }).slice(0, limit);
}

export async function refreshImapInbox(
  email: string,
  accessToken: string,
  top = 30,
  afterUid = "",
  cachedFolderId: string | null = null,
  proxyUrl = ""
): Promise<ImapRefreshResult> {
  return withClient(email, accessToken, async (client) => {
    const inboxFolderId = await resolveInboxPath(client, cachedFolderId);
    if (!inboxFolderId) {
      return { messages: [], totalCount: 0, inboxFolderId: "", cursor: null };
    }

    const lock = await client.getMailboxLock(inboxFolderId);

    try {
      const exists = client.mailbox && client.mailbox.exists ? client.mailbox.exists : 0;
      const uidNext = client.mailbox && client.mailbox.uidNext ? client.mailbox.uidNext : 0;
      const lastUid = Number(afterUid) || 0;
      const currentCursor = uidNext > 1 ? String(uidNext - 1) : afterUid || null;

      if (exists === 0 || (lastUid > 0 && uidNext > 0 && uidNext <= lastUid + 1)) {
        return { messages: [], totalCount: exists, inboxFolderId, cursor: currentCursor };
      }

      const limit = Math.min(Math.max(top, 1), 100);
      const uidRange = lastUid > 0 ? `${lastUid + 1}:*` : `${Math.max(1, uidNext - limit)}:*`;
      const matchedUids = await client.search({ uid: uidRange }, { uid: true });
      const selectedUids = (Array.isArray(matchedUids) ? matchedUids : []).slice(-limit);

      if (selectedUids.length === 0) {
        return { messages: [], totalCount: exists, inboxFolderId, cursor: currentCursor };
      }

      const messages = await fetchImapSummaries(client, selectedUids.join(","), limit);
      const maxUid = messages.reduce((value, message) => Math.max(value, Number(message.id) || 0), lastUid);
      return {
        messages,
        totalCount: exists,
        inboxFolderId,
        cursor: maxUid > 0 ? String(maxUid) : currentCursor
      };
    } finally {
      lock.release();
    }
  }, proxyUrl);
}

export async function getImapMessage(email: string, accessToken: string, folderId: string, messageId: string, proxyUrl = "") {
  return withClient(email, accessToken, async (client): Promise<MailMessageDetail> => {
    const lock = await client.getMailboxLock(folderId);

    try {
      const message = await client.fetchOne(messageId, {
        uid: true,
        flags: true,
        envelope: true,
        source: true,
        internalDate: true
      }, { uid: true });

      if (!message) {
        throw new Error("邮件不存在");
      }

      let content = "";
      let contentType = "text";

      if (message.source) {
        const parsed = await simpleParser(Buffer.from(message.source));

        if (parsed.html) {
          if (typeof parsed.html === "string") {
            content = parsed.html;
          } else {
            content = String(parsed.html);
          }
          contentType = "html";
        } else {
          content = parsed.textAsHtml || parsed.text || "";
        }
      }

      return {
        id: String(message.uid),
        subject: cleanText(message.envelope?.subject) || "(无主题)",
        from: headerAddress(message.envelope?.from?.[0]),
        receivedDateTime: toIsoString(message.internalDate),
        sentDateTime: toIsoString(message.envelope?.date),
        isRead: Array.isArray(message.flags) ? message.flags.includes("\\Seen") : false,
        importance: "normal",
        hasAttachments: false,
        bodyPreview: cleanText(content).slice(0, 180),
        webLink: null,
        toRecipients: headerAddressList(message.envelope?.to),
        ccRecipients: headerAddressList(message.envelope?.cc),
        body: {
          contentType,
          content
        }
      };
    } finally {
      lock.release();
    }
  }, proxyUrl);
}

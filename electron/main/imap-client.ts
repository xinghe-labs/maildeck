import { ImapFlow, type MessageStructureObject } from "imapflow";
import type { Readable } from "node:stream";
import { MailContentTooLargeError, isMailContentTooLargeError } from "./mail-errors.js";
import { parseMailSourceContent } from "./mail-source-parser.js";
import { normalizeMailText } from "./mail-text-normalizer.js";
import { normalizeMailDate } from "./mail-date-normalizer.js";
import type { MailFolder, MailMessageDetail, MailMessageSummary } from "./types.js";

interface ImapMessageListResult {
  messages: MailMessageSummary[];
  totalCount: number;
}

interface ImapRefreshResult extends ImapMessageListResult {
  inboxFolderId: string;
  cursor: string | null;
}

export const IMAP_FULL_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAP_TEXT_PART_MAX_BYTES = 4 * 1024 * 1024;
const IMAP_TEXT_PART_RAW_MAX_BYTES = IMAP_TEXT_PART_MAX_BYTES * 3;
const IMAP_PART_HEADER_MAX_BYTES = 64 * 1024;

function cleanText(value: string | undefined | null) {
  return normalizeMailText(value).replace(/\r/g, "").trim();
}

function headerAddress(address: { name?: string; address?: string } | undefined | null) {
  if (!address) {
    return null;
  }

  return {
    name: normalizeMailText(address.name),
    address: address.address || ""
  };
}

function headerAddressList(items: Array<{ name?: string; address?: string }> | undefined) {
  return (items || []).map((item) => ({
    name: normalizeMailText(item.name),
    address: item.address || ""
  }));
}

async function withClient<T>(
  email: string,
  accessToken: string,
  handler: (client: ImapFlow) => Promise<T>,
  proxyUrl = "",
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
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
  const onAbort = () => client.close();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await client.connect();
    signal?.throwIfAborted();
    const result = await handler(client);
    signal?.throwIfAborted();
    if (deferredErrors.length > 0) {
      throw deferredErrors[0];
    }
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    try {
      if (!signal?.aborted) {
        await client.logout().catch(() => undefined);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.throwIfAborted();
  }
}

function mimeType(node: MessageStructureObject) {
  return node.type.toLowerCase();
}

function hasAttachmentMetadata(node: MessageStructureObject) {
  return (
    node.disposition?.toLowerCase() === "attachment" ||
    Boolean(node.dispositionParameters?.filename?.trim()) ||
    Boolean(node.parameters?.name?.trim()) ||
    mimeType(node) === "message/rfc822"
  );
}

function preferredTextParts(root: MessageStructureObject | undefined): MessageStructureObject[] {
  if (!root || hasAttachmentMetadata(root)) {
    return [];
  }

  const type = mimeType(root);
  if (
    (type === "text/html" || type === "text/plain") &&
    (Boolean(root.part) || !(root.childNodes?.length))
  ) {
    return [root];
  }

  const branches = (root.childNodes || []).map((child) => preferredTextParts(child));
  if (type === "multipart/alternative") {
    const candidates = branches.flat();
    return [
      ...candidates.filter((candidate) => mimeType(candidate) === "text/html"),
      ...candidates.filter((candidate) => mimeType(candidate) === "text/plain")
    ];
  }
  return branches.find((branch) => branch.length > 0) || [];
}

function hasAttachment(root: MessageStructureObject | undefined, nested = false): boolean {
  if (!root) {
    return false;
  }
  const type = mimeType(root);
  if (
    hasAttachmentMetadata(root) ||
    (nested && !type.startsWith("multipart/") && !type.startsWith("text/"))
  ) {
    return true;
  }
  return (root.childNodes || []).some((child) => hasAttachment(child, true));
}

async function readBoundedStream(
  stream: Readable,
  limitBytes: number,
  signal?: AbortSignal
) {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > limitBytes) {
      stream.destroy();
      throw new MailContentTooLargeError(limitBytes);
    }
    chunks.push(bytes);
  }
  signal?.throwIfAborted();
  return Buffer.concat(chunks, total);
}

async function downloadPreferredTextPart(
  client: ImapFlow,
  messageId: string,
  bodyStructure: MessageStructureObject | undefined,
  signal?: AbortSignal
) {
  const parts = preferredTextParts(bodyStructure);
  if (parts.length === 0) {
    throw new MailContentTooLargeError(IMAP_FULL_SOURCE_MAX_BYTES);
  }

  let lastTooLargeError: MailContentTooLargeError | null = null;
  for (const part of parts) {
    try {
      return await downloadTextPart(client, messageId, bodyStructure, part, signal);
    } catch (error) {
      if (!isMailContentTooLargeError(error)) {
        throw error;
      }
      lastTooLargeError = error;
    }
  }
  throw lastTooLargeError || new MailContentTooLargeError(IMAP_TEXT_PART_MAX_BYTES);
}

async function downloadTextPart(
  client: ImapFlow,
  messageId: string,
  bodyStructure: MessageStructureObject | undefined,
  part: MessageStructureObject,
  signal?: AbortSignal
) {
  const isSingleNode = part === bodyStructure && !(bodyStructure?.childNodes?.length);
  const partId = part.part || (isSingleNode ? "1" : "");
  if (!partId) {
    throw new Error("邮件正文不存在");
  }
  const headerKey = isSingleNode ? "header" : `${partId}.mime`;
  const bodyKey = isSingleNode ? "text" : partId;
  const response = await client.fetchOne(messageId, {
    bodyParts: [
      { key: headerKey, maxLength: IMAP_PART_HEADER_MAX_BYTES + 1 },
      { key: bodyKey, maxLength: IMAP_TEXT_PART_RAW_MAX_BYTES + 1 }
    ]
  }, { uid: true });
  signal?.throwIfAborted();
  if (!response) {
    throw new Error("邮件正文不存在");
  }

  const headers = headerKey === "header" ? response.headers : response.bodyParts?.get(headerKey);
  const body = response.bodyParts?.get(bodyKey);
  if (!headers || !body) {
    throw new Error("邮件正文不存在");
  }
  if (headers.byteLength > IMAP_PART_HEADER_MAX_BYTES || body.byteLength > IMAP_TEXT_PART_RAW_MAX_BYTES) {
    throw new MailContentTooLargeError(IMAP_TEXT_PART_MAX_BYTES);
  }

  const hasSeparator = headers.subarray(-4).equals(Buffer.from("\r\n\r\n", "ascii")) ||
    headers.subarray(-2).equals(Buffer.from("\n\n", "ascii"));
  const parsed = await parseMailSourceContent(Buffer.concat([
    headers,
    ...(hasSeparator ? [] : [Buffer.from("\r\n\r\n", "ascii")]),
    body
  ]));
  if (Buffer.byteLength(parsed.content, "utf8") > IMAP_TEXT_PART_MAX_BYTES) {
    throw new MailContentTooLargeError(IMAP_TEXT_PART_MAX_BYTES);
  }
  return parsed;
}

async function downloadFullSource(
  client: ImapFlow,
  messageId: string,
  signal?: AbortSignal
) {
  const download = await client.download(messageId, undefined, {
    uid: true,
    maxBytes: IMAP_FULL_SOURCE_MAX_BYTES + 1
  });
  signal?.throwIfAborted();
  if (!download?.content) {
    throw new Error("邮件正文不存在");
  }

  const source = await readBoundedStream(download.content, IMAP_FULL_SOURCE_MAX_BYTES, signal);
  return parseMailSourceContent(source);
}

export async function listImapFolders(
  email: string,
  accessToken: string,
  proxyUrl = "",
  signal?: AbortSignal
): Promise<MailFolder[]> {
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
  }, proxyUrl, signal);
}

export async function listImapMessages(
  email: string,
  accessToken: string,
  folderId: string,
  top = 30,
  search = "",
  cursor = "",
  proxyUrl = "",
  signal?: AbortSignal
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
      // imapflow 在搜索命令被服务器拒绝（NO/BAD）时返回 false 而不是空数组；
      // 此时必须报错，绝不能静默当作“无搜索/无结果”。
      const matchedUids = query
        ? await client.search({ subject: query }, { uid: true }).then(
            (value) => {
              if (!Array.isArray(value)) {
                throw new Error("IMAP 搜索命令被服务器拒绝");
              }
              return value;
            }
          )
        : null;
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
          internalDate: true
        },
        { uid: true }
      )) {
        const subject = cleanText(message.envelope?.subject) || "(无主题)";
        messages.push({
          id: String(message.uid),
          subject,
          from: headerAddress(message.envelope?.from?.[0]),
          receivedDateTime: normalizeMailDate(message.internalDate),
          sentDateTime: normalizeMailDate(message.envelope?.date),
          isRead: Array.isArray(message.flags) ? message.flags.includes("\\Seen") : false,
          importance: "normal",
          hasAttachments: hasAttachment(message.bodyStructure),
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
  }, proxyUrl, signal);
}

export async function listNewImapMessages(
  email: string,
  accessToken: string,
  folderId: string,
  top = 30,
  afterUid = "",
  proxyUrl = "",
  signal?: AbortSignal
): Promise<ImapMessageListResult> {
  return withClient(email, accessToken, async (client) => {
    const lock = await client.getMailboxLock(folderId);

    try {
      const exists = client.mailbox && client.mailbox.exists ? client.mailbox.exists : 0;
      if (exists === 0) {
        return { messages: [], totalCount: 0 };
      }

      const lastUid = Number(afterUid) || 0;
      // 搜索被拒绝（false）时报错，不得静默当作“没有新邮件”。
      const matchedUids = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
      if (!Array.isArray(matchedUids)) {
        throw new Error("IMAP 搜索命令被服务器拒绝");
      }
      const selectedUids = matchedUids.slice(-Math.min(Math.max(top, 1), 100));

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
          internalDate: true
        },
        { uid: true }
      )) {
        messages.push({
          id: String(message.uid),
          subject: cleanText(message.envelope?.subject) || "(无主题)",
          from: headerAddress(message.envelope?.from?.[0]),
          receivedDateTime: normalizeMailDate(message.internalDate),
          sentDateTime: normalizeMailDate(message.envelope?.date),
          isRead: Array.isArray(message.flags) ? message.flags.includes("\\Seen") : false,
          importance: "normal",
          hasAttachments: hasAttachment(message.bodyStructure),
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
  }, proxyUrl, signal);
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
      internalDate: true
    },
    { uid: true }
  )) {
    messages.push({
      id: String(message.uid),
      subject: cleanText(message.envelope?.subject) || "(无主题)",
      from: headerAddress(message.envelope?.from?.[0]),
      receivedDateTime: normalizeMailDate(message.internalDate),
      sentDateTime: normalizeMailDate(message.envelope?.date),
      isRead: Array.isArray(message.flags) ? message.flags.includes("\\Seen") : false,
      importance: "normal",
      hasAttachments: hasAttachment(message.bodyStructure),
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
  proxyUrl = "",
  signal?: AbortSignal
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
      // 搜索被拒绝（false）时必须报错；若当作空结果返回，调用方会把增量游标
      // 推进到 uidNext-1，这批邮件之后永远不会被增量刷新报告。
      const matchedUids = await client.search({ uid: uidRange }, { uid: true });
      if (!Array.isArray(matchedUids)) {
        throw new Error("IMAP 搜索命令被服务器拒绝");
      }
      const selectedUids = matchedUids.slice(-limit);

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
  }, proxyUrl, signal);
}

export async function getImapMessage(
  email: string,
  accessToken: string,
  folderId: string,
  messageId: string,
  proxyUrl = "",
  signal?: AbortSignal
) {
  return withClient(email, accessToken, async (client): Promise<MailMessageDetail> => {
    const lock = await client.getMailboxLock(folderId);

    try {
      const message = await client.fetchOne(messageId, {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        size: true,
        bodyStructure: true
      }, { uid: true });

      if (!message) {
        throw new Error("邮件不存在");
      }

      let content = "";
      let contentType = "text";
      let previewText = "";

      if ((message.size || 0) > IMAP_FULL_SOURCE_MAX_BYTES) {
        const parsed = await downloadPreferredTextPart(client, messageId, message.bodyStructure, signal);
        content = parsed.content;
        contentType = parsed.contentType;
        previewText = parsed.previewText;
      } else {
        const parsed = await downloadFullSource(client, messageId, signal);
        content = parsed.content;
        contentType = parsed.contentType;
        previewText = parsed.previewText;
      }

      return {
        id: String(message.uid),
        subject: cleanText(message.envelope?.subject) || "(无主题)",
        from: headerAddress(message.envelope?.from?.[0]),
        receivedDateTime: normalizeMailDate(message.internalDate),
        sentDateTime: normalizeMailDate(message.envelope?.date),
        isRead: Array.isArray(message.flags) ? message.flags.includes("\\Seen") : false,
        importance: "normal",
        hasAttachments: hasAttachment(message.bodyStructure),
        bodyPreview: cleanText(previewText).slice(0, 180),
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
  }, proxyUrl, signal);
}

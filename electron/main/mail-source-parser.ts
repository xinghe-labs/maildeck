import { Joiner, Splitter, Streamer, type MimeNode, type SplitterChunk } from "@zone-eu/mailsplit";
import { simpleParser } from "mailparser";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MailParseFailedError, isMailParseFailedError } from "./mail-errors.js";
import { mojibakeScore, normalizeMailText } from "./mail-text-normalizer.js";

export interface ParsedMailContentInput {
  html?: string | boolean;
  text?: string;
  textAsHtml?: string;
}

export interface ParsedMailContent {
  contentType: "html" | "text";
  content: string;
  previewText: string;
}

const MAX_CHARSET_REPAIR_BYTES = 13 * 1024 * 1024;
const MAX_MIME_HEADER_BYTES = 1024 * 1024;
const CHARSET_REPAIR_CANDIDATES = ["utf-8", "gb18030", "windows-1252"] as const;

export function selectParsedMailContent(parsed: ParsedMailContentInput): ParsedMailContent {
  const html = typeof parsed.html === "string" ? normalizeMailText(parsed.html) : "";
  const text = normalizeMailText(parsed.text);
  const textAsHtml = normalizeMailText(parsed.textAsHtml);

  if (html) {
    return { contentType: "html", content: html, previewText: text };
  }
  if (text) {
    return { contentType: "text", content: text, previewText: text };
  }
  if (textAsHtml) {
    return { contentType: "html", content: textAsHtml, previewText: "" };
  }
  return { contentType: "text", content: "", previewText: "" };
}

function normalizeCharset(charset: string | false) {
  const value = (charset || "utf-8").trim().toLowerCase().replace(/^['"]|['"]$/gu, "");
  if (["ascii", "us-ascii", "utf8"].includes(value)) {
    return value === "utf8" ? "utf-8" : value;
  }
  if (["gb2312", "gbk", "x-gbk", "cp936"].includes(value)) {
    return "gb18030";
  }
  if (["latin1", "iso8859-1"].includes(value)) {
    return "iso-8859-1";
  }
  return value;
}

function decodePart(bytes: Buffer, charset: string, fatal: boolean) {
  try {
    return new TextDecoder(charset, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

function chooseRepairCharset(bytes: Buffer, declaredCharset: string | false) {
  const currentCharset = normalizeCharset(declaredCharset);
  const currentStrict = decodePart(bytes, currentCharset, true);
  if (currentCharset === "utf-8" && currentStrict !== null) {
    return null;
  }

  const currentText = currentStrict ?? decodePart(bytes, currentCharset, false);
  if (currentText === null) {
    return null;
  }

  const currentScore = mojibakeScore(currentText);
  if (currentScore === 0) {
    return null;
  }

  let bestCharset = currentCharset;
  let bestScore = currentScore;
  for (const charset of CHARSET_REPAIR_CANDIDATES) {
    if (charset === currentCharset) {
      continue;
    }
    const candidate = decodePart(bytes, charset, true);
    if (candidate === null) {
      continue;
    }
    const score = mojibakeScore(candidate);
    if (score < bestScore) {
      bestCharset = charset;
      bestScore = score;
    }
  }

  return bestScore < currentScore ? bestCharset : null;
}

function isMessageBodyTextNode(node: MimeNode) {
  return (
    (node.contentType === "text/plain" || node.contentType === "text/html") &&
    node.disposition !== "attachment"
  );
}

function objectSink() {
  return new Writable({
    objectMode: true,
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
}

async function findCharsetRepairs(source: Buffer) {
  const repairs = new Map<number, string>();
  const splitter = new Splitter({ maxHeadSize: MAX_MIME_HEADER_BYTES });
  const streamer = new Streamer(isMessageBodyTextNode);
  let textPartIndex = 0;

  streamer.on("node", ({ node, decoder, done }) => {
    const partIndex = textPartIndex;
    textPartIndex += 1;
    const chunks: Buffer[] = [];
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      if (error) {
        streamer.destroy(error);
      }
      done();
    };

    decoder.on("data", (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    decoder.once("error", (error) => finish(error));
    decoder.once("end", () => {
      try {
        const charset = chooseRepairCharset(Buffer.concat(chunks), node.charset);
        if (charset) {
          repairs.set(partIndex, charset);
        }
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  await pipeline(Readable.from([source]), splitter, streamer, objectSink());
  return repairs;
}

async function applyCharsetRepairs(source: Buffer, repairs: Map<number, string>) {
  const output: Buffer[] = [];
  const splitter = new Splitter({ maxHeadSize: MAX_MIME_HEADER_BYTES });
  const joiner = new Joiner();
  let textPartIndex = 0;
  const updateHeaders = new Transform({
    readableObjectMode: true,
    writableObjectMode: true,
    transform(chunk: SplitterChunk, _encoding, callback) {
      if (chunk.type === "node" && isMessageBodyTextNode(chunk)) {
        const charset = repairs.get(textPartIndex);
        textPartIndex += 1;
        if (charset) {
          chunk.setCharset(charset);
        }
      }
      callback(null, chunk);
    }
  });
  joiner.on("data", (chunk) => output.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  await pipeline(Readable.from([source]), splitter, updateHeaders, joiner);
  return Buffer.concat(output);
}

async function repairMailSourceCharsets(source: Buffer) {
  if (source.byteLength > MAX_CHARSET_REPAIR_BYTES) {
    return source;
  }

  try {
    const repairs = await findCharsetRepairs(source);
    return repairs.size > 0 ? await applyCharsetRepairs(source, repairs) : source;
  } catch {
    return source;
  }
}

export async function parseMailSourceContent(source: Buffer): Promise<ParsedMailContent> {
  try {
    const parsed = await simpleParser(await repairMailSourceCharsets(source));
    return selectParsedMailContent(parsed);
  } catch (error) {
    if (isMailParseFailedError(error)) {
      throw error;
    }
    throw new MailParseFailedError(error);
  }
}

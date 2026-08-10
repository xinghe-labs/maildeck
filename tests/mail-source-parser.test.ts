import { describe, expect, it } from "vitest";
import {
  parseMailSourceContent,
  selectParsedMailContent
} from "../electron/main/mail-source-parser.js";

function rawMessage(contentType: string, body: Buffer, transferEncoding = "8bit") {
  return Buffer.concat([
    Buffer.from(
      [
        "MIME-Version: 1.0",
        `Content-Type: ${contentType}`,
        `Content-Transfer-Encoding: ${transferEncoding}`,
        "",
        ""
      ].join("\r\n"),
      "ascii"
    ),
    body
  ]);
}

function multipartAlternative(plainBody: Buffer, htmlBody: Buffer) {
  const boundary = "mail-boundary";
  return Buffer.concat([
    Buffer.from(
      [
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary=${boundary}`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain",
        "Content-Transfer-Encoding: base64",
        "",
        plainBody.toString("base64"),
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        htmlBody.toString("base64"),
        `--${boundary}--`,
        ""
      ].join("\r\n"),
      "ascii"
    )
  ]);
}

describe("mail source parser", () => {
  it("keeps parsed plaintext as text instead of exposing textAsHtml markup", () => {
    expect(
      selectParsedMailContent({
        text: "第一行\n第二行",
        textAsHtml: "<p>第一行<br/>第二行</p>"
      })
    ).toEqual({
      contentType: "text",
      content: "第一行\n第二行",
      previewText: "第一行\n第二行"
    });
  });

  it("prefers a real HTML alternative while retaining plaintext for previews", () => {
    expect(
      selectParsedMailContent({
        html: "<p>正文</p>",
        text: "正文",
        textAsHtml: "<p>正文</p>"
      })
    ).toEqual({
      contentType: "html",
      content: "<p>正文</p>",
      previewText: "正文"
    });
  });

  it("recovers GB18030 text when a legacy message omits its charset", async () => {
    const gb18030Body = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7]);

    await expect(parseMailSourceContent(rawMessage("text/plain", gb18030Body))).resolves.toMatchObject({
      contentType: "text",
      content: "你好，世界",
      previewText: "你好，世界"
    });
  });

  it.each([
    ["base64", (body: Buffer) => Buffer.from(body.toString("base64"), "ascii")],
    ["quoted-printable", (body: Buffer) => Buffer.from([...body].map((byte) => `=${byte.toString(16).padStart(2, "0")}`).join(""), "ascii")]
  ])("recovers charset-less GB18030 through %s transfer encoding", async (encoding, encode) => {
    const gb18030Body = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7]);

    await expect(
      parseMailSourceContent(rawMessage("text/plain", encode(gb18030Body), encoding))
    ).resolves.toMatchObject({
      contentType: "text",
      content: "你好，世界"
    });
  });

  it("recovers UTF-8 text that was incorrectly declared as ISO-8859-1", async () => {
    const source = rawMessage("text/html; charset=iso-8859-1", Buffer.from("<p>你好，世界</p>", "utf8"));

    await expect(parseMailSourceContent(source)).resolves.toMatchObject({
      contentType: "html",
      content: "<p>你好，世界</p>"
    });
  });

  it("does not rewrite correctly declared Western European text", async () => {
    const latin1Body = Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]);

    await expect(
      parseMailSourceContent(rawMessage("text/plain; charset=iso-8859-1", latin1Body))
    ).resolves.toMatchObject({
      contentType: "text",
      content: "Grüße"
    });
  });

  it("does not mistake consecutive ISO-8859-1 accents for mojibake", async () => {
    const content = "ÀÁÂÃÄÅÆÇ ÈÉÊË ÌÍÎÏ";

    await expect(
      parseMailSourceContent(rawMessage("text/plain; charset=iso-8859-1", Buffer.from(content, "latin1")))
    ).resolves.toMatchObject({
      contentType: "text",
      content
    });
  });

  it("does not rewrite Content-Type-looking lines inside the message body", async () => {
    const content = "François\nContent-Type: text/plain; charset=windows-1252\nliteral body text";

    await expect(
      parseMailSourceContent(rawMessage("text/plain; charset=iso-8859-1", Buffer.from(content, "utf8")))
    ).resolves.toMatchObject({
      contentType: "text",
      content
    });
  });

  it("repairs only the broken part in a mixed-charset multipart message", async () => {
    const gb18030Plain = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    const utf8Html = Buffer.from("<p>世界</p>", "utf8");

    await expect(parseMailSourceContent(multipartAlternative(gb18030Plain, utf8Html))).resolves.toMatchObject({
      contentType: "html",
      content: "<p>世界</p>",
      previewText: "你好"
    });
  });

  it("preserves an intentional Unicode replacement symbol in valid UTF-8", async () => {
    const content = "Original replacement: �";

    await expect(
      parseMailSourceContent(rawMessage("text/plain; charset=utf-8", Buffer.from(content, "utf8")))
    ).resolves.toMatchObject({
      contentType: "text",
      content
    });
  });
});

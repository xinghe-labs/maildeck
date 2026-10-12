import createDOMPurify from "dompurify";

const purifier = createDOMPurify(window);
const DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i;
const CID_IMAGE = /^cid:[^\s]+$/i;
const EXTERNAL_LINK = /^(?:https?|mailto|tel):/i;

export const MAIL_DOCUMENT_CSP =
  "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'";

export function isMailHtmlBody(contentType: string) {
  const token = contentType.split(";", 1)[0].trim().toLowerCase();
  return token === "html" || token === "text/html";
}

function decodeCssEscapes(value: string) {
  // CSS 转义形如 "\72"（后跟可选空白）或 "\000072"；先反转义再匹配，
  // 避免 url\28 / u\72 l( 之类的写法绕过声明过滤。
  return value.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_match: string, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16))
  ).replace(/\\(.)/g, "$1");
}

export function sanitizeMailStyle(value: string) {
  return value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const decoded = decodeCssEscapes(declaration);
      return !/(?:url\s*\(|@import|expression\s*\(|-moz-binding)/i.test(decoded);
    })
    .join("; ");
}

purifier.addHook("uponSanitizeAttribute", (node, event) => {
  const tagName = node.tagName.toLowerCase();
  const attributeName = event.attrName.toLowerCase();

  if (attributeName === "style") {
    event.attrValue = sanitizeMailStyle(event.attrValue);
  }
  if (tagName === "img" && attributeName === "src" && !DATA_IMAGE.test(event.attrValue) && !CID_IMAGE.test(event.attrValue)) {
    event.keepAttr = false;
  }
  if (tagName === "a" && attributeName === "href" && !EXTERNAL_LINK.test(event.attrValue)) {
    event.keepAttr = false;
  }
});

purifier.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName.toLowerCase() === "a" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function sanitizeMailHtml(content: string) {
  return purifier.sanitize(content, {
    USE_PROFILES: { html: true },
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
      "meta",
      "link",
      "base",
      "video",
      "audio",
      "source",
      "track"
    ],
    FORBID_ATTR: ["srcset", "background", "formaction"],
    ADD_ATTR: ["target", "rel"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|data:image\/(?:png|gif|jpe?g|webp);base64,)/i
  });
}

export function buildMailHtmlDocument(sanitizedHtml: string) {
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_DOCUMENT_CSP}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;padding:0;background:#fff;color:#17262a;font:14px/1.68 "Segoe UI",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}</style></head><body>${sanitizedHtml}</body></html>`;
}

import createDOMPurify from "dompurify";

const purifier = createDOMPurify(window);
const DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i;
const CID_IMAGE = /^cid:[^\s]+$/i;
const EXTERNAL_LINK = /^(?:https?|mailto|tel):/i;
const REMOTE_IMAGE = /^https?:/i;

/** 被拦下的外部图片：src 换成一张本地透明图，正文 DOM 里不出现任何远程地址。 */
export const BLOCKED_IMAGE_ATTR = "data-blocked-image";

/**
 * 拦下外部图片时用的占位图。
 *
 * 之前是直接删掉 src，结果是 Chromium 把 `<img>` 渲染成“破图”图标 + alt 文字，
 * 用户看到的是一堆碎图标，比不显示还难看（报告 P0-4 的后半段）。
 * 换成一个本地透明 SVG 就既不发请求、也不占网络，又不会出现破图占位。
 */
const TRANSPARENT_PIXEL =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E";

export interface MailHtmlSanitizeOptions {
  /** 用户已明确要求加载外部图片（默认关闭）。 */
  allowRemoteImages?: boolean;
}

export interface MailHtmlSanitizeResult {
  html: string;
  /** 被拦下的外部图片数量，用于在阅读器里给出可操作的提示。 */
  blockedImages: number;
}

// DOMPurify 的 hook 是全局注册的，拿不到单次调用的参数；sanitize 是同步完成的，
// 所以在入口处把本次策略放进模块变量，结束后立即复位。
let activeOptions: Required<MailHtmlSanitizeOptions> = { allowRemoteImages: false };
let blockedImageCount = 0;

export const MAIL_DOCUMENT_CSP =
  "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'";
export const MAIL_DOCUMENT_CSP_WITH_REMOTE_IMAGES =
  "default-src 'none'; img-src data: cid: https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'";

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
    if (REMOTE_IMAGE.test(event.attrValue)) {
      if (!activeOptions.allowRemoteImages) {
        // 不保留原 URL：正文 DOM 里不应出现任何远程地址（避免泄漏 + 避免任何预加载路径），
        // 只留一个标记，阅读器据此提示「已阻止 N 张图片」并提供「显示图片」按钮。
        node.setAttribute(BLOCKED_IMAGE_ATTR, "1");
        event.attrValue = TRANSPARENT_PIXEL;
        blockedImageCount += 1;
      }
    } else {
      event.keepAttr = false;
    }
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
    ADD_ATTR: ["target", "rel", BLOCKED_IMAGE_ATTR],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|data:image\/(?:png|gif|jpe?g|webp);base64,)/i
  });
}

export function sanitizeMailHtmlDetailed(
  content: string,
  options: MailHtmlSanitizeOptions = {}
): MailHtmlSanitizeResult {
  activeOptions = { allowRemoteImages: Boolean(options.allowRemoteImages) };
  blockedImageCount = 0;
  try {
    const html = sanitizeMailHtml(content);
    return { html, blockedImages: blockedImageCount };
  } finally {
    activeOptions = { allowRemoteImages: false };
    blockedImageCount = 0;
  }
}

export function buildMailHtmlDocument(sanitizedHtml: string, options: MailHtmlSanitizeOptions = {}) {
  const csp = options.allowRemoteImages ? MAIL_DOCUMENT_CSP_WITH_REMOTE_IMAGES : MAIL_DOCUMENT_CSP;
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;padding:0;background:#fff;color:#17262a;font:14px/1.68 "Segoe UI",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}</style></head><body>${sanitizedHtml}</body></html>`;
}

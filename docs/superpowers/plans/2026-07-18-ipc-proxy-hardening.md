# IPC and Proxy Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject invalid or oversized renderer requests before business code runs, consolidate public IPC types, and prevent unsupported or credential-bearing proxy settings from being stored or logged unsafely.

**Architecture:** A pure shared contract module owns channel names, public types, Zod request schemas, and request limits. Electron main registers every invoke handler through one validated wrapper, while the sandboxed preload imports shared contracts only as erased TypeScript types so its emitted CommonJS artifact remains standalone. Proxy parsing/redaction stays pure; settings storage version 2 separates proxy components and encrypts the password through the existing `safeStorage` secret helper.

**Tech Stack:** Electron 35, TypeScript 5, Zod 4.4.3, Vitest 4, React 19, Node 22, PowerShell release smoke.

---

## File Structure

- Create `electron/shared/proxy-security.ts`: supported proxy parsing, normalization, reconstruction, and credential redaction with no Electron dependency.
- Create `electron/shared/ipc-contracts.ts`: IPC channel constants, public request/response types, request limits, and Zod schemas.
- Create `electron/main/validated-ipc.ts`: the only main-process wrapper around `ipcMain.handle`.
- Create `electron/main/settings-model.ts`: pure settings v1-to-v2 migration and public/runtime settings projections.
- Modify `electron/main/types.ts`: retain internal-only types and re-export public contract types.
- Modify `src/types.ts`: re-export public contract types instead of duplicating declarations.
- Modify `electron/preload/index.cts`: use shared types and channel-name type checking without runtime local imports.
- Modify `electron/main/ipc.ts`: register all channels through validated schemas and deduplicate bounded batches.
- Modify `electron/main/settings-store.ts`: persist settings version 2 and encrypted proxy passwords.
- Modify `electron/main/error-utils.ts` and `electron/main/index.ts`: redact proxy credentials from renderer-visible errors and process logs.
- Modify `src/App.tsx` and `src/components/SettingsModal.tsx`: use public proxy metadata and a write-only password field.
- Modify `README.md`: document HTTP/HTTPS-only proxy support.
- Create `tests/ipc-contracts.test.ts`, `tests/ipc-handler-boundary.test.ts`, `tests/proxy-security.test.ts`, and `tests/settings-model.test.ts`.
- Modify `package.json` and `package-lock.json`: add exact `zod@4.4.3` while preserving the user's `build.win.icon` hunk.

## Task 1: Define Shared Runtime Contracts

**Files:**
- Create: `electron/shared/proxy-security.ts`
- Create: `electron/shared/ipc-contracts.ts`
- Create: `tests/proxy-security.test.ts`
- Create: `tests/ipc-contracts.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the exact Zod runtime**

Run:

```powershell
npm.cmd install --save-exact zod@4.4.3 --registry=https://registry.npmjs.org/
```

Expected: exit `0`; `zod` is a production dependency because the Electron main process loads request schemas at runtime.

- [ ] **Step 2: Write failing proxy and IPC contract tests**

Create tests that import the not-yet-created modules and assert these exact behaviors:

```ts
import { describe, expect, it } from "vitest";
import {
  IMPORT_TEXT_MAX_BYTES,
  IPC_REQUEST_SCHEMAS,
  parseIpcRequest
} from "../electron/shared/ipc-contracts.js";

describe("IPC request contracts", () => {
  it("bounds import text at 10 MiB", () => {
    expect(parseIpcRequest(IPC_REQUEST_SCHEMAS.importText, ["a".repeat(IMPORT_TEXT_MAX_BYTES)])).toHaveLength(IMPORT_TEXT_MAX_BYTES);
    expect(() => parseIpcRequest(IPC_REQUEST_SCHEMAS.importText, ["a".repeat(IMPORT_TEXT_MAX_BYTES + 1)])).toThrow(
      "IPC request rejected"
    );
  });

  it("deduplicates bounded account batches", () => {
    expect(parseIpcRequest(IPC_REQUEST_SCHEMAS.testMany, [[" a ", "a", "b"]])).toEqual(["a", "b"]);
    expect(() => parseIpcRequest(IPC_REQUEST_SCHEMAS.testMany, [Array.from({ length: 5_001 }, (_, index) => String(index))])).toThrow();
  });

  it("normalizes and bounds mail list requests", () => {
    expect(parseIpcRequest(IPC_REQUEST_SCHEMAS.listMessages, [{ accountId: " a ", top: 100, search: " subject " }])).toMatchObject({
      accountId: "a",
      top: 100,
      search: "subject"
    });
    expect(() => parseIpcRequest(IPC_REQUEST_SCHEMAS.listMessages, [{ accountId: "a", top: 101 }])).toThrow();
    expect(() => parseIpcRequest(IPC_REQUEST_SCHEMAS.listMessages, [{ accountId: "a", cursor: "x".repeat(129) }])).toThrow();
  });

  it("accepts only closed job kinds and strict setting keys", () => {
    expect(parseIpcRequest(IPC_REQUEST_SCHEMAS.cancelJob, ["refreshBackground"])).toBe("refreshBackground");
    expect(() => parseIpcRequest(IPC_REQUEST_SCHEMAS.cancelJob, ["other"])).toThrow();
    expect(() => parseIpcRequest(IPC_REQUEST_SCHEMAS.updateSettings, [{ batchConcurrency: 4, unexpected: true }])).toThrow();
  });
});
```

`tests/proxy-security.test.ts` must cover empty/direct mode, HTTP and HTTPS normalization, SOCKS/FTP rejection, credential extraction, and redaction that never returns the original password.

- [ ] **Step 3: Run focused tests to verify RED**

Run:

```powershell
npm.cmd test -- tests/ipc-contracts.test.ts tests/proxy-security.test.ts
```

Expected: FAIL because `electron/shared/ipc-contracts.ts` and `proxy-security.ts` do not exist.

- [ ] **Step 4: Implement pure proxy parsing**

Implement this public surface in `electron/shared/proxy-security.ts`:

```ts
export type SupportedProxyProtocol = "http:" | "https:";
export type StoredProxyProtocol = SupportedProxyProtocol | "socks:" | "socks4:" | "socks5:";

export interface ParsedProxyUrl {
  protocol: StoredProxyProtocol;
  hostname: string;
  port: string;
  username: string;
  password: string;
  supported: boolean;
}

export function parseProxyUrl(value: string, allowLegacySocks = false): ParsedProxyUrl | null;
export function formatProxyUrl(proxy: Omit<ParsedProxyUrl, "password">, password?: string): string;
export function formatPublicProxyUrl(proxy: Omit<ParsedProxyUrl, "password">): string;
export function redactProxyCredentials(value: string): string;
```

Rules: trim input; empty means direct mode; accept only `http:`/`https:` for new input; accept SOCKS schemes only when migrating legacy settings; reject path, query, hash, missing hostname, and URLs longer than 2,048 characters; decode username/password safely; reconstruct through the structured `URL` API; replace any password in HTTP/HTTPS/SOCKS URLs with `***` in error text.

- [ ] **Step 5: Implement shared channels, public types, and request schemas**

`electron/shared/ipc-contracts.ts` must export:

```ts
export const IMPORT_TEXT_MAX_BYTES = 10 * 1024 * 1024;
export const ACCOUNT_BATCH_MAX = 5_000;
export const MAIL_PAGE_MAX = 100;
export const SEARCH_MAX_CHARS = 500;
export const CURSOR_MAX_CHARS = 128;

export const IPC_CHANNELS = {
  accountsList: "accounts:list",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  jobsCancel: "jobs:cancel",
  accountsPreviewImportText: "accounts:previewImportText",
  accountsImportText: "accounts:importText",
  accountsImportFile: "accounts:importFile",
  accountsUpsert: "accounts:upsert",
  accountsUpdate: "accounts:update",
  accountsDelete: "accounts:delete",
  accountsTest: "accounts:test",
  accountsTestFallback: "accounts:testFallback",
  accountsTestMany: "accounts:testMany",
  mailListFolders: "mail:listFolders",
  mailListMessages: "mail:listMessages",
  mailGetMessage: "mail:getMessage",
  mailClearCache: "mail:clearCache",
  mailRefreshMany: "mail:refreshMany"
} as const;

export const IPC_EVENT_CHANNELS = {
  accountsTestProgress: "accounts:testProgress",
  mailRefreshProgress: "mail:refreshProgress"
} as const;
```

Define Zod schemas for every invoke channel. Use tuple schemas because Electron supplies positional arguments, and transform their output into the existing ergonomic request shape. Account IDs are trimmed non-empty strings of at most 128 characters; batch arrays are capped at 5,000 before deduplication. Import text is capped at 10 MiB. Account input fields, message IDs, search, cursors, page sizes, skips, dates, settings, and job kinds are strict and bounded. Proxy URL validation delegates to `parseProxyUrl` and produces the normalized URL.

`parseIpcRequest(schema, args)` must throw a safe `Error` prefixed with `IPC request rejected:` and include only issue paths/messages, never input values.

Public types formerly duplicated in `electron/main/types.ts` and `src/types.ts` move here. Add:

```ts
export interface AppSettings {
  cacheMessages: boolean;
  cacheBodies: boolean;
  proxyUrl: string;
  proxyUsername: string;
  proxyHasPassword: boolean;
  proxySupported: boolean;
  batchConcurrency: number;
  hotmailFallbackEnabled: boolean;
  autoRefreshEnabled: boolean;
  autoRefreshIntervalMinutes: number;
}

export type AppSettingsUpdate = z.input<typeof appSettingsUpdateSchema>;
```

The update schema includes write-only `proxyPassword?: string` and `clearProxyPassword?: boolean`, but the returned `AppSettings` never contains the password.

- [ ] **Step 6: Verify contracts and commit without the icon hunk**

Run:

```powershell
npm.cmd test -- tests/ipc-contracts.test.ts tests/proxy-security.test.ts
npm.cmd test
npm.cmd run typecheck
```

Stage the new modules/tests, lockfile, and only the Zod dependency hunk from `package.json`. Confirm `git diff --cached -- package.json` does not contain `build.win.icon`, then commit:

```powershell
git commit -m "security: define shared ipc contracts"
```

## Task 2: Consolidate Types Without Breaking the Sandboxed Preload

**Files:**
- Modify: `electron/main/types.ts`
- Modify: `src/types.ts`
- Modify: `electron/preload/index.cts`
- Modify: `electron/main/ipc.ts`
- Create: `tests/preload-contract-boundary.test.ts`

- [ ] **Step 1: Write the preload boundary regression test**

The test reads `electron/preload/index.cts` and asserts that every non-Electron import starts with `import type`, that no `zod` runtime import exists, and that the source references the shared `IpcInvokeChannel`/`IpcEventChannel` types. It also asserts all values in `IPC_CHANNELS` and `IPC_EVENT_CHANNELS` are unique.

- [ ] **Step 2: Run it before refactoring**

Run:

```powershell
npm.cmd test -- tests/preload-contract-boundary.test.ts
```

Expected: FAIL because the preload does not yet import the shared channel types.

- [ ] **Step 3: Re-export the shared public types**

Keep only `AccountRecord` and `AccessTokenResult` as declarations in `electron/main/types.ts`; import the shared types needed by those internal declarations and re-export the public type set from `../shared/ipc-contracts.js`.

Replace `src/types.ts` with type-only re-exports from `../electron/shared/ipc-contracts` so existing renderer imports remain unchanged.

- [ ] **Step 4: Keep preload runtime imports standalone**

In `electron/preload/index.cts`, import all API types plus `IpcInvokeChannel` and `IpcEventChannel` with `import type`. Add typed wrappers around `ipcRenderer.invoke`, `ipcRenderer.on`, and `ipcRenderer.removeListener`; keep channel literals in the preload but require them to satisfy the shared channel union. Do not runtime-import `IPC_CHANNELS`, schemas, Zod, or any local module.

- [ ] **Step 5: Use channel constants in the main process**

Replace literal invoke and event channel strings in `electron/main/ipc.ts` with `IPC_CHANNELS` and `IPC_EVENT_CHANNELS`. Main is allowed to runtime-import the shared module.

- [ ] **Step 6: Verify source, compiled preload, and commit**

Run:

```powershell
npm.cmd test -- tests/preload-contract-boundary.test.ts
npm.cmd run typecheck
npm.cmd run build:electron
rg -n "require\(" dist-electron/preload/index.cjs
```

Expected: the preload test and both type checks pass; compiled preload contains only `require("electron")` and no local/Zod require.

Commit:

```powershell
git add electron/shared electron/main/types.ts src/types.ts electron/preload/index.cts electron/main/ipc.ts tests/preload-contract-boundary.test.ts
git commit -m "refactor: share ipc contract types"
```

## Task 3: Enforce Schemas at Every IPC Invoke Boundary

**Files:**
- Create: `electron/main/validated-ipc.ts`
- Modify: `electron/main/ipc.ts`
- Create: `tests/ipc-handler-boundary.test.ts`

- [ ] **Step 1: Write the failing boundary test**

Read `electron/main/ipc.ts` and assert it contains no direct `ipcMain.handle(` calls. Read `electron/main/validated-ipc.ts` and assert that it calls `parseIpcRequest(schema, args)` before invoking the business handler. Assert every value from `IPC_CHANNELS` is registered in `ipc.ts` through `handleValidated`.

- [ ] **Step 2: Run it to verify RED**

```powershell
npm.cmd test -- tests/ipc-handler-boundary.test.ts
```

Expected: FAIL because direct handlers still exist and `validated-ipc.ts` is missing.

- [ ] **Step 3: Implement the only validated handler wrapper**

Create:

```ts
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { parseIpcRequest, type IpcInvokeChannel } from "../shared/ipc-contracts.js";

export function handleValidated<Output>(
  channel: IpcInvokeChannel,
  schema: z.ZodType<Output>,
  handler: (event: IpcMainInvokeEvent, request: Output) => unknown | Promise<unknown>
) {
  ipcMain.handle(channel, (event, ...args) => handler(event, parseIpcRequest(schema, args)));
}
```

- [ ] **Step 4: Convert every handler**

Register all invoke channels through `handleValidated(channel, schema, handler)`. The handler receives normalized schema output, not raw renderer values. Specific requirements:

- both import-text handlers receive a string no larger than 10 MiB;
- selected import files are checked with the same import-text schema after reading;
- account batch handlers receive deduplicated arrays capped at 5,000;
- list-message page size is 1-100 and search/cursor values are already trimmed/bounded;
- job kinds are closed enums;
- clear-cache account ID remains optional but bounded;
- settings are strict and proxy URLs are HTTP/HTTPS only.

- [ ] **Step 5: Run focused and full verification**

```powershell
npm.cmd test -- tests/ipc-contracts.test.ts tests/ipc-handler-boundary.test.ts
npm.cmd test
npm.cmd run typecheck
```

- [ ] **Step 6: Commit**

```powershell
git add electron/main/validated-ipc.ts electron/main/ipc.ts tests/ipc-handler-boundary.test.ts
git commit -m "security: validate every ipc request"
```

## Task 4: Encrypt Proxy Credentials in Settings Version 2

**Files:**
- Create: `electron/main/settings-model.ts`
- Create: `tests/settings-model.test.ts`
- Modify: `electron/main/settings-store.ts`
- Modify: `electron/main/ipc.ts`

- [ ] **Step 1: Write failing settings-model tests**

Use deterministic injected `encrypt`/`decrypt` functions. Cover:

1. v1 `http://alice:secret@proxy.example:8080` migrates to version 2, does not contain `secret` in serialized JSON, returns public URL `http://proxy.example:8080`, reports username `alice` and `proxyHasPassword=true`, and reconstructs the credential-bearing runtime URL only in main.
2. v1 SOCKS is preserved as unsupported metadata for correction, never used as a runtime proxy, and returns a clear HTTP/HTTPS-only error.
3. Updating an unchanged endpoint/username with a blank write-only password preserves the encrypted password.
4. Changing endpoint or username clears the old password unless a new password is supplied.
5. `clearProxyPassword=true` removes the encrypted password.
6. Direct mode stores `proxy: null`.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- tests/settings-model.test.ts
```

Expected: FAIL because `settings-model.ts` does not exist.

- [ ] **Step 3: Implement the pure settings model**

Use this persisted shape:

```ts
export interface SettingsFileV2 {
  version: 2;
  settings: {
    cacheMessages: boolean;
    cacheBodies: boolean;
    batchConcurrency: number;
    hotmailFallbackEnabled: boolean;
    autoRefreshEnabled: boolean;
    autoRefreshIntervalMinutes: number;
  };
  proxy: null | {
    protocol: StoredProxyProtocol;
    hostname: string;
    port: string;
    username: string;
    encryptedPassword: string;
  };
}
```

Export pure functions to migrate unknown/v1 data, apply a validated `AppSettingsUpdate`, project safe public settings, and build runtime settings. The crypto dependency is `{ encrypt(value): string; decrypt(value): string }`. A legacy SOCKS entry may be represented only for migration/UI correction; runtime projection must reject it and no new update may create it.

- [ ] **Step 4: Wire the filesystem store**

`settings-store.ts` keeps the existing serialized queue and atomic temp-file rename. On first successful v1 read, write version 2 before returning. If encryption is unavailable, migration with a proxy password throws and leaves the original file untouched. Export:

```ts
export async function getSettings(): Promise<RuntimeAppSettings>;
export async function getPublicSettings(): Promise<AppSettings>;
export async function updateSettings(next: AppSettingsUpdate): Promise<{ settings: AppSettings; proxyChanged: boolean }>;
```

The IPC `settings:get` handler returns only public settings. The update handler clears token/proxy caches only when `proxyChanged` is true.

- [ ] **Step 5: Verify and commit**

```powershell
npm.cmd test -- tests/settings-model.test.ts tests/ipc-contracts.test.ts
npm.cmd test
npm.cmd run typecheck
```

```powershell
git add electron/main/settings-model.ts electron/main/settings-store.ts electron/main/ipc.ts tests/settings-model.test.ts
git commit -m "security: encrypt stored proxy credentials"
```

## Task 5: Redact Proxy Secrets and Update the Settings UI

**Files:**
- Modify: `electron/main/error-utils.ts`
- Modify: `electron/main/index.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/SettingsModal.tsx`
- Modify: `README.md`
- Create: `tests/error-utils.test.ts`

- [ ] **Step 1: Write the failing redaction test**

Assert `normalizeError(new Error("proxy http://alice:secret@127.0.0.1:7890 failed"))` contains `alice`, contains `***`, and contains neither `secret` nor its percent-encoded form. Also assert SOCKS legacy URLs and URL-encoded credentials are redacted.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- tests/error-utils.test.ts
```

Expected: FAIL because current normalized errors include the raw proxy password.

- [ ] **Step 3: Redact renderer errors and process logs**

Call `redactProxyCredentials` before classifying errors in `normalizeError`. Export a `formatErrorForLog(error)` helper that returns a redacted stack/message string. Use it for every `console.warn`/`console.error` call in `electron/main/index.ts` instead of logging raw error objects.

- [ ] **Step 4: Add safe proxy form fields**

The renderer default settings include `proxyUsername`, `proxyHasPassword`, and `proxySupported`. `SettingsModal` keeps `proxyPassword` write-only and blank after loading. It shows:

- base proxy URL with HTTP/HTTPS placeholder;
- optional username;
- password input whose empty value preserves an existing password only when endpoint/username are unchanged;
- a checkbox/button to clear a stored password;
- a visible validation error when migrated SOCKS settings are unsupported.

No password returned by `settings:get` is placed in React state.

- [ ] **Step 5: Correct documentation**

Replace README and settings copy that promises SOCKS support with HTTP/HTTPS-only wording and a clear note that SOCKS is rejected until all transports support it.

- [ ] **Step 6: Verify UI/types/build and commit**

```powershell
npm.cmd test -- tests/error-utils.test.ts tests/proxy-security.test.ts
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

```powershell
git add electron/main/error-utils.ts electron/main/index.ts src/App.tsx src/components/SettingsModal.tsx README.md tests/error-utils.test.ts
git commit -m "security: redact proxy credentials"
```

## Task 6: Verify the Packaged IPC and Proxy Boundary

**Files:**
- Modify: `scripts/verify-release-startup.ps1`
- Modify: this plan when recording results.

- [ ] **Step 1: Extend the existing CDP expression**

In addition to the existing sandbox/CSP fields, evaluate an oversized/invalid settings update through the public bridge and capture whether it rejects with `IPC request rejected` without crashing the renderer. Then read settings and assert no password-shaped field is returned.

- [ ] **Step 2: Run every gate**

```powershell
npm.cmd test
npm.cmd run typecheck
npx.cmd --yes npm@11.18.0 audit --omit=dev --registry=https://registry.npmjs.org/
npm.cmd run build
npm.cmd run dist:win
```

Expected: all tests pass, both type checks pass, production audit reports zero vulnerabilities, build and Windows packaging exit `0`, and the packaged smoke confirms the bridge remains usable while invalid IPC is rejected and no proxy password is exposed.

- [ ] **Step 3: Record outputs and commit**

Mark all checkboxes complete and append test count, audit result, build result, preload require list, packaged smoke fields, and artifact names. Confirm only the user's `package.json` icon hunk remains unstaged, then commit:

```powershell
git add scripts/verify-release-startup.ps1 docs/superpowers/plans/2026-07-18-ipc-proxy-hardening.md
git commit -m "test: verify packaged ipc hardening"
```

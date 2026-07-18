# Verification and Security Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish real automated verification, patch compatible production dependencies, and fix cancellation, refresh timestamp, and pagination regressions without changing the Electron/React framework.

**Architecture:** Vitest exercises pure behavior through focused modules under `tests/`. Cancellation and refresh timestamp decisions move behind small pure interfaces so IPC orchestration cannot silently mutate account health. This plan is the first independently releasable slice of the approved upgrade design; sandbox, shared IPC schemas, Electron 43, and the full Refresh Coordinator are separate follow-on plans.

**Tech Stack:** Electron 35, React 19, TypeScript 5, Vitest 4, Node SQLite, npm lockfile v3.

---

## File Structure

- Create `vitest.config.ts`: Node test discovery and isolation settings.
- Create `tests/import-parser.test.ts`: characterization coverage for supported account formats.
- Create `tests/mail-pagination.test.ts`: current pagination visibility behavior.
- Create `tests/mail-refresh-state.test.ts`: new-mail counting and state-commit policy.
- Create `tests/job-errors.test.ts`: cancellation classification and safe error normalization.
- Create `tests/account-refresh-state.test.ts`: successful versus failed refresh timestamps.
- Create `electron/main/job-errors.ts`: typed cancellation error and cancellation message.
- Create `electron/main/account-refresh-state.ts`: pure refresh timestamp transition.
- Modify `package.json`: real type-check and test commands plus Vitest dependency.
- Modify `package-lock.json`: resolved dependency graph.
- Modify `electron/main/types.ts`: add cancellation result code and flag.
- Modify `src/types.ts`: mirror the temporary renderer contract until the shared-contract plan removes duplication.
- Modify `electron/main/error-utils.ts`: normalize typed cancellation without string matching.
- Modify `electron/main/account-store.ts`: preserve the successful refresh timestamp on failed attempts.
- Modify `electron/main/mail-refresh-state.ts`: decide when list operations may commit incremental state.
- Modify `electron/main/ipc.ts`: use typed cancellation, failure state, and pagination policy.
- Modify `src/App.tsx`: do not offer retry for canceled results.

## Task 1: Add a Real Verification Harness

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/import-parser.test.ts`
- Create: `tests/mail-pagination.test.ts`
- Create: `tests/mail-refresh-state.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Record the existing no-op type-check behavior**

Run:

```powershell
$listed = @(npx.cmd --no-install tsc --listFiles --noEmit --pretty false)
$listed.Count
```

Expected: `0`, proving the root solution config does not check referenced projects.

- [x] **Step 2: Install Vitest without upgrading unrelated packages**

Run:

```powershell
npm.cmd install --save-dev vitest@4.1.10 --registry=https://registry.npmjs.org/
```

Expected: exit code `0`; `package-lock.json` remains lockfile version 3.

- [x] **Step 3: Add explicit scripts and Vitest configuration**

Set these `package.json` scripts while preserving every existing script:

```json
{
  "typecheck:renderer": "tsc -p tsconfig.app.json --noEmit --pretty false",
  "typecheck:electron": "tsc -p electron/tsconfig.json --noEmit --pretty false",
  "typecheck": "npm run typecheck:renderer && npm run typecheck:electron",
  "lint": "npm run typecheck",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true
  }
});
```

- [x] **Step 4: Add characterization tests**

Create `tests/import-parser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAccountImport } from "../electron/main/import-parser.js";

const clientId = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

describe("parseAccountImport", () => {
  it("parses header-based CSV and quoted commas", () => {
    const [account] = parseAccountImport(
      `email,client_id,refresh_token,remark,group\nuser@example.com,${clientId},M.long-token,"primary, mailbox",A`
    );
    expect(account).toEqual({
      email: "user@example.com",
      clientId,
      refreshToken: "M.long-token",
      remark: "primary, mailbox",
      group: "A"
    });
  });

  it("ignores the password field in the six-column dashed format", () => {
    const [account] = parseAccountImport(`user@example.com----password----${clientId}----M.long-token----main----A`);
    expect(account).toMatchObject({ email: "user@example.com", clientId, refreshToken: "M.long-token", remark: "main", group: "A" });
  });
});
```

Create `tests/mail-pagination.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveVisibleMailCursor } from "../src/mail-pagination";

describe("resolveVisibleMailCursor", () => {
  it("keeps a cursor while more messages remain", () => {
    expect(resolveVisibleMailCursor({ cursor: "50", displayedCount: 50, totalCount: 120 })).toBe("50");
  });

  it("hides a cursor after all known messages are displayed", () => {
    expect(resolveVisibleMailCursor({ cursor: "100", displayedCount: 100, totalCount: 100 })).toBeNull();
  });
});
```

Create the initial `tests/mail-refresh-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { countNewMessagesAfterRefresh } from "../electron/main/mail-refresh-state.js";

describe("countNewMessagesAfterRefresh", () => {
  it("counts only messages newer than the previous successful refresh", () => {
    const messages = [
      { receivedDateTime: "2026-07-18T10:01:00.000Z", sentDateTime: null },
      { receivedDateTime: "2026-07-18T09:59:00.000Z", sentDateTime: null }
    ];
    expect(countNewMessagesAfterRefresh(messages, "2026-07-18T10:00:00.000Z")).toBe(1);
  });
});
```

- [x] **Step 5: Run the baseline tests and both real type checks**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
```

Expected: all five characterization assertions pass; both TypeScript projects exit `0`.

- [x] **Step 6: Commit the harness without the user's icon-path hunk**

Stage the new tests, config, lockfile, and only the script/devDependency hunks from `package.json`. Verify `git diff --cached -- package.json` does not include the existing `build.win.icon` change.

Commit:

```powershell
git commit -m "test: add verification baseline"
```

## Task 2: Make Cancellation a First-Class Result

**Files:**
- Create: `electron/main/job-errors.ts`
- Create: `tests/job-errors.test.ts`
- Modify: `electron/main/types.ts`
- Modify: `src/types.ts`
- Modify: `electron/main/error-utils.ts`
- Modify: `electron/main/ipc.ts`
- Modify: `src/App.tsx`

- [x] **Step 1: Write the failing cancellation test**

Create `tests/job-errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeError } from "../electron/main/error-utils.js";
import { JobCanceledError } from "../electron/main/job-errors.js";

describe("JobCanceledError", () => {
  it("normalizes cancellation without treating it as an unknown failure", () => {
    expect(normalizeError(new JobCanceledError("刷新已取消"))).toEqual({
      code: "CANCELED",
      message: "刷新已取消"
    });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/job-errors.test.ts
```

Expected: FAIL because `electron/main/job-errors.ts` does not exist.

- [x] **Step 3: Add the typed cancellation implementation**

Create `electron/main/job-errors.ts`:

```ts
export class JobCanceledError extends Error {
  override readonly name = "JobCanceledError";
}

export function isJobCanceledError(error: unknown): error is JobCanceledError {
  return error instanceof JobCanceledError;
}
```

Add `"CANCELED"` to `AppErrorCode` in both type files. Add `canceled?: boolean` to `RefreshManyResult`.

At the start of `normalizeError`, add:

```ts
if (isJobCanceledError(error)) {
  return { code: "CANCELED", message: error.message };
}
```

Replace the refresh cancellation throw with `new JobCanceledError(cancelError(jobKind))`. In the refresh worker catch, return before account-state mutation:

```ts
if (isJobCanceledError(error)) {
  const message = error.message;
  failed += 1;
  completed += 1;
  metrics.totalMs = elapsedSince(totalStart);
  event.sender.send("mail:refreshProgress", { completed, total, ok, failed, accountId, error: message, code: "CANCELED", metrics });
  return { accountId, ok: false, canceled: true, count: 0, error: message, code: "CANCELED" as AppErrorCode, metrics };
}
```

Use code `CANCELED` for queued batch-test cancellations. Update retry selection and retry-button visibility in `src/App.tsx` to require `!item.ok && !item.canceled`.

- [x] **Step 4: Run the focused and full tests**

Run:

```powershell
npm.cmd test -- tests/job-errors.test.ts
npm.cmd test
npm.cmd run typecheck
```

Expected: focused test passes, full suite passes, type checks exit `0`.

- [x] **Step 5: Commit cancellation behavior**

```powershell
git add electron/main/job-errors.ts electron/main/error-utils.ts electron/main/ipc.ts electron/main/types.ts src/types.ts src/App.tsx tests/job-errors.test.ts
git commit -m "fix: preserve account state on canceled jobs"
```

## Task 3: Preserve the Last Successful Refresh Timestamp

**Files:**
- Create: `electron/main/account-refresh-state.ts`
- Create: `tests/account-refresh-state.test.ts`
- Modify: `electron/main/account-store.ts`
- Modify: `electron/main/ipc.ts`

- [x] **Step 1: Write the failing timestamp transition tests**

Create `tests/account-refresh-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveRefreshFailureStatus, resolveRefreshTimestamps } from "../electron/main/account-refresh-state.js";

describe("resolveRefreshTimestamps", () => {
  const previous = "2026-07-18T09:00:00.000Z";
  const attempted = "2026-07-18T10:00:00.000Z";

  it("advances lastRefreshedAt after success", () => {
    expect(resolveRefreshTimestamps(previous, attempted, true)).toEqual({ lastCheckedAt: attempted, lastRefreshedAt: attempted });
  });

  it("preserves lastRefreshedAt after failure", () => {
    expect(resolveRefreshTimestamps(previous, attempted, false)).toEqual({ lastCheckedAt: attempted, lastRefreshedAt: previous });
  });

  it("preserves account health for transient network failures", () => {
    expect(resolveRefreshFailureStatus("valid", "NETWORK_ERROR")).toBe("valid");
  });

  it("marks credential and permission failures invalid", () => {
    expect(resolveRefreshFailureStatus("valid", "TOKEN_EXPIRED")).toBe("invalid");
    expect(resolveRefreshFailureStatus("valid", "SCOPE_MISSING")).toBe("invalid");
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/account-refresh-state.test.ts
```

Expected: FAIL because `resolveRefreshTimestamps` does not exist.

- [x] **Step 3: Add the pure transition and failure write path**

Create `electron/main/account-refresh-state.ts`:

```ts
import type { AccountStatus, AppErrorCode } from "./types.js";

const INVALID_ACCOUNT_CODES = new Set<AppErrorCode>([
  "TOKEN_EXPIRED",
  "IMAP_AUTH_FAILED",
  "SCOPE_MISSING",
  "MAILBOX_NOT_FOUND"
]);

export function resolveRefreshTimestamps(lastRefreshedAt: string | null | undefined, attemptedAt: string, succeeded: boolean) {
  return {
    lastCheckedAt: attemptedAt,
    lastRefreshedAt: succeeded ? attemptedAt : lastRefreshedAt || null
  };
}

export function resolveRefreshFailureStatus(currentStatus: AccountStatus, code: AppErrorCode): AccountStatus {
  return INVALID_ACCOUNT_CODES.has(code) ? "invalid" : currentStatus;
}
```

Use `resolveRefreshTimestamps` inside `updateAccountRefreshState` with `succeeded=true`, replacing its direct `lastCheckedAt` and `lastRefreshedAt` assignments with the returned values.

Add this complete failure write path to `electron/main/account-store.ts`:

```ts
export async function updateAccountRefreshFailure(
  accountId: string,
  values: {
    status: AccountRecord["status"];
    lastError: string;
    refreshCooldownUntil?: string | null;
  }
): Promise<AccountView> {
  await migrateLegacyAccountsOnce();
  return withStoreLock(async () => {
    const account = getAccountById(accountId);
    if (!account) {
      throw new Error("账号不存在");
    }

    const timestamp = nowIso();
    const refreshTimestamps = resolveRefreshTimestamps(account.lastRefreshedAt, timestamp, false);
    const next: AccountRecord = {
      ...account,
      status: values.status,
      lastError: values.lastError,
      lastCheckedAt: refreshTimestamps.lastCheckedAt,
      lastRefreshedAt: refreshTimestamps.lastRefreshedAt,
      refreshCooldownUntil: values.refreshCooldownUntil ?? account.refreshCooldownUntil ?? null,
      updatedAt: timestamp
    };

    insertOrReplaceAccount(next);
    return toView(next);
  });
}
```

Replace the generic refresh-worker catch call to `updateAccountRefreshState` with:

```ts
await updateAccountRefreshFailure(accountId, {
  status: resolveRefreshFailureStatus(account?.status || "untested", code),
  lastError: message,
  refreshCooldownUntil: cooldownUntilFor(code)
}).catch(() => undefined);
```

Import `resolveRefreshFailureStatus` into `ipc.ts`. Also route the explicit Graph `MAILBOX_NOT_FOUND` failure through `updateAccountRefreshFailure` instead of `updateAccountRefreshState`; a failed mailbox lookup must not advance `lastRefreshedAt`. This keeps `valid` and `untested` accounts unchanged for transient network, parsing, unknown, and cancellation failures while retaining invalid status for credential, permission, and mailbox errors.

- [x] **Step 4: Run tests and type checks**

Run:

```powershell
npm.cmd test -- tests/account-refresh-state.test.ts
npm.cmd test
npm.cmd run typecheck
```

Expected: timestamp tests and full suite pass; type checks exit `0`.

- [x] **Step 5: Commit refresh timestamp behavior**

```powershell
git add electron/main/account-refresh-state.ts electron/main/account-store.ts electron/main/ipc.ts tests/account-refresh-state.test.ts
git commit -m "fix: preserve successful refresh timestamps"
```

## Task 4: Prevent Pagination from Regressing Incremental State

**Files:**
- Modify: `electron/main/mail-refresh-state.ts`
- Modify: `electron/main/ipc.ts`
- Modify: `tests/mail-refresh-state.test.ts`

- [x] **Step 1: Add failing commit-policy tests**

Append to `tests/mail-refresh-state.test.ts`:

```ts
import { shouldCommitMailboxRefreshState } from "../electron/main/mail-refresh-state.js";

describe("shouldCommitMailboxRefreshState", () => {
  it("allows an unfiltered first-page read to update incremental state", () => {
    expect(shouldCommitMailboxRefreshState({ search: "", cursor: null })).toBe(true);
  });

  it("rejects pagination and search reads", () => {
    expect(shouldCommitMailboxRefreshState({ search: "", cursor: "50" })).toBe(false);
    expect(shouldCommitMailboxRefreshState({ search: "invoice", cursor: null })).toBe(false);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/mail-refresh-state.test.ts
```

Expected: FAIL because `shouldCommitMailboxRefreshState` is not exported.

- [x] **Step 3: Implement and use the commit policy**

Add to `electron/main/mail-refresh-state.ts`:

```ts
export function shouldCommitMailboxRefreshState(options: { search?: string; cursor?: string | null }) {
  return !options.search?.trim() && !options.cursor;
}
```

In both IMAP and Graph list branches in `electron/main/ipc.ts`, replace `if (!search)` around account refresh-state writes with:

```ts
if (shouldCommitMailboxRefreshState({ search, cursor: options.cursor })) {
```

Cache page writes remain enabled; only account incremental state is protected.

- [x] **Step 4: Run tests and type checks**

Run:

```powershell
npm.cmd test -- tests/mail-refresh-state.test.ts
npm.cmd test
npm.cmd run typecheck
```

Expected: all tests pass and type checks exit `0`.

- [x] **Step 5: Commit cursor behavior**

```powershell
git add electron/main/mail-refresh-state.ts electron/main/ipc.ts tests/mail-refresh-state.test.ts
git commit -m "fix: keep pagination from regressing refresh cursors"
```

## Task 5: Apply Compatible Security Updates

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Capture the failing production audit**

Run:

```powershell
npm.cmd audit --omit=dev --json --registry=https://registry.npmjs.org/
```

Expected: non-zero exit with 4 high and 2 moderate production vulnerability groups before updates.

- [x] **Step 2: Install only approved compatible versions**

Run:

```powershell
npm.cmd install dompurify@3.4.12 imapflow@1.4.7 mailparser@3.9.14 undici@6.27.0 --save-exact --registry=https://registry.npmjs.org/
npm.cmd install --save-dev electron-builder@26.15.3 --save-exact --registry=https://registry.npmjs.org/
```

Expected: Electron remains on 35.7.5; React, Vite, and TypeScript major versions do not change.

- [x] **Step 3: Re-run audit and dependency checks**

Run:

```powershell
npm.cmd audit --omit=dev --registry=https://registry.npmjs.org/
npm.cmd ls dompurify imapflow mailparser undici electron electron-builder
```

Expected: production audit exits `0`, or any remaining advisory is recorded with the exact dependency path and shipped-code reachability. Installed versions match this task and Electron remains 35.7.5.

- [x] **Step 4: Run the full baseline**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Expected: tests, both type checks, and production build exit `0`.

- [x] **Step 5: Commit dependency updates without the user's icon-path hunk**

Stage `package-lock.json` and only this task's dependency version hunks from `package.json`. Verify the cached diff excludes `build.win.icon`.

Commit:

```powershell
git commit -m "build: patch production dependencies"
```

## Task 6: Validate the Windows Release Baseline

**Files:**
- Modify only if verification exposes a baseline defect.

- [x] **Step 1: Build Windows release assets and run the existing isolated startup smoke test**

Run:

```powershell
npm.cmd run dist:win
```

Expected: Electron Builder produces the portable executable, NSIS installer, and unpacked application; `verify-release-startup.ps1` confirms title, SQLite creation, and icon.

- [x] **Step 2: Verify artifacts and repository state**

Run:

```powershell
Get-ChildItem release -File | Where-Object Name -Match 'Outlook Manager.*0\.1\.7.*\.exe' | Select-Object Name,Length,LastWriteTime
git status --short
```

Expected: current release artifacts exist and are non-empty. Only the pre-existing unstaged icon-path change may remain after all planned commits.

- [x] **Step 3: Record the phase result**

If every gate passes, update this plan's checkboxes and append a short verification note with test count, audit result, build result, and artifact names. Commit only the plan update:

```powershell
git add docs/superpowers/plans/2026-07-18-verification-security-baseline.md
git commit -m "docs: record baseline verification"
```

## Verification Record (2026-07-18)

- Initial root `tsc --listFiles --noEmit` listed `0` files, confirming the former lint command was a no-op.
- Vitest `4.1.10`: `5` test files passed, `12` tests passed, `0` failures.
- Renderer and Electron TypeScript checks both exited `0`.
- Official-registry production audit: `found 0 vulnerabilities`.
- Verified direct versions: DOMPurify `3.4.12`, ImapFlow `1.4.7`, Mailparser `3.9.14`, Undici `6.27.0`, Electron Builder `26.15.3`, Electron `35.7.5`.
- Production build exited `0` with Vite `6.4.2`.
- Windows release build and startup smoke exited `0`: title `Outlook Manager`, SQLite database created, icon center pixel `ff13514e`.
- Artifacts: `Outlook Manager 0.1.7.exe` (`78,907,271` bytes), `Outlook Manager Setup 0.1.7.exe` (`79,081,827` bytes), and its blockmap (`84,461` bytes), plus `release/win-unpacked`.
- Repository state after planned commits contains only the pre-existing unstaged `build.win.icon` path change in `package.json`.

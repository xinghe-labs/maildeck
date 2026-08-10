# Electron Upgrade and Hardening Design

## Status

Direction approved on 2026-07-18: keep Electron and React, upgrade and harden the existing application, and do not rewrite it in another desktop framework.

This document defines the implementation scope that must be reviewed before code changes begin.

Implementation note (2026-08-05): the Refresh Coordinator now owns job registration, queued cancellation, per-account serialization, and stable multi-account locking for imports. Credential generations cover account reimport/edit/delete and proxy changes; access tokens are memory-only and stale token or fallback work cannot commit rotated credentials. Database schema v5 removes the persisted access-token table without removing account or mail data.

Implementation note (2026-08-10): Phase 4 upgraded Electron from 35.7.5 to the exact stable target 43.3.0 (Node 24.18.1 and Chromium 150). The project now requires host Node 22.12.0 or newer and explicitly installs and verifies the Electron binary during `npm install` and Windows distribution. The complete dependency audit reports zero vulnerabilities, and the packaged Windows smoke verifies the Electron version, SQLite startup, sandboxed preload, IPC validation, encrypted proxy storage, and CSP. Local portable and NSIS artifacts remain unsigned until a production Authenticode certificate is configured.

Implementation note (2026-08-10): Phase 5 now enforces the persisted batch concurrency as one global limit across batch and single-account network work. Active cancellation propagates through token exchange, Graph, IMAP, and the built-in Hotmail fallback; queued cache and account-state commits recheck cancellation inside their locks. Token refresh deduplication keeps shared requests alive for remaining callers while still aborting obsolete I/O after account, proxy, or final-caller invalidation.

Implementation note (2026-08-10): fallback list refreshes now return summaries without opening up to ten additional IMAP connections for message details. Detail reads are lazy and can retry a numeric IMAP UID through the built-in Hotmail fallback. IMAP reads keep full-MIME charset repair for messages up to 10 MiB; larger messages download only the preferred non-attachment HTML or plain-text part with a 4 MiB decoded-content limit. Rediscovering an Inbox during a detail read no longer advances successful refresh timestamps.

Implementation note (2026-08-10): the default Electron session now denies all Chromium permission checks, requests, and device permissions. Uncaught main-process exceptions and unhandled rejections are fatal after bounded local cleanup instead of being suppressed through error-message matching. The application CSP no longer exposes arbitrary localhost WebSocket endpoints and explicitly disables workers and media.

Implementation note (2026-08-10): SQLite schema upgrades now use ordered v1-v5 migrations inside one immediate transaction, verify every completed step, and reject databases written by a newer application version. Existing databases receive a consistent `VACUUM INTO` backup before the first missing migration; a failed migration rolls back all schema and version changes while preserving that backup for recovery.

Implementation note (2026-08-10): every invoke-style IPC response now uses a shared success/error envelope. Errors expose a stable code, safe message, retryability, and optional request ID; unknown implementation failures remain generic in React while their main-process logs redact authorization headers, Microsoft token shapes, and proxy credentials. The sandboxed preload validates and unwraps the envelope, including transport-failure sanitization.

Implementation note (2026-08-10): idempotent Microsoft Graph reads now make at most three total attempts (the initial request plus two retries) for 429, 502, 503, and 504 responses. The retry policy honors `Retry-After` seconds or HTTP dates, adds bounded jitter, declines automatic retry when the requested wait exceeds 30 seconds, and aborts immediately with the owning refresh job. Exhausted 429 responses remain typed as retryable throttling errors and do not trigger Graph rediscovery or Hotmail fallback requests. Graph delta continuation URLs are validated against the HTTPS `graph.microsoft.com/v1.0` boundary before an authorization header is attached.

Implementation note (2026-08-10): refresh and batch-test progress events now carry a main-process `jobId` and closed `kind`. The renderer displays only manual batch-refresh progress, so single-account and background refreshes cannot overwrite the active bulk progress indicator.

## Context

Outlook Manager is a Windows-focused Electron desktop application with a React renderer. The Electron main process owns Microsoft token exchange, Graph and IMAP access, SQLite storage, account encryption, proxy handling, caching, background refresh, and release verification.

The current application uses Electron 35.7.5. At the time of this design, the npm registry reports Electron 43.1.1 as the latest version. The project also has known production dependency advisories, a non-effective root `lint` command, no automated test suite, and several correctness and security risks in refresh coordination and mail rendering.

The existing portable executable is approximately 77 MB. Package size alone does not justify a framework rewrite.

## Goals

1. Keep the Electron main/preload/renderer process model and the React user interface.
2. Upgrade Electron to the current supported target after a reliable test baseline exists.
3. Remove known production dependency advisories without combining unrelated major upgrades.
4. Make renderer isolation, mail HTML rendering, IPC input handling, and secret handling defensible by default.
5. Ensure manual, single-account, and background refreshes cannot race on the same account.
6. Correct cancellation, refresh timestamps, pagination cursor, Graph/IMAP fallback, and proxy semantics.
7. Preserve existing account data, refresh tokens, mail cache, settings, portable builds, and NSIS builds.
8. Add automated verification that can prevent regressions before packaging and release.

## Non-goals

- Rewriting the application in Tauri, Wails, Neutralino, or another desktop framework.
- Replacing React or redesigning the user interface.
- Adding OAuth interactive login, mail export, sending mail, or a cloud backend.
- Upgrading React, Vite, TypeScript, and every development dependency to a new major version in the same change.
- Replacing SQLite or moving account data out of Electron `userData`.
- Implementing SOCKS support in the first hardening release.

## Considered Approaches

### Big-bang framework and dependency upgrade

Upgrade Electron and all major dependencies while restructuring the main process. This is rejected because failures would be difficult to attribute, rollback would be coarse, and the current project lacks tests.

### Staged hardening and Electron upgrade

Add a test baseline, apply compatible security patches, harden the process model, upgrade Electron, and then deepen refresh and mailbox modules. This is the selected approach because each phase has an independent verification and rollback point.

### Framework-neutral core before any fixes

Extract all mail behavior behind a runtime-independent core before changing Electron. This preserves a future migration option but delays concrete bug fixes and introduces abstractions before stable behavior is defined. It is rejected for the current release.

## Target Architecture

### Process model

The application keeps three execution areas:

- Electron main process: credentials, SQLite, Graph/IMAP network access, proxy dispatchers, refresh jobs, dialogs, and release lifecycle.
- Preload: a minimal IPC bridge with no business behavior.
- React renderer: account selection, mail presentation, job progress, forms, and user commands.

The renderer never receives refresh tokens or access tokens. Network access to Microsoft endpoints remains in the main process.

### Shared IPC contracts

A pure TypeScript shared contract module becomes the source of truth for IPC channel names, request types, response types, and runtime schemas. Zod 4 is the selected runtime schema implementation. Runtime validation occurs in the main process before business modules are called.

Validation limits include:

- Import text maximum: 10 MiB.
- Account IDs per batch: 5,000, deduplicated before execution.
- Mail page size: 1 to 100.
- Cursor and search strings: bounded strings with explicit normalization.
- Job kinds and setting values: closed enums and numeric ranges.
- Proxy URLs: only supported schemes and valid URLs.

The renderer and preload derive TypeScript types from the same schemas. The duplicate `electron/main/types.ts` and `src/types.ts` declarations are consolidated without exposing main-process implementation types.

### Credential lifecycle

Refresh tokens remain encrypted with Electron `safeStorage`. If encryption is unavailable, new secret writes continue to fail rather than falling back to plaintext. Documentation is updated to match that behavior.

Persisted access-token caching is removed. Access tokens remain in memory and in-flight refreshes remain coalesced by account ID. Each account has a credential generation number. Editing, reimporting, deleting an account, or changing the proxy increments the relevant generation and aborts or invalidates older token work. A token result is committed only when its captured generation still matches.

Account mutation methods return affected account IDs so importing one account does not clear every account's token cache. Saving settings invalidates token state only when the normalized proxy value actually changes.

### Refresh Coordinator Module

One Refresh Coordinator Module owns all test and refresh job lifecycle rules:

- Per-account mutual exclusion across manual, single-account, and background refreshes.
- One global concurrency limit shared by all refresh entry points.
- Account ID deduplication.
- AbortController propagation into token, Graph, and IMAP work where supported.
- Explicit states: queued, running, succeeded, failed, canceled, and skipped.
- Progress events scoped by job ID and kind.
- Generation checks before cache or account state is committed.

Cancellation does not mark an account invalid and does not change its successful refresh timestamp. Transient network failures are not treated as credential invalidation. Authentication and permission failures remain distinguishable from network and cancellation errors.

`lastRefreshedAt` means last successful refresh only. Failed attempts update error/status information without advancing that field. Pagination requests never update incremental refresh state.

### Mailbox Access Module

A Mailbox Access Module provides a stable interface for connection testing, listing messages, incremental refresh, and fetching message details. Existing Graph and IMAP implementations remain concrete adapters.

The module owns:

- Well-known Inbox resolution instead of choosing an arbitrary first folder.
- Graph delta pagination and tombstone handling.
- IMAP UID pagination and incremental cursor semantics.
- Fallback selection based on error category rather than every exception.
- Cache writes and account-state commits after a complete successful operation.
- Search semantics that distinguish local cache search from server search.

Hotmail fallback token exchange must request an IMAP-compatible scope before the token is passed to the IMAP adapter. Each endpoint attempt is validated through the intended transport, rather than accepting a token response that cannot authenticate to IMAP.

Fallback message details are fetched lazily. The application no longer opens up to ten new IMAP connections during a list refresh. When the primary token path remains unavailable, `getMessage` uses the same fallback policy for the requested message.

IMAP message detail reads use an explicit size limit and prefer the selected text body part over buffering an entire message with attachments. Oversized content returns a typed error instead of exhausting the Electron main process.

### Mail content safety

Mail HTML is untrusted content. The renderer applies all of the following:

- Upgrade DOMPurify to a patched version.
- Strip remote `http` and `https` image sources by default.
- Render HTML inside a sandboxed iframe with a restrictive document CSP.
- Allow only local/data image content in the initial hardening release.
- Open approved external links through the existing main-process navigation guard.
- Keep application-level CSP restrictive enough that mail content cannot initiate arbitrary renderer requests.

The BrowserWindow target is `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`. Because sandboxed preload execution has stricter loading rules, the preload entry is compiled as CommonJS (`.cts` to `.cjs`) and contains only the context bridge and IPC calls before the sandbox flag is enabled. No additional preload bundler is introduced.

### Proxy behavior

The first hardening release supports HTTP and HTTPS proxy URLs end to end. SOCKS input is rejected with a clear validation message because the current Graph/token dispatcher does not support it. The README and settings text are updated to stop promising unsupported SOCKS behavior.

Proxy URLs can contain credentials. Settings version 2 stores scheme, host, port, and username separately and encrypts the password with the same secret-storage policy as refresh tokens. Reading version 1 settings migrates any embedded password before the new settings file is committed. Logs and errors must redact proxy credentials.

SOCKS support may be designed later as a separate adapter with Graph, token, and IMAP integration tests.

### Database migrations

Database schema changes use ordered, transactional migrations. The migration runner reads the current schema version, applies each missing migration exactly once, verifies the resulting schema, and updates the version only after success.

The first new migration removes persisted access-token data and prepares any new account-state fields required by the Refresh Coordinator. Existing account and mail-cache rows remain intact. Migration tests start from representative v1 through v4 database fixtures and verify the upgraded data.

Synchronous SQLite calls remain in the main process for the first release. Their duration is measured with 5,000 accounts and 100 cached messages per account. Moving SQLite to a worker is considered only if a synchronous operation exceeds 50 ms at p95 or creates a main-process event-loop delay above 100 ms during that workload.

## Upgrade Sequence

### Phase 1: Verification baseline

- Add Vitest for pure and module-level tests.
- Replace the root no-op `lint` script with explicit renderer and Electron type checks.
- Add tests for import parsing, account validation, refresh-state transitions, cursor rules, cancellation, fresh database creation, and existing legacy JSON migration behavior.
- Keep the existing packaged startup smoke test.

### Phase 2: Compatible security updates

- Update DOMPurify, ImapFlow, Mailparser, Undici, Electron Builder, and compatible type packages within their current major ranges.
- Run the official npm production audit endpoint.
- Apply minimal regression fixes so cancellation cannot invalidate an account, failures cannot advance `lastRefreshedAt`, and pagination cannot overwrite incremental refresh state.
- Verify unit tests, both type-check targets, build, unpacked and portable startup, installer asset presence, and checksums. Full NSIS install/uninstall verification remains a disposable-VM gate.

### Phase 3: Renderer and IPC hardening

- Add shared runtime IPC contracts and limits.
- Compile the preload as a standalone CommonJS artifact for sandbox compatibility.
- Enable BrowserWindow sandbox and CSP.
- Isolate mail HTML and block remote resources.
- Validate and redact proxy configuration.

### Phase 4: Electron upgrade

- Target Electron 43.1.1 based on the registry snapshot used for this design; resolve the current supported patch again at implementation time.
- Review Electron breaking changes between the current and target majors, especially Node runtime, preload sandboxing, `node:sqlite`, Chromium CSP, and Windows packaging.
- Upgrade in isolated commits with a verified checkpoint after each compatibility adjustment.
- Do not combine React or Vite major upgrades with this phase.

### Phase 5: Refresh and mailbox deepening

- Introduce the Credential Lifecycle, Refresh Coordinator, and Mailbox Access modules.
- Correct cancellation, status, successful refresh timestamp, pagination cursor, Graph delta, fallback, and message-size behavior.
- Remove obsolete helpers only after the new interfaces are covered by tests.

## Error Handling

Errors cross IPC as structured values with a stable code, safe message, retryability, and optional diagnostic context. Secrets, authorization headers, refresh tokens, access tokens, and proxy credentials are never included.

Cancellation is a first-class result, not an unknown error. Network timeouts are retryable; invalid grants, missing scope, and mailbox permission errors are not retried automatically. Microsoft throttling observes `Retry-After` and bounded jittered backoff.

Unhandled exceptions remain visible in logs, but broad string matching must not suppress process-level errors indefinitely.

## Testing and Release Gates

Every phase must pass all applicable gates available in that phase:

1. Renderer TypeScript check.
2. Electron TypeScript check.
3. Unit and module tests.
4. Production dependency audit with no unresolved high or critical finding relevant to shipped paths.
5. Production build.
6. Portable executable startup smoke test with isolated `userData`.
7. SQLite fresh-create tests; ordered v1-v4 migration fixtures become mandatory when the migration runner is introduced in Phase 5.
8. Security tests for IPC limits, remote mail resources, link handling, and secret redaction.

The final phase also runs controlled Graph and IMAP integration tests with dedicated test accounts. Those tests are opt-in and never use user accounts or production tokens. NSIS install/uninstall verification runs only in a disposable Windows VM; local verification continues to use the unpacked application and portable executable.

## Compatibility and Data Safety

- Before migration tests, copy representative databases; never modify the user's live `userData` during development verification.
- Schema upgrades are forward-only, but release rollback is supported by backing up the pre-upgrade database before the first new migration.
- A failed migration leaves the original database and backup intact and prevents normal startup with a clear recovery message.
- Existing portable and NSIS asset names remain compatible with the release script.
- The user-visible account import formats remain unchanged.

## Rollback Strategy

Each phase is delivered as a separate commit or small commit group. If a gate fails, revert only that phase and restore its lockfile. Electron upgrade changes are not mixed with schema migration behavior.

Before a release containing database migrations, the startup path creates a timestamped database backup. Recovery consists of reinstalling the previous application build and restoring that backup. The release notes identify the schema migration and backup location.

## Acceptance Criteria

- Electron and React remain the application framework.
- The selected Electron target builds and starts on the supported Windows environment.
- Existing accounts and cached mail survive database migration.
- No known high or critical production audit issue remains without a documented, path-specific exception.
- Mail HTML cannot load remote tracking resources by default.
- IPC rejects invalid or oversized requests before business modules execute.
- The same account is never refreshed concurrently by different job kinds.
- Canceling a job does not invalidate accounts or advance successful refresh timestamps.
- Loading older pages does not move incremental refresh cursors backward.
- Fallback list and detail operations use transport-compatible tokens and do not prefetch details through multiple new connections.
- HTTP/HTTPS proxy behavior is tested end to end; unsupported SOCKS input is rejected clearly.
- Automated checks and packaged startup verification run from documented npm commands.

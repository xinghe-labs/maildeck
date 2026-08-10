import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const releaseVerifier = readFileSync(new URL("../scripts/verify-release-startup.ps1", import.meta.url), "utf8");
const cdpEvaluator = readFileSync(new URL("../scripts/evaluate-cdp.mjs", import.meta.url), "utf8");

describe("packaged release verification", () => {
  it("polls for a page target instead of relying on one fixed startup delay", () => {
    expect(releaseVerifier).toContain("$StartupDeadline");
    expect(releaseVerifier).toMatch(/do \{[\s\S]*Invoke-RestMethod[\s\S]*\} while/u);
    expect(releaseVerifier).not.toContain("Start-Sleep -Seconds 6");
  });

  it("waits for the renderer bridge and critical settings control", () => {
    expect(releaseVerifier).toContain("$RendererDeadline");
    expect(releaseVerifier).toContain("document.readyState === 'complete'");
    expect(releaseVerifier).toContain("window.outlookManager?.settings?.get");
    expect(releaseVerifier).toContain(".sidebar-actions .square-button:last-child");
  });

  it("allows cold packaged renderers enough time to answer CDP", () => {
    expect(cdpEvaluator).toContain("30_000");
  });

  it("verifies packaged permission denial and the production network policy", () => {
    expect(releaseVerifier).toContain("geolocationPermission");
    expect(releaseVerifier).toContain("worker-src 'none'");
    expect(releaseVerifier).toContain('.Contains("ws://")');
    expect(releaseVerifier).toContain('.Contains("wss://")');
  });

  it("verifies structured IPC error codes through the packaged context bridge", () => {
    expect(releaseVerifier).toContain("invalidIpcCode");
    expect(releaseVerifier).toContain("INVALID_REQUEST");
    expect(releaseVerifier).toContain("invalidIpcRetryable");
  });

  it("exercises the packaged account-list projection through the context bridge", () => {
    expect(releaseVerifier).toContain("bridge?.accounts?.list()");
    expect(releaseVerifier).toContain("accountListReadable");
  });
});

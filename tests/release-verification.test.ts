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
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ipcSource = readFileSync(new URL("../electron/main/ipc.ts", import.meta.url), "utf8");

describe("refresh coordinator boundary", () => {
  it("keeps job registration and cancellation state out of IPC handlers", () => {
    expect(ipcSource).not.toMatch(/const activeJobs|const canceledJobIds|function startJob|function finishJob/u);
    expect(ipcSource).toContain("refreshCoordinator.cancel(job)");
  });

  it("coordinates both batch job entry points", () => {
    expect(ipcSource.match(/refreshCoordinator\.runJob\(/gu)).toHaveLength(2);
    expect(ipcSource).toContain('refreshCoordinator.runJob("test"');
    expect(ipcSource).toContain("refreshCoordinator.runJob(jobKind");
  });

  it("serializes each account inside both batch jobs", () => {
    expect(ipcSource.match(/job\.runAccount\(\s*accountId/gu)).toHaveLength(2);
  });
});

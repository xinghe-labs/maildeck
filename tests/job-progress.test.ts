import { describe, expect, it } from "vitest";
import { shouldDisplayBulkRefreshProgress } from "../src/job-progress.js";

describe("job progress visibility", () => {
  it("shows only manual bulk refresh progress", () => {
    expect(shouldDisplayBulkRefreshProgress({ kind: "refresh" })).toBe(true);
    expect(shouldDisplayBulkRefreshProgress({ kind: "refreshSingle" })).toBe(false);
    expect(shouldDisplayBulkRefreshProgress({ kind: "refreshBackground" })).toBe(false);
  });
});

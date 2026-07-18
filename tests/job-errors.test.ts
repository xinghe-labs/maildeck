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

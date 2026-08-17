import { describe, expect, it } from "vitest";
import { normalizeMailDate } from "../electron/main/mail-date-normalizer.js";

describe("mail date normalization", () => {
  it("canonicalizes valid Date instances and offset strings", () => {
    expect(normalizeMailDate(new Date("2026-08-10T00:00:00.000Z"))).toBe("2026-08-10T00:00:00.000Z");
    expect(normalizeMailDate("2026-08-10T08:30:00+08:00")).toBe("2026-08-10T00:30:00.000Z");
  });

  it("returns null for empty, unsupported, and invalid values", () => {
    expect(normalizeMailDate("")).toBeNull();
    expect(normalizeMailDate("not-a-date")).toBeNull();
    expect(normalizeMailDate(new Date("invalid"))).toBeNull();
    expect(normalizeMailDate(1_786_320_000_000)).toBeNull();
  });
});

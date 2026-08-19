import { describe, expect, it } from "vitest";
import { resolveVisibleMailCursor } from "../src/mail-pagination";

describe("resolveVisibleMailCursor", () => {
  it("keeps a cursor while more messages remain", () => {
    expect(resolveVisibleMailCursor({ cursor: "50", displayedCount: 50, totalCount: 120 })).toBe("50");
  });

  it("hides a cursor after all known messages are displayed", () => {
    expect(resolveVisibleMailCursor({ cursor: "100", displayedCount: 100, totalCount: 100 })).toBeNull();
  });

  it("hides a cursor when an empty mailbox reports a zero total", () => {
    expect(resolveVisibleMailCursor({ cursor: "next", displayedCount: 0, totalCount: 0 })).toBeNull();
  });
});

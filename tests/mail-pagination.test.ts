import { describe, expect, it } from "vitest";
import { resolveMailListFooter, resolveVisibleMailCursor } from "../src/mail-pagination";

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

describe("resolveMailListFooter", () => {
  it("offers reload when the mailbox reports more messages than the cache holds", () => {
    // 报告 P0-5：摘要 22 封、列表 13 封，且服务器没给游标时，用户必须还有动作可点。
    const footer = resolveMailListFooter({ cursor: null, displayedCount: 13, totalCount: 22 });
    expect(footer.action).toBe("reload");
    expect(footer.countText).toBe("已显示 13 / 共 22 封");
  });

  it("offers load-more while a cursor exists", () => {
    expect(resolveMailListFooter({ cursor: "next", displayedCount: 50, totalCount: 120 }).action).toBe("load-more");
  });

  it("shows only the count once everything is displayed", () => {
    expect(resolveMailListFooter({ cursor: null, displayedCount: 22, totalCount: 22 })).toEqual({
      action: "none",
      countText: "共 22 封"
    });
  });

  it("stays silent for an empty list and for unknown totals", () => {
    expect(resolveMailListFooter({ cursor: null, displayedCount: 0, totalCount: 0 })).toEqual({
      action: "none",
      countText: null
    });
    expect(resolveMailListFooter({ cursor: null, displayedCount: 13, totalCount: null })).toEqual({
      action: "none",
      countText: "已显示 13 封"
    });
  });
});

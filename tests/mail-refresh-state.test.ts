import { describe, expect, it } from "vitest";
import {
  countNewMessagesAfterRefresh,
  shouldCommitMailboxRefreshState
} from "../electron/main/mail-refresh-state.js";

describe("countNewMessagesAfterRefresh", () => {
  it("counts only messages newer than the previous successful refresh", () => {
    const messages = [
      { receivedDateTime: "2026-07-18T10:01:00.000Z", sentDateTime: null },
      { receivedDateTime: "2026-07-18T09:59:00.000Z", sentDateTime: null }
    ];
    expect(countNewMessagesAfterRefresh(messages, "2026-07-18T10:00:00.000Z")).toBe(1);
  });
});

describe("shouldCommitMailboxRefreshState", () => {
  it("allows an unfiltered first-page read to update incremental state", () => {
    expect(shouldCommitMailboxRefreshState({ search: "", cursor: null })).toBe(true);
  });

  it("rejects pagination and search reads", () => {
    expect(shouldCommitMailboxRefreshState({ search: "", cursor: "50" })).toBe(false);
    expect(shouldCommitMailboxRefreshState({ search: "invoice", cursor: null })).toBe(false);
  });

  it("rejects skip-based page reads", () => {
    expect(shouldCommitMailboxRefreshState({ search: "", cursor: null, skip: 50 })).toBe(false);
    expect(shouldCommitMailboxRefreshState({ search: "", cursor: null, skip: 0 })).toBe(true);
  });
});

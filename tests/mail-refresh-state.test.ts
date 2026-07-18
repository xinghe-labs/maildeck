import { describe, expect, it } from "vitest";
import { countNewMessagesAfterRefresh } from "../electron/main/mail-refresh-state.js";

describe("countNewMessagesAfterRefresh", () => {
  it("counts only messages newer than the previous successful refresh", () => {
    const messages = [
      { receivedDateTime: "2026-07-18T10:01:00.000Z", sentDateTime: null },
      { receivedDateTime: "2026-07-18T09:59:00.000Z", sentDateTime: null }
    ];
    expect(countNewMessagesAfterRefresh(messages, "2026-07-18T10:00:00.000Z")).toBe(1);
  });
});

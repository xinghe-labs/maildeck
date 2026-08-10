import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobCanceledError } from "../electron/main/job-errors.js";

const fakeImap = vi.hoisted(() => ({
  closeCalls: 0,
  connectCalls: 0,
  logoutCalls: 0,
  connectImmediately: false,
  rejectConnect: null as ((error: Error) => void) | null,
  rejectLogout: null as ((error: Error) => void) | null
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    on() {}

    connect() {
      fakeImap.connectCalls += 1;
      if (fakeImap.connectImmediately) {
        return Promise.resolve();
      }
      return new Promise<void>((_resolve, reject) => {
        fakeImap.rejectConnect = reject;
      });
    }

    close() {
      fakeImap.closeCalls += 1;
      fakeImap.rejectConnect?.(new Error("IMAP connection closed"));
      fakeImap.rejectLogout?.(new Error("IMAP connection closed"));
    }

    logout() {
      fakeImap.logoutCalls += 1;
      return new Promise<void>((_resolve, reject) => {
        fakeImap.rejectLogout = reject;
      });
    }

    async list() {
      return [];
    }
  }
}));

import { listImapFolders } from "../electron/main/imap-client.js";

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}

beforeEach(() => {
  fakeImap.closeCalls = 0;
  fakeImap.connectCalls = 0;
  fakeImap.logoutCalls = 0;
  fakeImap.connectImmediately = false;
  fakeImap.rejectConnect = null;
  fakeImap.rejectLogout = null;
});

describe("IMAP network cancellation", () => {
  it("closes an active ImapFlow client and preserves the cancellation reason", async () => {
    const controller = new AbortController();
    const pending = listImapFolders("person@example.com", "access-token", "", controller.signal);
    await waitFor(() => fakeImap.connectCalls === 1);
    const canceled = new JobCanceledError("刷新已取消");

    controller.abort(canceled);

    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        (error) => error
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100))
    ]);
    expect(outcome).toBe(canceled);
    expect(fakeImap.closeCalls).toBe(1);
  });

  it("keeps cancellation wired while logout is still pending", async () => {
    fakeImap.connectImmediately = true;
    const controller = new AbortController();
    const pending = listImapFolders("person@example.com", "access-token", "", controller.signal);
    await waitFor(() => fakeImap.logoutCalls === 1);
    const canceled = new JobCanceledError("退出连接时取消");

    controller.abort(canceled);

    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        (error) => error
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100))
    ]);
    expect(outcome).toBe(canceled);
    expect(fakeImap.closeCalls).toBe(1);
  });
});

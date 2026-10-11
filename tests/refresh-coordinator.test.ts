import { describe, expect, it } from "vitest";
import { RefreshCoordinator } from "../electron/main/refresh-coordinator.js";
import { abortReasonOf } from "../electron/main/error-utils.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function unexpectedCancellation(): never {
  throw new Error("job was canceled unexpectedly");
}

describe("RefreshCoordinator", () => {
  it("assigns one stable unique id to each coordinated job", async () => {
    const coordinator = new RefreshCoordinator();
    const firstIds: string[] = [];
    const first = await coordinator.runJob("refresh", async (job) => {
      firstIds.push(job.id);
      await Promise.resolve();
      firstIds.push(job.id);
      return job.id;
    });
    const second = await coordinator.runJob("refresh", async (job) => job.id);

    expect(first).toEqual(expect.any(String));
    expect(first).not.toBe("");
    expect(firstIds).toEqual([first, first]);
    expect(second).not.toBe(first);
  });

  it("serializes work for the same account across job kinds", async () => {
    const coordinator = new RefreshCoordinator();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const events: string[] = [];

    const first = coordinator.runJob("refresh", (job) =>
      job.runAccount(
        "account-1",
        async () => {
          events.push("first:start");
          firstEntered.resolve();
          await releaseFirst.promise;
          events.push("first:end");
        },
        unexpectedCancellation
      )
    );

    await firstEntered.promise;

    const second = coordinator.runJob("refreshBackground", (job) =>
      job.runAccount(
        "account-1",
        async () => {
          events.push("second:start");
        },
        unexpectedCancellation
      )
    );

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("allows different accounts to run in parallel", async () => {
    const coordinator = new RefreshCoordinator();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondFinished = false;

    const first = coordinator.runAccount("account-1", async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });

    await firstEntered.promise;
    await coordinator.runAccount("account-2", async () => {
      secondFinished = true;
    });

    expect(secondFinished).toBe(true);
    releaseFirst.resolve();
    await first;
  });

  it("shares one concurrency limit across different job kinds", async () => {
    const coordinator = new RefreshCoordinator();
    coordinator.setConcurrency(2);
    const firstEntered = deferred();
    const secondEntered = deferred();
    const releaseActive = deferred();
    let active = 0;
    let maxActive = 0;
    let thirdStarted = false;

    const runBlocked = (entered: ReturnType<typeof deferred>) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      entered.resolve();
      await releaseActive.promise;
      active -= 1;
    };

    const refresh = coordinator.runJob("refresh", (job) =>
      Promise.all([
        job.runAccount("account-1", runBlocked(firstEntered), unexpectedCancellation),
        job.runAccount("account-2", runBlocked(secondEntered), unexpectedCancellation)
      ])
    );
    await Promise.all([firstEntered.promise, secondEntered.promise]);

    const test = coordinator.runJob("test", (job) =>
      job.runAccount(
        "account-3",
        async () => {
          thirdStarted = true;
          active += 1;
          maxActive = Math.max(maxActive, active);
          active -= 1;
        },
        unexpectedCancellation
      )
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(thirdStarted).toBe(false);
    expect(maxActive).toBe(2);

    releaseActive.resolve();
    await Promise.all([refresh, test]);
    expect(thirdStarted).toBe(true);
    expect(maxActive).toBe(2);
  });

  it("aborts running work and releases its global permit", async () => {
    const coordinator = new RefreshCoordinator();
    coordinator.setConcurrency(1);
    const operationStarted = deferred();
    const received = { signal: null as AbortSignal | null };

    const running = coordinator.runJob("refresh", (job) =>
      job.runAccount(
        "account-1",
        async (signal) => {
          received.signal = signal;
          operationStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(abortReasonOf(signal)), { once: true });
          });
          return "completed";
        },
        () => "canceled"
      )
    );

    await operationStarted.promise;
    expect(coordinator.cancel("refresh")).toBe(1);
    await expect(running).resolves.toBe("canceled");
    expect(received.signal?.aborted).toBe(true);

    await expect(
      coordinator.runJob("test", (job) =>
        job.runAccount("account-2", async () => "next", unexpectedCancellation)
      )
    ).resolves.toBe("next");
  });

  it("locks a deduplicated account set in stable order", async () => {
    const coordinator = new RefreshCoordinator();
    const groupEntered = deferred();
    const releaseGroup = deferred();
    const events: string[] = [];

    const group = coordinator.runAccounts(["account-2", "account-1", "account-2"], async () => {
      events.push("group:start");
      groupEntered.resolve();
      await releaseGroup.promise;
      events.push("group:end");
    });
    await groupEntered.promise;

    const single = coordinator.runAccount("account-1", async () => {
      events.push("single:start");
    });
    await Promise.resolve();
    expect(events).toEqual(["group:start"]);

    releaseGroup.resolve();
    await Promise.all([group, single]);
    expect(events).toEqual(["group:start", "group:end", "single:start"]);
  });

  it("keeps an internal symbol lock isolated from an account id with the same description", async () => {
    const coordinator = new RefreshCoordinator();
    const internalLock = Symbol("account-mutation");

    await expect(
      coordinator.runAccount(internalLock, () =>
        coordinator.runAccount("account-mutation", async () => "completed")
      )
    ).resolves.toBe("completed");
  });

  it("reports all active jobs of the requested kind and cleans them up", async () => {
    const coordinator = new RefreshCoordinator();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseJobs = deferred();

    const first = coordinator.runJob("refresh", async () => {
      firstStarted.resolve();
      await releaseJobs.promise;
    });
    const second = coordinator.runJob("refresh", async () => {
      secondStarted.resolve();
      await releaseJobs.promise;
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    expect(coordinator.cancel("refresh")).toBe(2);

    releaseJobs.resolve();
    await Promise.all([first, second]);
    expect(coordinator.cancel("refresh")).toBe(0);
  });

  it("skips canceled work without waiting for an occupied account", async () => {
    const coordinator = new RefreshCoordinator();
    const accountOccupied = deferred();
    const releaseAccount = deferred();
    let operationStarted = false;

    const occupying = coordinator.runAccount("account-1", async () => {
      accountOccupied.resolve();
      await releaseAccount.promise;
    });
    await accountOccupied.promise;

    const queued = coordinator.runJob("refresh", (job) =>
      job.runAccount(
        "account-1",
        async () => {
          operationStarted = true;
          return "ran";
        },
        () => "canceled"
      )
    );
    await Promise.resolve();
    coordinator.cancel("refresh");

    const outcome = await Promise.race([
      queued,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100))
    ]);

    releaseAccount.resolve();
    await occupying;
    await queued;

    expect(outcome).toBe("canceled");
    expect(operationStarted).toBe(false);
  });

  it("releases an account after an operation fails", async () => {
    const coordinator = new RefreshCoordinator();

    await expect(
      coordinator.runAccount("account-1", async () => {
        throw new Error("failed");
      })
    ).rejects.toThrow("failed");

    await expect(coordinator.runAccount("account-1", async () => "recovered")).resolves.toBe("recovered");
  });

  it("shares the global concurrency limit with single-account network work", async () => {
    const coordinator = new RefreshCoordinator();
    coordinator.setConcurrency(1);
    const batchStarted = deferred();
    const releaseBatch = deferred();
    let singleStarted = false;

    const batch = coordinator.runJob("refresh", (job) =>
      job.runAccount(
        "account-1",
        async () => {
          batchStarted.resolve();
          await releaseBatch.promise;
          return "batch";
        },
        () => "canceled"
      )
    );
    await batchStarted.promise;

    const single = coordinator.runNetworkAccount("account-2", async () => {
      singleStarted = true;
      return "single";
    });
    await Promise.resolve();
    expect(singleStarted).toBe(false);

    releaseBatch.resolve();
    await expect(Promise.all([batch, single])).resolves.toEqual(["batch", "single"]);
  });
});

import { describe, expect, it } from "vitest";
import { RefreshCoordinator } from "../electron/main/refresh-coordinator.js";

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
});

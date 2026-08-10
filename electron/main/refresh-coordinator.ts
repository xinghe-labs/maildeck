import { randomUUID } from "node:crypto";
import type { JobKind } from "../shared/ipc-contracts.js";
import { JobCanceledError } from "./job-errors.js";

export interface CoordinatedJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly signal: AbortSignal;
  runAccount<T>(
    accountId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    onCanceled: () => T | Promise<T>
  ): Promise<T>;
}

interface ActiveJob {
  canceled: boolean;
  readonly controller: AbortController;
  readonly canceledSignal: Promise<void>;
  cancel(): void;
}

interface GlobalWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: (() => void) | null) => void;
  readonly onAbort: () => void;
}

export class RefreshCoordinator {
  private readonly activeJobs = new Map<JobKind, Map<string, ActiveJob>>();
  private readonly accountTails = new Map<string | symbol, Promise<void>>();
  private readonly globalWaiters: GlobalWaiter[] = [];
  private globalConcurrency = 4;
  private activeGlobalOperations = 0;

  setConcurrency(value: number): void {
    const normalized = Number.isFinite(value) ? Math.floor(value) : 1;
    this.globalConcurrency = Math.max(1, normalized);
    this.drainGlobalWaiters();
  }

  async runJob<T>(kind: JobKind, operation: (job: CoordinatedJob) => Promise<T>): Promise<T> {
    const jobId = randomUUID();
    const controller = new AbortController();
    let signalCancellation!: () => void;
    const canceledSignal = new Promise<void>((resolve) => {
      signalCancellation = resolve;
    });
    const state: ActiveJob = {
      canceled: false,
      controller,
      canceledSignal,
      cancel: () => {
        if (!state.canceled) {
          state.canceled = true;
          controller.abort(new JobCanceledError("任务已取消"));
          signalCancellation();
        }
      }
    };
    const jobs = this.activeJobs.get(kind) ?? new Map<string, ActiveJob>();
    jobs.set(jobId, state);
    this.activeJobs.set(kind, jobs);

    const job: CoordinatedJob = {
      id: jobId,
      kind,
      signal: controller.signal,
      runAccount: (accountId, accountOperation, onCanceled) =>
        this.runCancelableAccount(accountId, state, accountOperation, onCanceled)
    };

    try {
      return await operation(job);
    } finally {
      jobs.delete(jobId);
      if (jobs.size === 0) {
        this.activeJobs.delete(kind);
      }
    }
  }

  cancel(kind: JobKind): number {
    const jobs = this.activeJobs.get(kind);
    if (!jobs) {
      return 0;
    }

    for (const state of jobs.values()) {
      state.cancel();
    }
    return jobs.size;
  }

  async runAccount<T>(accountId: string | symbol, operation: () => Promise<T>): Promise<T> {
    const slot = this.queueAccount(accountId);
    await slot.ready;

    try {
      return await operation();
    } finally {
      slot.release();
    }
  }

  async runNetworkAccount<T>(
    accountId: string,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    return this.runAccount(accountId, async () => {
      const releaseGlobal = await this.acquireGlobal(controller.signal);
      if (!releaseGlobal) {
        controller.signal.throwIfAborted();
        throw new JobCanceledError("任务已取消");
      }

      try {
        return await operation(controller.signal);
      } finally {
        releaseGlobal();
      }
    });
  }

  async runAccounts<T>(accountIds: Iterable<string>, operation: () => Promise<T>): Promise<T> {
    const orderedIds = [...new Set(accountIds)].sort();

    const acquire = (index: number): Promise<T> => {
      if (index >= orderedIds.length) {
        return operation();
      }
      return this.runAccount(orderedIds[index], () => acquire(index + 1));
    };

    return acquire(0);
  }

  private async runCancelableAccount<T>(
    accountId: string,
    job: ActiveJob,
    operation: (signal: AbortSignal) => Promise<T>,
    onCanceled: () => T | Promise<T>
  ): Promise<T> {
    if (job.canceled) {
      return onCanceled();
    }

    const slot = this.queueAccount(accountId);

    try {
      const outcome = await Promise.race([
        slot.ready.then(() => "ready" as const),
        job.canceledSignal.then(() => "canceled" as const)
      ]);

      if (outcome === "canceled" || job.canceled) {
        return await onCanceled();
      }

      const releaseGlobal = await this.acquireGlobal(job.controller.signal);
      if (!releaseGlobal || job.canceled) {
        releaseGlobal?.();
        return await onCanceled();
      }

      try {
        job.controller.signal.throwIfAborted();
        const result = await operation(job.controller.signal);
        return job.canceled ? await onCanceled() : result;
      } catch (error) {
        if (job.canceled) {
          return await onCanceled();
        }
        throw error;
      } finally {
        releaseGlobal();
      }
    } finally {
      slot.release();
    }
  }

  private acquireGlobal(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const waiter: GlobalWaiter = {
        signal,
        resolve,
        onAbort: () => {
          const index = this.globalWaiters.indexOf(waiter);
          if (index >= 0) {
            this.globalWaiters.splice(index, 1);
          }
          resolve(null);
        }
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.globalWaiters.push(waiter);
      this.drainGlobalWaiters();
    });
  }

  private drainGlobalWaiters(): void {
    while (this.activeGlobalOperations < this.globalConcurrency && this.globalWaiters.length > 0) {
      const waiter = this.globalWaiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.resolve(null);
        continue;
      }

      this.activeGlobalOperations += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.activeGlobalOperations -= 1;
        this.drainGlobalWaiters();
      });
    }
  }

  private queueAccount(accountId: string | symbol) {
    const previous = this.accountTails.get(accountId) ?? Promise.resolve();
    const ready = previous.catch(() => undefined);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = ready.then(() => current);
    this.accountTails.set(accountId, tail);

    return {
      ready,
      release: () => {
        release();
        void tail.then(() => {
          if (this.accountTails.get(accountId) === tail) {
            this.accountTails.delete(accountId);
          }
        });
      }
    };
  }
}

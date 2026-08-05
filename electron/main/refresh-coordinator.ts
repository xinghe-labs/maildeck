import { randomUUID } from "node:crypto";
import type { JobKind } from "../shared/ipc-contracts.js";

export interface CoordinatedJob {
  readonly kind: JobKind;
  runAccount<T>(
    accountId: string,
    operation: () => Promise<T>,
    onCanceled: () => T | Promise<T>
  ): Promise<T>;
}

interface ActiveJob {
  canceled: boolean;
  readonly canceledSignal: Promise<void>;
  cancel(): void;
}

export class RefreshCoordinator {
  private readonly activeJobs = new Map<JobKind, Map<string, ActiveJob>>();
  private readonly accountTails = new Map<string | symbol, Promise<void>>();

  async runJob<T>(kind: JobKind, operation: (job: CoordinatedJob) => Promise<T>): Promise<T> {
    const jobId = randomUUID();
    let signalCancellation!: () => void;
    const canceledSignal = new Promise<void>((resolve) => {
      signalCancellation = resolve;
    });
    const state: ActiveJob = {
      canceled: false,
      canceledSignal,
      cancel: () => {
        if (!state.canceled) {
          state.canceled = true;
          signalCancellation();
        }
      }
    };
    const jobs = this.activeJobs.get(kind) ?? new Map<string, ActiveJob>();
    jobs.set(jobId, state);
    this.activeJobs.set(kind, jobs);

    const job: CoordinatedJob = {
      kind,
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
    operation: () => Promise<T>,
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
      return await operation();
    } finally {
      slot.release();
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

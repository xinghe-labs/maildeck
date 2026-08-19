import type {
  JobKind,
  RefreshJobKind,
  RefreshManyResult,
  RefreshProgressEvent,
  TestManyResult,
  TestProgressEvent
} from "./types";

export interface RefreshJobAdapter {
  readonly testMany: (accountIds: string[]) => Promise<TestManyResult[]>;
  readonly refreshMany: (
    accountIds: string[],
    kind: RefreshJobKind
  ) => Promise<RefreshManyResult[]>;
  readonly cancel: (kind: JobKind) => Promise<{ canceled: JobKind; count: number }>;
  readonly onTestProgress: (listener: (event: TestProgressEvent) => void) => () => void;
  readonly onRefreshProgress: (listener: (event: RefreshProgressEvent) => void) => () => void;
}

export interface RefreshJobProgressProjection {
  readonly kind: "test" | "refresh";
  readonly phase: "running" | "canceling" | "completed";
  readonly completed: number;
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
}

export interface RefreshJobSessionState {
  readonly testRunning: boolean;
  readonly manualRefreshRunning: boolean;
  readonly backgroundRefreshRunning: boolean;
  readonly anyJobRunning: boolean;
  readonly singleRefreshBlocked: boolean;
  readonly busyAccountIds: readonly string[];
  readonly failedRefreshAccountIds: readonly string[];
  readonly progress: RefreshJobProgressProjection | null;
  readonly progressText: string;
  readonly canRetryFailedRefresh: boolean;
}

export interface RefreshJobSession {
  readonly getSnapshot: () => RefreshJobSessionState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly runTest: (accountIds: readonly string[]) => Promise<TestManyResult[] | null> | null;
  readonly runRefresh: (
    accountIds: readonly string[],
    kind: RefreshJobKind
  ) => Promise<RefreshManyResult[] | null> | null;
  readonly cancel: (
    kind: "test" | "refresh"
  ) => Promise<{ canceled: JobKind; count: number } | null>;
  readonly dispose: () => void;
}

interface ActiveOperation {
  readonly token: number;
  readonly kind: JobKind;
  readonly accountIds: ReadonlySet<string>;
  readonly total: number;
  jobId: string | null;
  phase: "running" | "canceling";
  completed: number;
  ok: number;
  failed: number;
}

const EMPTY_STRINGS: readonly string[] = Object.freeze([]);

export const EMPTY_REFRESH_JOB_SESSION_STATE: RefreshJobSessionState = Object.freeze({
  testRunning: false,
  manualRefreshRunning: false,
  backgroundRefreshRunning: false,
  anyJobRunning: false,
  singleRefreshBlocked: false,
  busyAccountIds: EMPTY_STRINGS,
  failedRefreshAccountIds: EMPTY_STRINGS,
  progress: null,
  progressText: "",
  canRetryFailedRefresh: false
});

function normalizeAccountIds(accountIds: readonly string[]) {
  return [...new Set(accountIds.map((accountId) => accountId.trim()).filter(Boolean))];
}

function progressText(progress: RefreshJobProgressProjection | null) {
  if (!progress) {
    return "";
  }
  if (progress.kind === "test") {
    if (progress.phase === "completed") {
      return `测试完成 ${progress.ok}/${progress.total}`;
    }
    const prefix = progress.phase === "canceling" ? "正在取消测试" : "测试中";
    return `${prefix} ${progress.completed}/${progress.total} · 可用 ${progress.ok} · 失效 ${progress.failed}`;
  }
  if (progress.phase === "completed") {
    return `刷新完成 ${progress.ok}/${progress.total}`;
  }
  const prefix = progress.phase === "canceling" ? "正在取消刷新" : "刷新中";
  return `${prefix} ${progress.completed}/${progress.total} · 成功 ${progress.ok} · 失败 ${progress.failed}`;
}

class DefaultRefreshJobSession implements RefreshJobSession {
  private state: RefreshJobSessionState = EMPTY_REFRESH_JOB_SESSION_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Map<number, ActiveOperation>();
  private readonly retiredJobIds = new Set<string>();
  private nextToken = 1;
  private lastForegroundProgress: RefreshJobProgressProjection | null = null;
  private failedRefreshAccountIds: readonly string[] = EMPTY_STRINGS;
  private disconnectProgress: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly adapter: RefreshJobAdapter) {}

  readonly getSnapshot = () => this.state;

  readonly subscribe = (listener: () => void) => {
    if (this.disposed) {
      return () => undefined;
    }
    this.ensureConnected();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly runTest = (accountIds: readonly string[]) => {
    const operation = this.startOperation("test", accountIds);
    if (!operation) {
      return null;
    }
    return this.executeTest(operation);
  };

  readonly runRefresh = (accountIds: readonly string[], kind: RefreshJobKind) => {
    const operation = this.startOperation(kind, accountIds);
    if (!operation) {
      return null;
    }
    return this.executeRefresh(operation);
  };

  private async executeTest(operation: ActiveOperation) {
    try {
      const results = await this.adapter.testMany([...operation.accountIds]);
      if (!this.operations.has(operation.token)) {
        return null;
      }
      this.completeTest(operation, results);
      return results;
    } catch (error) {
      if (!this.operations.has(operation.token)) {
        return null;
      }
      this.failOperation(operation);
      throw error;
    }
  }

  private async executeRefresh(operation: ActiveOperation) {
    try {
      const results = await this.adapter.refreshMany([...operation.accountIds], operation.kind as RefreshJobKind);
      if (!this.operations.has(operation.token)) {
        return null;
      }
      this.completeRefresh(operation, results);
      return results;
    } catch (error) {
      if (!this.operations.has(operation.token)) {
        return null;
      }
      this.failOperation(operation);
      throw error;
    }
  }

  readonly cancel = async (kind: "test" | "refresh") => {
    const operation = this.findOperation(kind);
    if (!operation || operation.phase === "canceling" || this.disposed) {
      return null;
    }

    operation.phase = "canceling";
    this.publish();
    try {
      return await this.adapter.cancel(kind);
    } catch (error) {
      if (this.operations.has(operation.token)) {
        operation.phase = "running";
        this.publish();
      }
      throw error;
    }
  };

  readonly dispose = () => {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disconnectProgress?.();
    this.disconnectProgress = null;
    this.operations.clear();
    this.listeners.clear();
  };

  private startOperation(kind: JobKind, rawAccountIds: readonly string[]) {
    if (this.disposed) {
      return null;
    }
    const accountIds = normalizeAccountIds(rawAccountIds);
    if (accountIds.length === 0 || !this.canStart(kind, accountIds)) {
      return null;
    }

    this.ensureConnected();
    const operation: ActiveOperation = {
      token: this.nextToken,
      kind,
      accountIds: new Set(accountIds),
      total: accountIds.length,
      jobId: null,
      phase: "running",
      completed: 0,
      ok: 0,
      failed: 0
    };
    this.nextToken += 1;
    this.operations.set(operation.token, operation);

    if (kind === "test" || kind === "refresh") {
      this.lastForegroundProgress = null;
      this.failedRefreshAccountIds = EMPTY_STRINGS;
    }
    this.publish();
    return operation;
  }

  private canStart(kind: JobKind, accountIds: readonly string[]) {
    if (kind !== "refreshSingle") {
      return this.operations.size === 0;
    }
    if (accountIds.length !== 1) {
      return false;
    }
    const accountId = accountIds[0];
    for (const operation of this.operations.values()) {
      if (operation.kind !== "refreshSingle" || operation.accountIds.has(accountId)) {
        return false;
      }
    }
    return true;
  }

  private ensureConnected() {
    if (this.disconnectProgress || this.disposed) {
      return;
    }
    const disconnectTest = this.adapter.onTestProgress((event) => this.acceptProgress(event));
    let disconnectRefresh: () => void;
    try {
      disconnectRefresh = this.adapter.onRefreshProgress((event) => this.acceptProgress(event));
    } catch (error) {
      disconnectTest();
      throw error;
    }
    this.disconnectProgress = () => {
      disconnectTest();
      disconnectRefresh();
    };
  }

  private acceptProgress(event: TestProgressEvent | RefreshProgressEvent) {
    if (this.disposed || this.retiredJobIds.has(event.jobId)) {
      return;
    }
    const candidates = Array.from(this.operations.values()).filter(
      (operation) =>
        operation.kind === event.kind &&
        operation.total === event.total &&
        operation.accountIds.has(event.accountId)
    );
    const operation = candidates.find((candidate) => candidate.jobId === event.jobId) ??
      candidates.filter((candidate) => candidate.jobId === null).at(0);
    if (!operation || (operation.jobId !== null && operation.jobId !== event.jobId)) {
      return;
    }
    if (operation.jobId === null) {
      const unassigned = candidates.filter((candidate) => candidate.jobId === null);
      if (unassigned.length !== 1) {
        return;
      }
      operation.jobId = event.jobId;
    }
    if (
      event.completed < operation.completed ||
      event.ok < operation.ok ||
      event.failed < operation.failed
    ) {
      return;
    }

    operation.completed = event.completed;
    operation.ok = event.ok;
    operation.failed = event.failed;
    this.publish();
  }

  private completeTest(operation: ActiveOperation, results: readonly TestManyResult[]) {
    const ok = results.filter((result) => result.ok).length;
    this.lastForegroundProgress = {
      kind: "test",
      phase: "completed",
      completed: results.length,
      total: operation.total,
      ok,
      failed: results.length - ok
    };
    this.retireOperation(operation);
  }

  private completeRefresh(operation: ActiveOperation, results: readonly RefreshManyResult[]) {
    if (operation.kind === "refresh") {
      const ok = results.filter((result) => result.ok).length;
      this.lastForegroundProgress = {
        kind: "refresh",
        phase: "completed",
        completed: results.length,
        total: operation.total,
        ok,
        failed: results.length - ok
      };
      this.failedRefreshAccountIds = Object.freeze(
        results
          .filter((result) => !result.ok && !result.canceled)
          .map((result) => result.accountId)
      );
    }
    this.retireOperation(operation);
  }

  private failOperation(operation: ActiveOperation) {
    if (!this.operations.has(operation.token)) {
      return;
    }
    if (operation.kind === "test" || operation.kind === "refresh") {
      this.lastForegroundProgress = null;
    }
    this.retireOperation(operation);
  }

  private retireOperation(operation: ActiveOperation) {
    if (operation.jobId) {
      this.retiredJobIds.add(operation.jobId);
      if (this.retiredJobIds.size > 256) {
        const oldest = this.retiredJobIds.values().next().value as string | undefined;
        if (oldest) {
          this.retiredJobIds.delete(oldest);
        }
      }
    }
    this.operations.delete(operation.token);
    this.publish();
  }

  private findOperation(kind: "test" | "refresh") {
    return Array.from(this.operations.values()).find((operation) => operation.kind === kind) ?? null;
  }

  private publish() {
    if (this.disposed) {
      return;
    }
    const operations = Array.from(this.operations.values());
    const foregroundOperation = operations.find(
      (operation) => operation.kind === "test" || operation.kind === "refresh"
    );
    const progress = foregroundOperation
      ? {
          kind: foregroundOperation.kind as "test" | "refresh",
          phase: foregroundOperation.phase,
          completed: foregroundOperation.completed,
          total: foregroundOperation.total,
          ok: foregroundOperation.ok,
          failed: foregroundOperation.failed
        }
      : this.lastForegroundProgress;
    const busyAccountIds = Object.freeze(
      operations
        .filter((operation) => operation.kind === "refreshSingle")
        .flatMap((operation) => [...operation.accountIds])
    );
    const hasBatchOperation = operations.some((operation) => operation.kind !== "refreshSingle");

    this.state = {
      testRunning: operations.some((operation) => operation.kind === "test"),
      manualRefreshRunning: operations.some((operation) => operation.kind === "refresh"),
      backgroundRefreshRunning: operations.some((operation) => operation.kind === "refreshBackground"),
      anyJobRunning: operations.length > 0,
      singleRefreshBlocked: hasBatchOperation,
      busyAccountIds,
      failedRefreshAccountIds: this.failedRefreshAccountIds,
      progress,
      progressText: progressText(progress),
      canRetryFailedRefresh:
        operations.length === 0 &&
        progress?.kind === "refresh" &&
        progress.phase === "completed" &&
        this.failedRefreshAccountIds.length > 0
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function createRefreshJobSession(adapter: RefreshJobAdapter): RefreshJobSession {
  return new DefaultRefreshJobSession(adapter);
}

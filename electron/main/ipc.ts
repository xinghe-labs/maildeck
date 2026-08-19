import { dialog } from "electron";
import {
  IPC_CHANNELS,
  IPC_EVENT_CHANNELS,
  IPC_REQUEST_SCHEMAS,
  IpcRequestValidationError,
  IMPORT_TEXT_MAX_BYTES,
  parseIpcRequest
} from "../shared/ipc-contracts.js";
import { clearAccountCache, clearAllMailCache } from "./mail-cache.js";
import { closeProxyDispatchers } from "./proxy-agent.js";
import {
  deleteAccount,
  findAccountIdsByEmails,
  listAccounts,
  previewAccounts,
  updateAccount,
  upsertAccounts
} from "./account-store.js";
import { parseAccountImport } from "./import-parser.js";
import { getPublicSettings, getSettingsSnapshot, updateSettings } from "./settings-store.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";
import { createMailboxAccess, type MailboxAccess } from "./mailbox-access.js";
import { handleValidated, sendValidatedEvent } from "./validated-ipc.js";
import { FileTooLargeError, readUtf8FileBounded } from "./bounded-file-reader.js";
import type {
  JobKind,
  RefreshManyResult,
  RefreshMetrics,
  RefreshProgressEvent,
  TestManyResult,
  TestProgressEvent
} from "./types.js";

const refreshCoordinator = new RefreshCoordinator();
const ACCOUNT_MUTATION_LOCK = Symbol("account-mutation");

function cancelError(job: JobKind) {
  return job === "test" ? "批量测试已取消" : "刷新已取消";
}

function canceledError(job: JobKind) {
  return { code: "CANCELED" as const, message: cancelError(job), retryable: false };
}

function nowMs() {
  return performance.now();
}

function elapsedSince(start: number) {
  return Math.round(performance.now() - start);
}

function createRefreshMetrics(): RefreshMetrics {
  return { tokenMs: 0, mailMs: 0, cacheMs: 0, stateMs: 0, totalMs: 0 };
}

function resolveBatchLimit(requestedLimit: number, total: number) {
  if (total <= 0) {
    return 1;
  }

  const requested = Number.isFinite(requestedLimit) ? Math.max(1, Math.round(requestedLimit)) : 4;
  const volumeCap = total >= 80 ? 6 : total >= 30 ? 8 : 12;
  return Math.min(requested, volumeCap, total);
}

async function runLimited<T, R>(
  items: T[],
  limit: number,
  handler: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await handler(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(1, Math.round(limit)), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function runConfiguredNetworkAccount<T>(
  accountId: string,
  operation: (mailbox: MailboxAccess, signal: AbortSignal) => Promise<T>
) {
  const settingsSnapshot = await getSettingsSnapshot();
  const { settings } = settingsSnapshot;
  refreshCoordinator.setConcurrency(settings.batchConcurrency);
  const mailbox = createMailboxAccess(settingsSnapshot);
  return refreshCoordinator.runNetworkAccount(accountId, (signal) => operation(mailbox, signal));
}

function runAccountMutation<T>(
  resolveAccountIds: () => Iterable<string> | Promise<Iterable<string>>,
  operation: () => Promise<T>
): Promise<T> {
  return refreshCoordinator.runAccount(ACCOUNT_MUTATION_LOCK, async () => {
    const accountIds = await resolveAccountIds();
    return refreshCoordinator.runAccounts(accountIds, operation);
  });
}

async function upsertAccountsCoordinated(inputs: Parameters<typeof upsertAccounts>[0]) {
  return runAccountMutation(
    () => findAccountIdsByEmails(inputs.map((input) => input.email)),
    async () => {
      const { affectedAccountIds: _affectedAccountIds, ...result } = await upsertAccounts(inputs);
      return result;
    }
  );
}

export function registerIpcHandlers() {
  handleValidated(IPC_CHANNELS.accountsList, IPC_REQUEST_SCHEMAS.accountsList, async () => listAccounts());

  handleValidated(IPC_CHANNELS.settingsGet, IPC_REQUEST_SCHEMAS.getSettings, async () => getPublicSettings());

  handleValidated(
    IPC_CHANNELS.settingsUpdate,
    IPC_REQUEST_SCHEMAS.updateSettings,
    async (_event, settings) => {
      const next = await updateSettings(settings);
      if (next.proxyChanged) {
        closeProxyDispatchers();
      }
      refreshCoordinator.setConcurrency(next.settings.batchConcurrency);
      return next.settings;
    }
  );

  handleValidated(IPC_CHANNELS.jobsCancel, IPC_REQUEST_SCHEMAS.cancelJob, async (_event, job) => {
    return { canceled: job, count: refreshCoordinator.cancel(job) };
  });

  handleValidated(IPC_CHANNELS.accountsPreviewImportText, IPC_REQUEST_SCHEMAS.importText, async (_event, text) => {
    return previewAccounts(parseAccountImport(text));
  });

  handleValidated(IPC_CHANNELS.accountsImportText, IPC_REQUEST_SCHEMAS.importText, async (_event, text) => {
    return upsertAccountsCoordinated(parseAccountImport(text));
  });

  handleValidated(IPC_CHANNELS.accountsImportFile, IPC_REQUEST_SCHEMAS.importFile, async () => {
    const result = await dialog.showOpenDialog({
      title: "导入邮箱账号",
      filters: [
        { name: "Account files", extensions: ["csv", "txt"] },
        { name: "All files", extensions: ["*"] }
      ],
      properties: ["openFile"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    let fileText: string;
    try {
      fileText = await readUtf8FileBounded(result.filePaths[0], IMPORT_TEXT_MAX_BYTES);
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        throw new IpcRequestValidationError(`导入文件不能超过 ${IMPORT_TEXT_MAX_BYTES} 字节`);
      }
      throw error;
    }
    const text = parseIpcRequest(IPC_REQUEST_SCHEMAS.importText, [fileText]);
    return upsertAccountsCoordinated(parseAccountImport(text));
  });

  handleValidated(IPC_CHANNELS.accountsUpsert, IPC_REQUEST_SCHEMAS.upsertAccount, async (_event, input) => {
    return upsertAccountsCoordinated([input]);
  });

  handleValidated(IPC_CHANNELS.accountsUpdate, IPC_REQUEST_SCHEMAS.updateAccount, async (_event, input) => {
    return runAccountMutation(() => [input.id], async () => {
      const account = await updateAccount(input);
      await clearAccountCache(account.id);
      return account;
    });
  });

  handleValidated(IPC_CHANNELS.accountsDelete, IPC_REQUEST_SCHEMAS.deleteAccount, async (_event, accountId) => {
    return runAccountMutation(() => [accountId], () => deleteAccount(accountId));
  });

  handleValidated(IPC_CHANNELS.accountsTest, IPC_REQUEST_SCHEMAS.testAccount, async (_event, accountId) => {
    const result = await runConfiguredNetworkAccount(accountId, (mailbox, signal) =>
      mailbox.testConnection(accountId, true, signal)
    );
    return result.ok
      ? { account: result.account, ok: true as const, message: result.message }
      : { account: result.account, ok: false as const, error: result.error };
  });

  handleValidated(IPC_CHANNELS.accountsTestFallback, IPC_REQUEST_SCHEMAS.testFallback, async (_event, accountId) => {
    return runConfiguredNetworkAccount(accountId, (mailbox, signal) => mailbox.testFallback(accountId, signal));
  });

  handleValidated(IPC_CHANNELS.accountsTestMany, IPC_REQUEST_SCHEMAS.testMany, async (event, accountIds) => {
    return refreshCoordinator.runJob("test", async (job) => {
      const settingsSnapshot = await getSettingsSnapshot();
      const { settings } = settingsSnapshot;
      const mailbox = createMailboxAccess(settingsSnapshot);
      refreshCoordinator.setConcurrency(settings.batchConcurrency);
      let completed = 0;
      let ok = 0;
      let failed = 0;
      const total = accountIds.length;
      const sendProgress = (payload: Omit<TestProgressEvent, "jobId" | "kind">) => {
        sendValidatedEvent(event.sender, IPC_EVENT_CHANNELS.accountsTestProgress, {
          ...payload,
          jobId: job.id,
          kind: "test" as const
        });
      };

      return runLimited(accountIds, resolveBatchLimit(settings.batchConcurrency, total), (accountId) =>
        job.runAccount<TestManyResult>(
          accountId,
          async (signal) => {
            const result = await mailbox.testConnection(accountId, true, signal);
            completed += 1;
            if (result.ok) {
              ok += 1;
              sendProgress({ completed, total, ok, failed, accountId });
            } else {
              failed += 1;
              sendProgress({ completed, total, ok, failed, accountId, error: result.error });
            }
            return result;
          },
          () => {
            completed += 1;
            failed += 1;
            const error = canceledError("test");
            sendProgress({ completed, total, ok, failed, accountId, error });
            return { accountId, account: null, ok: false as const, error };
          }
        )
      );
    });
  });

  handleValidated(IPC_CHANNELS.mailListFolders, IPC_REQUEST_SCHEMAS.listFolders, async (_event, accountId) => {
    return runConfiguredNetworkAccount(accountId, (mailbox, signal) => mailbox.listFolders(accountId, signal));
  });

  handleValidated(IPC_CHANNELS.mailListMessages, IPC_REQUEST_SCHEMAS.listMessages, async (_event, options) => {
    return runConfiguredNetworkAccount(options.accountId, (mailbox, signal) => mailbox.listMessages(options, signal));
  });

  handleValidated(IPC_CHANNELS.mailGetMessage, IPC_REQUEST_SCHEMAS.getMessage, async (_event, options) => {
    return runConfiguredNetworkAccount(options.accountId, (mailbox, signal) => mailbox.getMessage(options, signal));
  });

  handleValidated(IPC_CHANNELS.mailClearCache, IPC_REQUEST_SCHEMAS.clearCache, async (_event, accountId) => {
    if (accountId) {
      await clearAccountCache(accountId);
      return { cleared: 1 };
    }
    await clearAllMailCache();
    return { cleared: "all" };
  });

  handleValidated(IPC_CHANNELS.mailRefreshMany, IPC_REQUEST_SCHEMAS.refreshMany, async (event, request) => {
    const { accountIds, jobKind } = request;
    return refreshCoordinator.runJob(jobKind, async (job) => {
      const settingsSnapshot = await getSettingsSnapshot();
      const { settings } = settingsSnapshot;
      const mailbox = createMailboxAccess(settingsSnapshot);
      refreshCoordinator.setConcurrency(settings.batchConcurrency);
      let completed = 0;
      let ok = 0;
      let failed = 0;
      const total = accountIds.length;
      const batchLimit = resolveBatchLimit(settings.batchConcurrency, total);
      const sendProgress = (payload: Omit<RefreshProgressEvent, "jobId" | "kind">) => {
        sendValidatedEvent(event.sender, IPC_EVENT_CHANNELS.mailRefreshProgress, {
          ...payload,
          jobId: job.id,
          kind: jobKind
        });
      };

      const results = await runLimited(accountIds, batchLimit, (accountId) => {
        const canceledMetrics = createRefreshMetrics();
        const queuedAt = nowMs();
        return job.runAccount<RefreshManyResult>(
          accountId,
          async (signal) => {
            const result = await mailbox.refreshAccount(accountId, signal);
            completed += 1;
            if (result.ok) {
              ok += 1;
              sendProgress({ completed, total, ok, failed, accountId, metrics: result.metrics });
            } else {
              failed += 1;
              sendProgress({
                completed,
                total,
                ok,
                failed,
                accountId,
                error: result.error,
                metrics: result.metrics
              });
            }
            return result;
          },
          () => {
            const error = canceledError(jobKind);
            failed += 1;
            completed += 1;
            canceledMetrics.totalMs = elapsedSince(queuedAt);
            sendProgress({
              completed,
              total,
              ok,
              failed,
              accountId,
              error,
              metrics: canceledMetrics
            });
            return {
              accountId,
              ok: false,
              canceled: true,
              count: 0,
              error,
              metrics: canceledMetrics
            };
          }
        );
      });

      const slowest = results
        .filter((result) => result.metrics)
        .sort((left, right) => (right.metrics?.totalMs || 0) - (left.metrics?.totalMs || 0))
        .slice(0, 5)
        .map((result) => ({
          accountId: result.accountId,
          ok: result.ok,
          count: result.count,
          metrics: result.metrics
        }));
      console.info("mail:refreshMany summary", { total, batchLimit, ok, failed, slowest });
      return results;
    });
  });
}

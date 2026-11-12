// maildeck-shim.js — 把原版 Electron preload 的 window.maildeck 契约桥接到 Tauri invoke。
// 渲染层代码零改动：接口名、参数、返回值、错误抛出形态（AppErrorPayload）与原版完全一致。
(function () {
  "use strict";

  var invoke = window.__TAURI__.core.invoke;
  var listen = window.__TAURI__.event.listen;

  // Tauri invoke 失败时 reject 的就是主进程 Err(Value)（AppErrorPayload 原样透传），
  // 但为保险起见，非对象错误统一包成 transportError（与原版语义一致）。
  function call(channel, args) {
    return invoke(channel, args).catch(function (error) {
      if (error && typeof error === "object" && typeof error.code === "string" &&
        typeof error.message === "string" && typeof error.retryable === "boolean") {
        throw error;
      }
      throw { code: "UNKNOWN", message: "主进程通信失败，请重试。", retryable: true };
    });
  }

  function onEvent(channel, callback) {
    var unlisten = null;
    var disposed = false;
    listen(channel, function (event) { callback(event.payload); }).then(function (fn) {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return function () {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }

  window.maildeck = {
    app: {
      openExternal: function (url) { return call("app_open_external", { url: url }); }
    },
    accounts: {
      list: function () { return call("accounts_list", {}); },
      previewImportText: function (text) { return call("accounts_preview_import_text", { text: text }); },
      importText: function (text) { return call("accounts_import_text", { text: text }); },
      importFile: function () { return call("accounts_import_file", {}); },
      upsert: function (input) { return call("accounts_upsert", { input: input }); },
      update: function (input) { return call("accounts_update", { input: input }); },
      delete: function (accountId) { return call("accounts_delete", { accountId: accountId }); },
      test: function (accountId) { return call("accounts_test", { accountId: accountId }); },
      testFallback: function (accountId) { return call("accounts_test_fallback", { accountId: accountId }); },
      testMany: function (accountIds) { return call("accounts_test_many", { accountIds: accountIds }); },
      refreshMany: function (accountIds, jobKind) {
        return call("mail_refresh_many", { request: { accountIds: accountIds, jobKind: jobKind || "refresh" } });
      },
      onRefreshProgress: function (callback) { return onEvent("mail:refreshProgress", callback); },
      onTestProgress: function (callback) { return onEvent("accounts:testProgress", callback); }
    },
    mail: {
      listFolders: function (accountId) { return call("mail_list_folders", { accountId: accountId }); },
      listMessages: function (options) { return call("mail_list_messages", { options: options }); },
      getMessage: function (options) { return call("mail_get_message", { options: options }); },
      listAttachments: function (options) { return call("mail_list_attachments", { options: options }); },
      saveAttachment: function (options) { return call("mail_save_attachment", { options: options }); },
      cacheStats: function () { return call("mail_cache_stats", {}); },
      clearCache: function (accountId) {
        return call("mail_clear_cache", { accountId: accountId === undefined ? null : accountId });
      }
    },
    settings: {
      get: function () { return call("settings_get", {}); },
      update: function (settings) { return call("settings_set", { patch: settings }); }
    },
    jobs: {
      cancel: function (job) { return call("jobs_cancel", { job: job }); }
    },
    auth: {
      startDeviceCode: function (options) {
        return call("auth_start_device_code", { clientId: options && options.clientId ? options.clientId : null });
      },
      cancelDeviceCode: function () { return call("auth_cancel_device_code", {}); },
      onDeviceCodeState: function (callback) { return onEvent("auth:deviceCodeState", callback); }
    },
    update: {
      getState: function () { return call("update_get_state", {}); },
      check: function () { return call("update_check", {}); },
      install: function () { return call("update_install", {}); },
      onState: function (callback) { return onEvent("update:state", callback); }
    },
    // 仅 Tauri 壳层提供：旧 Electron 主进程没有这套 IPC，渲染层按「有没有这个命名空间」决定是否显示设置。
    telegram: {
      get: function () { return call("telegram_get_config", {}); },
      update: function (config) { return call("telegram_set_config", { input: config }); },
      test: function (config) { return call("telegram_test", { input: config }); }
    }
  };
})();

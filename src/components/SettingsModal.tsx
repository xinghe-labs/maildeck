import { Loader2, Settings } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { getDesktopApi } from "../desktop-api";
import { errorMessage } from "../app-error";
import { APP_VERSION } from "../app-version";
import { validateNumberField } from "../form-validation";
import type { FieldErrors } from "../form-validation";
import { formatBytes } from "../ui-utils";
import type { AppSettings, AppSettingsUpdate, MailCacheStats } from "../types";
import { ModalShell } from "./ModalShell";

type SettingsField = "batchConcurrency" | "autoRefreshIntervalMinutes";

interface SettingsFormState {
  cacheMessages: boolean;
  cacheBodies: boolean;
  proxyUrl: string;
  proxyUsername: string;
  proxyPassword: string;
  clearProxyPassword: boolean;
  // 两个数字项用字符串存：换成 number 就分不出「用户清空了输入框」和「用户填了 1」,
  // 原实现是 Number(value) || 1,清空会被静默改成 1（P5）。
  batchConcurrency: string;
  hotmailFallbackEnabled: boolean;
  autoRefreshEnabled: boolean;
  autoRefreshIntervalMinutes: string;
}

function initialForm(settings: AppSettings): SettingsFormState {
  return {
    cacheMessages: settings.cacheMessages,
    cacheBodies: settings.cacheBodies,
    proxyUrl: settings.proxyUrl,
    proxyUsername: settings.proxyUsername,
    proxyPassword: "",
    clearProxyPassword: false,
    batchConcurrency: String(settings.batchConcurrency),
    hotmailFallbackEnabled: settings.hotmailFallbackEnabled,
    autoRefreshEnabled: settings.autoRefreshEnabled,
    autoRefreshIntervalMinutes: String(settings.autoRefreshIntervalMinutes)
  };
}

export function SettingsModal({
  settings,
  onClose,
  onSaved
}: {
  settings: AppSettings;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
}) {
  const [form, setForm] = useState<SettingsFormState>(() => initialForm(settings));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<SettingsField>>({});
  const concurrencyInputRef = useRef<HTMLInputElement>(null);
  const intervalInputRef = useRef<HTMLInputElement>(null);
  const hasProxyEndpoint = Boolean(form.proxyUrl.trim());
  const proxyProtocolUnsupported = hasProxyEndpoint && !/^https?:\/\//iu.test(form.proxyUrl.trim());
  const proxyIdentityUnchanged =
    form.proxyUrl.trim() === settings.proxyUrl && form.proxyUsername.trim() === settings.proxyUsername;
  const [cacheStats, setCacheStats] = useState<MailCacheStats | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheMessage, setCacheMessage] = useState("");

  // 缓存开关只控制“以后还缓不缓存”，已经落盘的数据得让用户看得见、能清掉（P6）。
  useEffect(() => {
    const api = getDesktopApi();
    // 老版本 preload / 测试桩可能还没有这个方法，缺了就退回“未知”，别把设置弹窗砸挂。
    if (!api?.mail || typeof api.mail.cacheStats !== "function") {
      return;
    }
    let active = true;
    api.mail
      .cacheStats()
      .then((stats) => {
        if (active) {
          setCacheStats(stats);
        }
      })
      .catch(() => {
        if (active) {
          setCacheStats(null);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function clearMailCache() {
    const api = getDesktopApi();
    if (!api?.mail || typeof api.mail.clearCache !== "function") {
      return;
    }
    setClearingCache(true);
    setCacheMessage("");
    try {
      await api.mail.clearCache();
      const stats = await api.mail.cacheStats();
      setCacheStats(stats);
      setCacheMessage("邮件缓存已清空");
    } catch (cacheError) {
      setCacheMessage(errorMessage(cacheError));
    } finally {
      setClearingCache(false);
    }
  }

  const cacheStatsText = cacheStats
    ? `缓存占用：${formatBytes(cacheStats.approximateBytes)}（邮件 ${cacheStats.messageCount} 条 · 正文 ${cacheStats.bodyCount} 封 · ${cacheStats.accountCount} 个账号）`
    : "缓存占用：读取中…";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const api = getDesktopApi();
    if (!api) {
      setError("设置需要在 Electron 桌面应用中使用。");
      return;
    }
    if (proxyProtocolUnsupported) {
      setError("代理仅支持 HTTP 或 HTTPS。请修改代理地址，或清空后使用直连。");
      return;
    }

    // ModalShell 已关掉原生校验提示，所以区间必须在这里守住（P5）。
    const concurrencyError = validateNumberField(form.batchConcurrency, {
      min: 1,
      max: 12,
      label: "批量并发"
    });
    const intervalError = form.autoRefreshEnabled
      ? validateNumberField(form.autoRefreshIntervalMinutes, {
          min: 1,
          max: 120,
          label: "刷新间隔",
          unit: " 分钟"
        })
      : null;

    if (concurrencyError || intervalError) {
      setFieldErrors({
        ...(concurrencyError ? { batchConcurrency: concurrencyError } : {}),
        ...(intervalError ? { autoRefreshIntervalMinutes: intervalError } : {})
      });
      setError("");
      (concurrencyError ? concurrencyInputRef : intervalInputRef).current?.focus();
      return;
    }
    setFieldErrors({});

    const proxyUrl = form.proxyUrl.trim();
    const update: AppSettingsUpdate = {
      cacheMessages: form.cacheMessages,
      cacheBodies: form.cacheBodies,
      proxyUrl,
      proxyUsername: proxyUrl ? form.proxyUsername.trim() : "",
      proxyPassword: proxyUrl ? form.proxyPassword : "",
      clearProxyPassword: proxyUrl ? form.clearProxyPassword : false,
      batchConcurrency: Number(form.batchConcurrency),
      hotmailFallbackEnabled: form.hotmailFallbackEnabled,
      autoRefreshEnabled: form.autoRefreshEnabled,
      autoRefreshIntervalMinutes: Number(form.autoRefreshIntervalMinutes)
    };

    setLoading(true);
    setError("");

    try {
      onSaved(await api.settings.update(update));
      onClose();
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <ModalShell
      title="设置"
      subtitle="缓存、网络与自动刷新的默认行为"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="secondary-button dark-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button dark-primary" type="submit" disabled={loading || proxyProtocolUnsupported}>
            {loading ? <Loader2 size={16} className="spin" /> : <Settings size={16} />}
            保存设置
          </button>
        </>
      }
    >
      <section className="settings-section">
        <h3>邮件与缓存</h3>
        <div className="settings-grid">
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.cacheMessages}
              onChange={(event) => setForm({ ...form, cacheMessages: event.target.checked })}
            />
            缓存邮件列表
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.cacheBodies}
              onChange={(event) => setForm({ ...form, cacheBodies: event.target.checked })}
            />
            缓存邮件正文
          </label>
          <div className="settings-cache-row span-2">
            <span className="field-hint">{cacheStatsText}</span>
            <button
              type="button"
              className="secondary-button dark-button settings-cache-clear"
              onClick={() => void clearMailCache()}
              disabled={clearingCache}
            >
              {clearingCache ? "清理中…" : "清空邮件缓存"}
            </button>
          </div>
          {cacheMessage ? (
            <p className="settings-cache-message span-2" role="status">
              {cacheMessage}
            </p>
          ) : null}
          <label>
            批量并发
            <input
              ref={concurrencyInputRef}
              type="number"
              min={1}
              max={12}
              value={form.batchConcurrency}
              aria-invalid={fieldErrors.batchConcurrency ? true : undefined}
              aria-describedby={fieldErrors.batchConcurrency ? "settings-concurrency-error" : undefined}
              onChange={(event) => {
                setForm({ ...form, batchConcurrency: event.target.value });
                setFieldErrors((previous) => ({ ...previous, batchConcurrency: undefined }));
              }}
            />
            {fieldErrors.batchConcurrency ? (
              <span className="field-error" id="settings-concurrency-error" role="alert">
                {fieldErrors.batchConcurrency}
              </span>
            ) : (
              <span className="field-hint">同时测试/刷新的账号数，网络较差时建议 2–4。</span>
            )}
          </label>
        </div>
      </section>

      <section className="settings-section">
        <h3>网络与认证</h3>
        <p className="settings-section-hint">代理仅支持 HTTP/HTTPS，留空表示直连。</p>
        <div className="settings-grid">
          <label>
            代理地址
            <input
              value={form.proxyUrl}
              onChange={(event) => setForm({ ...form, proxyUrl: event.target.value, clearProxyPassword: false })}
              placeholder="http://127.0.0.1:7890"
              spellCheck={false}
            />
          </label>
          <label>
            代理用户名
            <input
              value={form.proxyUsername}
              onChange={(event) => setForm({ ...form, proxyUsername: event.target.value, clearProxyPassword: false })}
              disabled={!hasProxyEndpoint}
              autoComplete="username"
              placeholder={hasProxyEndpoint ? "可选" : "先填写代理地址"}
            />
          </label>
          <label>
            代理密码
            <input
              type="password"
              value={form.proxyPassword}
              onChange={(event) =>
                setForm({ ...form, proxyPassword: event.target.value, clearProxyPassword: false })
              }
              disabled={!hasProxyEndpoint}
              autoComplete="new-password"
              placeholder={
                !hasProxyEndpoint
                  ? "先填写代理地址"
                  : settings.proxyHasPassword
                    ? proxyIdentityUnchanged
                      ? "已保存，留空保留"
                      : "留空将清除旧密码"
                    : "可选"
              }
            />
          </label>
          {settings.proxyHasPassword ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.clearProxyPassword}
                disabled={!hasProxyEndpoint}
                onChange={(event) =>
                  setForm({ ...form, clearProxyPassword: event.target.checked, proxyPassword: "" })
                }
              />
              清除已保存的代理密码
            </label>
          ) : null}
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.hotmailFallbackEnabled}
              onChange={(event) => setForm({ ...form, hotmailFallbackEnabled: event.target.checked })}
            />
            内置 Hotmail 兜底
          </label>
        </div>
      </section>

      <section className="settings-section">
        <h3>自动刷新</h3>
        <p className="settings-section-hint">应用打开时才会定时刷新；关闭窗口后刷新停止。</p>
        <div className="settings-grid">
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.autoRefreshEnabled}
              onChange={(event) => setForm({ ...form, autoRefreshEnabled: event.target.checked })}
            />
            应用打开时定时刷新
          </label>
          <label>
            刷新间隔（分钟）
            <input
              ref={intervalInputRef}
              type="number"
              min={1}
              max={120}
              value={form.autoRefreshIntervalMinutes}
              disabled={!form.autoRefreshEnabled}
              aria-invalid={fieldErrors.autoRefreshIntervalMinutes ? true : undefined}
              aria-describedby={fieldErrors.autoRefreshIntervalMinutes ? "settings-interval-error" : undefined}
              onChange={(event) => {
                setForm({ ...form, autoRefreshIntervalMinutes: event.target.value });
                setFieldErrors((previous) => ({ ...previous, autoRefreshIntervalMinutes: undefined }));
              }}
            />
            {fieldErrors.autoRefreshIntervalMinutes ? (
              <span className="field-error" id="settings-interval-error" role="alert">
                {fieldErrors.autoRefreshIntervalMinutes}
              </span>
            ) : null}
          </label>
        </div>
      </section>

      {proxyProtocolUnsupported ? (
        <div className="error-box">当前代理协议不受支持，请改为 HTTP/HTTPS 或清空代理地址。</div>
      ) : null}
      {error ? <div className="error-box">{error}</div> : null}
      <p className="settings-version">Outlook Manager v{APP_VERSION}</p>
    </ModalShell>
  );
}

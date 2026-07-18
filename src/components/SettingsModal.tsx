import { Loader2, Settings, X } from "lucide-react";
import { FormEvent, useState } from "react";
import { getDesktopApi } from "../desktop-api";
import type { AppSettings, AppSettingsUpdate } from "../types";

interface SettingsFormState {
  cacheMessages: boolean;
  cacheBodies: boolean;
  proxyUrl: string;
  proxyUsername: string;
  proxyPassword: string;
  clearProxyPassword: boolean;
  batchConcurrency: number;
  hotmailFallbackEnabled: boolean;
  autoRefreshEnabled: boolean;
  autoRefreshIntervalMinutes: number;
}

function initialForm(settings: AppSettings): SettingsFormState {
  return {
    cacheMessages: settings.cacheMessages,
    cacheBodies: settings.cacheBodies,
    proxyUrl: settings.proxyUrl,
    proxyUsername: settings.proxyUsername,
    proxyPassword: "",
    clearProxyPassword: false,
    batchConcurrency: settings.batchConcurrency,
    hotmailFallbackEnabled: settings.hotmailFallbackEnabled,
    autoRefreshEnabled: settings.autoRefreshEnabled,
    autoRefreshIntervalMinutes: settings.autoRefreshIntervalMinutes
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
  const hasProxyEndpoint = Boolean(form.proxyUrl.trim());
  const proxyProtocolUnsupported = hasProxyEndpoint && !/^https?:\/\//iu.test(form.proxyUrl.trim());
  const proxyIdentityUnchanged =
    form.proxyUrl.trim() === settings.proxyUrl && form.proxyUsername.trim() === settings.proxyUsername;

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

    const proxyUrl = form.proxyUrl.trim();
    const update: AppSettingsUpdate = {
      cacheMessages: form.cacheMessages,
      cacheBodies: form.cacheBodies,
      proxyUrl,
      proxyUsername: proxyUrl ? form.proxyUsername.trim() : "",
      proxyPassword: proxyUrl ? form.proxyPassword : "",
      clearProxyPassword: proxyUrl ? form.clearProxyPassword : false,
      batchConcurrency: form.batchConcurrency,
      hotmailFallbackEnabled: form.hotmailFallbackEnabled,
      autoRefreshEnabled: form.autoRefreshEnabled,
      autoRefreshIntervalMinutes: form.autoRefreshIntervalMinutes
    };

    setLoading(true);
    setError("");

    try {
      onSaved(await api.settings.update(update));
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal dark-modal" onSubmit={submit}>
        <div className="modal-header">
          <div>
            <h2>设置</h2>
            <p>代理仅支持 HTTP/HTTPS，留空表示直连</p>
          </div>
          <button className="toolbar-icon" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
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
          <label>
            批量并发
            <input
              type="number"
              min={1}
              max={12}
              value={form.batchConcurrency}
              onChange={(event) => setForm({ ...form, batchConcurrency: Number(event.target.value) || 1 })}
            />
          </label>
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
                settings.proxyHasPassword
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
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.autoRefreshEnabled}
              onChange={(event) => setForm({ ...form, autoRefreshEnabled: event.target.checked })}
            />
            后台定时刷新
          </label>
          <label>
            刷新间隔（分钟）
            <input
              type="number"
              min={1}
              max={120}
              value={form.autoRefreshIntervalMinutes}
              disabled={!form.autoRefreshEnabled}
              onChange={(event) =>
                setForm({ ...form, autoRefreshIntervalMinutes: Number(event.target.value) || 10 })
              }
            />
          </label>
        </div>
        {proxyProtocolUnsupported ? (
          <div className="error-box">当前代理协议不受支持，请改为 HTTP/HTTPS 或清空代理地址。</div>
        ) : null}
        {error ? <div className="error-box">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button dark-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button dark-primary" type="submit" disabled={loading || proxyProtocolUnsupported}>
            {loading ? <Loader2 size={16} className="spin" /> : <Settings size={16} />}
            保存设置
          </button>
        </div>
      </form>
    </div>
  );
}

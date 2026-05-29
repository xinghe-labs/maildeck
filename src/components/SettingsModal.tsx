import { Loader2, Settings, X } from "lucide-react";
import { FormEvent, useState } from "react";
import { getDesktopApi } from "../desktop-api";
import type { AppSettings } from "../types";

export function SettingsModal({
  settings,
  onClose,
  onSaved
}: {
  settings: AppSettings;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
}) {
  const [form, setForm] = useState<AppSettings>(settings);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const api = getDesktopApi();
    if (!api) {
      setError("设置需要在 Electron 桌面应用中使用。");
      return;
    }

    setLoading(true);
    setError("");

    try {
      onSaved(await api.settings.update(form));
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
            <p>代理支持 HTTP/HTTPS/SOCKS，留空表示直连</p>
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
              onChange={(event) => setForm({ ...form, proxyUrl: event.target.value })}
              placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
            />
          </label>
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
              onChange={(event) => setForm({ ...form, autoRefreshIntervalMinutes: Number(event.target.value) || 10 })}
            />
          </label>
        </div>
        {error ? <div className="error-box">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button dark-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button dark-primary" type="submit" disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <Settings size={16} />}
            保存设置
          </button>
        </div>
      </form>
    </div>
  );
}

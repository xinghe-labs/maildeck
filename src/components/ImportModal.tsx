import { Loader2, Plus, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { errorMessage } from "../app-error";
import type { AccountInput, ImportPreviewResult, ImportResult } from "../types";

const emptyAccountForm: AccountInput = {
  email: "",
  clientId: "",
  refreshToken: "",
  remark: "",
  group: ""
};

export function ImportModal({
  onClose,
  onImported,
  onPreviewImportText,
  onImportText,
  onUpsert
}: {
  onClose: () => void;
  onImported: (result: ImportResult) => void;
  onPreviewImportText: (text: string) => Promise<ImportPreviewResult | null>;
  onImportText: (text: string) => Promise<ImportResult | null>;
  onUpsert: (input: AccountInput) => Promise<ImportResult | null>;
}) {
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [single, setSingle] = useState<AccountInput>(emptyAccountForm);
  const [batchText, setBatchText] = useState("");
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const previewText = mode === "single"
    ? `${single.email},${single.clientId},${single.refreshToken}`
    : batchText;
  const currentPreviewTextRef = useRef(previewText);
  const mountedRef = useRef(true);
  currentPreviewTextRef.current = previewText;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setPreview(null);
  }, [previewText]);

  async function previewBatch() {
    const requestedText = previewText;
    setPreviewing(true);
    setError("");
    try {
      const result = await onPreviewImportText(requestedText);
      if (result && mountedRef.current && currentPreviewTextRef.current === requestedText) {
        setPreview(result);
      }
    } catch (previewError) {
      if (mountedRef.current && currentPreviewTextRef.current === requestedText) {
        setError(errorMessage(previewError));
      }
    } finally {
      if (mountedRef.current) {
        setPreviewing(false);
      }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const result = mode === "single" ? await onUpsert(single) : await onImportText(batchText);
      if (!result) {
        return;
      }
      onImported(result);
      onClose();
    } catch (submitError) {
      if (mountedRef.current) {
        setError(errorMessage(submitError));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal dark-modal" onSubmit={submit}>
        <div className="modal-header">
          <div>
            <h2>导入邮箱</h2>
            <p>支持 CSV、email----client_id----refresh_token、email----password----client_id----refresh_token</p>
          </div>
          <button className="toolbar-icon" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="import-format-help">
          <strong>可上传 .txt / .csv 文件，也可直接粘贴多行。</strong>
          <span>CSV: email,client_id,refresh_token,remark,group</span>
          <span>短横线: email----client_id----refresh_token----remark----group</span>
          <span>带密码: email----password----client_id----refresh_token----remark----group</span>
        </div>

        <div className="segmented dark-segmented">
          <button type="button" className={mode === "single" ? "active" : ""} onClick={() => setMode("single")}>
            单个账号
          </button>
          <button type="button" className={mode === "batch" ? "active" : ""} onClick={() => setMode("batch")}>
            批量粘贴
          </button>
        </div>

        {mode === "single" ? (
          <div className="form-grid">
            <label>
              邮箱
              <input value={single.email} onChange={(event) => setSingle({ ...single, email: event.target.value })} required />
            </label>
            <label>
              Client ID
              <input value={single.clientId} onChange={(event) => setSingle({ ...single, clientId: event.target.value })} required />
            </label>
            <label className="span-2">
              Refresh Token
              <textarea
                value={single.refreshToken}
                onChange={(event) => setSingle({ ...single, refreshToken: event.target.value })}
                required
              />
            </label>
            <label>
              备注
              <input value={single.remark} onChange={(event) => setSingle({ ...single, remark: event.target.value })} />
            </label>
            <label>
              分组
              <input value={single.group} onChange={(event) => setSingle({ ...single, group: event.target.value })} />
            </label>
          </div>
        ) : (
          <label className="stacked-label">
            导入文本
            <textarea
              className="batch-textarea"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={
                "email,client_id,refresh_token,remark,group\nuser@hotmail.com,9e5f94bc-e8a4-4e73-b8be-63364c29d753,M.Cxxx,主号,A组\nuser@hotmail.com----9e5f94bc-e8a4-4e73-b8be-63364c29d753----M.Cxxx----主号----A组\nuser@hotmail.com----password----9e5f94bc-e8a4-4e73-b8be-63364c29d753----M.Cxxx----主号----A组"
              }
              required
            />
          </label>
        )}

        {preview ? (
          <div className="preview-box">
            共 {preview.total} 行 · 有效 {preview.valid} · 重复 {preview.duplicates} · 错误 {preview.invalid}
            {preview.errors.length > 0 ? <p>{preview.errors.slice(0, 5).join("；")}</p> : null}
            {preview.warnings.length > 0 ? <p className="preview-warning">{preview.warnings.slice(0, 5).join("；")}</p> : null}
          </div>
        ) : null}

        {error ? <div className="error-box">{error}</div> : null}

        <div className="modal-actions">
          <button type="button" className="secondary-button dark-button" onClick={previewBatch} disabled={previewing || loading}>
            {previewing ? <Loader2 size={16} className="spin" /> : null}
            {previewing ? "预检中" : "预检"}
          </button>
          <button type="button" className="secondary-button dark-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button dark-primary" type="submit" disabled={loading || previewing}>
            {loading ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
            保存导入
          </button>
        </div>
      </form>
    </div>
  );
}

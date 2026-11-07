import { Loader2, Plus } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { errorMessage } from "../app-error";
import { firstErrorField, validateAccountFields } from "../form-validation";
import type { AccountField, FieldErrors } from "../form-validation";
import type { AccountInput, ImportPreviewResult, ImportResult } from "../types";
import { TokenGuidePanel } from "./TokenGuidePanel";
import { DeviceCodePanel } from "./DeviceCodePanel";
import { ModalShell } from "./ModalShell";

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
  // 重复行会直接覆盖已有账号的登录凭据，必须让用户点头确认，不能默默换掉 token。
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<AccountField>>({});
  const emailInputRef = useRef<HTMLInputElement>(null);
  const clientIdInputRef = useRef<HTMLInputElement>(null);
  const refreshTokenInputRef = useRef<HTMLTextAreaElement>(null);
  const previewText = mode === "single"
    ? `${single.email},${single.clientId},${single.refreshToken}`
    : batchText;
  const currentPreviewTextRef = useRef(previewText);
  // 预检发现重复行、用户还没勾选确认时，禁止提交。
  const overwriteBlocked = preview !== null && preview.duplicates > 0 && !confirmOverwrite;
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
        // 每次重新预检都重新要一次确认：行数变了就可能是另一批账号。
        setConfirmOverwrite(false);
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
    setError("");

    // ModalShell 已关掉原生校验气泡，所以提交前在这里把缺项说清楚（P4）。
    if (mode === "single") {
      const errors = validateAccountFields(single, { requireRefreshToken: true });
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        const firstField = firstErrorField(errors, ["email", "clientId", "refreshToken"]);
        const target =
          firstField === "email"
            ? emailInputRef.current
            : firstField === "clientId"
              ? clientIdInputRef.current
              : refreshTokenInputRef.current;
        target?.focus();
        return;
      }
    } else if (!batchText.trim()) {
      setError("请先粘贴要导入的账号文本。");
      return;
    }

    setFieldErrors({});
    setLoading(true);

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
    <ModalShell
      title="导入邮箱"
      subtitle="支持 CSV、email----client_id----refresh_token、email----password----client_id----refresh_token"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="secondary-button dark-button" onClick={previewBatch} disabled={previewing || loading}>
            {previewing ? <Loader2 size={16} className="spin" /> : null}
            {previewing ? "预检中" : "预检"}
          </button>
          <button type="button" className="secondary-button dark-button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button dark-primary"
            type="submit"
            disabled={loading || previewing || overwriteBlocked}
            title={overwriteBlocked ? "预检发现重复账号，请先勾选确认覆盖" : undefined}
          >
            {loading ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
            保存导入
          </button>
        </>
      }
    >
      <div className="import-format-help">
        <strong>直接粘贴多行即可；要从文件导入，请用侧栏的「导入文件」按钮上传 .txt / .csv。</strong>
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
            <input
              ref={emailInputRef}
              value={single.email}
              aria-invalid={fieldErrors.email ? true : undefined}
              aria-describedby={fieldErrors.email ? "import-email-error" : undefined}
              onChange={(event) => {
                setSingle({ ...single, email: event.target.value });
                setFieldErrors((previous) => ({ ...previous, email: undefined }));
              }}
            />
            {fieldErrors.email ? (
              <span className="field-error" id="import-email-error" role="alert">
                {fieldErrors.email}
              </span>
            ) : null}
          </label>
          <label>
            Client ID
            <input
              ref={clientIdInputRef}
              value={single.clientId}
              aria-invalid={fieldErrors.clientId ? true : undefined}
              aria-describedby={fieldErrors.clientId ? "import-client-id-error" : undefined}
              onChange={(event) => {
                setSingle({ ...single, clientId: event.target.value });
                setFieldErrors((previous) => ({ ...previous, clientId: undefined }));
              }}
            />
            {fieldErrors.clientId ? (
              <span className="field-error" id="import-client-id-error" role="alert">
                {fieldErrors.clientId}
              </span>
            ) : null}
          </label>
          <label className="span-2">
            Refresh Token
            <textarea
              ref={refreshTokenInputRef}
              value={single.refreshToken}
              aria-invalid={fieldErrors.refreshToken ? true : undefined}
              aria-describedby={fieldErrors.refreshToken ? "import-refresh-token-error" : undefined}
              onChange={(event) => {
                setSingle({ ...single, refreshToken: event.target.value });
                setFieldErrors((previous) => ({ ...previous, refreshToken: undefined }));
              }}
            />
            {fieldErrors.refreshToken ? (
              <span className="field-error" id="import-refresh-token-error" role="alert">
                {fieldErrors.refreshToken}
              </span>
            ) : (
              <span className="field-hint">
                手上有 refresh_token 就直接粘贴；没有就用下面的「用 Microsoft 账号登录」自动获取。
              </span>
            )}
          </label>
          <DeviceCodePanel
            onAuthorized={({ clientId, refreshToken, email }) => {
              setSingle((previous) => ({
                ...previous,
                email: previous.email.trim() ? previous.email : (email ?? previous.email),
                clientId,
                refreshToken
              }));
              setFieldErrors({});
            }}
          />
          <label>
            备注
            <input value={single.remark} onChange={(event) => setSingle({ ...single, remark: event.target.value })} />
          </label>
          <label>
            分组
            <input value={single.group} onChange={(event) => setSingle({ ...single, group: event.target.value })} />
          </label>
          <TokenGuidePanel className="span-2" />
        </div>
      ) : (
        <>
          <label className="stacked-label">
            导入文本
            <textarea
              className="batch-textarea"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={
                "email,client_id,refresh_token,remark,group\nuser@hotmail.com,9e5f94bc-e8a4-4e73-b8be-63364c29d753,M.Cxxx,主号,A组\nuser@hotmail.com----9e5f94bc-e8a4-4e73-b8be-63364c29d753----M.Cxxx----主号----A组\nuser@hotmail.com----password----9e5f94bc-e8a4-4e73-b8be-63364c29d753----M.Cxxx----主号----A组"
              }
              required={false}
            />
          </label>
          {/* 批量模式同样需要“token 去哪拿”的说明：新手不会先去切回单个账号页（P1） */}
          <TokenGuidePanel className="span-2" />
        </>
      )}

      {preview ? (
        <div className="preview-box">
          共 {preview.total} 行 · 有效 {preview.valid} · 重复 {preview.duplicates} · 错误 {preview.invalid}
          {preview.errors.length > 0 ? <p>{preview.errors.slice(0, 5).join("；")}</p> : null}
          {preview.warnings.length > 0 ? <p className="preview-warning">{preview.warnings.slice(0, 5).join("；")}</p> : null}
          {preview.duplicates > 0 ? (
            <label className="preview-confirm">
              <input
                type="checkbox"
                checked={confirmOverwrite}
                onChange={(event) => setConfirmOverwrite(event.target.checked)}
              />
              <span>
                这 {preview.duplicates} 个账号已存在，导入会<b>覆盖</b>它们现在保存的 refresh_token（不可撤销）
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="error-box">{error}</div> : null}
    </ModalShell>
  );
}

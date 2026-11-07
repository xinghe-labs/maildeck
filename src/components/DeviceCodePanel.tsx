import { CheckCircle2, Copy, ExternalLink, Loader2, LogIn, UserPlus, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../app-error";
import { getDesktopApi } from "../desktop-api";
import type { DeviceCodeStateEvent } from "../../electron/shared/ipc-contracts";

type Phase = "idle" | "starting" | "waiting" | "authorized" | "failed";

// 微软个人账号注册页：没有账号的用户从这里开始，注册完回应用里走设备代码登录。
const SIGNUP_URL = "https://signup.live.com/signup?lic=1";

export interface DeviceCodeResult {
  clientId: string;
  refreshToken: string;
  email: string | null;
}

function formatRemaining(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * 「用微软账号登录拿 token」面板（设备代码流程）。
 *
 * 之前只能手填 refresh_token，等于把绝大多数普通用户挡在门外：他们没有抓包工具，
 * 也不知道 client_id 是什么。这里直接给一个短码，让用户在浏览器登录一次即可。
 */
export function DeviceCodePanel({ onAuthorized }: { onAuthorized: (result: DeviceCodeResult) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [remainingSec, setRemainingSec] = useState(0);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [signupOpened, setSignupOpened] = useState(false);
  const [signupOpenFailed, setSignupOpenFailed] = useState(false);
  const authorizedRef = useRef(onAuthorized);
  authorizedRef.current = onAuthorized;

  useEffect(() => {
    const api = getDesktopApi();
    const unsubscribe = api.auth.onDeviceCodeState((event: DeviceCodeStateEvent) => {
      if (event.phase === "waiting") {
        setUserCode(event.userCode);
        setVerificationUri(event.verificationUri);
        setRemainingSec(event.expiresInSec);
        setPhase("waiting");
        return;
      }
      if (event.phase === "authorized") {
        setPhase("authorized");
        setMessage(event.email ? `已登录：${event.email}` : "已拿到 token");
        authorizedRef.current({ clientId: event.clientId, refreshToken: event.refreshToken, email: event.email });
        return;
      }
      if (event.phase === "canceled") {
        setPhase("idle");
        setMessage("");
        return;
      }
      setPhase("failed");
      setMessage(event.message);
    });
    return unsubscribe;
  }, []);

  // 倒计时让用户知道还剩多久，过期后不用干等。
  useEffect(() => {
    if (phase !== "waiting") {
      return;
    }
    const timer = window.setInterval(() => {
      setRemainingSec((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  async function start() {
    setPhase("starting");
    setMessage("");
    setCopied(false);
    try {
      const session = await getDesktopApi().auth.startDeviceCode();
      setUserCode(session.userCode);
      setVerificationUri(session.verificationUri);
      setRemainingSec(session.expiresInSec);
      setPhase("waiting");
    } catch (error) {
      setPhase("failed");
      setMessage(errorMessage(error));
    }
  }

  async function cancel() {
    try {
      await getDesktopApi().auth.cancelDeviceCode();
    } catch {
      // 取消失败不影响界面回到初始态。
    }
    setPhase("idle");
    setMessage("");
  }

  async function openSignup() {
    setSignupOpenFailed(false);
    try {
      await getDesktopApi().app.openExternal(SIGNUP_URL);
      setSignupOpened(true);
    } catch {
      // 主进程拒绝或打不开浏览器时不再静默：给出地址让用户手动访问。
      setSignupOpenFailed(true);
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(userCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (phase === "idle") {
    return (
      <div className="device-code span-2">
        <div className="device-code-row">
          <button type="button" className="secondary-button dark-button device-code-start" onClick={() => void start()}>
            <LogIn size={16} />
            用微软账号登录，自动获取 token
          </button>
          <button type="button" className="secondary-button dark-button" onClick={() => void openSignup()}>
            <UserPlus size={16} />
            没有微软账号？注册一个
          </button>
        </div>
        {signupOpened ? (
          <span className="field-hint">
            已在浏览器打开微软注册页，完成人机验证后回到这里点「用微软账号登录」收尾。
          </span>
        ) : signupOpenFailed ? (
          <span className="field-hint">无法打开系统浏览器，请手动访问 signup.live.com/signup，完成后回这里登录收尾。</span>
        ) : (
          <span className="field-hint">不用自己抓 refresh_token：点这里登录一次，邮箱和 token 会自动填好。</span>
        )}
      </div>
    );
  }

  if (phase === "starting") {
    return (
      <div className="device-code span-2">
        <span className="device-code-status">
          <Loader2 size={16} className="spin" /> 正在向微软申请登录代码…
        </span>
      </div>
    );
  }

  if (phase === "authorized") {
    return (
      <div className="device-code span-2">
        <span className="device-code-status device-code-ok">
          <CheckCircle2 size={16} /> {message || "已拿到 token"}
        </span>
        <span className="field-hint">确认邮箱无误后点「保存导入」即可。</span>
      </div>
    );
  }

  if (phase === "failed") {
    return (
      <div className="device-code span-2">
        <span className="device-code-status device-code-error">
          <XCircle size={16} /> {message || "登录失败"}
        </span>
        <button type="button" className="secondary-button dark-button" onClick={() => void start()}>
          重新登录
        </button>
      </div>
    );
  }

  return (
    <div className="device-code span-2">
      <div className="device-code-row">
        <span className="device-code-label">在浏览器打开</span>
        <code className="device-code-url">{verificationUri}</code>
        <button
          type="button"
          className="secondary-button dark-button"
          onClick={() => void getDesktopApi().app.openExternal(verificationUri)}
        >
          <ExternalLink size={14} /> 打开登录页
        </button>
      </div>
      <div className="device-code-row">
        <span className="device-code-label">输入代码</span>
        <code className="device-code-value">{userCode}</code>
        <button type="button" className="secondary-button dark-button" onClick={() => void copyCode()}>
          <Copy size={14} /> {copied ? "已复制" : "复制"}
        </button>
      </div>
      <div className="device-code-row">
        <span className="device-code-status">
          <Loader2 size={16} className="spin" /> 等待你在浏览器完成登录…（剩余 {formatRemaining(remainingSec)}）
        </span>
        <button type="button" className="secondary-button dark-button" onClick={() => void cancel()}>
          取消
        </button>
      </div>
    </div>
  );
}

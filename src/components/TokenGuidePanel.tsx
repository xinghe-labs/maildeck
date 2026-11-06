import { KeyRound } from "lucide-react";
import { TOKEN_GUIDE_ERROR_HINTS, TOKEN_GUIDE_INTRO, TOKEN_GUIDE_STEPS, TOKEN_GUIDE_TITLE } from "../../electron/shared/token-guide";

/**
 * 「refresh_token 到底去哪拿」的说明面板。
 *
 * 应用不内置微软登录流程，所以空态和导入弹窗里必须有一条能点开的说明，
 * 否则新手只能对着 Client ID / Refresh Token 两个空字段猜（P1）。
 * 文案统一来自 electron/shared/token-guide，和「帮助」菜单保持同一套说法。
 */
export function TokenGuidePanel({ className }: { className?: string }) {
  return (
    <details className={`token-guide ${className ?? ""}`.trim()}>
      <summary>
        <KeyRound size={14} />
        {TOKEN_GUIDE_TITLE}
      </summary>
      <div className="token-guide-body">
        <p>{TOKEN_GUIDE_INTRO}</p>
        <ol>
          {TOKEN_GUIDE_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="token-guide-hint-title">常见报错对照</p>
        <ul className="token-guide-hints">
          {TOKEN_GUIDE_ERROR_HINTS.map((hint) => (
            <li key={hint.code}>
              <code>{hint.code}</code> {hint.meaning}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

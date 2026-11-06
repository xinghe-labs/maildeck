/**
 * 「怎么拿到 client_id / refresh_token」的统一说明。
 *
 * 主进程用它拼「帮助 → 如何获取 Client ID 和 refresh_token」的对话框，
 * 渲染进程用它渲染空态与导入弹窗里的引导，避免两处文案各说一套。
 *
 * 这里只写应用自身能担保的事实（导入格式、scope 要求、错误码含义），
 * 不假装应用内置了微软登录流程——它确实没有。
 */
export const TOKEN_GUIDE_TITLE = "如何获取 Client ID 和 refresh_token";

export const TOKEN_GUIDE_INTRO =
  "本应用不内置微软登录页：它需要你提供一对已经可用的 client_id + refresh_token，应用用它们在后台换取 access token 并读取邮件。";

export const TOKEN_GUIDE_STEPS: readonly string[] = [
  "client_id 必须是「公共客户端」（Mobile and desktop application）类型，并且注册时选择支持个人 Microsoft 账户（outlook.com / hotmail.com / live.com）。",
  "注册成「单页应用（SPA）」或强制要求 client secret 的类型不能用：前者会报 AADSTS9002326，后者应用根本不会发送 secret。",
  "refresh_token 必须带邮件读取权限：Graph 路径要 Mail.Read（或等价的读取权限），IMAP 路径要 https://outlook.office.com/IMAP.AccessAsUser.All。应用会根据 token 返回的 scope 自动选择 Graph 或 IMAP。",
  "如果你已经在用别的工具（授权码流程、设备码流程或现成的 token 导出脚本）拿 token，把导出的 refresh_token 直接粘进来即可。",
  "一个 refresh_token 只属于一个微软账号；换账号要重新授权。账号密码只用于识别导入格式里的字段顺序，不会被读取或保存。"
];

export const TOKEN_GUIDE_ERROR_HINTS: readonly { code: string; meaning: string }[] = [
  { code: "AADSTS700016", meaning: "Client ID 不存在，或该应用没有对个人账号启用。" },
  { code: "AADSTS9002326", meaning: "Client ID 注册成了 SPA 类型，需要换公共客户端类型。" },
  { code: "AADSTS65001", meaning: "还没获得这个账号的授权，重新走一次授权并在授权页点「接受」。" },
  { code: "AADSTS50173", meaning: "refresh_token 已失效（改过密码、授权被撤销或长期未使用），需要重新获取。" }
];

/** 给 dialog.showMessageBox 用的纯文本版本（单行宽度有限，用短横线分条）。 */
export const TOKEN_GUIDE_TEXT = [
  TOKEN_GUIDE_INTRO,
  "",
  ...TOKEN_GUIDE_STEPS.map((step, index) => `${index + 1}. ${step}`),
  "",
  "常见报错对照：",
  ...TOKEN_GUIDE_ERROR_HINTS.map((hint) => `· ${hint.code}：${hint.meaning}`)
].join("\n");

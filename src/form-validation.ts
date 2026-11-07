/**
 * 表单校验：把「能不能提交」的判断放在应用层，而不是靠浏览器原生 required 气泡。
 *
 * 原生气泡会飘到别的字段上方、两三秒后消失，用户只会觉得「点了保存没反应」，
 * 而且它给不出「为什么不能提交、该怎么改」（P4/P5）。
 */
export type FieldErrors<Field extends string> = Partial<Record<Field, string>>;

export type AccountField = "email" | "clientId" | "refreshToken";

// 与 electron/main/account-store.ts 的 isEmailLike 保持同一套宽松规则：
// 只要求 local@domain.tld，不做 RFC 级校验（微软的别名邮箱五花八门）。
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function validateAccountFields(
  input: { email: string; clientId: string; refreshToken: string },
  options: { requireRefreshToken: boolean }
): FieldErrors<AccountField> {
  const errors: FieldErrors<AccountField> = {};
  const email = input.email.trim();
  const clientId = input.clientId.trim();

  if (!email) {
    errors.email = "请填写邮箱地址";
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.email = "邮箱格式不对，需要形如 name@outlook.com";
  }

  if (!clientId) {
    errors.clientId = "请填写 Client ID：应用的公共客户端 ID，不是邮箱密码";
  }

  if (options.requireRefreshToken && !input.refreshToken.trim()) {
    errors.refreshToken =
      "请填写 refresh_token：没有它这个账号读不了邮件。获取方法见「帮助 → 如何获取 Client ID 和 refresh_token」";
  } else {
    const tokenIssue = refreshTokenIssue(input.refreshToken);
    if (tokenIssue) {
      errors.refreshToken = tokenIssue;
    }
  }

  return errors;
}

/**
 * refresh_token 的格式预检。
 *
 * 报告 P2-19：粘贴错东西时只有等保存、连接失败才知道，而且报错来自微软，看不懂。
 * 这里只抓「一看就不对」的几种：粘贴进网址、拿成 access_token、带空格换行、被截断。
 * 真实 token（MSA 的 `M.C5…`、AAD 的 `0.A…`）不会被误伤。
 */
function refreshTokenIssue(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  if (/\s/u.test(value)) {
    return "refresh_token 中间不能有空格或换行，粘贴时可能被截断了，请重新复制完整的一整串";
  }
  if (/^https?:\/\//iu.test(value)) {
    return "这看起来是一个网址，不是 refresh_token。请粘贴登录后地址栏里 code= 后面那串";
  }
  if (value.startsWith("eyJ") && value.split(".").length === 3) {
    return "这看起来是 access_token（或 id_token），它很快就会过期；需要的是 refresh_token";
  }
  if (value.length < 24) {
    return "refresh_token 太短了，正常是一千多字符，请确认没有少复制";
  }
  return null;
}

/** 数字区间校验：空值、非整数、越界都给出人能看懂的说明。 */
export function validateNumberField(
  raw: string,
  options: { min: number; max: number; label: string; unit?: string }
): string | null {
  const value = raw.trim();
  if (!value) {
    return `${options.label}不能为空`;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return `${options.label}要填整数`;
  }
  if (parsed < options.min || parsed > options.max) {
    return `${options.label}只能是 ${options.min}–${options.max}${options.unit ?? ""}`;
  }

  return null;
}

/** 取第一个出错的字段名，用来把焦点送到出错的位置。 */
export function firstErrorField<Field extends string>(errors: FieldErrors<Field>, order: readonly Field[]): Field | null {
  for (const field of order) {
    if (errors[field]) {
      return field;
    }
  }
  return null;
}

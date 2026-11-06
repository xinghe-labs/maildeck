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
  }

  return errors;
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

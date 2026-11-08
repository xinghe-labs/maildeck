/**
 * 邮件里的 webLink 来自服务器，理论上总是 Outlook 网页版地址；但渲染进程不应
 * 无条件把任意字符串交给 window.open（主进程会把它交给系统浏览器打开）。
 * 这里只放行 https + 已知的 Outlook/Office 域名，其余一律拒绝。
 */
const ALLOWED_WEB_MAIL_HOSTS = [
  "outlook.office.com",
  "outlook.office365.com",
  "outlook.live.com",
  "outlook.com",
  "office.com",
  "office365.com",
  "microsoft365.com",
  "outlook.cn"
] as const;

/**
 * 微软账号/登录相关域名：设备代码登录页（microsoft.com/devicelogin 及各主权云）、
 * 账号注册页（signup.live.com）都从这里来。与邮件 webLink 分开白名单，
 * 避免为了登录入口把整个 live.com 放进邮件链接白名单。
 */
const ALLOWED_ACCOUNT_HOSTS = [
  "microsoft.com",
  "live.com",
  "microsoftonline.com",
  "microsoftonline.cn",
  "chinacloudapi.cn",
  "msauth.net"
] as const;

function allowedHost(url: URL, candidates: readonly string[]): boolean {
  const host = url.hostname.toLowerCase();
  return candidates.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

export function safeWebMailUrl(raw: string | null | undefined): string | null {
  const value = (raw || "").trim();
  if (!value) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") {
    return null;
  }

  return allowedHost(url, ALLOWED_WEB_MAIL_HOSTS) ? url.toString() : null;
}

/** 设备代码登录页、注册页这类微软账号地址：https + 账号域名白名单。 */
export function safeAccountUrl(raw: string | null | undefined): string | null {
  const value = (raw || "").trim();
  if (!value) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") {
    return null;
  }

  return allowedHost(url, ALLOWED_ACCOUNT_HOSTS) ? url.toString() : null;
}


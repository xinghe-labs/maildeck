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

/** 消费级邮箱域名：网页版入口在 outlook.live.com，其余走 office365。 */
const CONSUMER_MAIL_DOMAINS = [
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "outlook.jp",
  "outlook.kr"
] as const;

const CONSUMER_WEB_MAIL_INBOX = "https://outlook.live.com/mail/0/";
const WORK_WEB_MAIL_INBOX = "https://outlook.office365.com/mail/";

export interface WebMailEntry {
  url: string;
  /** true = 直达这封邮件；false = 只到网页版收件箱（缓存里的 IMAP 邮件没有直达链接）。 */
  direct: boolean;
  label: string;
  title: string;
}

/**
 * 决定「在浏览器中打开」到底打开什么。
 *
 * Graph 取回的邮件带 webLink，可以直达；IMAP/Hotmail 兜底取回的邮件没有 webLink
 * （缓存里 web_link 全为空），以前就干脆不显示入口，用户想「去网页版处理这封邮件」
 * 时无路可走。这里退一步：没有直达链接就打开该邮箱的网页版收件箱。
 */
export function resolveWebMailEntry(
  webLink: string | null | undefined,
  accountEmail: string | null | undefined
): WebMailEntry | null {
  const direct = safeWebMailUrl(webLink);
  if (direct) {
    return {
      url: direct,
      direct: true,
      label: "在浏览器中打开",
      title: "在默认浏览器中打开这封邮件（网页版里可以看附件、回复、下载原文件）"
    };
  }

  const email = (accountEmail || "").trim().toLowerCase();
  const domain = email.includes("@") ? email.split("@").pop() || "" : "";
  if (!domain) {
    return null;
  }

  const consumer = CONSUMER_MAIL_DOMAINS.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
  return {
    url: consumer ? CONSUMER_WEB_MAIL_INBOX : WORK_WEB_MAIL_INBOX,
    direct: false,
    label: "网页版",
    title: "在默认浏览器中打开这个邮箱的网页版收件箱（这封邮件没有直达链接）"
  };
}


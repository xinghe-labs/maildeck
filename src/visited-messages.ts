/**
 * 「本机已打开过的邮件」记录。
 *
 * 应用目前不向服务器回写已读状态（没有标记已读的接口），但用户在应用里点开过的
 * 邮件应该能看出来「我已经读过了」，否则未读圆点会一直是装饰品。
 *
 * 这里记录的是**本机、本应用内**打开过的邮件，不冒充服务器状态：列表里只把
 * 「未读且已打开」的行做成弱化样式，圆点变空心，用户能区分「真没看过」和
 * 「在手机/网页上看过，或在这里看过但服务器仍标未读」。
 */

const STORAGE_KEY = "outlookManager.visitedMessages";
/** 上限，防止长期使用把 localStorage 撑爆（每条 key 约 50 字节）。 */
const MAX_ENTRIES = 5_000;

export function messageVisitKey(accountId: string | null, messageId: string): string {
  return `${accountId ?? ""}:${messageId}`;
}

export function loadVisitedMessages(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    // localStorage 不可用或内容损坏都不该影响读信，直接当作没有记录。
    return new Set();
  }
}

export function saveVisitedMessages(visited: Set<string>): void {
  try {
    // Set 的插入顺序就是访问顺序，只保留最近的 MAX_ENTRIES 条。
    const entries = Array.from(visited);
    const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // 写不进去就算了，不影响当前会话内的记忆。
  }
}

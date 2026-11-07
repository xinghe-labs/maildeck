export function resolveVisibleMailCursor({
  cursor,
  displayedCount,
  totalCount
}: {
  cursor: string | null;
  displayedCount: number;
  totalCount?: number | null;
}) {
  if (!cursor) {
    return null;
  }

  if (totalCount != null && displayedCount >= totalCount) {
    return null;
  }

  return cursor;
}

export interface MailListFooter {
  /**
   * - `none`：已经到底，什么都不用显示
   * - `load-more`：有游标，点一下继续翻页
   * - `reload`：总数比已显示的多，但服务器没给游标（缓存命中/游标丢失），
   *   只能重新拉一次列表把缺口补上
   */
  action: "none" | "load-more" | "reload";
  /** 「已显示 13 / 共 22 封」这类计数；拿不到总数时为 null。 */
  countText: string | null;
}

/**
 * 列表底部的「还有没有更多」判定。
 *
 * 之前的实现只看游标：游标为空就不画任何按钮，于是「摘要说 22 封、列表只有 13 封、
 * 翻到底也没有入口」会同时出现。这里把「总数比已显示多」单独识别成 reload，
 * 保证用户总有一个把剩余邮件找回来的动作。
 */
export function resolveMailListFooter({
  cursor,
  displayedCount,
  totalCount
}: {
  cursor: string | null;
  displayedCount: number;
  totalCount?: number | null;
}): MailListFooter {
  const countText =
    totalCount != null && totalCount > 0
      ? displayedCount >= totalCount
        ? `共 ${totalCount} 封`
        : `已显示 ${displayedCount} / 共 ${totalCount} 封`
      : displayedCount > 0
        ? `已显示 ${displayedCount} 封`
        : null;

  if (displayedCount === 0) {
    return { action: "none", countText: null };
  }

  if (totalCount != null && displayedCount >= totalCount) {
    return { action: "none", countText };
  }

  if (cursor) {
    return { action: "load-more", countText };
  }

  return totalCount != null ? { action: "reload", countText } : { action: "none", countText };
}

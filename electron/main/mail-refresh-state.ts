export function messageTimeMs(message: { receivedDateTime: string | null; sentDateTime: string | null }) {
  const value = message.receivedDateTime || message.sentDateTime;
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function countNewMessagesAfterRefresh(
  messages: Array<{ receivedDateTime: string | null; sentDateTime: string | null }>,
  previousRefreshAt?: string | null
) {
  if (!previousRefreshAt) {
    return 0;
  }

  const refreshTime = new Date(previousRefreshAt).getTime();
  if (!Number.isFinite(refreshTime)) {
    return 0;
  }

  return messages.filter((message) => messageTimeMs(message) > refreshTime).length;
}

export function shouldCommitMailboxRefreshState(options: { search?: string; cursor?: string | null; skip?: number }) {
  // skip 与 cursor 同属翻页读取，均不得提交持久化刷新状态。
  return !options.search?.trim() && !options.cursor && !options.skip;
}

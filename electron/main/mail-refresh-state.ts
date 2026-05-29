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

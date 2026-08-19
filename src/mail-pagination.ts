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

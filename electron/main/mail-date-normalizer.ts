export function normalizeMailDate(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) {
    return null;
  }

  if (typeof value === "string" && value.trim().length === 0) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

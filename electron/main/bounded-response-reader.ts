function parseContentLength(value: string | null) {
  const normalized = value?.trim() || "";
  if (!/^\d+$/u.test(normalized)) {
    return null;
  }

  const length = Number(normalized);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

export async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
  createTooLargeError: () => Error
): Promise<string> {
  const declaredLength = parseContentLength(response.headers.get("Content-Length"));
  if (declaredLength !== null && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw createTooLargeError();
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw createTooLargeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

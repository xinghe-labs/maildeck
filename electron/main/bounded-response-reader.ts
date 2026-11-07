function parseContentLength(value: string | null) {
  const normalized = value?.trim() || "";
  if (!/^\d+$/u.test(normalized)) {
    return null;
  }

  const length = Number(normalized);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

export async function readResponseBytesBounded(
  response: Response,
  maxBytes: number,
  createTooLargeError: () => Error
): Promise<Uint8Array> {
  const declaredLength = parseContentLength(response.headers.get("Content-Length"));
  if (declaredLength !== null && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw createTooLargeError();
  }

  if (!response.body) {
    return new Uint8Array(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
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
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
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

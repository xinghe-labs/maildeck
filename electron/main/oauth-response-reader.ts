export const OAUTH_RESPONSE_MAX_BYTES = 128 * 1024;
export const OAUTH_RESPONSE_TOO_LARGE_MESSAGE = "OAuth token 响应体超过 128 KiB 限制";

function responseTooLargeError() {
  return new Error(OAUTH_RESPONSE_TOO_LARGE_MESSAGE);
}

function parseContentLength(value: string | null) {
  const normalized = value?.trim() || "";
  if (!/^\d+$/u.test(normalized)) {
    return null;
  }

  const length = Number(normalized);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

export async function readOAuthResponseText(
  response: Response,
  maxBytes = OAUTH_RESPONSE_MAX_BYTES
): Promise<string> {
  const declaredLength = parseContentLength(response.headers.get("Content-Length"));
  if (declaredLength !== null && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw responseTooLargeError();
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
        throw responseTooLargeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

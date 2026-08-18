import { readResponseTextBounded } from "./bounded-response-reader.js";

export const OAUTH_RESPONSE_MAX_BYTES = 128 * 1024;
export const OAUTH_RESPONSE_TOO_LARGE_MESSAGE = "OAuth token 响应体超过 128 KiB 限制";

function responseTooLargeError() {
  return new Error(OAUTH_RESPONSE_TOO_LARGE_MESSAGE);
}

export async function readOAuthResponseText(
  response: Response,
  maxBytes = OAUTH_RESPONSE_MAX_BYTES
): Promise<string> {
  return readResponseTextBounded(response, maxBytes, responseTooLargeError);
}

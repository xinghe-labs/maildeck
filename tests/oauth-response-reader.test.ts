import { describe, expect, it } from "vitest";
import {
  OAUTH_RESPONSE_TOO_LARGE_MESSAGE,
  readOAuthResponseText
} from "../electron/main/oauth-response-reader.js";

describe("bounded OAuth response reading", () => {
  it("rejects a declared response length before reading the body", async () => {
    const response = new Response("ok", {
      headers: { "Content-Length": "5" }
    });

    await expect(readOAuthResponseText(response, 4)).rejects.toThrow(OAUTH_RESPONSE_TOO_LARGE_MESSAGE);
    expect(response.bodyUsed).toBe(true);
  });

  it("cancels a stream whose actual bytes exceed the limit", async () => {
    let canceled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
      },
      cancel() {
        canceled = true;
      }
    }));

    await expect(readOAuthResponseText(response, 4)).rejects.toThrow(OAUTH_RESPONSE_TOO_LARGE_MESSAGE);
    expect(canceled).toBe(true);
  });

  it("decodes UTF-8 characters split across stream chunks", async () => {
    const bytes = new TextEncoder().encode("A你好B");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2, 5));
        controller.enqueue(bytes.slice(5));
        controller.close();
      }
    }));

    await expect(readOAuthResponseText(response, bytes.byteLength)).resolves.toBe("A你好B");
  });
});

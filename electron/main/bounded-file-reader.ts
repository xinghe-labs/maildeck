import { open } from "node:fs/promises";

export class FileTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`file exceeds the ${maxBytes} byte limit`);
    this.name = "FileTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export async function readUtf8FileBounded(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const metadata = await handle.stat();
    if (!Number.isSafeInteger(metadata.size) || metadata.size > maxBytes) {
      throw new FileTooLargeError(maxBytes);
    }

    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(maxBytes, 1)));
    let totalBytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }

      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new FileTooLargeError(maxBytes);
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }

    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

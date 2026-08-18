import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTooLargeError, readUtf8FileBounded } from "../electron/main/bounded-file-reader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bounded UTF-8 file reader", () => {
  it("preserves UTF-8 text when the file is within the limit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "outlook-manager-bounded-file-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "accounts.txt");
    await writeFile(filePath, "你好，Café", "utf8");

    await expect(readUtf8FileBounded(filePath, Buffer.byteLength("你好，Café", "utf8"))).resolves.toBe("你好，Café");
  });

  it("rejects a file larger than the limit before loading its contents", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "outlook-manager-bounded-file-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "too-large.txt");
    await writeFile(filePath, "12345", "utf8");

    await expect(readUtf8FileBounded(filePath, 4)).rejects.toMatchObject({
      name: "FileTooLargeError",
      maxBytes: 4
    } satisfies Partial<FileTooLargeError>);
  });
});

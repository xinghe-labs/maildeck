import { safeStorage } from "electron";

const ENCRYPTED_PREFIX = "safe:";
const PLAIN_PREFIX = "plain:";

export function encryptSecret(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `${ENCRYPTED_PREFIX}${safeStorage.encryptString(value).toString("base64")}`;
  }

  throw new Error("当前系统不可用 Electron safeStorage，已拒绝明文保存 token。请检查系统凭据服务后重试。");
}

export function decryptSecret(value: string): string {
  if (value.startsWith(ENCRYPTED_PREFIX)) {
    return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), "base64"));
  }

  if (value.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(value.slice(PLAIN_PREFIX.length), "base64").toString("utf8");
  }

  return value;
}

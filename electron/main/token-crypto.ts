import { safeStorage } from "electron";

const ENCRYPTED_PREFIX = "safe:";
const PLAIN_PREFIX = "plain:";

export function encryptSecret(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `${ENCRYPTED_PREFIX}${safeStorage.encryptString(value).toString("base64")}`;
  }

  return `${PLAIN_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`;
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

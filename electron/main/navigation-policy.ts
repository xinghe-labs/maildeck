import path from "node:path";
import { fileURLToPath } from "node:url";

export function isAllowedExternalUrl(url: string) {
  try {
    return ["http:", "https:", "mailto:", "tel:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isSameFileUrl(url: string, allowedFilePath: string | null) {
  if (!allowedFilePath || !url.startsWith("file://")) {
    return false;
  }

  try {
    return path.normalize(fileURLToPath(url)) === path.normalize(allowedFilePath);
  } catch {
    return false;
  }
}

export function isAllowedAppNavigation(url: string, appOrigin: string | null, allowedFilePath: string | null) {
  if (isSameFileUrl(url, allowedFilePath)) {
    return true;
  }
  if (!appOrigin) {
    return false;
  }

  try {
    return new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}

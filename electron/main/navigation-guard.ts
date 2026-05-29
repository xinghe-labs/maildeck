import { shell, type BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isAllowedExternalUrl(url: string) {
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

function isAllowedAppNavigation(url: string, appOrigin: string | null, allowedFilePath: string | null) {
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

export function guardExternalNavigation(window: BrowserWindow, appOrigin: string | null, allowedFilePath: string | null = null) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, appOrigin, allowedFilePath)) {
      return;
    }

    event.preventDefault();
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
    }
  });
}

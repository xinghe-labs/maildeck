import { shell, type BrowserWindow } from "electron";
import { formatErrorForLog } from "./error-utils.js";
import { isAllowedAppNavigation, isAllowedExternalUrl } from "./navigation-policy.js";

function openExternalSafely(url: string) {
  void shell.openExternal(url).catch((error) => {
    console.warn("External navigation failed", formatErrorForLog(error));
  });
}

export function guardExternalNavigation(window: BrowserWindow, appOrigin: string | null, allowedFilePath: string | null = null) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      openExternalSafely(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, appOrigin, allowedFilePath)) {
      return;
    }

    event.preventDefault();
    if (isAllowedExternalUrl(url)) {
      openExternalSafely(url);
    }
  });
}

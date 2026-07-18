import { shell, type BrowserWindow } from "electron";
import { isAllowedAppNavigation, isAllowedExternalUrl } from "./navigation-policy.js";

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

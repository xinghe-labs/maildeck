import type { Session } from "electron";

type PermissionSession = Pick<
  Session,
  "setDevicePermissionHandler" | "setPermissionCheckHandler" | "setPermissionRequestHandler"
>;

export function configureSessionPermissions(target: PermissionSession) {
  target.setPermissionCheckHandler(() => false);
  target.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  target.setDevicePermissionHandler(() => false);
}

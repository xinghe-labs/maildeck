/// <reference types="vite/client" />

import type { OutlookManagerApi } from "../electron/preload";

declare global {
  interface Window {
    outlookManager: OutlookManagerApi;
  }
}

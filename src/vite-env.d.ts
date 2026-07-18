/// <reference types="vite/client" />

import type { OutlookManagerApi } from "../electron/preload/index.cjs";

declare global {
  interface Window {
    outlookManager: OutlookManagerApi;
  }
}

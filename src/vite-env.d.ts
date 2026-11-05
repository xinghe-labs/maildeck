/// <reference types="vite/client" />

import type { OutlookManagerApi } from "../electron/preload/index.cjs";

declare global {
  // 构建期由 vite.config.ts 的 define 注入，值来自 package.json 的 version。
  // 必须写在 declare global 里：本文件含 import，是模块而非全局脚本。
  const __APP_VERSION__: string;

  interface Window {
    outlookManager: OutlookManagerApi;
  }
}

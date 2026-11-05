import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 读不到 package.json 时退回 0.0.0，让构建继续并在界面上明显暴露问题，而不是直接崩。
function resolvePackageVersion() {
  try {
    const raw = readFileSync(new URL("./package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.trim() ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const packageVersion = resolvePackageVersion();

export default defineConfig({
  base: "./",
  plugins: [react()],
  // 界面里的版本号必须与 package.json 一致：构建期注入，避免运行期再走一次 IPC。
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion)
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false
  },
  build: {
    outDir: "dist"
  }
});

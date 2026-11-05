// 版本号由 vite.config.ts 的 define 注入（值来自 package.json）。
// 非 Vite 环境（例如 vitest 里直接渲染组件）没有这个全局变量，退回 "dev"。
// 先落到 `unknown` 再做类型收窄：注入值在类型层面是外部输入，不能直接当成 string 用。
const injected: unknown = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

export const APP_VERSION: string = typeof injected === "string" ? injected : "dev";

# MailDeck Rust 重构方案

> 原项目：`D:/code/outlook-manager`（Electron 43 + React 19 + Vite + node:sqlite）
> 本目录：`D:/code/outlook-manager-rust`（重构目标）
> 依据：通读 `CONTEXT.md`、`electron/main/`（44 个 TS 文件，约 10.4K 行）、`electron/shared/ipc-contracts.ts`、`package.json`、`tests/`

---

## 1. 现状盘点

原架构 = Electron 主进程（TypeScript）+ React 渲染层，IPC 用 zod 校验契约。

**主进程模块分组**（行数为 `wc -l` 实测）：

| 分组 | 文件 | 行数 |
|---|---|---|
| 邮箱业务 | `mailbox-access.ts` | 1334 |
| 存储层 | `account-store.ts` (908)、`mail-cache.ts` (764)、`database.ts`、`database-migrations.ts` (457)、`settings-store.ts`、`settings-model.ts` (343) | ~2700 |
| 传输适配器 | `graph-client.ts` (688)、`imap-client.ts` (628)、`hotmail-fallback-client.ts` (280)、`graph-retry.ts`、`graph-errors.ts` | ~1650 |
| 认证/凭据 | `access-token-manager.ts` (235)、`token-crypto.ts`、`device-code-auth.ts` (270)、`credential-generations.ts` | ~770 |
| IPC 层 | `ipc.ts` (527)、`validated-ipc.ts`、`ipc-contracts.ts` (682，zod schema + 常量) | ~1250 |
| Job 调度 | `refresh-coordinator.ts` (251)、`job-errors.ts` | ~280 |
| 桌面外壳 | `index.ts` (238)、`tray-controller.ts`、`window-security.ts`、`session-security.ts`、`navigation-guard.ts`、`navigation-policy.ts`、`session-proxy.ts`、`proxy-agent.ts`、`app-updater.ts` (273)、`update-controller.ts`、`user-data-path.ts` | ~1300 |
| 邮件解析/工具 | `mail-source-parser.ts` (204)、`mail-text-normalizer.ts`、`mail-date-normalizer.ts`、`mail-errors.ts`、`error-utils.ts` (316)、`bounded-response-reader.ts`、`bounded-file-reader.ts`、`request-timeout.ts`、`import-parser.ts` (123)、`attachment-file-name.ts`、`account-view-projection.ts`、`account-refresh-state.ts`、`mail-refresh-state.ts` | ~900 |

**关键技术依赖**（须逐一找到 Rust 对应物）：
- `node:sqlite` → SQLite 存储，schema 版本 **v6**，迁移带 `VACUUM INTO` 备份与断言校验
- `electron.safeStorage` → Windows DPAPI 加密 refresh token（前缀 `safe:` / 兼容 `plain:`）
- `undici`（per-request ProxyAgent dispatcher）→ Graph 请求走用户代理
- `imapflow` + `mailparser` + `@zone-eu/mailsplit` → IMAP 读取与 MIME 解析
- `zod` → IPC 契约校验（含 `IPC_REQUEST_SCHEMAS` / `IPC_EVENT_SCHEMAS`）
- `electron-updater` → GitHub Releases 更新
- 托盘 / 单实例锁 / 开机自启 / `closeToTray`

**DOMAIN 不变量**（`CONTEXT.md`，重构必须原样保留，逐条写成测试）：
1. 成功刷新必须**先写邮件缓存，再提交账号成功状态**
2. 取消和凭据 generation 检查发生在**每个持久化写入前**
3. Mailbox Access 的调用者不选择传输方式（Graph/IMAP/Hotmail fallback）
4. 搜索、分页、节流、解析失败、内容超限、缓存写失败**不得误触发 fallback**
5. 同一账号只允许一个连接测试；批量测试/手动刷新/后台刷新互斥
6. 各类 generation（快照/命令/凭据）防陈旧结果覆盖

---

## 2. 目标架构决策

**推荐：Tauri 2 + 复用现有 React 渲染层**，Rust 只重写主进程职责。

理由：
- 渲染层 `src/`（React + Vite）与 Electron 无强耦合，仅经 `desktop-api.ts` / preload 调 IPC，换成 Tauri 的 invoke 层即可复用，UI 不重写
- 主进程正是 Rust 的强项：SQLite、DPAPI、HTTP/IMAP 并发、Job 调度
- 托盘/单实例/自启/更新器 Tauri 官方插件齐备，不必手写

备选（不推荐但留档）：纯 Rust CLI/服务（保留 Tauri 只做壳）——仅当未来要去桌面化时考虑。

---

## 3. Workspace 布局

```
outlook-manager-rust/
├── REFACTOR-PLAN.md          # 本文件
├── Cargo.toml                # workspace
├── crates/
│   ├── maildeck-core/        # 领域核心：storage + mailbox-access + jobs（不依赖 Tauri）
│   ├── maildeck-transports/  # graph / imap / hotmail fallback 适配器
│   └── maildeck-app/         # Tauri 壳：commands、事件、托盘、更新器、窗口策略
├── ui/                       # 从原项目 src/ 平移的 React 渲染层（或 git worktree 引用）
└── docs/
```

分层原则对应原不变量：`maildeck-core` 对应 Mailbox Access + Refresh Job（调度/取消/互斥/进度），`maildeck-transports` 对应 Transport Adapter（只做协议交互），`maildeck-app` 对应 IPC 层（输入验证 + 事件广播）。核心 crate 不依赖 Tauri，可独立做集成测试。

---

## 4. 依赖选型（TS → Rust 映射）

| 原 TS 依赖 | Rust 选型 | 备注 |
|---|---|---|
| `node:sqlite` | `rusqlite` (bundled) | 保留 v6 schema 与迁移逻辑，`VACUUM INTO` 备份原样移植 |
| `undici` ProxyAgent | `reqwest` + `hyper-proxy` / `reqwest-proxy` | 支持按请求不同代理（per-account proxy 设置） |
| `imapflow` | `async-imap`（tokio） | IMAP IDLE/UID 语义需对照重写，重点回归 `Mailbox Cursor`（UID） |
| `mailparser`/`mailsplit` | `mailparse` + `mail-builder` | MIME 解析；HTML sanitize 需另评估（原用 `dompurify`，渲染层可继续用） |
| `zod` | `serde` + 手写校验函数 | 把 `ipc-contracts.ts` 的常量（`MAIL_PAGE_MAX=100` 等）逐条搬成 Rust 常量 + 校验 |
| `safeStorage` (DPAPI) | `windows` crate `CryptProtectData`/`CryptUnprotectData` | **加密格式必须与原版字节兼容**，否则老用户数据解不开；保留 `safe:`/`plain:` 前缀协议 |
| `electron-updater` | `tauri-plugin-updater` | GitHub Releases 源 |
| 单实例锁 | `tauri-plugin-single-instance` | 保留"第二实例唤起已有窗口"行为 |
| 托盘/自启 | `tauri` tray feature + `tauri-plugin-autostart` | `closeToTray` 语义照搬 |
| 系统代理/会话代理 | reqwest 级别配置 | 原 `session-proxy.ts` 是 Electron session 代理，Tauri 下渲染层网络少，主要管更新器代理 |

---

## 5. 模块移植映射

| 原文件 | 目标 crate::module | 要点 |
|---|---|---|
| `database.ts` / `database-migrations.ts` | `core::db` | 迁移数组结构改为 Rust `MIGRATIONS: [Migration; 6]`，保留 verify 断言 |
| `account-store.ts` | `core::store::account` | `AccountRecord` 20 字段 serde struct；credential generation 语义保留 |
| `mail-cache.ts` | `core::store::mail_cache` | 缓存写入顺序不变量（先缓存后状态）在此层与 `mailbox_access` 双保险 |
| `settings-store.ts` / `settings-model.ts` | `core::settings` | `RuntimeSettingsSnapshot` 同名概念 |
| `token-crypto.ts` | `core::crypto` | DPAPI 字节兼容是 P0 风险，先写 probe 脚本验证新旧互通 |
| `credential-generations.ts` | `core::credentials` | `CredentialsChangedError` → Rust enum variant |
| `access-token-manager.ts` | `core::auth::token_manager` | 按 context 缓存/轮换 token |
| `device-code-auth.ts` | `core::auth::device_code` | 状态机事件 → Tauri event |
| `graph-client.ts` / `graph-retry.ts` / `graph-errors.ts` | `transports::graph` | reqwest；delta link 分页语义保留；错误分类 → `AppErrorCode` |
| `imap-client.ts` | `transports::imap` | UID cursor；解析失败不得触发 fallback |
| `hotmail-fallback-client.ts` | `transports::hotmail` | 触发条件与原版逐条对齐 |
| `mailbox-access.ts` | `core::mailbox` | 最大模块（1334 行），fallback 决策、刷新提交顺序全在此 |
| `refresh-coordinator.ts` | `core::jobs` | tokio：CancellationToken + per-account Mutex + 全局 Semaphore |
| `import-parser.ts` | `core::import` | 文本导入预检，10MB / 5000 上限 |
| `ipc.ts` / `validated-ipc.ts` / `ipc-contracts.ts` | `app::commands` | 28 个 invoke channel + 4 个 event channel，逐个映射为 `#[tauri::command]` |
| `index.ts` / `tray-controller.ts` / `window-security.ts` 等 | `app::shell` | Tauri 配置 + 少量 Rust |
| `app-updater.ts` / `update-controller.ts` | `app::updater` | tauri-plugin-updater 包装 |
| `proxy-agent.ts` / `session-proxy.ts` | `transports::proxy` | per-request dispatcher 语义 |
| 渲染层 `src/` | `ui/` | 只改 `desktop-api.ts` → Tauri invoke 绑定 |

---

## 6. 分阶段路线（每阶段可验证、可回退）

- **Phase 0 — 脚手架**：workspace 三 crate、CI、clippy/rustfmt 配置；原项目只读不改。
- **Phase 1 — 存储层**：`core::db` 迁移 v1→v6 全链路 + `core::store`；用原 `tests/database-migrations.test.ts` 的断言翻译成 Rust 测试；**用原项目真实 `maildeck.db` 副本做兼容性测试**。
- **Phase 2 — 凭据与认证**：DPAPI 字节兼容 probe（旧加密串新代码可解）→ `core::crypto`、`core::auth`。
- **Phase 3 — 传输适配器**：graph / imap / hotmail；错误分类表对齐 `AppErrorCode` 18 个枚举值；每个 adapter 带录制回放或 mock 测试。
- **Phase 4 — 邮箱业务 + Job**：`core::mailbox` + `core::jobs`；CONTEXT.md 六条不变量逐条写成测试（先缓存后状态、写入前 generation 检查、互斥矩阵）。
- **Phase 5 — Tauri 壳**：commands/events 全量映射、托盘、单实例、自启、更新器；渲染层接入。
- **Phase 6 — 打包与验收**：Windows MSI/NSIS；与原版并行跑同一数据目录副本对比行为；冒烟脚本参照原 `scripts/verify-release-startup.ps1`。

每个 Phase 结束在原项目 git 打 tag/commit 记录对照基线（原项目不动代码）。

---

## 7. 风险清单

1. **P0 — DPAPI 兼容**：`safeStorage.encryptString` 在 Windows 就是 DPAPI `CryptProtectData`（ entropy 是否加prefix 需实测 probe），解不开 = 老用户 token 全部失效。Phase 2 第一个任务就是双向 probe。
2. **P0 — SQLite 兼容**：`node:sqlite` 与 rusqlite 打开的同一 db 文件、WAL/journal 模式差异；迁移必须能在原库上幂等执行。
3. **P1 — IMAP 语义**：imapflow 有隐式重连、IDLE、序列号/UID 混用陷阱；`Mailbox Cursor` 不变量依赖 UID 精确语义。
4. **P1 — HTML 邮件 sanitize**：原渲染层 dompurify 在 Tauri 下仍可用，但 CSP 配置不同，需重配。
5. **P2 — 更新器差异**：tauri-plugin-updater 的签名机制（minisign）与 electron-builder blockmap 不同，发布流程要重建。
6. **P2 — 行为漂移**：1334 行的 `mailbox-access.ts` 是行为最密集处，建议边移植边用原测试套件做对照（vitest 场景翻译成 Rust 测试用例清单）。

---

## 8. 下一步

1. `cargo init` workspace + 三 crate（Phase 0）
2. 从原项目拷贝真实 db 文件副本与加密 token 样本到 `docs/fixtures/`（脱敏），先做 DPAPI/SQLite 兼容 probe（Phase 1/2 的前置验证）

---

## 9. 交付状态（2026-11-09 完成）

全部 Phase 落地完毕，验证证据：

- **cargo build**：`target/debug/maildeck-shell.exe`（25.5 MB，Tauri 2 + tray-icon + single-instance + autostart + updater）。
- **cargo test**：71/71 通过（maildeck-core 66 + maildeck-app 5），含 DPAPI 往返、SQLite v1→v6 迁移、settings 归一化/迁移/投影、OAuth 请求体、graph/imap 错误分类、导入去重、刷新失败落库端到端冒烟。
- **cargo clippy**：0 warnings。

crate 结构：
- `crates/maildeck-core`：contracts（IPC 契约+serde camelCase）、db（SQLite v6 迁移，node:sqlite 互通）、crypto（DPAPI）、credentials（TieredTokenStore: 内存→keyring→DPAPI 文件）、settings（settings.json 模型/归一化/迁移/投影/redact）、proxy_security、oauth（device-code + PKCE interactive）、transports（GraphClient REST / ImapClient）、mailbox、mail_cache、account_store、import_module、refresh_state（批量刷新/冷却/取消）。
- `crates/maildeck-app`：IPC 命令门面（AppContext + cmd_*，17 个命令对应原 IPC channels），独立于窗口可测。
- `crates/maildeck-shell`：Tauri 2 壳，`tauri.conf.json` + `frontend/index.html` 占位 + 复用原项目 `build/icon.ico`，托盘（显示/退出），17 个 #[tauri::command] 全部委托 maildeck-app。

数据兼容：userData 目录 `%APPDATA%/outlook-manager` → 首启自动迁移为 `%APPDATA%/maildeck`；SQLite 库文件、settings.json、DPAPI 密文均与原 Electron 版互通。

遗留（不影响重构完成判定）：
- 前端 UI 未随本次重构移植（壳内为占位页，invoke 通道全部就绪）。
- auto-update 需要 minisign 签名私钥，发布流程待配。

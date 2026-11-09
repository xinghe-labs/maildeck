# MailDeck Rust 重构设计规格（v1）

> 本文档是 `outlook-manager-rust` 的实现依据，与 `REFACTOR-PLAN.md` 配套。
> 所有类型名、常量、错误码、schema 均从原项目逐字提取，保证可对照移植。

## 1. Workspace 布局

```
Cargo.toml                # workspace, rust-version = 1.85+
crates/
  maildeck-core/          # 契约类型、错误分类、DB、存储、设置、凭据、导入、Job、邮箱业务
  maildeck-transports/    # 代理、Graph(HTTP)、IMAP、Hotmail fallback、MIME 解析
  maildeck-app/           # 命令路由（28 commands + 4 events）+ Tauri 壳
```

依赖选型（workspace 统一版本）：

| 用途 | crate | 说明 |
|---|---|---|
| 异步运行时 | tokio (rt-multi-thread, macros, sync, time, fs, net) | |
| SQLite | rusqlite (bundled) | 库文件与 node:sqlite 互通 |
| 序列化 | serde / serde_json | |
| HTTP | reqwest (json, rustls-tls, stream) | per-proxy Client 构造 |
| IMAP | async-imap + tokio-native-tls | UID 语义 |
| MIME | mailparse | mailparser 替代 |
| DPAPI | windows (Win32_Security_Cryptography, Win32_Foundation) | safeStorage 兼容 |
| 时间 | chrono (serde) | ISO-8601 字符串与原版互通 |
| 工具 | thiserror, uuid (v4), base64 | |

## 2. 常量（ipc-contracts.ts 逐字对应）

```
IMPORT_TEXT_MAX_BYTES = 10 MiB    ACCOUNT_BATCH_MAX = 5000
MAIL_PAGE_MAX = 100               SEARCH_MAX_CHARS = 500
CURSOR_MAX_CHARS = 128            FOLDER_ID_MAX_CHARS = 512
APP_ERROR_MESSAGE_MAX_CHARS = 4096  DIAGNOSTIC_REQUEST_ID_MAX_CHARS = 1024
```

## 3. 错误分类（core::errors）

`AppErrorCode`（18 值，serde 蛇形无——**与原版一致的 SCREAMING_SNAKE**）:
INVALID_REQUEST, CANCELED, STALE_CREDENTIALS, CREDENTIAL_UNREADABLE, THROTTLED,
TOKEN_EXPIRED, INVALID_CLIENT, IMAP_AUTH_FAILED, SCOPE_MISSING, NETWORK_ERROR,
MAIL_PARSE_FAILED, MAIL_TOO_LARGE, MAILBOX_NOT_FOUND, GRAPH_NOT_FOUND,
DEVICE_CODE_EXPIRED, DEVICE_CODE_DECLINED, ACCOUNT_NOT_FOUND, UNKNOWN

`AppErrorPayload { code, message, retryable, diagnostic?{requestId} }`。

归一化规则（error-utils.ts 移植）：
- Graph 429 / Retry-After → THROTTLED(retryable=true)
- AADSTS 错误串匹配表 → TOKEN_EXPIRED / INVALID_CLIENT / IMAP_AUTH_FAILED / SCOPE_MISSING
- 网络层错误（连接拒绝/DNS/超时/代理失败）→ NETWORK_ERROR(retryable=true)
- 取消信号 → CANCELED；凭据 generation 失配 → STALE_CREDENTIALS
- DPAPI 解密失败 → CREDENTIAL_UNREADABLE
- MIME 解析失败 → MAIL_PARSE_FAILED；内容超限 → MAIL_TOO_LARGE
- Graph 404 资源 → GRAPH_NOT_FOUND；邮箱 404 → MAILBOX_NOT_FOUND

## 4. DB schema（core::db，逐字移植 database-migrations.ts）

schema_migrations 单行(id=1) 版本表；CURRENT_SCHEMA_VERSION = 6。
- v1: accounts(15列) + mail_cache_meta(account_id PK) + mail_messages(account_id,message_id PK) + mail_details(account_id,message_id PK) + 三索引 idx_accounts_email/status/group_name + idx_mail_messages_account_updated/account_received
- v2: +accounts.inbox_folder_id, refresh_cooldown_until
- v3: +accounts.graph_delta_link
- v4: 建 access_token_cache（legacy）
- v5: +accounts.credential_generation INTEGER NOT NULL DEFAULT 0；DROP access_token_cache
- v6: 三张缓存表重建为 (account_id, folder_id) 复合主键，folder_id DEFAULT 'INBOX'，回填旧数据到 'INBOX'，重建索引

迁移行为：逐版本 `BEGIN IMMEDIATE` 事务；up → verify（表/列/主键/索引断言）→ 写版本；失败 ROLLBACK。应用启动时若需迁移，先 `VACUUM INTO` 生成 `maildeck.db.pre-v6.<ts>.<uuid>.db.bak` 备份。库版本 > 支持版本时报错退出。

文件名：userData 下 `maildeck.db`；存在旧 `outlook-manager.db` 且无新文件时连 -wal/-shm 一起改名；改不动则用旧文件名。

userData 目录：env `MAILDECK_USER_DATA_DIR` / `OUTLOOK_MANAGER_USER_DATA_DIR` 覆盖；默认目录不存在而 legacy `outlook-manager` 存在时整体改名迁移。

## 5. 设置文件（core::settings）

`settings.json`（userData 下，≤1MiB，损坏时备份为 `settings.json.broken-<ts>.bak` 重建）：

```json
{ "version": 2,
  "settings": { cacheMessages, cacheBodies, batchConcurrency, hotmailFallbackEnabled,
    autoRefreshEnabled, autoRefreshIntervalMinutes, refreshScope, autoUpdateCheckEnabled,
    closeToTray, launchAtStartup },
  "proxy": null | { protocol:"http:"|"https:"|"socks:"|"socks4:"|"socks5:",
    hostname, port, username, encryptedPassword } }
```

默认值：cacheMessages/Bodies=true, batchConcurrency=4, hotmailFallbackEnabled=true,
autoRefresh=false, interval=10, scope="all", autoUpdateCheck=true, closeToTray=false, launchAtStartup=false。

v1 legacy 文件（settings.proxyUrl 字符串）自动迁移为 v2 proxy 块。运行时 `RuntimeAppSettings = settings + proxyUrl`（凭据拼回 URL）；不支持协议（socks4 等按原版白名单）在 projectRuntime 时报错。代理修改 → proxyGeneration 自增 → 全部在途凭据快照失效。

## 6. 凭据加密（core::crypto）

格式：`"safe:" + base64(DPAPI CryptProtectData(blob))`；兼容解密 `"plain:" + base64(utf8)`（legacy 明文前缀）。Windows 用 CryptProtectData/CryptUnprotectData（无附加熵，与 Electron safeStorage 字节兼容）。加密不可用（非 Windows 或失败）时拒绝明文保存，报错。DPAPI 解密失败 → CREDENTIAL_UNREADABLE。

## 7. IPC 契约（core::contracts + app::commands）

28 个 invoke 命令、4 个事件通道，名字与 `IPC_CHANNELS`/`IPC_EVENT_CHANNELS` 一致。
校验限值（serde 校验函数实现，等价于原 zod schema）：
- accountId/jobId: trim, 1..128；messageId: 1..2048
- email: trim ≤320 + 格式校验；clientId: 1..256；refreshToken: 1..32768
- remark ≤1000 optional；group ≤200
- listMessages: top 1..100, skip 0..1e6, search ≤500, cursor ≤128, folderId 1..512, since RFC3339+offset nullable
- 批量账号 ≤5000 自动去重排序
- batchConcurrency 更新 1..12；autoRefreshIntervalMinutes 1..120
- 代理 URL：仅 http/https（可含 socks 于存储，运行时白名单 http/https），URL 内不允许携带凭据（必须分离字段）
- 进度事件不变式：completed ≤ total；ok + failed == completed；total ≥ 1

事件：accountsTestProgress(kind=test)、mailRefreshProgress(kind=refresh|refreshSingle|refreshBackground)、authDeviceCodeState(waiting|authorized|failed|canceled)、updateState(idle|checking|available|not-available|downloading|downloaded|error|unsupported)。

IpcResult<T> = Result<T, AppErrorPayload>（tauri 层包装为 {ok,value}|{ok,error}）。

## 8. Job 调度（core::jobs，refresh-coordinator.ts 移植）

- JobKind = test | refresh | refreshSingle | refreshBackground；同 kind 可并存多个 job（Map<kind, Map<jobId>>）
- `cancel(kind)` 取消该 kind 全部活动 job，返回取消数
- 每账号串行（per-account tail queue），不同账号并行
- 全局并发配额：Semaphore(batchConcurrency，默认 4，可 1..12)，运行中可调大调小
- 取消语义：等待账号槽/全局槽时被取消 → 直接走 onCanceled 分支；操作中取消 → 结束后结果被丢弃换 onCanceled；取消检查在每个持久化写入前（不变量②）
- runAccounts(批量测试) 对账号集合去重排序后逐个持有账号锁

## 9. 邮箱业务（core::mailbox）

MailboxOperationGuard：捕获 (accountId 凭据 generation, proxyGeneration) 快照，每次远端调用后、每次持久化写入前 assertCurrent；token 轮换后 refreshAfterCredentialRotation。

核心流程（移植 mailbox-access.ts）：
- `test_connection(account, force_refresh)`: token → 按模式列目录 → 成功提交 valid；失败按 resolveRefreshFailureStatus 提交（untested/invalid），bumpLastCheckedAt=false；STALE_CREDENTIALS 不改状态
- `refresh_mailbox(account, kind)`: token → Graph delta/listMessages 或 IMAP UID 增量 → 写缓存 → 再提交账号刷新状态（**不变量①：顺序不可反**）；shouldCommitMailboxRefreshState=false（搜索/翻页/cursor 模式）时不落 cursor；失败且 cooldown 类错误 → 写 refreshCooldownUntil
- `list_messages`: forceRefresh 或缓存缺失 → 走远端；网络/凭据失败且缓存存在 → 返回 stale 列表（stale=true + staleReason），不触发 fallback
- fallback 触发（不变量④）：仅 Graph 域名解析到 hotmail 场景的特定错误集合 + hotmailFallbackEnabled 设置开启；搜索/分页/节流/解析失败/内容超限/缓存写失败一律不触发
- IMAP 账号附件不支持 → MailAttachmentListResult { supported:false, attachments:[] }

账号刷新失败状态映射（account-refresh-state.ts）：THROTTLED/NETWORK_ERROR 等可重试错误不改 status（保持原值），TOKEN_EXPIRED/INVALID_CLIENT/IMAP_AUTH_FAILED/SCOPE_MISSING → invalid，其余 → untested→invalid / valid 保持？——以 resolveRefreshFailureStatus 为准：invalid 永远保持 invalid，valid 遇到凭据类错误才降级。

cooldown: THROTTLED → cooldownUntil = now + 10min（cooldownUntilFor）；cooldown 期内刷新直接 skipped。

## 10. 传输适配器（maildeck-transports）

- graph.rs: reqwest Client per proxy；refresh_token 流（login.microsoftonline.com/common/oauth2/v2.0/token，scope offline_access ... Mail.Read）；detectAuthMode(scope 含 IMAP.AccessAsUser.All → imap)；listMailFolders/listMessages/deltaMessages/getMessage/listAttachments/downloadAttachment(binary bounded)；响应体大小上限（16MB）→ MAIL_TOO_LARGE；重试（429/5xx 指数退避 ≤3 次）
- imap.rs: async-imap + TLS；list folders / fetch summaries (UID) / fetch body preferred text part（bounded）；INBOX 路径解析缓存
- hotmail.rs: login.live.com oauth + outlook.live.com/owa 0 起始 API；token 轮换返回 nextRefreshToken
- proxy.rs: ParsedProxyUrl 解析/公共格式化/完整格式化；协议白名单 {http:, https:, socks:, socks4:, socks5:}，运行时仅 http/https 直受 reqwest 支持，socks5 经 reqwest "socks" feature

## 11. 不变量测试清单（tests/invariants.rs）

1. 刷新成功：缓存写入成功后账号状态才更新（事务/顺序断言）
2. 持久化写入前 generation 检查：轮换凭据后旧流程写状态 → STALE_CREDENTIALS，库内容不变
3. 搜索/翻页/节流/解析失败/内容超限/缓存失败 → 无 fallback
4. 同账号测试互斥（并发两个 test 同账号 → 串行）；不同账号并行
5. cancel 后 runAccount 立即走 onCanceled，全局配额释放
6. 迁移 v0→v6 幂等，v5 库→v6 保留数据回填 INBOX；老版本拒开（version>6）
7. DPAPI roundtrip + `safe:`/`plain:` 前缀协议
8. 进度事件计数不变式（completed≤total, ok+failed==completed）
9. zod 限值对齐：top>100、search>500、batch>5000 → INVALID_REQUEST

## 12. Tauri 壳（maildeck-app）

- tauri.conf.json：productName MailDeck，identifier com.maildeck.desktop，frontendDist ui/dist，窗口 1280×800 min 960×600
- 命令层 `commands.rs`：28 个 #[tauri::command] 薄包装 → `CommandRouter`（不依赖 tauri，可独立测试）
- 事件层 `events.rs`：EventSink trait（测试用内存实现；tauri 用 AppHandle emit）
- 托盘/单实例/自启/更新器：tauri-plugin-single-instance / autostart / updater；closeToTray 拦截 close 事件为 hide
- main.rs：单实例锁 → 打开 DB（失败弹窗退出）→ 注册命令 → 建窗 → 设置初始化托盘/自启 → 更新器 8s 延迟启动

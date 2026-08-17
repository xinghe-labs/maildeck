# Outlook Manager 开发方案

## 目标

把 GuJumpgate 的 Microsoft 邮件读取能力拆成独立桌面应用，面向批量 Outlook/Hotmail 邮箱管理。

## MVP 范围

1. 桌面应用基础框架
   - Electron 主进程
   - React 渲染进程
   - 安全 preload IPC

2. 邮箱导入
   - CSV 导入
   - `----` 分隔格式导入
   - 导入预检
   - 单账号编辑和删除
   - 本地保存账号

3. Microsoft 邮件读取
   - refresh token 换取 access token
   - 根据 scope 自动分流 Graph / Outlook IMAP OAuth
   - 连接测试
   - 固定读取收件箱
   - 邮件列表和主题搜索
   - 邮件分页加载更多
   - 增量刷新
   - 邮件详情
   - 本地邮件摘要和详情缓存
   - 缓存过期
   - 缓存开关
   - 代理设置

4. 桌面 UI
   - 左侧邮箱列表
   - 中间邮件列表
   - 右侧邮件详情
   - 连接状态、错误原因、刷新按钮
   - 批量测试和批量刷新
   - 批量测试、批量刷新并发队列和进度展示
   - 批量任务并发数设置
   - 批量任务取消
   - 批量刷新失败重试
   - 最近刷新时间、邮件数量、最新邮件时间

## 存储设计

账号数据保存在 Electron `userData` 目录下的 `outlook-manager.db` SQLite 文件中，使用 Node/Electron 内置 SQLite 能力，不要求用户安装独立数据库服务。

`refreshToken` 使用 Electron `safeStorage` 加密；如果系统不支持，则保存时会打上非加密前缀，便于后续迁移和风险识别。

设置数据保存在 Electron `userData` 目录下的 `settings.json`，包含邮件列表缓存、邮件正文缓存、代理地址和批量任务并发数。

邮件缓存保存在 SQLite 的 `mail_messages`、`mail_details` 和 `mail_cache_meta` 表中，当前缓存最近邮件摘要和已打开过的邮件详情，默认 5 分钟过期。账号删除时会同步清理对应缓存。

邮件正文、主题、预览和联系人显示统一经过主进程文本规范化：保留 MIME 声明修复，同时识别常见的合法 UTF-8 二次误解码文本；Graph、IMAP 和历史缓存读取使用同一规则，避免不同传输路径出现不一致的乱码。

IPC 调用请求和主进程发出的批量进度事件都使用共享 Zod 契约做运行时校验；进度计数必须满足 `completed = ok + failed` 且不能超过批量上限，公开错误消息在进入 IPC 前限制为 4096 字符。Graph token、文件夹、邮件列表、增量和详情响应不再依赖 TypeScript 强制断言，缺失关键字段时返回明确的响应格式错误。Graph 与 IMAP 日期统一规范化为 ISO 字符串，非法日期降级为 `null`，避免异常服务器数据中断整批邮件读取。

旧版 `accounts.json` 和 `mail-cache.json` 会在首次启动时自动迁移到 SQLite，并保留 `.bak` / `.migrated` 备份文件，避免升级时丢失已有账号和缓存。

账号写入和邮件缓存写入均通过进程内队列串行化，并使用 SQLite 事务保证批量任务中的状态更新一致。

全量账号列表由 SQLite 列别名直接返回 Renderer 需要的账号视图，不读取加密 refresh token 或凭据代数，也不再逐行复制成新对象。Electron 43 的 Node 24/SQLite 运行时基准包含 5,000 个账号和 50 万封邮件摘要，账号列表 p95 低于 16ms，邮件读取和缓存写入 p95 低于 1.5ms，因此当前继续保留同步 SQLite；超过 50ms p95 或 100ms 最大阻塞时才考虑 Worker。

账号侧栏使用固定 80px 行高与 8px 行间距的窗口化渲染，只在视口和少量 overscan 范围内创建 DOM 节点；5,000 个账号的滚动容器仍保留完整高度，但初始页面只渲染约 10 行。批量测试结果通过账号 ID 索引后一次合并，避免对每个测试结果重复扫描全量账号。固定桌面窗口的 `body` 最小高度使用 `100vh`，避免内容区因窗口边框差异产生外层滚动条。

Access token 使用内存缓存；同一账号在刷新中的 token 请求会复用同一个刷新任务，避免并发触发 refresh token 换取。

批量刷新优先做增量读取：IMAP 记录最高 UID，Graph 记录最新邮件时间。没有游标时回退为最近邮件读取。

批量测试和批量刷新读取设置中的并发数，默认 4，保存时限制在 1-12，避免误配置导致本机或 Microsoft 侧连接压力过高。

## 后续增强

- OAuth 授权登录添加邮箱
- 邮件导出

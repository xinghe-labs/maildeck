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

旧版 `accounts.json` 和 `mail-cache.json` 会在首次启动时自动迁移到 SQLite，并保留 `.bak` / `.migrated` 备份文件，避免升级时丢失已有账号和缓存。

账号写入和邮件缓存写入均通过进程内队列串行化，并使用 SQLite 事务保证批量任务中的状态更新一致。

Access token 使用内存缓存；同一账号在刷新中的 token 请求会复用同一个刷新任务，避免并发触发 refresh token 换取。

批量刷新优先做增量读取：IMAP 记录最高 UID，Graph 记录最新邮件时间。没有游标时回退为最近邮件读取。

批量测试和批量刷新读取设置中的并发数，默认 4，保存时限制在 1-12，避免误配置导致本机或 Microsoft 侧连接压力过高。

## 后续增强

- OAuth 授权登录添加邮箱
- 邮件导出

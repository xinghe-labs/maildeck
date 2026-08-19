# Domain Context

## Mailbox Access

面向 IPC 的邮箱业务边界。它选择认证模式和传输方式，执行邮箱读取与刷新，并负责按正确顺序提交缓存和账号刷新状态。

## Refresh Job

由 Refresh Coordinator 管理的一次批量测试或刷新。它拥有取消信号、全局并发配额、账号互斥和进度生命周期；Mailbox Access 不注册或取消 Job。

## Refresh Job Session

Renderer 中由当前窗口发起的 Refresh Job 投影。它关联 invoke、`jobId` 进度事件和完成结果，负责前台任务互斥、后台静默、单账号刷新集合以及失败重试状态；主进程仍拥有 Job 调度与取消。

## Transport Adapter

Graph、IMAP 或 Hotmail fallback 的协议实现。适配器只负责远端协议交互，不直接暴露给 IPC，也不决定缓存和账号状态提交策略。

## Credential Generation

账号凭据版本。任何 token 轮换、fallback 请求或持久化写入前都必须确认读取时的 generation 仍然有效，避免旧请求覆盖新凭据。

## Mailbox Cursor

某个邮箱传输的增量或分页位置。IMAP 使用消息 UID，Graph 使用分页偏移或 delta link；只有非搜索、非翻页的主邮箱读取才可更新持久化刷新状态。

## Mailbox Session

Renderer 中当前选中账号的一次邮件浏览会话。它拥有搜索条件、邮件列表、Mailbox Cursor、选中邮件、正文详情和异步请求 generation；视图只发送用户命令并消费状态投影。

## Invariants

- IPC 负责输入验证、Job 调度和进度事件；Mailbox Access 负责邮箱业务策略。
- Mailbox Access 的调用者不选择 Graph、IMAP 或 Hotmail fallback。
- 成功刷新必须先写邮件缓存，再提交账号成功状态。
- 取消和凭据 generation 检查必须发生在每个持久化写入前。
- 搜索、分页、节流、解析失败、内容超限和缓存写入失败不得误触发 fallback。
- Mailbox Session 只接受当前账号、搜索条件和请求 generation 对应的异步结果；陈旧成功、失败和完成事件都不得修改当前视图。
- Refresh Job Session 只接受 kind、账号集合和 `jobId` 对应且单调前进的进度事件；已结束或不匹配 Job 的迟到事件不得修改当前投影。
- 批量测试、手动刷新和后台刷新在当前窗口内互斥；后台刷新不覆盖前台进度，单账号刷新按账号去重并可在不同账号间并行。

# Telegram Bot（只读查邮件）

在手机 TG 里搜索账号、看邮件列表、读正文，不用在手机上一个个登录官方 App。

## 边界（先看清楚）

- **桌面版必须开着**。Bot 跑在桌面版进程里，电脑关着就没有任何响应——你在 TG 里发消息也不会有回复。
- **纯只读**。不会标已读、不会删邮件、不会发信。
- **只服务你一个人**。配置里填的 chat id 之外的任何消息，一律静默丢弃（连"无权限"都不回，避免暴露 Bot 存在）。

## 一次性配置

### 1. 建 Bot 拿 token

在 TG 里找 `@BotFather`：

1. 发 `/newbot`
2. 起个名字（比如 `My MailDeck`）
3. 起个用户名（必须以 `bot` 结尾，比如 `my_maildeck_bot`）
4. 拿到一串 `123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### 2. 拿你的 chat id

给刚建好的 Bot 随便发一句话，然后浏览器打开（把 `<token>` 换成你的）：

```text
https://api.telegram.org/bot<token>/getUpdates
```

返回里找 `"chat":{"id":123456789,...}`，那个数字就是。

或者直接找 `@userinfobot` 问它要。

### 3. 写配置文件

文件位置：`%APPDATA%\maildeck\telegram.json`

```json
{
  "botToken": "123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "chatId": "123456789"
}
```

可以直接写明文 token——首次加载后会自动加密回写（Windows 上是 DPAPI，绑定当前用户）。
也可以先手动写密文，但没必要。

### 4. 确认代理

`api.telegram.org` 在国内直连不通，Bot 复用设置里的 `proxyUrl`（和「检查更新」同一套逻辑）。
确认 `%APPDATA%\maildeck\settings.json` 的 `proxy` 节点已配置，或者直接在设置页填好代理。

启动后日志会打印实际用的代理：

```text
[telegram] Bot 已启动（token 123456789:…，只响应 chat 123456789）
[telegram] 代理：http://127.0.0.1:10808
```

如果显示「未配置（直连…）」，说明代理没读到，Bot 会一直连不上。

### 5. 重启 MailDeck

配置在启动时读取，改完要重启。

## 怎么用

```text
你: /start
Bot: 🔍 输入邮箱前缀（至少 2 个字符）来搜索账号。

你: milio
Bot: 匹配到 3 个：
     [milioegros9637@hotmail.com] [milioe.gros@gmail.com] ...

你: (点第一个)
Bot: 📬 milioegros9637@hotmail.com
     ⏳ 缓存 · 正在刷新…
     （1~3 秒后原地变成）
     ✅ 已刷新
     1. [未读] Netflix · 订阅即将续费 · 11-07 14:32
     2. [已读] GitHub · PR #12 · 11-06 09:15
     [🔄 刷新] [🔍 换账号]

你: (点第 1 封)
Bot: ⏳ 正在获取…
     （原地变成正文）
     ── Netflix ──
     订阅即将续费
     11-07 14:32

     正文……
     📎 2 个附件
     [← 返回列表]
```

### 命令

Bot 启动时会自动注册命令菜单（`setMyCommands`），手机/桌面的输入框旁会出现
菜单按钮，输入 `/` 也会自动补全。改了命令只需重启 MailDeck，会覆盖旧菜单。

| 命令 | 作用 |
| --- | --- |
| `/find 关键词`（或 `/f`） | 查邮箱账号，模糊匹配；直接发文字等价 |
| `/open 完整邮箱`（或 `/o`） | 直接打开某个邮箱，没精确命中就退回模糊搜索 |
| `/unread`（或 `/u`） | 按未读数列出账号，点一下直接进账号视图 |
| `/search 关键词`（或 `/s`） | 跨账号搜邮件：主题 / 发件人名 / 发件地址 |
| `/refresh`（或 `/r`） | 刷新当前打开的账号 |
| `/start` / `/help` | 用法提示 |

菜单里没出现新命令时，把 Telegram 切到别的聊天再切回来（客户端会缓存命令列表）。

`/unread` 和 `/search` 都**只读本地缓存**，不联网。缓存里没有的邮件搜不到，
先点账号刷新一次再试。

```text
你: /unread
Bot: 📬 共 715 封未读，涉及 372 个账号（先显示 10 个）：
     [xxx@hotmail.com · 25 封] [yyy@hotmail.com · 24 封] ...

你: /search microsoft
Bot: 🔍 「microsoft」命中 7 封（缓存）：

     1. New sign-in detected for your Microsoft account
        account-security-noreply · 11-07 14:32 · xxx@hotmail.com
     2. …
     [1] [2] [3] [4] [5]
     [6] [7]

你: (点 1)
Bot: 正文…
```

细节：

- 搜索是**邮箱地址包含匹配**，不区分大小写。输 `@hotmail` 能筛出一批。
- 最多显示 10 个结果，超了会让你多输几个字符。
- 邮件列表每页 10 封，超过一页会给 `◀ 上一页` / `下一页 ▶`，翻页只读缓存不联网。
- 正文超过 TG 的 4096 字符上限会自动切 2~3 条发，不截断。
- HTML 正文转纯文本，链接保留但不可点（TG 不支持）。
- 失效账号（`invalid`）前面带 `⚠️`。
- 刷新失败会明确写「⚠️ 刷新失败，下面是缓存」，不假装成功。
- 界面上的「取消刷新」和 Bot 的刷新**互不干扰**（各用各的取消槽）。

## 出问题时看什么

日志同时写到两处：`%APPDATA%\maildeck\logs\maildeck.log`（按大小轮转，
单文件 2MB，留 3 个）和 stderr（从终端启动才看得到）。


| 日志 | 含义 |
| --- | --- |
| `[telegram] Bot 已启动…` | 配置读到了，线程起来了 |
| `[telegram] 代理：未配置` | 设置里没代理，国内必失败 |
| `[telegram] worker 已就绪` | 后台执行线程起来了（重活都在它里面跑） |
| `[telegram] 从 offset N 继续` | 重启后接着上次的位置收，不会重放旧命令 |
| `[telegram] {method} 触发限流` | 命中 429，按 `retry_after` 退避后自动重试 |
| `[telegram] 队列已满，丢弃本次操作` | 连点太快，后台还在忙（会回一句“请等几秒”） |
| `[telegram] 处理 … 时 panic` | 单条命令出错，已跳过，Bot 继续运行 |
| `轮询失败…Unauthorized` | 代理通了，但 token 是错的 |
| `轮询失败…error sending request` | 网络/代理层不通 |
| 完全没有 `[telegram]` 开头 | `telegram.json` 没被读到（路径、JSON 格式、字段为空） |

重试退避是 3s → 5s → 10s → 30s，不会打爆日志。

## 实现要点（改代码前先看）

- **轮询线程只做三件事**：白名单校验、`answer_callback_query` 秒回、把活丢进队列。
  刷新/搜索/取正文全在 `telegram-worker` 线程里串行跑（`crates/maildeck-app/src/telegram_bot.rs`
  的 `accept` / `push` / `worker`）。早期版本在轮询线程里同步做刷新，一次刷新
  就把 `get_updates` 和按钮应答一起堵住，表现是“按钮一直转圈”。
- **按钮应答必须在轮询线程发**：Telegram 只在收到 `answerCallbackQuery` 后才停止转圈。
- **进度已记录在 `telegram_offset`**：文件里是已确认的 `update_id + 1`，
  删掉它会让 Bot 重新处理 Telegram 还留着的旧命令（约 24 小时内）。
- **429 会退避重试**：最多 3 次，等待秒数取 `parameters.retry_after`，封顶 60s。
- **单条命令 panic 不影响 Bot**：worker 用 `catch_unwind` 包住每个 job；
  轮询线程也包住了 update 解析。

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

细节：

- 搜索是**邮箱地址包含匹配**，不区分大小写。输 `@hotmail` 能筛出一批。
- 最多显示 10 个结果，超了会让你多输几个字符。
- 列表显示最近 10 封；正文超过 TG 的 4096 字符上限会自动切 2~3 条发，不截断。
- HTML 正文转纯文本，链接保留但不可点（TG 不支持）。
- 失效账号（`invalid`）前面带 `⚠️`。
- 刷新失败会明确写「⚠️ 刷新失败，下面是缓存」，不假装成功。

## 出问题时看什么

日志在 stderr（从终端启动能看到，或看 `err.log`）：

| 日志 | 含义 |
| --- | --- |
| `[telegram] Bot 已启动…` | 配置读到了，线程起来了 |
| `[telegram] 代理：未配置` | 设置里没代理，国内必失败 |
| `轮询失败…Unauthorized` | 代理通了，但 token 是错的 |
| `轮询失败…error sending request` | 网络/代理层不通 |
| 完全没有 `[telegram]` 开头 | `telegram.json` 没被读到（路径、JSON 格式、字段为空） |

重试退避是 3s → 5s → 10s → 30s，不会打爆日志。

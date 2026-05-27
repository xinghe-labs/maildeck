# Outlook Manager

桌面版 Microsoft/Outlook 邮箱管理工具。当前 MVP 支持：

- 导入邮箱账号：支持 CSV、`email----client_id----refresh_token`、`email----password----client_id----refresh_token`
- 自动识别 Microsoft Graph / Outlook IMAP OAuth token
- 测试连接、批量测试、批量刷新收件箱
- 读取邮件列表和邮件正文
- 按主题搜索邮件
- 加载更多邮件
- 编辑已导入账号
- 导入前预检有效行、重复行、错误行、字段顺序和 token 类型
- 展示最近刷新时间、收件箱数量和最新邮件时间
- 本地缓存最近邮件，切换邮箱时优先显示缓存
- 批量测试和批量刷新使用并发队列并显示进度
- 支持在设置中调整批量任务并发数
- 批量测试和批量刷新支持取消
- 批量刷新失败后可单独重试失败账号
- 支持关闭邮件列表/正文缓存
- 支持 HTTP/HTTPS/SOCKS 代理配置
- 本地加密保存 refresh token
- 使用本机 SQLite 保存账号和邮件缓存

## 开发运行

```powershell
npm install
npm run dev
```

构建 Windows 安装包/绿色版：

```powershell
npm run dist:win
```

## 导入格式

CSV：

```text
email,client_id,refresh_token,remark,group
user@hotmail.com,9e5f94bc-e8a4-4e73-b8be-63364c29d753,M.Cxxx,主号,A组
```

分隔符格式：

```text
user@hotmail.com----9e5f94bc-e8a4-4e73-b8be-63364c29d753----M.Cxxx----主号----A组
user@hotmail.com----password----9e5f94bc-e8a4-4e73-b8be-63364c29d753----M.Cxxx----主号----A组
```

## 注意

账号需要具备可刷新 access token 的 `refresh_token`。

- Graph token：需要 `Mail.Read` 或等价读取权限。
- Outlook IMAP token：需要 `https://outlook.office.com/IMAP.AccessAsUser.All` 等邮件读取权限。

应用会根据 token 返回的 scope 自动选择 Graph 或 IMAP 读取路径。

账号和邮件缓存保存在本机 `outlook-manager.db` SQLite 文件中。旧版 `accounts.json` 和 `mail-cache.json` 会在首次启动时自动迁移，迁移后保留备份。应用不需要用户单独安装 SQLite。

邮件摘要和已打开正文默认缓存 5 分钟。需要立即读取服务器最新邮件时，可使用邮件列表右上角的强制刷新按钮。

批量刷新会优先做增量读取：IMAP 使用上次最高 UID，Graph 使用上次最新邮件时间。首次刷新或没有游标时会读取最近邮件。

批量测试和批量刷新默认 4 并发，可在设置中调整为 1-12。账号量较大或网络不稳定时建议保持 4-6，代理质量较好时可适当调高。

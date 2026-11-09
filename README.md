# MailDeck

Outlook / Hotmail 多账号邮件桌面客户端 —— Rust + Tauri 2 重写版。

> 本仓库是 [outlook-manager](https://github.com/xinghe-labs/outlook-manager)（Electron + TypeScript）的全量 Rust 重写：业务逻辑、IPC 契约、前端界面与原版逐项对齐，安装包体积从 ~90MB 降到 ~4MB。

## 功能

- **多账号管理** — 批量粘贴导入（`邮箱----clientId----refreshToken` 三段式 / `----邮箱----密码----` Hotmail 兜底式），导入前预检、逐号测试、备注/排序、单个与批量删除
- **三种邮件通道，按凭据自动路由** — Microsoft Graph API（oauth scope 含 mail.read）、原生 IMAP（scope 含 outlook.office.com，含 Modified UTF-7 文件夹名与 RFC2047 主题解码）、Hotmail IMAP 兜底（账号密码直登）
- **批量操作** — 批量测试可用性、批量刷新令牌、后台任务进度事件推送、失败号标记
- **邮件阅读** — 文件夹树、邮件列表（分页 + 本地缓存）、HTML/纯文本正文渲染、附件列表、已读标记回写、跨账号搜索
- **本地优先** — 邮件正文与元数据落 SQLite（AES-GCM 加密敏感字段），离线可见缓存，缓存占用统计与单账号/全量清理
- **凭据安全** — Windows 用 DPAPI，macOS/Linux 用系统钥匙串（keyring）+ AES-256-GCM；令牌仅内存解密，不落明文
- **桌面集成** — 系统托盘（关闭窗口进托盘不退出）、单实例、设备代码登录向导、应用内自动更新（GitHub Releases）
- **代理支持** — 全局 HTTP/SOCKS 代理（含认证），Graph / IMAP / 兜底通道统一走代理

## 下载

从 [Releases](https://github.com/xinghe-labs/maildeck/releases) 获取（tag `rust-v0.5.0` 起）：

| 平台 | 文件 |
|---|---|
| Windows x64 | `MailDeck_*_x64-setup.exe`（NSIS 安装包） |
| macOS Apple Silicon | `MailDeck_*_aarch64.dmg` |
| Linux x64 | `MailDeck_*_amd64.AppImage` / `MailDeck_*_amd64.deb` |

Windows 上也可以直接用旧版数据目录迁移：首次启动时若 `%APPDATA%/maildeck` 存在旧版数据库，新版按同 schema 沿用（DPAPI 加密字段直接兼容）。

## 架构

```
crates/
├── maildeck-core     # 领域层：SQLite(migration/账号/邮件缓存/设置)、凭据加密、
│                     # OAuth 设备码、Graph/IMAP/Hotmail 传输、刷新协调、导入预览
├── maildeck-app      # IPC 门面：40+ 命令，契约与原版 electron/main 逐一对齐
└── maildeck-shell    # Tauri 2 壳：窗口/托盘/单实例/更新器 + 原版前端 dist + preload shim
frontend/             # React + Vite（与原版同源 UI），经 window.maildeck shim 调用
```

- 前端零改动复用原版构建产物，`maildeck-shim.js` 完整实现 `window.maildeck` 接口面（accounts / mail / settings / auth / jobs / update / app）
- 事件（刷新进度、设备码状态、更新状态）经 Tauri event → shim 回调，与原版 ipcRenderer 语义一致

## 开发

```bash
# 依赖：Rust 1.85+、Node 20+、Tauri 2 系统依赖（Linux 需 webkit2gtk 等）
cargo test --workspace          # 94 个测试
cargo build -p maildeck-shell   # debug 运行版
cargo tauri build               # 产物在 target/release/bundle/
```

- 设置/数据库/加密实现细节见 [docs/design.md](docs/design.md)
- 重构映射与遗留项见 [REFACTOR-PLAN.md](REFACTOR-PLAN.md)

## CI

GitHub Actions（[build-rust.yml](.github/workflows/build-rust.yml)）在 Windows / macOS / Ubuntu 三平台构建：跑全量测试 → cargo tauri build → 按版本号上传安装包到 Release。CI 测试环境设 `MAILDECK_NO_KEYRING=1` 跳过钥匙串（headless 无 GUI）。

## License

与上游 outlook-manager 一致。

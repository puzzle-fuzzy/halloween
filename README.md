# Halloween

供自己使用的桌面文件管理工具：个人云盘、阿里云 OSS 和设备管理后台。

| 包 | 职责 |
| --- | --- |
| `packages/desktop` | Electron 主进程、系统凭据、文件传输、安装包 |
| `packages/renderer` | 桌面界面 |
| `packages/server` | Bun/Hono API、文件存储、授权、OSS 签名 |
| `packages/admin` | 浏览器中的设备、OSS 账号和个人资料管理 |
| `packages/contracts` | 回收站、备份任务等跨端共享的数据类型 |

使用 Bun 1.4.0（`packageManager` 固定版本）。依赖通过 `bun.lock` 锁定。

## 本地开发

```sh
bun install --frozen-lockfile
bun run setup:local
bun run dev:server
```

`setup:local` 仅在不存在时创建 `packages/server/.env`，生成随机凭据，并将数据和控制状态分别放入 `.local-data/files`、`.local-data/state`。读取该文件中的 `ADMIN_PASSWORD` 登录本地后台，勿将凭据提交到 Git。

另开终端运行桌面端：

```sh
HALLOWEEN_SERVER_URL=http://127.0.0.1:3690/cloud bun run dev
```

首次授权需先构建后台（`bun run --filter @halloween/admin build`），或另开终端运行 `bun run dev:admin` 开发后台页面。桌面应用打开服务器上的 `/admin/#/device/<code>`，比较桌面与浏览器里的授权码和设备名，再明确批准；已有管理员会话也不会自动批准。

后台热更新入口为 `http://localhost:5174/admin/`。API 服务端口为 3690。开发时切换服务地址不会把另一服务的设备令牌带过去。已打包应用使用配置中的服务地址，默认是 `https://halloween.yxswy.com/cloud`。

## 检查与打包

```sh
bun run check       # 回归测试、全部类型检查、构建
bun run build
bun run dist:mac    # 在 macOS 上生成 DMG / ZIP
bun run dist:win    # 在 Windows 上生成 NSIS 安装包
```

Electron 真实窗口检查（先完成 `bun run build`，需图形桌面环境）：

```sh
bun run --filter @halloween/desktop test:smoke
bun run --filter @halloween/desktop test:smoke --packaged # macOS ARM64 打包后验证 asar 内容
bun run test:ui     # 临时服务端 + 真实后台页面，验证明确批准与拒绝
bun run test:media  # 真实 Chromium 音频预览、失效链接刷新与播放位置恢复
bun run test:dev-proxy # 验证本地后台开发代理和跨来源保护
bun run test:recovery # 回收站界面与未配置备份状态
```

检查使用临时用户目录，不读取已有桌面凭据。媒体检查使用真实 renderer、fixture IPC 和本地 Range 媒体服务，通过推进测试时钟模拟链接过期，不连接真实存储。GitHub Actions 在 Ubuntu、macOS 上执行测试、类型检查和构建；本地检查成功不代表远程 CI 已运行。

macOS 分发的开发者签名、公证需要自行配置 Apple 证书和账户。构建成功或本机可启动不等于完成签名、公证或 Windows 安装验收。

## 数据和操作规则

- `DATA_ROOT` 只包含云盘文件；`STATE_ROOT` 保存设备令牌、OSS 密钥、个人资料与回收站。两者必须是互不包含的目录。
- 控制 JSON 原子写入并限制文件权限；配置损坏会拒绝启动，避免当成空配置覆盖。
- 云盘同名上传拒绝覆盖。客户端到 OSS 的上传也拒绝覆盖已有对象。
- 云盘删除移入服务端回收站；OSS 删除永久生效，请先配置 OSS 版本控制或备份。
- Trash 页面可查看回收站大小、批量恢复、遇到同名时改路径恢复，以及明确确认后的永久清理。损坏项仍会显示，不能误当作完整文件恢复。
- Backups 页面可创建加密备份、查看快照、执行完整性检查和隔离恢复验证；备份任务在服务器执行，离开页面仍可继续。
- OSS 文件夹按对象前缀处理，目录重命名会先复制全部对象，再删除源对象。它不是存储服务提供的原子目录事务，过程中不要通过其他客户端修改同一前缀。
- 桌面令牌使用系统凭据加密；预览使用短期单文件票据，下载使用鉴权请求。
- 预览链接失效或加载失败时支持刷新；音视频刷新会恢复播放位置与暂停状态。
- 传输列表保留当前应用进程的任务状态；本地下载先写临时文件，成功后发布为最终文件。

生产部署、旧版迁移、回收站恢复见 [服务端说明](packages/server/README.md)。设计约束与发布检查见 [维护说明](docs/maintenance.md)。

备份首次启用需要在服务器配置 restic、专用仓库和密码文件，步骤见 [备份说明](packages/server/BACKUPS.md)。未配置时页面会如实显示状态，云盘与回收站照常使用。备份覆盖云盘文件、控制 JSON 和回收站，不复制 OSS Bucket 中的实际对象；环境密钥和仓库密码需独立保管。

新增功能的真实备份回归可设置 `BACKUP_TEST_RESTIC_BINARY=/absolute/path/to/restic` 后运行 `bun run test` 与 `bun run test:recovery`。没有现成引擎时，`bun run test:fetch-restic` 会从官方固定版本下载、校验并在临时目录准备测试引擎，输出路径；不会安装系统软件。CI 使用同样方式运行真实临时加密仓库测试。

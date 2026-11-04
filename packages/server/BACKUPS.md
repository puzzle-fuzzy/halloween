# 备份与恢复验证

备份引擎使用 [restic](https://restic.net/)，应用不自建备份存储格式。需要服务端安装 **restic 0.17.0 或更新版本**，并由运维先建立一个专用于 Halloween 的加密仓库。应用不会自动初始化、修复、清理或删除仓库快照。

未安装 restic、缺少配置或密码文件权限不正确时，界面明确显示未配置，并拒绝启动作业。`configured=true` 说明本地依赖和配置检查通过；是否能连接、解密并读取远端仓库，需执行“刷新快照”或完整性检查确认。状态轮询只读缓存，不会不断请求远端仓库。

## 配置与保管

在服务端受限权限的环境文件中设置：

```dotenv
BACKUP_REPOSITORY=s3:https://backup.example.com/private-bucket/halloween
BACKUP_PASSWORD_FILE=/etc/halloween-backup/password
# 可选；非默认位置时必须为绝对路径
BACKUP_RESTIC_BINARY=/usr/local/bin/restic
# 按使用的 restic 存储后端配置，例如 S3：
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

仓库地址、密码文件和后端凭据只通过服务器配置提供；没有修改密钥的 HTTP/桌面表单。API 不返回仓库地址、密码文件路径、后端凭据或 restic 原始 stderr。备份子进程使用参数数组、`shell:false`；不会继承应用 `TOKEN`、`ADMIN_PASSWORD` 或 `RESTIC_PASSWORD_COMMAND`。

支持绝对本地路径、`local:`、`sftp:`、`rest:https://`、`s3:http(s)://`、`b2:`、`azure:`、`gs:`、`swift:`、`rclone:`。建议使用另一台机器或独立对象存储账户。仅备份到原磁盘的另一个目录，无法覆盖原磁盘损坏的情况。远端后端的部署与凭据参数按 [restic 仓库文档](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html) 配置。

密码文件要求：绝对路径、普通文件、非空、最多 64 KiB，Unix 上不得开放组/其他用户权限（通常 `0600`）；不得位于 `DATA_ROOT` 或 `STATE_ROOT`。仓库也不得与这两个目录互相包含。应用不会把仓库密码文件和服务进程的 `.env` 放进快照，应将它们与部署版本在独立安全位置保管。丢失 restic 仓库密码将无法解密备份。

例如先创建密码文件，再用相同的仓库/密码配置执行初始化：

```sh
sudo install -d -m 0700 -o halloween -g halloween /etc/halloween-backup
sudo -u halloween sh -c 'umask 077; openssl rand -base64 48 > /etc/halloween-backup/password'
# 通过受限环境文件或管理员终端配置 RESTIC_REPOSITORY，以及后端凭据。
# BACKUP_* 是应用配置；手工调用 restic 时使用 restic 原生变量：
export RESTIC_REPOSITORY='s3:https://backup.example.com/private-bucket/halloween'
export RESTIC_PASSWORD_FILE=/etc/halloween-backup/password
restic init --repository-version 2
```

初始化与服务运行应使用同一服务用户的访问权限，不要将真实密码放在命令行参数、聊天、截图或 Git 中。更改配置或安装 restic 后重启服务。仓库地址变化会隔离原仓库的本地任务历史，避免把旧仓库的成功状态当作新仓库的状态。

systemd 的 `ProtectSystem=strict` 保持有效；缓存、快照工作区和验证报告均在 `STATE_ROOT/backups/` 内。若配置本地备份盘，需给服务追加仅限目标仓库的 `ReadWritePaths=/mnt/backup/halloween-restic`；远端 HTTPS 仓库通常不需要额外本地写目录。SFTP 需配置服务用户的 SSH 密钥与已核对的主机密钥；不要关闭主机身份校验。

## 覆盖范围与一致性

每个应用备份包含：

- `files/`：`DATA_ROOT` 的完整普通文件/目录树，包括空目录。
- `state/`：`tokens.json`、`profile.json`、`oss-accounts.json` 和 `trash/`。
- `metadata.json`：应用备份版本及源目录说明。
- `manifest.jsonl`：文件 SHA-256、路径、类型、大小和权限的完整性清单。

**不包含 OSS Bucket 中的实际对象**；只备份本地保存的 OSS 账号配置。OSS 数据需使用对象存储自己的版本控制、复制或独立备份。`STATE_ROOT/backups/` 下的缓存、任务历史与验证输出不递归备份；应用 `.env`、服务端 master 密钥、管理员密码、备份密码文件也不包含在快照中。

应用先在所有云盘写入、控制配置写入及回收站变更共享的锁中构建稳定树，再释放锁，计算清单并运行 restic。普通文件优先使用同卷硬链接；应用通过新增 inode、原子替换、改名与移入回收站修改文件，因此之后的应用操作不会改变已构建的快照内容。**外部进程不得在备份期间原地修改这些源文件**。不支持符号链接、设备等特殊文件；发现时作业明确失败，不跟随到其他目录。

跨文件系统或不支持硬链接时会退回复制，因此可能需要与待备份数据相当的额外临时空间，并延长锁住写操作的时间。清单散列和远端传输在释放锁后执行；大视频会被顺序读取，不整体载入应用内存。空间不足或中断不修改原数据，生成的 staging 会在失败后清理；重启时也会清理专用工作目录内遗留的 UUID 工作树。

restic 自己管理加密、去重和仓库快照。应用清单用于额外核对恢复出来的目录内容，不替代 restic 的仓库格式或校验。相关路径行为见 [restic 相对路径备份说明](https://restic.readthedocs.io/en/stable/040_backup.html#absolute-and-relative-paths)。

## 手动操作与结果

桌面“备份”页对应四种异步作业：

| 操作       | 引擎动作                                             | 成功含义                                                |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------- |
| 立即备份   | `restic backup`，专用应用 tag                        | 引擎返回成功且确认完整快照 ID；这不等于已执行完整性检查 |
| 刷新快照   | `restic snapshots --tag halloween-personal-cloud-v1` | 更新当前仓库的应用快照缓存                              |
| 完整性检查 | `restic check --read-data`                           | 独立读取并检查仓库结构和全部数据                        |
| 恢复验证   | `restic restore <id> --verify`，再核对 SHA-256 清单  | 指定快照能恢复到独立目录且清单一致                      |

“完整性检查”会读取整个仓库的数据，对远端仓库可能产生相应时间和流量。这个强度来自 [restic 完整性检查文档](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#checking-integrity-and-consistency)。

同时只允许一个备份作业；已有作业时返回 `409`。服务重启会把未结束的作业标记为 `interrupted`，不会当作成功。restic 非零返回码（包括“部分文件未读成功”的 `3`）均视为失败。最近 30 个任务、最多 500 个快照及最近一次备份成功/检查/验证结果在私有 JSON 中原子保存；最近成功摘要独立保存，不随任务列表滚动丢失。

备份历史损坏、无法读取/写入或工作目录不安全时，仅禁用备份功能，保留现有历史文件并显示维护原因；云盘和回收站继续运行。不会把损坏的备份历史当作空配置覆盖。主控制文件（设备令牌、OSS 账号等）的启动校验规则不受这个隔离策略影响。

HTTP 接口使用已批准设备的 Bearer 认证：

```text
GET  /cloud/api/backups/status
POST /cloud/api/backups/jobs       {"kind":"backup|check|verify|refresh","snapshotId":"verify时必填"}
GET  /cloud/api/backups/jobs/<uuid>
```

返回的任务包含 `status`、`phase`、起止时间、可用的进度、快照 ID、摘要与可读错误。进度百分比为 `0..1`。`verify` 仅接受已刷新缓存中完整的 64 位小写十六进制快照 ID，不接受 `latest`、任意路径或命令参数；客户端不能指定恢复位置。

## 恢复验证与真正恢复

验证只写 `STATE_ROOT/backups/restores/<job UUID>/content`，从不覆盖 `DATA_ROOT` 或当前控制 JSON。引擎核对恢复内容后，再比较应用 SHA-256 清单，连额外/缺失文件、空目录、权限及类型也参与核对。失败会删除本次生成的恢复目录；成功也删除完整 `content`，仅保留小型 `verification.json` 报告，避免每次验证再占一份完整数据。`restoreId` 对应报告 ID，不是可下载的数据副本。重启会清理中断验证的 payload。

真正的生产恢复需离线操作，参考 [restic 恢复文档](https://restic.readthedocs.io/en/stable/050_restore.html)。先在独立目录验证，保留当前生产数据的另一份备份；停止应用后，再人工核对并恢复 `files/` 与 `state/` 到匹配的目标目录。服务环境密钥与仓库密码按各自独立保管副本恢复。API 不提供直接覆盖生产目录的恢复按钮。

```sh
# 设置好原生 RESTIC_REPOSITORY/RESTIC_PASSWORD_FILE 和相应后端凭据。
restic snapshots --tag halloween-personal-cloud-v1
# 使用列表中的完整 ID；目标必须为新建、独立、受限权限的恢复目录。
restic restore <full-snapshot-id> --target /srv/halloween-offline-recovery --verify
# 检查恢复结果；确认后再停服并按清单人工迁移 files/ 和 state/。
```

没有自动 `forget`/`prune`/`unlock`。保留策略和仓库维修需使用 restic 运维流程；不要因应用一次失败就删除源数据、快照或强制清除可能仍在使用的锁。备份完成但本地结果来不及落盘时，应先刷新仓库并重新执行检查/恢复验证。

## 可选定时触发

单用户应用无需另设调度平台。可选用 systemd timer 触发现有 API，凭据放在只读、`0600` 的 curl 配置文件中（不放进 `ExecStart` 命令行）。例如 `/etc/halloween-backup/trigger.curl`：

```text
url = "http://127.0.0.1:3690/cloud/api/backups/jobs"
request = "POST"
header = "Authorization: Bearer <专用于触发的已批准设备令牌>"
header = "Content-Type: application/json"
data = "{\"kind\":\"backup\"}"
```

```ini
# /etc/systemd/system/halloween-backup-trigger.service
[Unit]
Description=Queue Halloween backup
After=halloween-cloud.service
[Service]
Type=oneshot
User=halloween
ExecStart=/usr/bin/curl --fail --silent --show-error --config /etc/halloween-backup/trigger.curl
```

```ini
# /etc/systemd/system/halloween-backup-trigger.timer
[Unit]
Description=Daily Halloween backup trigger
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
```

`systemctl enable --now halloween-backup-trigger.timer` 只在配置并核对后由管理员执行。触发接口返回成功代表已创建作业，**不代表备份已结束**；应检查返回 ID 的最终状态及最近成功时间。并发作业会返回 `409`，不会自动创建多个重叠备份。

## 测试

```sh
bun test packages/server/test/backups.test.ts
# 另有真实引擎时；只使用自动生成并清理的临时仓库、假数据与假密码：
BACKUP_TEST_RESTIC_BINARY=/absolute/path/to/restic bun test packages/server/test/backups.test.ts
```

默认测试使用 fake runner 覆盖未配置、排他作业、状态持久化、重启中断、硬链接/跨卷回退、空间不足、非法 ID、符号链接、失败诊断保密及恢复清单不一致。真实测试初始化临时加密仓库，完成备份、全数据检查、快照刷新和恢复验证；没有连接生产仓库或读取真实凭据。

# Halloween 私人云盘服务

这是单用户、多设备应用；所有已批准设备拥有同一云盘和所配置 OSS 账号的读写权限。无需配置用户注册或租户数据库。

## 本地运行与检查

在仓库根目录安装锁定依赖并构建管理界面：

```sh
bun install --frozen-lockfile
bun run --filter @halloween/admin build
cp packages/server/.env.example packages/server/.env
```

分别运行两次 `openssl rand -hex 32`，将不同的结果填入 `TOKEN` 和 `ADMIN_PASSWORD`。然后：

```sh
bun run --filter @halloween/server dev
bun run --filter @halloween/server test
bun run --filter @halloween/server typecheck
```

默认监听 `127.0.0.1:3690`，后台入口为 `/admin/`。`TOKEN` 至少 32 字符，后台密码至少 12 字符；示例文件故意不提供可直接上线的默认密码。`DATA_ROOT` 和 `STATE_ROOT` 的相对路径按服务进程工作目录解析（workspace 脚本中为 `packages/server`）。

## 数据、迁移与备份

- `DATA_ROOT`（默认 `./data`）：可见云盘文件。所有 API 拒绝点文件、`..`、反斜线和符号链接；现有隐藏文件不会显示或通过文件接口读取。
- `STATE_ROOT`（默认 `./state`）：`tokens.json`、`profile.json`、`oss-accounts.json` 和 `trash/`。状态目录与数据目录必须互不包含，包含符号链接别名的重叠也会拒绝启动。目录权限 `0700`，JSON `0600`。设备令牌仅存 SHA-256 摘要；OSS 密钥仅在此目录中保存，需随备份保密。
- JSON 使用唯一临时文件、文件同步、原子替换和支持时的目录同步。读取失败或 JSON 损坏会阻止启动；服务不会把损坏配置当作空配置运行。

首次升级会校验并迁移 `DATA_ROOT/.tokens.json`、`.profile.json`、`.oss-accounts.json` 至独立状态目录，然后删除旧文件。旧设备令牌保持有效，但转换为摘要存储。如果旧文件与状态目录中的文件同时存在且内容不同，启动会中止，需先离线核对并保留正确版本。升级前备份两个目录。迁移中途重启可继续，已经迁移且内容一致的文件不会重复导入。

旧 master `TOKEN` 太短时需先换成强随机值才能启动。**更换 master TOKEN 本身不会撤销已批准设备的独立令牌**；它会使旧 master 凭据失效，并改变会话/预览票据签名。若怀疑旧凭据文件曾泄露，应撤销设备、轮换 OSS AccessKey，再重新批准可信设备。后台会话保存在进程内，重启后需重新登录。

备份时先停止服务以获得文件和状态的一致快照；备份 `DATA_ROOT`、`STATE_ROOT`、部署版本及受限权限的环境配置。回滚新版本前，保留已经迁移的状态目录；旧版本只认识点文件，不能直接读取新状态目录，不能盲目回退旧代码。恢复备份时同样停服、恢复两个目录和匹配版本后再启动。

## 上传、删除与恢复

上传是流式写入，不把完整文件载入内存。默认上限 100 GiB，可通过 `MAX_UPLOAD_BYTES`（正整数、字节）调整；实际 Bun HTTP 服务和应用层都使用此上限。Nginx 上传入口允许大请求，将大小控制交给后端。JSON 请求另有限额：公开设备接口 4 KiB，其他 JSON 1 MiB。磁盘容量耗尽返回错误；中断或失败的上传会清理临时文件。已有同名文件返回 `409 {"error":"target exists"}`，不会覆盖。

云盘删除会将文件/目录移入 `STATE_ROOT/trash/<id>/content`，并写入 `manifest.json`，其中包含原路径 `originalPath` 和删除时间。删除响应增加 `trashIds`，原来的 `ok`/`deleted` 字段保留。选中父目录和其子项时只回收父目录一次。桌面 Trash 页面支持查看占用、恢复、改名恢复和明确确认后的永久清理；回收站不会自动清空。

```text
GET  /cloud/api/trash
POST /cloud/api/trash/restore  {"id":"回收项ID","destination":"可选新云盘路径"}
POST /cloud/api/trash/purge    {"ids":["ID"],"confirmation":"DELETE"}
POST /cloud/api/trash/purge    {"all":true,"confirmation":"EMPTY_TRASH"}
```

恢复不覆盖已有目标，返回 409 时可指定另一个完整云盘路径；目标父目录必须已存在。旧版清单兼容读取，损坏或不完整的项会显示但禁用恢复。恢复完成而回收站清理失败时返回 `warning`，数据已恢复，剩余副本需核对。

永久删除部分成功时返回 HTTP 207 与 `{ok:false,purged,failed:[{id,error}]}`，客户端刷新列表、展示实际结果并对剩余项重新确认。正在删除但未完整清理的项会标记不可恢复，避免把半棵目录当作完整副本。批量移入回收站中途失败时，之前成功的项仍在回收站，需刷新云盘和回收站查看。

可选加密备份、最近成功状态及隔离恢复验证见 [备份说明](BACKUPS.md)。备份配置及工作目录问题只禁用备份子系统，不影响云盘使用。

手工恢复（示例中将 `<id>`、`folder` 换成清单中的实际值）：

```sh
sudo systemctl stop halloween-cloud
sudo cat /var/lib/halloween-cloud/trash/<id>/manifest.json
# 确认 /srv/halloween-cloud/folder 不存在，且父目录为预期云盘目录。
sudo -u halloween mv -n -- /var/lib/halloween-cloud/trash/<id>/content /srv/halloween-cloud/folder
# 确认 content 已移走、目标完整后，可移除只剩清单的这一项。
sudo systemctl start halloween-cloud
```

`mv -n` 防止覆盖已有目标；遇到目标冲突时先恢复到另一个未占用名称，不要覆盖当前文件。跨文件系统删除时，服务会先完整复制到回收站再删除源；发生部分失败时保留内容以便核对。

OSS 删除直接请求对象存储，不进入本地回收站。重要 Bucket 应在 OSS 中启用版本控制或独立备份，并使用仅允许所需 Bucket 的 RAM 凭据。OSS 目录操作把末尾 `/` 作为目录前缀，多页读取全部对象；重命名先检查目标并完成全部复制后才删除源。对象存储没有跨对象事务：中断、复制失败或部分删除可能留下两处数据，接口会报错而不是假报成功。复制失败时源对象不会删除；重试前核对目标前缀中的副本。大于 1 GiB 的对象使用 OSS 服务端 multipart copy，保留内容类型和用户元数据，并在分片完成时禁止覆盖；失败时尝试中止未完成的分片上传。源 ETag 作为复制条件，全部复制后还会重新检查源元数据，发现源已变化就保留源并报冲突。进程中止或清理失败仍可能留下未完成分片，应为 Bucket 配置清理未完成分片的生命周期策略。

## 认证与接口约定

- 云盘与 OSS API 使用 `Authorization: Bearer <device-token>`；后台只接受 master Bearer 或后台会话 Cookie。
- `POST /cloud/api/device/code {name}` 申请设备授权。后台 `GET /admin/api/device/:code` 返回 `{name,userCode,expiresAt,status}`，仅查看不会批准；`POST /admin/api/device/approve {user_code}` 和 `/device/deny` 必须由管理员显式操作。拒绝轮询返回 `403`，过期返回 `410`，重复处理返回 `409`。
- 六位设备码使用密码学随机数并检查碰撞；公开申请、轮询、后台登录和设备码尝试均有限流，超额 `429`。只有配置了可信反向代理时才启用 `TRUST_PROXY=1`；应用仍应只监听 loopback，避免客户端伪造代理 IP。
- 生产 Cookie 配置 `HttpOnly; Secure; SameSite=Lax; Path=/admin`，签名与随机会话标识均校验；注销立即使相应会话失效，跨 Origin 的后台写请求拒绝。
- `POST /cloud/api/preview-ticket {path}` 返回 `{url,expiresAt}`。URL 含 5 分钟、限定单文件的签名票据，不暴露长期设备令牌。支持 `GET Range` 与 `HEAD`；客户端需在票据过期前获取新票据，或在过期后重新打开预览；当前桌面端会刷新媒体预览链接并保留播放位置。旧客户端文件 URL 的 `?token=` 暂保留兼容，新客户端不应再使用。
- OSS `GET /oss/api/accounts/:id/objects?bucket=...&prefix=...&marker=...` 返回 `{entries,truncated,nextMarker?}`；`truncated=true` 时必须用 `nextMarker` 继续读取。
- OSS `POST .../sign {bucket,key,method:"PUT"}` 拒绝已存在目标，响应 `{url,method,headers}`；直传必须合并响应 `headers`，其中包含 `Content-Type` 与签名绑定的 `x-oss-forbid-overwrite`，避免签名后发生并发覆盖。下载签名为 5 分钟有效。

## Linux 部署

`deploy/halloween-cloud.service` 按完整仓库位于 `/srv/halloween-cloud-app` 配置，依赖先在仓库根目录按锁文件安装，并构建 admin bundle。服务用户 `halloween` 只需读应用代码、写两个数据目录；systemd 使用受限文件系统、`UMask=0077`、专用用户和 loopback 监听。

部署前按实际环境建立专用用户与两个目录：

```sh
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin halloween
sudo install -d -o halloween -g halloween -m 0700 /srv/halloween-cloud /var/lib/halloween-cloud
sudo install -o root -g root -m 0600 /dev/null /etc/halloween-cloud.env
```

在 `/etc/halloween-cloud.env` 写入强随机 `TOKEN`、`ADMIN_PASSWORD`（不要放入仓库），并核对 service 中 Bun 的绝对路径、仓库工作目录、域名、证书和数据路径。若原数据属于 root，停服并按实际路径调整两个目录的所有权，使专用用户可迁移和读写；不要递归修改整个 `/srv` 或应用以外目录。

`deploy/nginx-halloween-cloud.conf` 提供后台与 API 反代。文件也流式反代 Bun，统一执行路径、符号链接和票据检查，因此 Nginx 用户无需读私有云盘目录。文件请求不记录 query，避免票据或旧 token 进入 access log；应用日志同样只记录路径。保留的内部 `/_auth` 示例通过 `X-Original-URI` 转发原始路径/参数，不拼接双问号。生产配置使用 `PUBLIC_ORIGIN=https://...`、`TRUST_PROXY=1`、`SECURE_COOKIES=1`。

安装配置后运行 `nginx -t` 再 reload；启动服务后先检查健康接口、后台登录、显式设备授权、上传/下载（含 Range）、删除后回收站恢复，再接入真实 OSS。回归测试使用临时目录和 fake OSS client；通过测试不代表线上权限、Nginx、OSS RAM 策略或对象版本控制已经验收。

# SyncClipboard Server

[English](README_EN.md)

使用 **Bun + TypeScript** 实现的独立 SyncClipboard 服务端。提供剪贴板同步、SignalR 实时通知、SQLite 历史记录和附件存储。本仓库只包含服务端。

## 运行

安装 Bun 1.4.4 或更新版本，然后在仓库根目录执行：

```sh
bun install --frozen-lockfile
SYNCCLIPBOARD_USERNAME=myuser SYNCCLIPBOARD_PASSWORD=mypassword bun start
```

默认监听 `http://0.0.0.0:5033`，数据保存在当前工作目录的 `server/`。所有接口均使用 HTTP Basic 认证，未配置凭据时默认值为 `admin` / `admin`。使用环境变量或配置文件设置自己的账号密码。

```sh
bun start --port 5033 --host 127.0.0.1 --data-dir ./server
bun run build
bun dist/index.js --data-dir ./server
```

构建后的 `dist/index.js` 包含运行依赖和 Swagger UI，可复制到安装了 Bun 的机器单独运行。日志写到标准输出/错误输出；`SIGINT`、`SIGTERM` 关闭服务并释放数据库。

## Docker

```sh
docker pull ghcr.io/jamesflare1212/syncclipboard-server:latest
docker run -d --name syncclipboard-server \
  -p 5033:5033 \
  -e SYNCCLIPBOARD_USERNAME=myuser \
  -e SYNCCLIPBOARD_PASSWORD=mypassword \
  -v syncclipboard-data:/app/server \
  --restart unless-stopped \
  ghcr.io/jamesflare1212/syncclipboard-server:latest
```

也可以设置 `SYNCCLIPBOARD_USERNAME`、`SYNCCLIPBOARD_PASSWORD` 后运行 `docker compose up -d --build`。容器以 `bun` 用户运行；挂载已有宿主机目录时，确保该用户有读写权限。配置文件可挂载到 `/app/appsettings.json`。

镜像内置健康检查：每 30 秒使用当前端口和凭据请求服务，单次超时 5 秒，启动宽限期 10 秒，连续失败 3 次标记为 `unhealthy`。也可运行 `docker exec syncclipboard-server bun index.js --healthcheck` 手动检查；HTTP 和 HTTPS 均支持。

PR 和 master 提交会执行类型、格式、测试、独立 bundle 和容器验收；同一 PR 或分支的新运行会取消旧运行，各任务设有超时。容器验收包含非 root 用户、鉴权、附件读写、退出和重建容器后的数据卷持久化。

推送 `v*` 标签时，发布工作流依次排队执行，先打包并生成 SHA-256 校验文件，再分别验收 amd64/arm64 镜像。构建包上传到草稿 Release 后才推送 `ghcr.io/<仓库所有者>/<仓库名>` 镜像，最后公开 Release。失败重跑会继续更新草稿；已公开的版本会跳过附件和镜像发布。

## 配置

复制 `appsettings.example.json` 为 `appsettings.json`，保留原服务端的字段和 JSON 注释/末尾逗号写法：

```json
{
  "Kestrel": { "Endpoints": { "http": { "Url": "http://0.0.0.0:5033" } } },
  "AppSettings": {
    "UserName": "myuser",
    "Password": "mypassword",
    "MaxSavedHistoryCount": 1000,
    "HistoryRetentionMinutes": 0
  }
}
```

| 环境变量 | 用途 / 默认值 |
| --- | --- |
| `SYNCCLIPBOARD_USERNAME`、`SYNCCLIPBOARD_PASSWORD` | 两者同时非空时覆盖文件中的凭据 |
| `AppSettings__UserName`、`AppSettings__Password` | 单独覆盖对应配置字段 |
| `HOST`、`PORT` | 覆盖监听地址和端口；默认 `0.0.0.0:5033` |
| `ASPNETCORE_URLS` | 兼容原配置，指定单个 HTTP/HTTPS URL |
| `SYNCCLIPBOARD_CONFIG` | 配置文件路径；默认 `appsettings.json` |
| `SYNCCLIPBOARD_DATA_DIR` | 数据根目录；默认 `server/` |
| `AppSettings__MaxSavedHistoryCount` | 最大未删除记录数；默认 `1000`，`0` 不限数量 |
| `AppSettings__HistoryRetentionMinutes` | 保留分钟数；默认 `0`，不限时间 |
| `SYNCCLIPBOARD_MAX_BODY_BYTES` | 单次请求最大字节数；默认 `2147483647` |
| `SYNCCLIPBOARD_MAX_EXTRACTED_BYTES` | ZIP 解压总字节限制；默认 `2147483647` |
| `SYNCCLIPBOARD_MAX_ARCHIVE_ENTRIES` | ZIP 条目上限；默认 `100000` |
| `SYNCCLIPBOARD_SWAGGER` | `true` 启用 `/swagger` 和 `/openapi.json` |
| `SYNCCLIPBOARD_TLS_CERT`、`SYNCCLIPBOARD_TLS_KEY` | HTTPS 的 PEM 证书和私钥路径 |

命令行 `--port`、`--host`、`--data-dir`、`--config`、`--urls` 优先于环境变量。配置修改后重启服务。HTTPS 也支持原来的 `Kestrel.Certificates.Default.Path` / `KeyPath`；可通过反向代理终止 TLS。`NODE_ENV=development` 或 `ASPNETCORE_ENVIRONMENT=Development` 也会启用 Swagger。

数量和时间限制独立生效。星标和置顶记录受到保护；超过数量时按最后访问/修改时间中较新的时间清理。删除记录保留为 tombstone 用于同步，30 天后移除。数量/保留时间每 10 分钟处理，过期 tombstone 和孤立目录每 12 小时处理，启动时也会运行清理。

## 从原 .NET 服务端迁移

1. 停止原服务端，备份完整的 `server/` 目录和配置文件。
2. 将整个 `server/` 目录放到新服务的工作目录下，或通过 `SYNCCLIPBOARD_DATA_DIR` 指定其位置。
3. 保留原来的 `appsettings.json`，使用 Bun 启动。原端口、账号密码和保留配置可继续使用。

兼容 `server/data/history.db` 的原 EF Core 表结构，包括尚未添加 `TransferDataHash` 的数据库；首次启动自动补充该列和查询索引。旧字段、历史元数据及附件相对路径会保留，原 PascalCase 格式的 `SyncClipboard.json` 也可读取。一个数据目录只运行一个服务端实例。

## 协议

| 方法与路径 | 功能 |
| --- | --- |
| `GET /`，`PROPFIND /` | 状态检查、WebDAV 兼容 |
| `GET /api/time`、`GET /api/version` | 服务端时间、协议版本 |
| `GET/PUT /SyncClipboard.json` | 获取/发布当前剪贴板 |
| `PROPFIND/MKCOL/DELETE /file` | 暂存附件目录操作 |
| `PUT /file/{name}` | 暂存附件 |
| `GET/HEAD /file/{name}` | 读取已关联历史记录的最近附件 |
| `POST /api/history` | multipart 历史上传，返回服务端接受的记录 |
| `POST /api/history/query` | 表单查询，每页 50 条，包含删除标记 |
| `GET /api/history/{Type-Hash}` | 历史元数据 |
| `GET /api/history/{Type-Hash}/data` | 下载校验过的附件 |
| `PATCH /api/history/{type}/{hash}` | 更新星标、置顶、删除和版本状态 |
| `GET /api/history/statistics` | 记录数与附件占用 |
| `DELETE /api/history/clear` | 清空历史及附件 |
| `/SyncClipboardHub` | SignalR JSON v1，支持 WebSocket / SSE / Long Polling |

JSON 输出使用 camelCase，输入字段大小写不敏感。Profile 类型为 `Text`、`File`、`Image`、`Group`；`hash` 是内容身份，附件字节 SHA-256 单独通过 `transferDataHash` 或 `X-SyncClipboard-Transfer-Data-Hash` 传递。[哈希算法](docs/Hash.md)保持与原实现一致。

历史上传字段：`type`、`hash`、`text`、`size`、`createTime`、`lastModified`、`lastAccessed`、`starred`、`pinned`、`version`、`isDeleted`、`hasData`，可选二进制 `data`。建议按原协议将 `data` 放在最后。`File` / `Image` 的 `text` 是文件名；长文本的 `text` 是摘要，`size` 为完整文本的 UTF-16 长度。

历史查询支持 `page`、`before`（不含）、`after`（包含）、`modifiedAfter`（包含）、`types`、`searchText`、`starred`、`sortByLastAccessed`。`types` 接受类型名称、逗号分隔标志或 0–15 数字掩码。PATCH 使用 `isDelete`；时间相差不超过 5 分钟时比较版本，否则比较时间。冲突返回 `409` 和服务端状态。

上传会验证附件字节和内容身份；Group ZIP 还会校验内部路径与文件内容。历史附件无效返回 `422`，错误码 `history_data_invalid`。下载时会重新检查字节哈希；Group 压缩包损坏或丢失时，可从有效的解压文件重建。实时事件为 `RemoteProfileChanged` 和 `RemoteHistoryChanged`。

## 开发与测试

```sh
bun run dev
bun run check
bun run build
bun run test:bundle
docker build -t syncclipboard-server:test .
SYNCCLIPBOARD_TEST_DOCKER_IMAGE=syncclipboard-server:test bun run test:docker
```

测试使用真实 HTTP 服务、官方 Microsoft SignalR 客户端和临时 SQLite 数据库，覆盖协议、哈希、上传中断、附件恢复、冲突、保留清理和旧数据迁移。SignalR 还覆盖畸形消息、字节超限、超时、长轮询取消和服务重启后的自动重连。测试需要允许监听本机临时端口；容器测试默认跳过，设置镜像变量后必须能访问 Docker 引擎。发布准备脚本的回归测试使用模拟 GitHub CLI，不操作真实 Release，并在 Windows 上跳过。

服务端迁移范围与原测试对应关系见 [迁移说明](docs/ai_design/bun-server-migration.md)。项目沿用 MIT 许可证；打包依赖的许可证保存在 `LICENSES/`。

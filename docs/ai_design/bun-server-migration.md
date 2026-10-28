# Bun 服务端迁移说明

## 范围与实现

此仓库从包含桌面端的 .NET 解决方案改为单一 Bun + TypeScript 服务端。保留独立服务端业务协议、数据和测试场景，移除 Avalonia、WinUI3、桌面核心服务、平台集成、客户端测试、客户端脚本和安装/发布资源。

| 原服务端组成 | 新实现 |
| --- | --- |
| Program / Web / AppSettings / CredentialChecker / BasicAuthenticationHandler | `src/index.ts`, `src/config.ts`, `src/server.ts` |
| SyncClipboardController | `src/server.ts`, `src/history.ts` |
| HistoryController / HistoryService / HistoryHelper | `src/history.ts`, `src/multipart.ts`, `src/models.ts` |
| HistoryDbContext / EF migrations | `src/database.ts`，保留原表结构和历史数据 |
| HistoryCleaner / HistoryManagerHelper | `HistoryService.cleanup()` 和启动/定时调度 |
| SyncClipboardHub | `src/signalr.ts`，JSON v1 和三种原传输方式 |
| 服务端使用的 Profile / Text / File / Image / Group 逻辑 | `src/profiles.ts`, `src/archive.ts`, `src/files.ts` |
| Swagger filters / UI | `src/openapi.ts`, `src/swagger.ts`，本地资源 |
| 独立服务端 Docker/发布 | 根目录 Dockerfile、Compose 和 `.github/workflows/` |

协议保持 `3.3.3`，避免已有连接端的版本协商因运行时重写而失效。无多用户业务扩展：继续使用 `default_user`。不保留只服务于桌面程序的内置服务端启动器、UI、图片预览和剪贴板操作。

## 数据与一致性

继续使用 `server/data/history.db`、`history/Type_HASH/`、`file/`、`SyncClipboard.json`，增加 `tmp/` 用于上传校验。原 EF 初始化 schema 和新增 transfer hash 的两种版本均有兼容测试，保留未使用的原字段和 EF migration 元数据。

数据库写入、历史附件发布与清理使用同一互斥队列。上传先流式写暂存文件，再计算字节哈希、验证内容身份，Group 解压到唯一目录；失败清理自己的暂存数据，不触碰已有解压目录。发布后才写元数据并通知。数据库和文件系统并非一个跨介质事务；运行时中断产生的孤立历史目录由清理任务处理。部署必须一个数据目录对应一个服务实例。

Group 计算采用实际 `GroupEntry.ToEntryStringAsync` 的 `D|name/\0` / `F|name|size|SHA256\0` 格式。旧 GroupProfile 内的简述注释省略了这些前缀和分隔符；移植以实际实现和 `docs/Hash.md` 为准，并通过固定哈希向量锁定协议。

## 测试迁移对应

| 原测试/需求 | Bun 测试 |
| --- | --- |
| HistoryTransferDataHashTests 中服务端上传、当前记录、校验、下载、删除恢复测试 | `test/history.test.ts`, `test/http.test.ts` |
| UtilitySHA256Tests 的有效性、大小写、缺失值、内容不匹配 | `test/config.test.ts`, `test/history.test.ts` |
| ProfileDtoTransferDataHashTests 的 DTO/响应兼容行为 | `test/http.test.ts`, `test/history.test.ts` |
| ProfileTransferValidationTests / PrepareTransferDataInfoTests / SetTransferDataInfoTests 的服务端校验与持久化行为 | `test/history.test.ts`, `test/http.test.ts` |
| GroupProfileTransferTests：目录/零字节文件、损坏与缺失 ZIP、源文件缺失或改变、恢复、空包、独立解压目录 | `test/archive.test.ts`, `test/history.test.ts` |
| GroupProfileExtractionTests：内部和外部 dot path 拒绝 | `test/archive.test.ts`，并增加重复路径、符号链接和资源限制 |
| ProfileWorkingDirectoryTests 的路径安全要求 | `test/http.test.ts`, `test/archive.test.ts` |
| HistoryRetentionTests 中服务端也需满足的时间/数量和保护规则 | `test/retention.test.ts`，不迁移客户端上传调度断言 |
| 共享 HistoryManagerHelper 保留与排序规则、服务器 tombstone/orphan 清理 | `test/retention.test.ts` |
| 旧 EF 数据库兼容和继续写入 | `test/migration.test.ts` + 原初始化 schema fixture |
| 新运行时 HTTP/Basic/WebDAV、长文本、并发、查询、重启 | `test/http.test.ts`, `test/history.test.ts` |
| SignalR 协商、握手、广播、重连、WebSocket/SSE/LongPolling | `test/signalr.test.ts`，使用官方 `@microsoft/signalr` 客户端 |
| 流式上传失败/取消，Swagger 本地资源 | `test/streaming.test.ts` |
| CLI 参数、进程退出、脱离 node_modules 的单文件构建包 | `test/cli.test.ts`；`bun run test:bundle` 将构建包复制到独立临时目录运行 |

客户端历史导入导出、显示/分页 ViewModel、下载队列、S3/WebDAV 远端适配器、系统热键、通知、剪贴板、更新安装和平台 UI 的测试随对应客户端实现删除。纯内部对象复制/延迟加载断言没有逐行复制；服务端实际依赖的行为通过 HTTP 和持久化回归验证。

## 验证命令

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun run test:bundle
docker build -t syncclipboard-server .
```

本次本地验证：84 个测试通过、0 失败；类型检查、Prettier、冻结 lockfile 安装、构建包独立启动/退出、Compose 配置校验和 `git diff --check` 均通过。测试包含超过 30 秒的长轮询保活验证。未运行 Docker 镜像构建：当前环境无法访问 Docker socket，非交互 sudo 也不可用；CI 中保留镜像构建检查。

## 实现依据

- [Bun HTTP server](https://bun.sh/docs/runtime/http/server)
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite)
- [Microsoft SignalR Hub Protocol](https://github.com/dotnet/aspnetcore/blob/main/src/SignalR/docs/specs/HubProtocol.md)
- [Microsoft SignalR Transport Protocols](https://github.com/dotnet/aspnetcore/blob/main/src/SignalR/docs/specs/TransportProtocols.md)
- [Busboy streaming multipart parser](https://github.com/mscdex/busboy)
- [yauzl ZIP reader](https://github.com/thejoshwolfe/yauzl) / [yazl ZIP writer](https://github.com/thejoshwolfe/yazl)

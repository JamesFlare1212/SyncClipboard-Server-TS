# SyncClipboard Server

[中文](README.md)

A standalone **Bun + TypeScript** SyncClipboard server with HTTP/WebDAV-compatible clipboard synchronization, SignalR notifications, SQLite history, and attachment storage. This repository contains only the server.

## Run

Requires Bun 1.4.4 or newer:

```sh
bun install --frozen-lockfile
SYNCCLIPBOARD_USERNAME=myuser SYNCCLIPBOARD_PASSWORD=mypassword bun start
```

The default endpoint is `http://0.0.0.0:5033`, and the data directory is `server/` under the working directory. Every endpoint requires Basic authentication. Unconfigured credentials default to `admin` / `admin`; set your own credentials through environment variables or configuration.

```sh
bun start --port 5033 --host 127.0.0.1 --data-dir ./server
bun run build
bun dist/index.js --data-dir ./server
```

The JavaScript bundle includes runtime dependencies and local Swagger UI assets. Copy it to a machine with Bun to run it without installing npm packages. Logs use stdout/stderr; SIGINT and SIGTERM stop the server and close SQLite.

## Docker

```sh
docker build -t syncclipboard-server .
docker run -d --name syncclipboard-server \
  -p 5033:5033 \
  -e SYNCCLIPBOARD_USERNAME=myuser \
  -e SYNCCLIPBOARD_PASSWORD=mypassword \
  -v syncclipboard-data:/app/server \
  --restart unless-stopped syncclipboard-server
```

Alternatively, set the two credential variables and run `docker compose up -d --build`. The container runs as the `bun` user; existing bind-mounted data must be writable by that user. Mount configuration at `/app/appsettings.json`.

Pull requests and master pushes check types, formatting, tests, isolated bundles, and running containers. New runs cancel older runs for the same PR or branch, and jobs have timeouts. Container acceptance covers non-root execution, authentication, attachment transfers, graceful exit, and volume persistence across container recreation.

Pushing a `v*` tag queues a release run. It packages the bundle and SHA-256 checksum, tests both amd64 and arm64 containers, uploads assets to a draft Release, pushes images to `ghcr.io/<owner>/<repository>`, and finally publishes the Release. Failed runs can resume an existing draft; already published releases skip asset and image publication.

## Configuration

Copy `appsettings.example.json` to `appsettings.json`. The original `AppSettings.UserName`, `Password`, `MaxSavedHistoryCount`, `HistoryRetentionMinutes`, and `Kestrel.Endpoints.<name>.Url` fields are supported, including JSON comments and trailing commas.

| Environment variable | Purpose / default |
| --- | --- |
| `SYNCCLIPBOARD_USERNAME`, `SYNCCLIPBOARD_PASSWORD` | Override credentials when both are nonempty |
| `AppSettings__UserName`, `AppSettings__Password` | Override individual configuration fields |
| `HOST`, `PORT` | Listen address/port; default `0.0.0.0:5033` |
| `ASPNETCORE_URLS` | Legacy single HTTP/HTTPS endpoint URL |
| `SYNCCLIPBOARD_CONFIG` | Configuration file; default `appsettings.json` |
| `SYNCCLIPBOARD_DATA_DIR` | Data directory; default `server/` |
| `AppSettings__MaxSavedHistoryCount` | Active record limit; default `1000`, `0` means unlimited |
| `AppSettings__HistoryRetentionMinutes` | Retention duration; default `0` means unlimited |
| `SYNCCLIPBOARD_MAX_BODY_BYTES` | Request byte limit; default `2147483647` |
| `SYNCCLIPBOARD_MAX_EXTRACTED_BYTES` | ZIP expanded byte limit; default `2147483647` |
| `SYNCCLIPBOARD_MAX_ARCHIVE_ENTRIES` | ZIP entry limit; default `100000` |
| `SYNCCLIPBOARD_SWAGGER` | `true` enables `/swagger` and `/openapi.json` |
| `SYNCCLIPBOARD_TLS_CERT`, `SYNCCLIPBOARD_TLS_KEY` | HTTPS PEM certificate and private key paths |

CLI options `--port`, `--host`, `--data-dir`, `--config`, and `--urls` take precedence. Restart after changing configuration. HTTPS also accepts the original `Kestrel.Certificates.Default.Path` and `KeyPath` settings. TLS can instead terminate at a reverse proxy. `NODE_ENV=development` and `ASPNETCORE_ENVIRONMENT=Development` also enable Swagger.

Count and time retention limits apply independently. Starred and pinned records are protected. Count cleanup orders records by the later of their access and modification timestamps. Deleted records remain as synchronization tombstones for 30 days. Retention runs every 10 minutes; expired tombstone and orphan cleanup runs every 12 hours. Cleanup also runs at startup.

## Migrate existing server data

1. Stop the .NET server and back up its complete `server/` directory and configuration.
2. Copy the directory to the new working directory, or point `SYNCCLIPBOARD_DATA_DIR` at it.
3. Keep the existing `appsettings.json` and start the Bun server.

The original EF Core `server/data/history.db` schema is supported, including databases predating `TransferDataHash`. Startup adds the missing column and lookup indexes. Existing fields, metadata, and relative attachment paths are retained. PascalCase `SyncClipboard.json` files remain readable. Run one server instance per data directory.

## API

| Method and path | Purpose |
| --- | --- |
| `GET /`, `PROPFIND /` | Status and WebDAV compatibility |
| `GET /api/time`, `GET /api/version` | Server time and protocol version |
| `GET/PUT /SyncClipboard.json` | Read/publish current clipboard |
| `PROPFIND/MKCOL/DELETE /file` | Manage staging directory |
| `PUT /file/{name}` | Stage an attachment |
| `GET/HEAD /file/{name}` | Retrieve the most recently used committed attachment |
| `POST /api/history` | Multipart history upload; returns accepted metadata |
| `POST /api/history/query` | Form query, 50 records per page, including tombstones |
| `GET /api/history/{Type-Hash}` | History metadata |
| `GET /api/history/{Type-Hash}/data` | Verified attachment download |
| `PATCH /api/history/{type}/{hash}` | Update starred, pinned, deletion and version state |
| `GET /api/history/statistics` | Counts and attachment disk usage |
| `DELETE /api/history/clear` | Clear history and attachments |
| `/SyncClipboardHub` | SignalR JSON v1 over WebSocket, SSE or Long Polling |

JSON responses use camelCase; input property names are case insensitive. Types are `Text`, `File`, `Image`, and `Group`. Profile identity hashes differ from transfer byte hashes. Transfer SHA-256 uses `transferDataHash` on current profiles and `X-SyncClipboard-Transfer-Data-Hash` on history upload/download. History metadata does not bind a local transfer hash. The original [hash algorithm](docs/Hash.md) is preserved.

History multipart fields: `type`, `hash`, `text`, `size`, `createTime`, `lastModified`, `lastAccessed`, `starred`, `pinned`, `version`, `isDeleted`, `hasData`, and optional binary `data`. Send `data` last for original protocol compatibility. File/Image `text` is the filename; long-text `text` is a preview and `size` counts UTF-16 code units in the full text.

Queries support `page`, exclusive `before`, inclusive `after`/`modifiedAfter`, `types`, `searchText`, `starred`, and `sortByLastAccessed`. Type filters accept names, comma-separated flags, or numeric masks 0–15. PATCH uses `isDelete`. Within five minutes, conflict resolution compares versions; outside that interval, it compares timestamps. Conflicts return `409` with server state.

Uploads validate both transfer bytes and semantic identity, including ZIP paths and contents. Invalid history attachments return `422` with `code: history_data_invalid`. Downloads recheck transfer bytes; missing or corrupt Group archives can be regenerated from verified extracted files. The notification events are `RemoteProfileChanged` and `RemoteHistoryChanged`.

## Development

```sh
bun run dev
bun run check
bun run build
bun run test:bundle
docker build -t syncclipboard-server:test .
SYNCCLIPBOARD_TEST_DOCKER_IMAGE=syncclipboard-server:test bun run test:docker
```

Tests exercise real HTTP listeners, the official Microsoft SignalR client, and temporary SQLite databases. They cover hashes, uploads, cancellation, recovery, conflicts, retention, and legacy data migration. SignalR also covers malformed messages, byte limits, timeouts, polling cancellation, and automatic reconnection after a server restart. Local ephemeral ports must be available. Container tests are skipped unless the image variable is set, then require access to Docker. Release preparation tests use a simulated GitHub CLI without changing real releases and skip Windows.

See the [migration and test mapping](docs/ai_design/bun-server-migration.md). The project retains its MIT license; bundled dependency licenses are in `LICENSES/`.

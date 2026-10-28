# AGENTS.md

## Project

SyncClipboard Server is a server-only Bun + TypeScript application. It implements the existing SyncClipboard HTTP/WebDAV-compatible API, SignalR JSON protocol (WebSocket, SSE, long polling), and SQLite history storage. There are no desktop clients or .NET projects in this repository.

## Commands

Run from the repository root with Bun 1.4.4 or newer:

```sh
bun install --frozen-lockfile
bun start
bun run dev
bun run typecheck
bun test
bun test test/history.test.ts
bun run format
bun run format:check
bun run check
bun run build
bun run test:bundle
docker build -t syncclipboard-server .
```

Tests use temporary directories and ephemeral loopback ports. The build outputs a self-contained JavaScript bundle at `dist/index.js`, run with `bun dist/index.js`.

## Architecture

- `src/index.ts`: command-line entrypoint and lifecycle.
- `src/server.ts`: Basic authentication, HTTP routes, response serialization.
- `src/signalr.ts`: negotiation, JSON framing, transports, keepalive, broadcasts.
- `src/history.ts`: history conflicts, current profile, retention, cleanup and notifications.
- `src/database.ts`: `bun:sqlite`, original EF schema compatibility, parameterized queries.
- `src/profiles.ts`, `src/archive.ts`, `src/files.ts`: profile/transfer hashes, streaming file handling, ZIP validation and regeneration, safe paths.
- `src/multipart.ts`, `src/models.ts`: wire parsing and DTOs.
- `src/config.ts`: JSONC appsettings and environment configuration.
- `src/openapi.ts`, `src/swagger.ts`: optional local interactive API documentation.

The default data root is `server/`: `data/history.db`, `history/Type_HASH/`, `file/`, `tmp/`, and `SyncClipboard.json`. Preserve existing on-disk formats and protocol behavior. History uses the original `default_user` identity. API JSON uses camelCase; incoming JSON is case insensitive and legacy PascalCase current-profile files remain readable.

## Conventions

- Use strict TypeScript and Bun built-ins for HTTP, WebSocket, SQLite, and tests.
- Keep requests and archive contents streaming; do not buffer whole attachments in memory.
- Validate transfer SHA-256 and profile semantic identity before publishing files or notifying clients.
- Group hashes use UTF-8 byte ordering and `D|name/\0` / `F|name|size|SHA256\0` entries. See `docs/Hash.md`.
- Serialize mutations and cleanup through the history mutex. Use parameterized SQL.
- Do not expose unverified transfer hashes through history metadata; use the download response header.
- Keep dependencies in `package.json` and commit the Bun lockfile when dependencies change.
- Prettier defines TypeScript/JSON/YAML formatting with roughly 120 columns. Keep control-statement bodies on their own line.
- Commit messages use conventional prefixes and Chinese descriptions, e.g. `fix: 修复历史记录清理`.

## Tests

- Tests should validate functional requirements, significant failure paths, or confirmed defects.
- Prefer public HTTP behavior and official SignalR client interoperability over implementation-only assertions.
- When removing a mechanism, remove obsolete assertions instead of testing that the old mechanism is absent.
- Do not turn an unspecified behavior into a guarantee of its opposite.
- Preserve useful assertions when simplifying mixed-purpose tests.
- Platform-specific tests must explicitly skip unsupported environments. Most server tests should be platform independent.
- Existing .NET behavior and the migration coverage mapping are recorded in `docs/ai_design/bun-server-migration.md`.

## Git and documentation

- Never push to remote `master`, including force pushes.
- “提交到 master” authorizes merging into local `master` only, not a remote push.
- Store AI-generated or AI-maintained design documents in `docs/ai_design/`.
- Keep `AGENTS.md` and `CLAUDE.md` synchronized.

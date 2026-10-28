import { timingSafeEqual } from "node:crypto";
import { createReadStream, openSync, fstatSync, closeSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import type { Config } from "./config";
import { HttpError, TransferError } from "./errors";
import { receiveFile, safeName, safePath } from "./files";
import { HistoryService } from "./history";
import { historyMetadata, historyQuery, historyUpdate, readMultipart } from "./multipart";
import { normalizeHash, parseProfile, parseProfileId, parseType, toHistoryDto, transferHashHeader } from "./models";
import { SignalRHub, type SocketData } from "./signalr";
import { version } from "../package.json";
import { openApi } from "./openapi";
import { swaggerResponse } from "./swagger";

function authorized(request: Request, config: Config): boolean {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) {
    return false;
  }
  const credentials = Buffer.from(match[1]!, "base64");
  const expected = Buffer.from(`${config.username}:${config.password}`, "utf8");
  return credentials.length === expected.length && timingSafeEqual(credentials, expected);
}

function fileResponse(path: string, head: boolean, attachment = false, hash?: string): Response {
  const fd = openSync(path, "r");
  const headers = new Headers({
    "content-type": Bun.file(path).type || "application/octet-stream",
    "content-length": String(fstatSync(fd).size),
  });
  if (hash) {
    headers.set(transferHashHeader, hash);
  }
  if (attachment) {
    headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`);
  }
  if (head) {
    closeSync(fd);
    return new Response(null, { headers });
  }
  return new Response(Readable.toWeb(createReadStream(path, { fd, autoClose: true })) as unknown as ReadableStream, {
    headers,
  });
}

export function createServer(config: Config, options: { cleanup?: boolean } = {}) {
  const hub = new SignalRHub();
  const history = new HistoryService(config, (event, value) => hub.broadcast(event, value));
  let closing = false;
  let activeRequests = 0;
  let drained: (() => void) | undefined;
  const server = Bun.serve<SocketData>({
    hostname: config.hostname,
    port: config.port,
    maxRequestBodySize: config.maxBodyBytes,
    idleTimeout: 60,
    ...(config.tls ? { tls: { cert: Bun.file(config.tls.cert), key: Bun.file(config.tls.key) } } : {}),
    websocket: hub.websocket,
    async fetch(request, server) {
      activeRequests++;
      try {
        if (!authorized(request, config)) {
          return new Response(null, { status: 401, headers: { "www-authenticate": 'Basic realm="SyncClipboard"' } });
        }
        if (closing) {
          return new Response(null, { status: 503 });
        }
        const url = new URL(request.url);
        let path: string;
        try {
          path = decodeURIComponent(url.pathname).replace(/\/$/, "") || "/";
        } catch {
          throw new HttpError(400, "Invalid URL encoding.");
        }
        const route = path.toLowerCase();
        const method = request.method;
        const ok = () => new Response(null, { status: 200 });
        if (route === "/syncclipboardhub" || route === "/syncclipboardhub/negotiate") {
          return await hub.handle(request, server);
        }
        if (route === "/" && method === "GET") {
          return new Response("Server is running.");
        }
        if (route === "/" && method === "PROPFIND") {
          return ok();
        }
        if (route === "/api/time" && method === "GET") {
          return Response.json(new Date().toISOString());
        }
        if (route === "/api/version" && method === "GET") {
          return new Response(version);
        }
        if (config.swagger && (route === "/swagger/v1/swagger.json" || route === "/openapi.json") && method === "GET") {
          return Response.json(openApi);
        }
        if (config.swagger && method === "GET") {
          const response = swaggerResponse(route);
          if (response) {
            return response;
          }
        }
        if (route === "/file") {
          if (["PROPFIND", "MKCOL"].includes(method)) {
            await mkdir(join(config.dataDir, "file"), { recursive: true });
            return ok();
          }
          if (method === "DELETE") {
            await history.mutex.run(() => rm(join(config.dataDir, "file"), { recursive: true, force: true }));
            return ok();
          }
        }
        if (route.startsWith("/file/")) {
          const name = safeName(path.slice(6));
          if (method === "PUT") {
            await history.mutex.run(
              () => receiveFile(request, safePath(join(config.dataDir, "file"), name), config.maxBodyBytes),
              request.signal,
            );
            return ok();
          }
          if (method === "GET" || method === "HEAD") {
            return (
              (await history.recentFile(name, (path) => fileResponse(path, method === "HEAD"))) ??
              new Response(null, { status: 404 })
            );
          }
        }
        if (route === "/syncclipboard.json") {
          if (method === "GET") {
            return Response.json(await history.currentProfile());
          }
          if (method === "PUT") {
            await history.setCurrent(parseProfile(await request.json()), request.signal);
            return ok();
          }
        }
        if (route === "/api/history" && method === "POST") {
          const header = request.headers.get(transferHashHeader);
          const hash = normalizeHash(header);
          if (header !== null && !hash) {
            throw new HttpError(400, `${transferHashHeader} cannot be empty`);
          }
          const upload = await readMultipart(request, history.profiles.temp, config.maxBodyBytes);
          try {
            if (hash && !upload.path) {
              throw new HttpError(400, `${transferHashHeader} cannot be set without transfer data`);
            }
            return Response.json(await history.add(historyMetadata(upload.fields), upload.path, hash, request.signal));
          } finally {
            await upload.cleanup();
          }
        }
        if (route === "/api/history/query" && method === "POST") {
          const fields = Object.fromEntries(
            [...(await request.formData()).entries()].map(([key, value]) => [key.toLowerCase(), String(value)]),
          );
          return Response.json(history.query(historyQuery(fields)));
        }
        if (route === "/api/history/statistics" && method === "GET") {
          return Response.json(history.statistics());
        }
        if (route === "/api/history/clear" && method === "DELETE") {
          return Response.json({ deleted: await history.clear(request.signal) });
        }
        const dataMatch = /^\/api\/history\/([^/]+)\/data$/i.exec(path);
        if (dataMatch && method === "GET") {
          let identity: ReturnType<typeof parseProfileId>;
          try {
            identity = parseProfileId(dataMatch[1]!);
          } catch {
            return new Response(null, { status: 404 });
          }
          return (
            (await history.transfer(
              ...identity,
              (data) => fileResponse(data.path, false, true, data.hash),
              request.signal,
            )) ?? new Response(null, { status: 404 })
          );
        }
        const updateMatch = /^\/api\/history\/([^/]+)\/([^/]+)$/i.exec(path);
        if (updateMatch && method === "PATCH") {
          const type = parseType(updateMatch[1]);
          const hash = normalizeHash(updateMatch[2])!;
          return await history.update(type, hash, historyUpdate(await request.json()), request.signal);
        }
        const recordMatch = /^\/api\/history\/([^/]+)$/i.exec(path);
        if (recordMatch && method === "GET") {
          const record = history.database.get(...parseProfileId(recordMatch[1]!));
          return record ? Response.json(toHistoryDto(record)) : new Response(null, { status: 404 });
        }
        return new Response(null, { status: 404 });
      } catch (error) {
        if (error instanceof TransferError) {
          return Response.json(
            {
              status: 422,
              title: "History transfer data is invalid",
              detail: error.message,
              code: "history_data_invalid",
            },
            { status: 422, headers: { "content-type": "application/problem+json" } },
          );
        }
        if (error instanceof HttpError) {
          return new Response(error.message, { status: error.status });
        }
        if (error instanceof SyntaxError || error instanceof TypeError) {
          return new Response("Invalid request.", { status: 400 });
        }
        if (request.signal.aborted) {
          return new Response(null, { status: 499 });
        }
        console.error("Request failed:", error);
        return new Response("Internal server error.", { status: 500 });
      } finally {
        if (--activeRequests === 0) {
          drained?.();
        }
      }
    },
  });
  let cleanup: Promise<void> = Promise.resolve();
  let tickCount = 0;
  const runCleanup = () => {
    cleanup = cleanup
      .then(() => history.cleanup(Date.now(), tickCount++ % 72 === 0))
      .catch((error: unknown) => {
        console.error("History cleanup failed:", error);
      });
  };
  const timer = options.cleanup === false ? undefined : setInterval(runCleanup, 10 * 60_000);
  timer?.unref();
  if (options.cleanup !== false) {
    runCleanup();
  }
  return {
    server,
    history,
    hub,
    url: server.url.toString().replace(/\/$/, ""),
    async stop() {
      if (closing) {
        return;
      }
      closing = true;
      clearInterval(timer);
      hub.stop();
      await server.stop(true);
      if (activeRequests) {
        await new Promise<void>((resolve) => {
          drained = resolve;
        });
      }
      await cleanup;
      await history.mutex.run(async () => {
        history.database.close();
      });
    },
  };
}

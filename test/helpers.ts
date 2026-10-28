import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ZipFile } from "yazl";
import { loadConfig, type Config } from "../src/config";
import { createServer } from "../src/server";
import { sha256 } from "../src/files";
import type { HistoryDto } from "../src/models";

export const auth = `Basic ${Buffer.from("test:pass:word").toString("base64")}`;

export async function fixture(overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), "syncclipboard-test-"));
  const config: Config = {
    ...loadConfig(root, {}),
    hostname: "127.0.0.1",
    port: 0,
    username: "test",
    password: "pass:word",
    maxHistoryCount: 0,
    ...overrides,
  };
  const app = createServer(config, { cleanup: false });
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("authorization")) {
      headers.set("authorization", auth);
    }
    return fetch(`${app.url}${path}`, { ...init, headers });
  };
  const json = (path: string, method: string, value: unknown) =>
    request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const upload = (metadata: Partial<HistoryDto>, data?: Uint8Array | string, headers?: HeadersInit) => {
    const dto = { ...textHistory("hello"), ...metadata };
    const form = new FormData();
    for (const [key, value] of Object.entries(dto)) {
      form.set(key, String(value));
    }
    if (data !== undefined) {
      form.set("data", new Blob([data as BlobPart]), "upload.bin");
    }
    return request("/api/history", { method: "POST", body: form, headers });
  };
  const query = (fields: Record<string, string | number | boolean> = {}) =>
    request("/api/history/query", {
      method: "POST",
      body: new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)])),
    });
  return {
    ...app,
    config,
    root,
    request,
    json,
    upload,
    query,
    async [Symbol.asyncDispose]() {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function textHistory(text: string, overrides: Partial<HistoryDto> = {}): HistoryDto {
  const now = new Date().toISOString();
  return {
    hash: sha256(text),
    text,
    type: "Text",
    size: text.length,
    hasData: false,
    createTime: now,
    lastAccessed: now,
    lastModified: now,
    starred: false,
    pinned: false,
    version: 0,
    isDeleted: false,
    ...overrides,
  };
}

// Independent wire fixtures implement the documented .NET hash recipe, not the server's archive helpers.
export async function groupFixture(files: Record<string, string>, comment?: string) {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith("/")) {
      zip.addEmptyDirectory(name);
    } else {
      zip.addBuffer(Buffer.from(content), name);
    }
  }
  zip.end(comment ? { comment, forceZip64Format: false } : undefined);
  const bytes = new Uint8Array(await done);
  const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex").toUpperCase();
  const lines = Object.entries(files)
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([name, content]) =>
      name.endsWith("/") ? `D|${name}\0` : `F|${name}|${Buffer.byteLength(content)}|${digest(content)}\0`,
    );
  return {
    bytes,
    hash: digest(lines.join("")),
    transferHash: digest(bytes),
    size: Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0),
  };
}

export async function write(path: string, data: string | Uint8Array) {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, data);
}

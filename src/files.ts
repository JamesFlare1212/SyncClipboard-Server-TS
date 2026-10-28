import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { checkAbort, HttpError } from "./errors";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) {
    hash.update(chunk);
  }
  return hash.digest("hex").toUpperCase();
}

export async function textFileLength(path: string, signal?: AbortSignal): Promise<number> {
  const decoder = new TextDecoder("utf-8");
  let length = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    length += decoder.decode(chunk, { stream: true }).length;
  }
  return length + decoder.decode().length;
}

export function fileProfileHash(name: string, contentHash: string): string {
  return sha256(`${name}|${contentHash.toUpperCase()}`);
}

export function safeName(name: string): string {
  if (!name || name === "." || name === ".." || /[/\\\x00-\x1f:]/.test(name) || basename(name) !== name) {
    throw new HttpError(400, "Invalid file name.");
  }
  return name;
}

// Reject symlinks at every existing component so stored paths cannot escape their data root.
export function safePath(root: string, stored: string): string {
  const path = resolve(root, stored.replaceAll("\\", "/"));
  const rel = relative(resolve(root), path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HttpError(400, "Invalid storage path.");
  }
  let current = resolve(root);
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new HttpError(400, "Symbolic links are not supported in stored data.");
    }
  }
  return path;
}

export async function atomicWrite(path: string, value: string | Uint8Array, signal?: AbortSignal): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    checkAbort(signal);
    await Bun.write(temp, value);
    checkAbort(signal);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function receiveFile(request: Request, path: string, limit: number): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    let size = 0;
    const source = request.body ? Readable.fromWeb(request.body as never) : Readable.from([]);
    await pipeline(
      source,
      async function* (chunks) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > limit) {
            throw new HttpError(413, "Request body is too large.");
          }
          yield chunk;
        }
      },
      createWriteStream(temp, { flags: "wx" }),
      { signal: request.signal },
    );
    checkAbort(request.signal);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      checkAbort(signal);
      return await action();
    } finally {
      release();
    }
  }
}

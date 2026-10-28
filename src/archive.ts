import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import * as yazl from "yazl";
import type { Config } from "./config";
import { checkAbort, TransferError } from "./errors";
import { hashFile, safeName, safePath } from "./files";

interface GroupEntry {
  name: string;
  size: number;
  hash?: string;
  path?: string;
}

export function groupHash(entries: GroupEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
    hash.update(entry.name.endsWith("/") ? `D|${entry.name}\0` : `F|${entry.name}|${entry.size}|${entry.hash}\0`);
  }
  return hash.digest("hex").toUpperCase();
}

function archiveName(name: string): string {
  if (!name || name.includes("\\") || name.startsWith("/") || /[\x00-\x1f:]/.test(name)) {
    throw new TransferError("Invalid ZIP entry path.");
  }
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new TransferError("ZIP entries cannot contain empty or dot path segments.");
  }
  return name;
}

export async function readArchive(
  path: string,
  limits: Pick<Config, "maxExtractedBytes" | "maxArchiveEntries">,
  extractDir?: string,
  signal?: AbortSignal,
): Promise<GroupEntry[]> {
  checkAbort(signal);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, strictFileNames: true }, (error, file) => {
      if (error) {
        reject(error);
      } else {
        resolve(file!);
      }
    });
  });
  const entries: GroupEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal!.reason);
      const finish = (error?: unknown) => {
        signal?.removeEventListener("abort", aborted);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      signal?.addEventListener("abort", aborted, { once: true });
      zip.on("error", finish);
      zip.on("end", () => finish());
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          checkAbort(signal);
          const name = archiveName(entry.fileName);
          const key = name.replace(/\/$/, "");
          if (names.has(key)) {
            throw new TransferError("Duplicate ZIP entry.");
          }
          names.add(key);
          if (names.size > limits.maxArchiveEntries) {
            throw new TransferError("ZIP has too many entries.");
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode && mode !== 0x8000 && mode !== 0x4000) {
            throw new TransferError("ZIP contains a symbolic link or special file.");
          }
          total += entry.uncompressedSize;
          if (total > limits.maxExtractedBytes) {
            throw new TransferError("ZIP exceeds the extracted size limit.");
          }
          if (name.endsWith("/")) {
            if (extractDir) {
              await mkdir(safePath(extractDir, key), { recursive: true });
            }
            entries.push({ name, size: 0 });
          } else {
            const input = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
              zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream!)));
            });
            const hash = createHash("sha256");
            let size = 0;
            const destination = extractDir ? safePath(extractDir, name) : undefined;
            if (destination) {
              await mkdir(dirname(destination), { recursive: true });
            }
            const chunks = async function* () {
              for await (const chunk of input as ReturnType<typeof createReadStream>) {
                checkAbort(signal);
                size += chunk.length;
                if (size > entry.uncompressedSize || size > limits.maxExtractedBytes) {
                  throw new TransferError("Invalid ZIP entry size.");
                }
                hash.update(chunk);
                yield chunk;
              }
            };
            if (destination) {
              await pipeline(chunks(), createWriteStream(destination, { flags: "wx" }), { signal });
            } else {
              for await (const _ of chunks()) {
                /* Validate without retaining file contents. */
              }
            }
            entries.push({ name, size, hash: hash.digest("hex").toUpperCase() });
          }
          zip.readEntry();
        })().catch(finish);
      });
      zip.readEntry();
    });
    if (!entries.length) {
      throw new TransferError("Group transfer archive contains no entries.");
    }
    return entries;
  } finally {
    zip.close();
  }
}

export async function collectGroup(paths: string[], signal?: AbortSignal): Promise<GroupEntry[]> {
  const entries: GroupEntry[] = [];
  async function walk(path: string, name: string): Promise<void> {
    checkAbort(signal);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      throw new TransferError("Group contains an unsupported file.");
    }
    if (info.isDirectory()) {
      entries.push({ name: `${name}/`, size: 0, path });
      for (const child of await readdir(path)) {
        await walk(join(path, child), `${name}/${safeName(child)}`);
      }
    } else {
      entries.push({ name, size: info.size, hash: await hashFile(path, signal), path });
    }
  }
  for (const path of paths) {
    await walk(path, safeName(basename(path)));
  }
  if (!entries.length) {
    throw new TransferError("No transferable Group entries were found.");
  }
  return entries;
}

export async function createArchive(path: string, entries: GroupEntry[], signal?: AbortSignal): Promise<void> {
  const zip = new yazl.ZipFile();
  const output = createWriteStream(path, { flags: "wx" });
  zip.on("error", (error: Error) => output.destroy(error));
  const done = pipeline(zip.outputStream, output, { signal });
  try {
    for (const entry of entries) {
      checkAbort(signal);
      if (entry.name.endsWith("/")) {
        zip.addEmptyDirectory(entry.name);
      } else {
        zip.addFile(entry.path!, entry.name);
      }
    }
    zip.end();
  } catch (error) {
    output.destroy(error as Error);
  }
  await done;
}

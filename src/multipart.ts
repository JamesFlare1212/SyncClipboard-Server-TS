import busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { checkAbort, HttpError } from "./errors";
import {
  date,
  normalizeHash,
  parseType,
  type HistoryDto,
  type HistoryQuery,
  type HistoryUpdate,
  lowerKeys,
} from "./models";

export interface Upload {
  fields: Record<string, string>;
  path?: string;
  cleanup: () => Promise<void>;
}

export async function readMultipart(request: Request, tempRoot: string, maxBytes: number): Promise<Upload> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "Expected multipart/form-data.");
  }
  await mkdir(tempRoot, { recursive: true });
  const temp = await mkdtemp(join(tempRoot, "upload-"));
  const cleanup = () => rm(temp, { recursive: true, force: true });
  const fields: Record<string, string> = {};
  const writes: Promise<void>[] = [];
  let path: string | undefined;
  let failure: unknown;
  try {
    const parser = busboy({
      headers: { "content-type": request.headers.get("content-type")! },
      limits: { fieldSize: maxBytes, fields: 100, files: 1, parts: 101, fileSize: maxBytes },
    });
    parser.on("field", (name, value, info) => {
      if (info.valueTruncated) {
        failure = new HttpError(413, "Form field is too large.");
      }
      fields[name.toLowerCase()] = value;
    });
    for (const event of ["fieldsLimit", "filesLimit", "partsLimit"] as const) {
      parser.on(event, () => {
        failure = new HttpError(400, "Too many multipart sections.");
      });
    }
    parser.on("file", (name, stream) => {
      if (name !== "data" || path) {
        failure = new HttpError(400, "Only one data file is supported.");
        stream.resume();
        return;
      }
      path = join(temp, "data");
      stream.on("limit", () => {
        failure = new HttpError(413, "Transfer data is too large.");
      });
      writes.push(
        pipeline(stream, createWriteStream(path, { flags: "wx" }), { signal: request.signal }).catch(
          (error: unknown) => {
            failure = error;
            parser.destroy(error as Error);
          },
        ),
      );
    });
    let bytes = 0;
    const source = request.body ? Readable.fromWeb(request.body as never) : Readable.from([]);
    await pipeline(
      source,
      async function* (chunks) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            throw new HttpError(413, "Request body is too large.");
          }
          yield chunk;
        }
      },
      parser,
      { signal: request.signal },
    );
    await Promise.all(writes);
    if (failure) {
      throw failure;
    }
    checkAbort(request.signal);
    return { fields, path, cleanup };
  } catch (error) {
    await Promise.allSettled(writes);
    await cleanup();
    checkAbort(request.signal);
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "Invalid or incomplete multipart/form-data.");
  }
}

export function historyMetadata(fields: Record<string, string>): HistoryDto {
  const now = new Date().toISOString();
  const timestamp = (key: string) => {
    try {
      return date(fields[key]);
    } catch {
      return now;
    }
  };
  const hash = normalizeHash(fields.hash);
  if (!hash) {
    throw new HttpError(400, "hash is required");
  }
  const number = (value: string | undefined) =>
    /^-?\d+$/.test(value ?? "") && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
  return {
    type: parseType(fields.type),
    hash,
    text: fields.text ?? "",
    size: number(fields.size),
    createTime: timestamp("createtime"),
    lastModified: timestamp("lastmodified"),
    lastAccessed: timestamp("lastaccessed"),
    starred: fields.starred?.toLowerCase() === "true",
    pinned: fields.pinned?.toLowerCase() === "true",
    isDeleted: fields.isdeleted?.toLowerCase() === "true",
    hasData: fields.hasdata?.toLowerCase() === "true",
    version: number(fields.version),
  };
}

export function historyQuery(fields: Record<string, string>): HistoryQuery {
  const result: HistoryQuery = {};
  if (fields.page) {
    if (!/^-?\d+$/.test(fields.page) || !Number.isSafeInteger(Number(fields.page))) {
      throw new HttpError(400, "Invalid page.");
    }
    result.page = Math.max(1, Number(fields.page));
  }
  for (const key of ["before", "after", "modifiedAfter"] as const) {
    if (fields[key.toLowerCase()]) {
      result[key] = date(fields[key.toLowerCase()]);
    }
  }
  if (result.before && result.after && result.after >= result.before) {
    throw new HttpError(400, "after must be less than before");
  }
  const typeFlags: Record<string, number> = {
    none: 0,
    text: 1,
    file: 2,
    image: 4,
    group: 8,
    fileandgroup: 10,
    all: 15,
  };
  if (fields.types) {
    result.types = 0;
    for (const flag of fields.types.split(",")) {
      const normalized = flag.trim().toLowerCase();
      const value = /^\d+$/.test(normalized) ? Number(normalized) : typeFlags[normalized];
      if (value == null || !Number.isInteger(value) || value > 15) {
        throw new HttpError(400, "Invalid profile type filter.");
      }
      result.types |= value;
    }
  }
  for (const key of ["starred", "sortByLastAccessed"] as const) {
    const value = fields[key.toLowerCase()]?.toLowerCase();
    if (value) {
      if (value !== "true" && value !== "false") {
        throw new HttpError(400, `Invalid ${key}.`);
      }
      result[key] = value === "true";
    }
  }
  result.searchText = fields.searchtext;
  return result;
}

export function historyUpdate(value: unknown): HistoryUpdate {
  const fields = lowerKeys(value);
  const update: HistoryUpdate = {};
  for (const key of ["starred", "pinned", "isDelete"] as const) {
    const value = fields[key.toLowerCase()];
    if (value != null) {
      if (typeof value !== "boolean") {
        throw new HttpError(400, `Invalid ${key}.`);
      }
      update[key] = value;
    }
  }
  if (fields.version != null) {
    if (!Number.isSafeInteger(fields.version)) {
      throw new HttpError(400, "Invalid version.");
    }
    update.version = Number(fields.version);
  }
  for (const key of ["lastModified", "lastAccessed"] as const) {
    if (fields[key.toLowerCase()] != null) {
      update[key] = date(fields[key.toLowerCase()]);
    }
  }
  return update;
}

import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { collectGroup, createArchive, groupHash, readArchive } from "./archive";
import type { Config } from "./config";
import { checkAbort, HttpError, TransferError } from "./errors";
import { fileProfileHash, hashFile, safeName, safePath, sha256, textFileLength } from "./files";
import type { HistoryRecord, ProfileDto, ProfileType } from "./models";

export class ProfileStore {
  readonly root: string;
  readonly temp: string;

  constructor(private config: Config) {
    this.root = join(config.dataDir, "history");
    this.temp = join(config.dataDir, "tmp");
  }

  workingDir(record: Pick<HistoryRecord, "type" | "hash">): string {
    return safePath(this.root, `${record.type}_${safeName(record.hash)}`);
  }

  storedPath(record: HistoryRecord, path: string): string {
    return safePath(this.workingDir(record), path);
  }

  inline(record: HistoryRecord): void {
    if (
      record.type !== "Text" ||
      record.size > record.text.length ||
      sha256(record.text) !== record.hash.toUpperCase()
    ) {
      throw new HttpError(400, "Local data is missing or does not match the profile hash.");
    }
    record.transferDataHash = null;
  }

  async attach(
    record: HistoryRecord,
    source: string,
    declaredHash?: string,
    dataName?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(this.temp, { recursive: true });
    const staging = await mkdtemp(join(this.temp, "profile-"));
    try {
      let name =
        dataName ??
        (record.type === "Text"
          ? `Text_${crypto.randomUUID()}.txt`
          : record.type === "Group"
            ? `File_${crypto.randomUUID()}.zip`
            : record.text);
      name = safeName(name);
      if (
        record.type === "Group" &&
        (!name.toLowerCase().endsWith(".zip") || ["", ".", ".."].includes(name.slice(0, -4)))
      ) {
        throw new TransferError("Group transfer data must be a ZIP file.");
      }
      const stagedFile = join(staging, name);
      await copyFile(source, stagedFile);
      const actualHash = await hashFile(stagedFile, signal);
      if (declaredHash && declaredHash !== actualHash) {
        throw new TransferError("Transfer data SHA-256 does not match the declared hash.");
      }
      let paths = [name];
      let semanticHash: string;
      if (record.type === "Group") {
        const extractName = `extracted-${crypto.randomUUID()}`;
        const extractDir = join(staging, extractName);
        await mkdir(extractDir);
        await readArchive(stagedFile, this.config, extractDir, signal);
        const topLevel = await readdir(extractDir);
        const entries = await collectGroup(
          topLevel.map((file) => join(extractDir, file)),
          signal,
        );
        semanticHash = groupHash(entries);
        record.size = entries.reduce((sum, entry) => sum + entry.size, 0);
        paths = topLevel.map((file) => `${extractName}/${file}`);
        if (!record.text) {
          record.text = topLevel.join("\n");
        }
      } else if (record.type === "Text") {
        semanticHash = actualHash;
        if (!record.size) {
          record.size = await textFileLength(stagedFile, signal);
        }
      } else {
        semanticHash = fileProfileHash(name, actualHash);
        record.text = name;
        record.size = (await stat(stagedFile)).size;
      }
      if (record.hash && semanticHash !== record.hash.toUpperCase()) {
        throw new TransferError("Transfer data does not match the profile hash.");
      }
      record.hash ||= semanticHash;
      const working = this.workingDir(record);
      await mkdir(working, { recursive: true });
      checkAbort(signal);
      // Publish only after full byte and semantic validation. Failed uploads leave existing data intact.
      for (const entry of await readdir(staging)) {
        await rename(join(staging, entry), safePath(working, entry));
      }
      record.transferDataFile = name;
      record.transferDataHash = actualHash;
      record.filePaths = paths;
      record.hasData = true;
    } catch (error) {
      checkAbort(signal);
      if (error instanceof HttpError) {
        throw error;
      }
      throw new TransferError("History transfer data is invalid or unreadable.");
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async prepare(record: HistoryRecord, signal?: AbortSignal): Promise<{ path: string; hash: string } | undefined> {
    if (record.type === "Text" && !record.transferDataFile && record.size <= record.text.length) {
      try {
        this.inline(record);
      } catch {
        throw new TransferError("Stored inline text is invalid.");
      }
      return undefined;
    }
    try {
      const stored = record.transferDataFile || record.filePaths[0];
      const path = stored ? this.storedPath(record, stored) : undefined;
      if (path && existsSync(path)) {
        try {
          const hash = await hashFile(path, signal);
          if (record.type === "Group") {
            if (
              record.transferDataHash
                ? record.transferDataHash.toUpperCase() === hash
                : groupHash(await readArchive(path, this.config, undefined, signal)) === record.hash.toUpperCase()
            ) {
              record.transferDataHash = hash;
              return { path, hash };
            }
          } else {
            const semanticHash = record.type === "Text" ? hash : fileProfileHash(basename(path), hash);
            if (semanticHash === record.hash.toUpperCase()) {
              record.transferDataFile ||= relative(this.workingDir(record), path);
              record.transferDataHash = hash;
              return { path, hash };
            }
          }
        } catch {
          checkAbort(signal);
        }
      }
      if (record.type !== "Group") {
        throw new TransferError("Stored transfer data is invalid and cannot be regenerated.");
      }
      const entries = await collectGroup(
        record.filePaths.map((path) => this.storedPath(record, path)),
        signal,
      );
      if (groupHash(entries) !== record.hash.toUpperCase()) {
        throw new TransferError("Stored Group files do not match the profile hash.");
      }
      const name = `File_${crypto.randomUUID()}.zip`;
      const regenerated = safePath(this.workingDir(record), name);
      try {
        await createArchive(regenerated, entries, signal);
        // Recheck archive bytes against the identity in case a local file changed during ZIP generation.
        if (groupHash(await readArchive(regenerated, this.config, undefined, signal)) !== record.hash.toUpperCase()) {
          throw new TransferError("Group changed during archive regeneration.");
        }
        const hash = await hashFile(regenerated, signal);
        record.transferDataFile = name;
        record.transferDataHash = hash;
        return { path: regenerated, hash };
      } catch (error) {
        await rm(regenerated, { force: true });
        throw error;
      }
    } catch (error) {
      checkAbort(signal);
      if (error instanceof TransferError) {
        throw error;
      }
      throw new TransferError("Stored transfer data is invalid and cannot be regenerated.");
    }
  }

  async remove(record: HistoryRecord): Promise<void> {
    await rm(this.workingDir(record), { recursive: true, force: true });
  }

  toProfile(record: HistoryRecord): ProfileDto {
    const hasData = record.type !== "Text" || !!record.transferDataFile || record.size > record.text.length;
    return {
      type: record.type,
      hash: record.hash,
      text: record.text,
      hasData,
      dataName: hasData ? basename(record.transferDataFile || record.filePaths[0] || "") : null,
      ...(hasData && record.transferDataHash ? { transferDataHash: record.transferDataHash } : {}),
      size: record.size,
    };
  }
}

export function clipboardType(type: ProfileType, name: string | null): ProfileType {
  return type === "File" && name && /\.(jpg|jpeg|gif|bmp|png)$/i.test(name) ? "Image" : type;
}

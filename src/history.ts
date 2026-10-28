import { existsSync, readdirSync, lstatSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Config } from "./config";
import { HistoryDatabase } from "./database";
import { checkAbort, HttpError } from "./errors";
import { atomicWrite, Mutex, safeName, safePath, sha256 } from "./files";
import { clipboardType, ProfileStore } from "./profiles";
import { parseProfile, profileTypes, shouldUpdate, toHistoryDto, toUpdateDto } from "./models";
import type { HistoryDto, HistoryQuery, HistoryRecord, HistoryUpdate, ProfileDto, ProfileType } from "./models";

type Notify = (event: "RemoteProfileChanged" | "RemoteHistoryChanged", value: ProfileDto | HistoryDto) => void;

export class HistoryService {
  readonly database: HistoryDatabase;
  readonly profiles: ProfileStore;
  readonly mutex = new Mutex();
  private current?: ProfileDto;

  constructor(
    readonly config: Config,
    private notify: Notify = () => {},
  ) {
    this.database = new HistoryDatabase(config.dataDir);
    this.profiles = new ProfileStore(config);
  }

  private record(dto: HistoryDto): HistoryRecord {
    return { ...dto, id: 0, userId: "default_user", transferDataFile: "", transferDataHash: null, filePaths: [] };
  }

  private publish(record: HistoryRecord): void {
    this.notify("RemoteHistoryChanged", toHistoryDto(record));
  }

  private async removeData(record: HistoryRecord): Promise<void> {
    try {
      await this.profiles.remove(record);
    } catch (error) {
      console.error("Unable to remove history data; cleanup will retry:", error);
    }
  }

  async add(dto: HistoryDto, path?: string, declaredHash?: string, signal?: AbortSignal): Promise<HistoryDto> {
    return this.mutex.run(async () => {
      const existing = this.database.get(dto.type, dto.hash);
      if (existing) {
        if (existing.isDeleted) {
          if (path) {
            await this.profiles.attach(existing, path, declaredHash, existing.transferDataFile || undefined, signal);
          } else if (existing.type === "Text" && !existing.transferDataFile) {
            this.profiles.inline(existing);
          } else {
            throw new HttpError(400, "Needs transfer data.");
          }
        }
        if (
          existing.isDeleted ||
          shouldUpdate(existing.version, dto.version, existing.lastModified, dto.lastModified)
        ) {
          existing.createTime = dto.createTime;
          existing.lastModified = dto.lastModified;
          existing.lastAccessed = dto.lastAccessed;
          existing.starred = dto.starred;
          existing.pinned = dto.pinned;
          existing.isDeleted = dto.isDeleted;
          existing.version = Math.max(dto.version, existing.version + 1);
          this.database.save(existing);
          this.publish(existing);
          if (existing.isDeleted) {
            await this.removeData(existing);
          }
        }
        return toHistoryDto(existing);
      }
      const record = this.record(dto);
      if (path) {
        await this.profiles.attach(record, path, declaredHash, undefined, signal);
      } else {
        this.profiles.inline(record);
      }
      checkAbort(signal);
      this.database.save(record);
      this.publish(record);
      if (record.isDeleted) {
        await this.removeData(record);
      }
      return toHistoryDto(record);
    }, signal);
  }

  async update(type: ProfileType, hash: string, update: HistoryUpdate, signal?: AbortSignal): Promise<Response> {
    return this.mutex.run(async () => {
      const record = this.database.get(type, hash);
      if (!record) {
        return new Response(null, { status: 404 });
      }
      const version = update.version ?? record.version + 1;
      const modified = update.lastModified ?? new Date().toISOString();
      if (!shouldUpdate(record.version, version, record.lastModified, modified)) {
        return Response.json(toUpdateDto(record), { status: 409 });
      }
      if (update.isDelete === false && record.isDeleted && record.transferDataFile) {
        return new Response(null, { status: 404 });
      }
      record.starred = update.starred ?? record.starred;
      record.pinned = update.pinned ?? record.pinned;
      record.isDeleted = update.isDelete ?? record.isDeleted;
      record.lastModified = modified;
      record.lastAccessed = update.lastAccessed ?? record.lastAccessed;
      record.version = version;
      this.database.save(record);
      this.publish(record);
      if (record.isDeleted) {
        await this.removeData(record);
      }
      return new Response(null, { status: 200 });
    }, signal);
  }

  query(query: HistoryQuery): HistoryDto[] {
    return this.database.query(query).map(toHistoryDto);
  }

  async transfer<T>(
    type: ProfileType,
    hash: string,
    consume: (data: { path: string; hash: string }) => T,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    return this.mutex.run(async () => {
      const record = this.database.get(type, hash);
      if (!record) {
        return undefined;
      }
      const data = await this.profiles.prepare(record, signal);
      this.database.save(record);
      return data ? consume(data) : undefined;
    }, signal);
  }

  async recentFile<T>(name: string, consume: (path: string) => T): Promise<T | undefined> {
    return this.mutex.run(async () => {
      for (const record of this.database.all().sort((a, b) => b.lastAccessed.localeCompare(a.lastAccessed))) {
        if (record.transferDataFile && basename(record.transferDataFile) === name) {
          const path = this.profiles.storedPath(record, record.transferDataFile);
          if (existsSync(path)) {
            return consume(path);
          }
        }
      }
      return undefined;
    });
  }

  async currentProfile(): Promise<ProfileDto> {
    return this.mutex.run(async () => {
      if (this.current) {
        return this.current;
      }
      try {
        const raw = await Bun.file(join(this.config.dataDir, "SyncClipboard.json")).json();
        const profile = parseProfile(raw);
        const savedTime = raw.syncedAt ?? raw.SyncedAt;
        if (typeof savedTime === "string" && Number.isFinite(Date.parse(savedTime))) {
          profile.syncedAt = savedTime;
        }
        return (this.current = profile);
      } catch {
        return (this.current = { type: "Text", hash: sha256(""), text: "", hasData: false, dataName: null, size: 0 });
      }
    });
  }

  async setCurrent(dto: ProfileDto, signal?: AbortSignal): Promise<void> {
    await this.mutex.run(async () => {
      const now = new Date().toISOString();
      let consumedUpload: string | undefined;
      let record = dto.hash ? this.database.get(dto.type, dto.hash) : undefined;
      if (record && !record.isDeleted) {
        record.lastModified = now;
        record.lastAccessed = now;
        record.version++;
      } else {
        const type = clipboardType(dto.type, dto.dataName);
        const candidate = this.record({
          type,
          hash: dto.hash,
          text: dto.text,
          size: dto.size ?? (dto.hasData ? 0 : dto.text.length),
          hasData: dto.hasData,
          createTime: now,
          lastModified: now,
          lastAccessed: now,
          starred: false,
          pinned: false,
          version: 0,
          isDeleted: false,
        });
        if (dto.hasData) {
          const name = safeName(dto.dataName ?? "");
          const path = safePath(join(this.config.dataDir, "file"), name);
          if (!existsSync(path)) {
            throw new HttpError(404, "Transfer data file not found");
          }
          try {
            await this.profiles.attach(candidate, path, dto.transferDataHash, name, signal);
            consumedUpload = path;
          } catch (error) {
            checkAbort(signal);
            if (error instanceof HttpError) {
              throw new HttpError(400, error.message);
            }
            throw error;
          }
        } else {
          candidate.hash ||= sha256(dto.text);
          this.profiles.inline(candidate);
        }
        const previous = this.database.get(candidate.type, candidate.hash);
        record = previous
          ? {
              ...candidate,
              id: previous.id,
              createTime: previous.createTime,
              starred: previous.starred,
              pinned: previous.pinned,
              version: previous.version + 1,
            }
          : candidate;
      }
      checkAbort(signal);
      const current = { ...this.profiles.toProfile(record), syncedAt: now };
      await atomicWrite(join(this.config.dataDir, "SyncClipboard.json"), JSON.stringify(current), signal);
      this.database.save(record);
      this.current = current;
      this.publish(record);
      this.notify("RemoteProfileChanged", current);
      if (consumedUpload) {
        await rm(consumedUpload, { force: true });
      }
    }, signal);
  }

  async clear(signal?: AbortSignal): Promise<number> {
    return this.mutex.run(async () => {
      const records = this.database.all();
      this.database.db.transaction(() => {
        for (const record of records) {
          this.database.remove(record.id);
        }
      })();
      for (const record of records) {
        await this.removeData(record);
      }
      return records.length;
    }, signal);
  }

  statistics() {
    const records = this.database.all();
    function size(path: string): number {
      if (!existsSync(path)) {
        return 0;
      }
      let total = 0;
      for (const name of readdirSync(path)) {
        const child = join(path, name);
        const stat = lstatSync(child);
        if (stat.isFile()) {
          total += stat.size;
        } else if (stat.isDirectory()) {
          total += size(child);
        }
      }
      return total;
    }
    const bytes = size(this.profiles.root);
    return {
      activeCount: records.filter((r) => !r.isDeleted).length,
      starredCount: records.filter((r) => r.starred).length,
      deletedCount: records.filter((r) => r.isDeleted).length,
      totalCount: records.length,
      totalFileSizeMB: bytes ? Math.max(0.01, Math.round((bytes / 1024 / 1024) * 100) / 100) : 0,
    };
  }

  async cleanup(now = Date.now(), maintenance = true): Promise<void> {
    await this.mutex.run(async () => {
      const records = this.database.all();
      const expire = async (record: HistoryRecord) => {
        record.isDeleted = true;
        record.version++;
        record.lastModified = new Date(now).toISOString();
        this.database.save(record);
        this.publish(record);
        await this.removeData(record);
      };
      const cutoff = now - this.config.retentionMinutes * 60_000;
      if (this.config.retentionMinutes > 0) {
        for (const record of records) {
          if (
            !record.isDeleted &&
            !record.starred &&
            !record.pinned &&
            Date.parse(record.lastModified) < cutoff &&
            Date.parse(record.lastAccessed) < cutoff
          ) {
            await expire(record);
          }
        }
      }
      if (this.config.maxHistoryCount > 0) {
        let excess = records.filter((r) => !r.isDeleted).length - this.config.maxHistoryCount;
        const candidates = records
          .filter((r) => !r.isDeleted && !r.starred && !r.pinned)
          .sort(
            (a, b) =>
              Math.max(Date.parse(a.lastAccessed), Date.parse(a.lastModified)) -
                Math.max(Date.parse(b.lastAccessed), Date.parse(b.lastModified)) || a.id - b.id,
          );
        for (const record of candidates) {
          if (excess-- <= 0) {
            break;
          }
          await expire(record);
        }
      }
      if (!maintenance) {
        return;
      }
      for (const record of records) {
        if (record.isDeleted) {
          await this.removeData(record);
          if (Date.parse(record.lastModified) < now - 30 * 86400_000) {
            this.database.remove(record.id);
          }
        }
      }
      await mkdir(this.profiles.root, { recursive: true });
      for (const dir of await readdir(this.profiles.root, { withFileTypes: true })) {
        const match = /^(Text|File|Image|Group)_(.+)$/.exec(dir.name);
        if (!dir.isDirectory() || !match || !profileTypes.includes(match[1] as ProfileType)) {
          continue;
        }
        const record = this.database.get(match[1] as ProfileType, match[2]!);
        if (!record || record.isDeleted) {
          await rm(safePath(this.profiles.root, dir.name), { recursive: true, force: true });
        }
      }
    });
  }
}

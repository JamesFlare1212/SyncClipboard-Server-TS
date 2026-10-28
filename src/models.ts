import { HttpError } from "./errors";

export const profileTypes = ["Text", "File", "Image", "Group"] as const;
export type ProfileType = (typeof profileTypes)[number];
export const transferHashHeader = "X-SyncClipboard-Transfer-Data-Hash";

export interface ProfileDto {
  type: ProfileType;
  hash: string;
  text: string;
  hasData: boolean;
  dataName: string | null;
  transferDataHash?: string;
  size?: number;
  syncedAt?: string;
}

export interface HistoryDto {
  hash: string;
  text: string;
  type: ProfileType;
  createTime: string;
  lastModified: string;
  lastAccessed: string;
  starred: boolean;
  pinned: boolean;
  size: number;
  hasData: boolean;
  version: number;
  isDeleted: boolean;
}

export interface HistoryRecord extends HistoryDto {
  id: number;
  userId: string;
  transferDataFile: string;
  transferDataHash: string | null;
  filePaths: string[];
}

export interface HistoryUpdate {
  starred?: boolean;
  pinned?: boolean;
  isDelete?: boolean;
  version?: number;
  lastModified?: string;
  lastAccessed?: string;
}

export interface HistoryQuery {
  page?: number;
  before?: string;
  after?: string;
  modifiedAfter?: string;
  types?: number;
  searchText?: string;
  starred?: boolean;
  sortByLastAccessed?: boolean;
}

export function parseType(value: unknown): ProfileType {
  const type = profileTypes.find(
    (name, index) => name.toLowerCase() === String(value).toLowerCase() || String(index) === String(value),
  );
  if (!type) {
    throw new HttpError(400, "Type is invalid or missing");
  }
  return type;
}

export function parseProfileId(value: string): [ProfileType, string] {
  const separator = value.indexOf("-");
  if (separator < 1 || separator === value.length - 1) {
    throw new HttpError(400, "Invalid profileId format. Expected format: 'Type-Hash'");
  }
  return [parseType(value.slice(0, separator)), normalizeHash(value.slice(separator + 1))!];
}

export function normalizeHash(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new HttpError(400, "Hash must contain exactly 64 hexadecimal characters.");
  }
  return value.toUpperCase();
}

export function lowerKeys(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "A JSON object is required.");
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), item]));
}

export function date(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, "Invalid date.");
  }
  return new Date(value).toISOString();
}

export function parseProfile(value: unknown): ProfileDto {
  const fields = lowerKeys(value);
  const hash = normalizeHash(fields.hash === "" ? undefined : fields.hash) ?? "";
  if (fields.text != null && typeof fields.text !== "string") {
    throw new HttpError(400, "Text must be a string.");
  }
  if (fields.hasdata != null && typeof fields.hasdata !== "boolean") {
    throw new HttpError(400, "HasData must be a boolean.");
  }
  if (fields.dataname != null && typeof fields.dataname !== "string") {
    throw new HttpError(400, "DataName must be a string.");
  }
  if (fields.size != null && (!Number.isSafeInteger(fields.size) || Number(fields.size) < 0)) {
    throw new HttpError(400, "Size must be a nonnegative integer.");
  }
  const dto: ProfileDto = {
    type: parseType(fields.type ?? "Text"),
    hash,
    text: (fields.text as string) ?? "",
    hasData: (fields.hasdata as boolean) ?? false,
    dataName: (fields.dataname as string) ?? null,
  };
  const transferHash = normalizeHash(fields.transferdatahash);
  if (!dto.hasData && transferHash) {
    throw new HttpError(400, "TransferDataHash cannot be set when HasData is false");
  }
  if (transferHash) {
    dto.transferDataHash = transferHash;
  }
  if (fields.size != null) {
    dto.size = Number(fields.size);
  }
  return dto;
}

export function toHistoryDto(record: HistoryRecord): HistoryDto {
  const {
    hash,
    text,
    type,
    createTime,
    lastModified,
    lastAccessed,
    starred,
    pinned,
    size,
    version,
    isDeleted,
    transferDataFile,
    filePaths,
  } = record;
  return {
    hash,
    text,
    type,
    createTime,
    lastModified,
    lastAccessed,
    starred,
    pinned,
    size,
    version,
    isDeleted,
    hasData: !!transferDataFile || filePaths.length > 0,
  };
}

export function toUpdateDto(record: HistoryRecord): HistoryUpdate {
  const { starred, pinned, version, lastModified, lastAccessed, isDeleted } = record;
  return { starred, pinned, version, lastModified, lastAccessed, isDelete: isDeleted };
}

export function shouldUpdate(oldVersion: number, newVersion: number, oldTime: string, newTime: string): boolean {
  const gap = Date.parse(newTime) - Date.parse(oldTime);
  return Math.abs(gap) <= 5 * 60_000 ? newVersion >= oldVersion : gap >= 0;
}

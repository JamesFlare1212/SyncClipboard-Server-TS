import { describe, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../src/files";
import { fixture, groupFixture, textHistory } from "./helpers";

describe("server history retention and cleanup", () => {
  test("expiration requires both activity times to be old and preserves starred and pinned records", async () => {
    await using f = await fixture({ retentionMinutes: 60 });
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    const recent = new Date().toISOString();
    for (const [text, fields] of [
      ["expired", {}],
      ["starred", { starred: true }],
      ["pinned", { pinned: true }],
      ["accessed", { lastAccessed: recent }],
      ["modified", { lastModified: recent }],
    ] as const) {
      await f.upload(textHistory(text, { createTime: recent, lastModified: old, lastAccessed: old, ...fields }));
    }
    await f.history.cleanup();
    const records = f.history.database.all();
    expect(records.filter((r) => r.isDeleted).map((r) => r.text)).toEqual(["expired"]);
    expect(records.find((r) => r.text === "expired")!.version).toBe(1);
  });

  test("count limit uses latest activity rather than creation time and preserves protected records", async () => {
    await using f = await fixture({ maxHistoryCount: 3 });
    const old = new Date(Date.now() - 2 * 86400_000).toISOString();
    const recent = new Date().toISOString();
    for (const [text, fields] of [
      ["inactive", {}],
      ["starred", { starred: true }],
      ["accessed", { lastAccessed: recent }],
      ["modified", { lastModified: recent }],
    ] as const) {
      await f.upload(textHistory(text, { createTime: recent, lastModified: old, lastAccessed: old, ...fields }));
    }
    await f.history.cleanup();
    expect(
      f.history.database
        .all()
        .filter((r) => !r.isDeleted)
        .map((r) => r.text)
        .sort(),
    ).toEqual(["accessed", "modified", "starred"]);
    f.config.maxHistoryCount = 1;
    for (const record of f.history.database.all()) {
      record.pinned = true;
      f.history.database.save(record);
    }
    await f.history.cleanup();
    expect(f.history.database.all().filter((r) => !r.isDeleted)).toHaveLength(3);
  });

  test("zero disables its own retention limit; 30 day tombstones expire independently", async () => {
    await using f = await fixture();
    const old = new Date(Date.now() - 31 * 86400_000).toISOString();
    await f.upload(textHistory("old live", { lastModified: old, lastAccessed: old }));
    await f.upload(textHistory("old deleted", { lastModified: old, lastAccessed: old, isDeleted: true }));
    await f.upload(textHistory("new deleted", { isDeleted: true }));
    await f.history.cleanup();
    expect(
      f.history.database
        .all()
        .map((r) => r.text)
        .sort(),
    ).toEqual(["new deleted", "old live"]);
  });

  test("cleanup removes orphan and deleted profile directories while preserving live and unrelated data", async () => {
    await using f = await fixture();
    const group = await groupFixture({ "keep.txt": "kept" });
    await f.upload({ type: "Group", hash: group.hash }, group.bytes);
    const orphan = join(f.history.profiles.root, `File_${sha256("orphan")}`);
    const unrelated = join(f.history.profiles.root, "unrelated");
    await mkdir(orphan);
    await mkdir(unrelated);
    await f.history.cleanup();
    expect((await readdir(f.history.profiles.root)).sort()).toEqual([`Group_${group.hash}`, "unrelated"]);
    const record = f.history.database.all()[0]!;
    record.isDeleted = true;
    f.history.database.save(record);
    await f.history.cleanup();
    expect(await readdir(f.history.profiles.root)).toEqual(["unrelated"]);
    expect(f.history.database.all()).toHaveLength(1);
  });

  test("cleanup waits for pending attachment commit and preserves its new directory", async () => {
    await using f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = f.history.mutex.run(() => gate);
    const group = await groupFixture({ "race.txt": "race" });
    const source = join(f.root, "upload.zip");
    await Bun.write(source, group.bytes);
    const add = f.history.add(textHistory("race.txt", { type: "Group", hash: group.hash }), source);
    const cleanup = f.history.cleanup();
    release();
    await Promise.all([blocked, add, cleanup]);
    expect((await f.request(`/api/history/Group-${group.hash}/data`)).status).toBe(200);
  });
});

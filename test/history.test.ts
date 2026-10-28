import { describe, expect, test } from "bun:test";
import { readdir, rm, chmod } from "node:fs/promises";
import { fileProfileHash, sha256 } from "../src/files";
import { transferHashHeader } from "../src/models";
import { fixture, groupFixture, textHistory, write } from "./helpers";

describe("ported HistoryTransferDataHashTests", () => {
  for (const matching of [false, true]) {
    test(`inline history requires matching identity hash (${matching})`, async () => {
      await using f = await fixture();
      const dto = textHistory("inline", { hash: matching ? sha256("inline").toLowerCase() : "A".repeat(64) });
      const result = await f.upload(dto);
      expect(result.status).toBe(matching ? 200 : 400);
      expect(f.history.database.all()).toHaveLength(matching ? 1 : 0);
      if (matching) {
        expect((await result.json()).hash).toBe(sha256("inline"));
        expect(f.history.database.all()[0]!.transferDataHash).toBeNull();
      }
    });
  }

  test("group requires semantic validation even with the correct archive SHA-256", async () => {
    await using f = await fixture();
    const group = await groupFixture({ "unexpected.txt": "unexpected" });
    const response = await f.upload(
      { type: "Group", text: "expected", hash: "A".repeat(64), hasData: true },
      group.bytes,
      { [transferHashHeader]: group.transferHash },
    );
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("history_data_invalid");
    expect(f.history.database.all()).toHaveLength(0);
    expect(await readdir(f.history.profiles.temp)).toEqual([]);
  });

  test("declared byte hash mismatch rejects valid semantic content", async () => {
    await using f = await fixture();
    const group = await groupFixture({ "ok.txt": "ok" });
    const response = await f.upload({ type: "Group", hash: group.hash, hasData: true }, group.bytes, {
      [transferHashHeader]: "B".repeat(64),
    });
    expect(response.status).toBe(422);
    expect(f.history.database.all()).toHaveLength(0);
  });

  for (const declared of [false, true]) {
    test(`valid Group persists server calculated transfer hash (declared: ${declared})`, async () => {
      await using f = await fixture();
      const group = await groupFixture({ "目录/": "", "目录/空/": "", "目录/文档.txt": "中文", "a.txt": "a" });
      const response = await f.upload(
        { type: "Group", text: "目录\na.txt", hash: group.hash, hasData: true },
        group.bytes,
        declared ? { [transferHashHeader]: group.transferHash.toLowerCase() } : undefined,
      );
      expect(response.status).toBe(200);
      const dto = await response.json();
      expect(dto.hasData).toBe(true);
      expect(dto.size).toBe(group.size);
      expect(dto.transferDataHash).toBeUndefined();
      const record = f.history.database.all()[0]!;
      expect(record.transferDataHash).toBe(group.transferHash);
      const download = await f.request(`/api/history/Group-${group.hash}/data`);
      expect(download.headers.get(transferHashHeader)).toBe(group.transferHash);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(group.bytes);
    });
  }

  for (const [deleted, invalidHash] of [
    [false, true],
    [true, false],
    [true, true],
  ]) {
    test(`duplicates replace data only after verified restoration (deleted ${deleted}, invalid ${invalidHash})`, async () => {
      await using f = await fixture();
      const first = await groupFixture({ "existing.txt": "content" }, "first archive");
      const second = await groupFixture({ "existing.txt": "content" }, "new archive bytes");
      const dto = { type: "Group" as const, text: "existing.txt", hash: first.hash, hasData: true };
      expect((await f.upload(dto, first.bytes)).status).toBe(200);
      if (deleted) {
        expect((await f.json(`/api/history/Group/${first.hash}`, "PATCH", { isDelete: true })).status).toBe(200);
      }
      const result = await f.upload(dto, second.bytes, {
        [transferHashHeader]: invalidHash ? "A".repeat(64) : second.transferHash,
      });
      expect(result.status).toBe(deleted && invalidHash ? 422 : 200);
      const record = f.history.database.all()[0]!;
      expect(record.isDeleted).toBe(!!(deleted && invalidHash));
      expect(record.transferDataHash).toBe(deleted && !invalidHash ? second.transferHash : first.transferHash);
      expect(f.history.database.all()).toHaveLength(1);
    });
  }

  for (const mismatchBytes of [false, true]) {
    test(`rejected replacement preserves existing extraction (${mismatchBytes})`, async () => {
      await using f = await fixture();
      const group = await groupFixture({ "original.txt": "original" });
      const incoming = await groupFixture({ "bad.txt": "bad" });
      const dto = { type: "Group" as const, hash: group.hash, hasData: true };
      await f.upload(dto, group.bytes);
      const record = f.history.database.all()[0]!;
      record.isDeleted = true;
      f.history.database.save(record);
      const originalPath = f.history.profiles.storedPath(record, record.filePaths[0]!);
      const result = await f.upload(dto, incoming.bytes, {
        [transferHashHeader]: mismatchBytes ? "B".repeat(64) : incoming.transferHash,
      });
      expect(result.status).toBe(422);
      expect(await Bun.file(originalPath).text()).toBe("original");
      expect(f.history.database.all()[0]!.isDeleted).toBe(true);
    });
  }

  test("known Group byte hash allows reuse and rejects changed bytes when no local copy exists", async () => {
    await using f = await fixture();
    const group = await groupFixture({ "content.txt": "content" });
    await f.upload({ type: "Group", hash: group.hash, hasData: true }, group.bytes);
    const record = f.history.database.all()[0]!;
    const originalWorkingDir = f.history.profiles.workingDir(record);
    record.hash = "B".repeat(64);
    record.filePaths = [];
    f.history.database.save(record);
    const path = f.history.profiles.storedPath(record, record.transferDataFile);
    await write(path, group.bytes);
    await rm(originalWorkingDir, { force: true, recursive: true });
    expect((await f.request(`/api/history/Group-${record.hash}/data`)).status).toBe(200);
    await Bun.write(path, "changed");
    expect((await f.request(`/api/history/Group-${record.hash}/data`)).status).toBe(422);
  });

  for (const state of ["missing", "corrupted", "unreadable", "legacy"]) {
    test(`Group archive ${state} is regenerated or verified from stored data`, async () => {
      await using f = await fixture();
      const group = await groupFixture({ "folder/": "", "folder/hello.txt": "regenerate" });
      await f.upload({ type: "Group", hash: group.hash, hasData: true }, group.bytes);
      const record = f.history.database.all()[0]!;
      const path = f.history.profiles.storedPath(record, record.transferDataFile);
      if (state === "missing") {
        await rm(path);
      }
      if (state === "corrupted") {
        await Bun.write(path, "corrupted");
      }
      if (state === "unreadable") {
        await chmod(path, 0);
      }
      if (state === "legacy") {
        record.transferDataHash = null;
        f.history.database.save(record);
      }
      try {
        const response = await f.request(`/api/history/Group-${group.hash}/data`);
        expect(response.status).toBe(200);
        const data = new Uint8Array(await response.arrayBuffer());
        expect(response.headers.get(transferHashHeader)).toBe(sha256(data));
        expect(f.history.database.all()[0]!.transferDataHash).toBe(sha256(data));
        // Validate regenerated content by reuploading to a fresh server with the original profile identity.
        await using other = await fixture();
        expect((await other.upload({ type: "Group", hash: group.hash, hasData: true }, data)).status).toBe(200);
      } finally {
        if (state === "unreadable") {
          await chmod(path, 0o600);
        }
      }
    });
  }

  for (const attachment of [false, true]) {
    for (const localWins of [false, true]) {
      test(`deleted PATCH respects conflict and attachment restoration (attachment ${attachment}, localWins ${localWins})`, async () => {
        await using f = await fixture();
        const name = "file.bin";
        const type = attachment ? "File" : "Text";
        const hash = attachment ? fileProfileHash(name, sha256("content")) : sha256("content");
        await f.upload(
          { type, hash, text: attachment ? name : "content", size: 7 },
          attachment ? "content" : undefined,
        );
        await f.json(`/api/history/${type}/${hash}`, "PATCH", { isDelete: true, version: 10 });
        const response = await f.json(`/api/history/${type}/${hash}`, "PATCH", {
          isDelete: false,
          version: localWins ? 11 : 1,
        });
        expect(response.status).toBe(!localWins ? 409 : attachment ? 404 : 200);
        expect(f.history.database.all()[0]!.isDeleted).toBe(!localWins || attachment);
      });
    }
  }

  for (const type of ["File", "Image", "Text"] as const) {
    test(`${type} transfer download rejects altered content`, async () => {
      await using f = await fixture();
      const name = type === "Image" ? "image.png" : "file.bin";
      const content = "full content";
      const hash = type === "Text" ? sha256(content) : fileProfileHash(name, sha256(content));
      expect(
        (await f.upload({ type, text: type === "Text" ? "full" : name, hash, size: content.length }, content)).status,
      ).toBe(200);
      const record = f.history.database.all()[0]!;
      expect((await f.request(`/api/history/${type}-${hash}/data`)).status).toBe(200);
      await Bun.write(f.history.profiles.storedPath(record, record.transferDataFile), "corrupted");
      expect((await f.request(`/api/history/${type}-${hash}/data`)).status).toBe(422);
    });
  }
});

describe("history query, concurrency, statistics and clear", () => {
  test("paging and type, time, search, starred filters preserve tombstones and stable order", async () => {
    await using f = await fixture();
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 65; i++) {
      const timestamp = new Date(base + i * 1000).toISOString();
      await f.upload(
        textHistory(`item ${i}`, {
          createTime: timestamp,
          lastModified: timestamp,
          lastAccessed: new Date(base + (65 - i) * 1000).toISOString(),
          starred: i % 2 === 0,
          isDeleted: i === 10,
        }),
      );
    }
    const first = await (await f.query()).json();
    const second = await (await f.query({ page: 2 })).json();
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(15);
    expect(first[0].text).toBe("item 64");
    expect(second[14].text).toBe("item 0");
    expect((await (await f.query({ sortByLastAccessed: true })).json())[0].text).toBe("item 0");
    expect(await (await f.query({ types: "FileAndGroup" })).json()).toEqual([]);
    expect(await (await f.query({ types: "None" })).json()).toEqual([]);
    expect(await (await f.query({ types: "Text", searchText: "ITEM 1", starred: true })).json()).toHaveLength(5);
    const range = await (await f.query({ after: "2026-01-01T00:00:10Z", before: "2026-01-01T00:00:12Z" })).json();
    expect(range.map((r: { text: string }) => r.text)).toEqual(["item 11", "item 10"]);
    expect(range[1].isDeleted).toBe(true);
    expect(await (await f.query({ modifiedAfter: "2026-01-01T00:01:04Z" })).json()).toHaveLength(1);
    for (const fields of [
      { before: "bad" },
      { page: "bad" },
      { types: "Nonsense" },
      { starred: "yes" },
      { before: "2026-01-01", after: "2026-01-02" },
    ] as Record<string, string>[]) {
      expect((await f.query(fields)).status).toBe(400);
    }
    expect(await (await f.query({ page: 0 })).json()).toHaveLength(50);
  });

  test("concurrent duplicate uploads create one record and case insensitive lookup uses exact hash", async () => {
    await using f = await fixture();
    const results = await Promise.all(Array.from({ length: 20 }, () => f.upload(textHistory("same"))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(f.history.database.all()).toHaveLength(1);
    const response = await f.request(`/api/history/Text-${sha256("same").toLowerCase()}`);
    expect(response.status).toBe(200);
    expect((await f.request("/api/history/Text-%25")).status).toBe(400);
    expect((await f.request("/api/history/invalid")).status).toBe(400);
    expect((await f.request(`/api/history/Text-${"A".repeat(64)}`)).status).toBe(404);
  });

  test("upload conflicts return accepted metadata; patches use five minute clock tolerance", async () => {
    await using f = await fixture();
    const dto = textHistory("conflict", { version: 10, lastModified: "2026-01-01T00:00:00Z" });
    await f.upload(dto);
    const stale = await (await f.upload({ ...dto, version: 9, starred: true })).json();
    expect(stale.version).toBe(10);
    expect(stale.starred).toBe(false);
    const endpoint = `/api/history/Text/${dto.hash}`;
    const conflict = await f.json(endpoint, "PATCH", {
      version: 9,
      lastModified: "2026-01-01T00:05:00Z",
      starred: true,
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).isDelete).toBe(false);
    expect(
      (await f.json(endpoint, "PATCH", { version: 1, lastModified: "2026-01-01T00:05:01Z", starred: true })).status,
    ).toBe(200);
    expect((await f.json(endpoint, "PATCH", { version: 999, lastModified: "2025-12-31T00:00:00Z" })).status).toBe(409);
  });

  test("statistics and clear include deleted rows and remove attachment folders", async () => {
    await using f = await fixture();
    const group = await groupFixture({ "file.txt": "size" });
    await f.upload(textHistory("starred", { starred: true }));
    await f.upload(textHistory("deleted", { isDeleted: true, starred: true }));
    await f.upload({ type: "Group", hash: group.hash }, group.bytes);
    const stats = await (await f.request("/api/history/statistics")).json();
    expect(stats).toEqual({ activeCount: 2, deletedCount: 1, starredCount: 2, totalCount: 3, totalFileSizeMB: 0.01 });
    expect(await (await f.request("/api/history/clear", { method: "DELETE" })).json()).toEqual({ deleted: 3 });
    expect(await readdir(f.history.profiles.root)).toEqual([]);
    expect(f.history.database.all()).toEqual([]);
  });
});

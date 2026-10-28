import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "../src/server";
import { sha256 } from "../src/files";
import { auth, fixture, groupFixture, write } from "./helpers";

for (const hasHashColumn of [false, true]) {
  test(`reads original EF SQLite schema and data without loss (transfer hash column ${hasHashColumn})`, async () => {
    await using f = await fixture();
    await f.stop();
    const dbPath = join(f.config.dataDir, "data", "history.db");
    await rm(dbPath);
    const db = new Database(dbPath);
    db.exec(await Bun.file(join(import.meta.dir, "fixtures/legacy-schema.sql")).text());
    if (hasHashColumn) {
      db.exec("ALTER TABLE HistoryRecords ADD COLUMN TransferDataHash TEXT NULL");
    }
    const group = await groupFixture({ "文件.txt": "legacy content" });
    const hash = group.hash.toLowerCase();
    const time = "2026-01-02 03:04:05.1234567";
    db.query(
      `INSERT INTO HistoryRecords (UserId,Type,Text,Size,TransferDataFile,TransferDataSha256,
      TransferDataMd5,FilePaths,Hash,CreateTime,LastAccessed,LastModified,Stared,Pinned,"From",Tags,ExtraData,Version,IsDeleted)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "default_user",
      3,
      "文件.txt",
      group.size,
      "legacy.zip",
      "",
      "",
      '["legacy/文件.txt"]',
      hash,
      time,
      time,
      time,
      1,
      0,
      "original",
      '["keep"]',
      '{"keep":true}',
      7,
      0,
    );
    if (hasHashColumn) {
      db.query("UPDATE HistoryRecords SET TransferDataHash = ?").run(group.transferHash);
    }
    db.close();
    const working = join(f.config.dataDir, "history", `Group_${hash}`);
    await write(join(working, "legacy.zip"), group.bytes);
    await write(join(working, "legacy/文件.txt"), "legacy content");
    await write(
      join(f.config.dataDir, "SyncClipboard.json"),
      JSON.stringify({
        Type: "Group",
        Hash: hash,
        Text: "文件.txt",
        HasData: true,
        DataName: "legacy.zip",
        Size: group.size,
        SyncedAt: "2026-01-02T03:04:05Z",
      }),
    );
    const app = createServer(f.config, { cleanup: false });
    try {
      const request = (path: string, init: RequestInit = {}) =>
        fetch(`${app.url}${path}`, { ...init, headers: { authorization: auth } });
      const metadata = await (await request(`/api/history/Group-${group.hash}`)).json();
      expect(metadata.text).toBe("文件.txt");
      expect(metadata.version).toBe(7);
      expect(metadata.starred).toBe(true);
      expect(metadata.createTime).toBe("2026-01-02T03:04:05.123Z");
      expect((await (await request("/SyncClipboard.json")).json()).syncedAt).toBe("2026-01-02T03:04:05Z");
      const data = await request(`/api/history/Group-${group.hash}/data`);
      expect(new Uint8Array(await data.arrayBuffer())).toEqual(group.bytes);
      expect(app.history.database.all()[0]!.transferDataHash).toBe(group.transferHash);
      const raw = app.history.database.db.query<Record<string, unknown>, []>("SELECT * FROM HistoryRecords").get()!;
      expect(raw.From).toBe("original");
      expect(raw.Tags).toBe('["keep"]');
      expect(raw.ExtraData).toBe('{"keep":true}');
      expect(app.history.database.db.query("SELECT * FROM __EFMigrationsHistory").all()).toHaveLength(1);
      await rm(join(working, "legacy.zip"));
      expect((await request(`/api/history/Group-${group.hash}/data`)).status).toBe(200);
      expect(app.history.database.all()[0]!.hash).toBe(hash);
      const result = await request("/api/history/query", {
        method: "POST",
        body: new URLSearchParams({ after: "2026-01-02T03:04:05Z", before: "2026-01-02T03:04:06Z" }),
      });
      expect(await result.json()).toHaveLength(1);
    } finally {
      await app.stop();
    }
    // Idempotent reopen after migration and continued writes.
    const reopened = createServer(f.config, { cleanup: false });
    try {
      await reopened.history.setCurrent({
        type: "Text",
        hash: sha256("new"),
        text: "new",
        hasData: false,
        dataName: null,
      });
      expect(reopened.history.database.all()).toHaveLength(2);
    } finally {
      await reopened.stop();
    }
  });
}

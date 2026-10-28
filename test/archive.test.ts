import { describe, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { sha256 } from "../src/files";
import { fixture, groupFixture } from "./helpers";

// Stored ZIP encoder permits hostile names that normal archive writers reject.
function rawZip(entries: { name: string; content?: string; mode?: number }[]): Uint8Array<ArrayBuffer> {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.content ?? "");
    const crc = Bun.hash.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0x81a4) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, centralBytes, end]));
}

describe("ported GroupProfile transfer and extraction behavior", () => {
  const vectors: [Record<string, string>, string][] = [
    [{ "folder/": "" }, "C12AE951F4066635565B3A0B7A345F4926F53ADC5FEA40CC654FA5FC0E49C10F"],
    [{ "empty.txt": "" }, "E192AFEBB9752F4FD1CC50BC87FCBF6ECFAEAFA50C68A3F064566E0CE36DAD3F"],
    [
      { "目录/": "", "目录/文档.txt": "中文", "a.txt": "a" },
      "D9F741FAA7E494D434F5E84E2007FCEB74823DB8083C04D4A4B312AB5A7540AD",
    ],
  ];
  for (const [files, expectedHash] of vectors) {
    test(`original D/F/NUL hash vector ${Object.keys(files).join(", ")}`, async () => {
      await using f = await fixture();
      const group = await groupFixture(files);
      expect(group.hash).toBe(expectedHash);
      const result = await f.upload({ type: "Group", hash: expectedHash }, group.bytes);
      expect(result.status).toBe(200);
      expect((await f.request(`/api/history/Group-${expectedHash}/data`)).status).toBe(200);
    });
  }

  for (const name of [
    "folder/../extra",
    "./extra",
    "./declared.txt",
    "folder/./extra",
    "folder/../extra/",
    "../outside",
    "/outside",
    "C:/outside",
    "folder\\outside",
    "bad\0name",
  ]) {
    test(`rejects unsafe ZIP path ${JSON.stringify(name)} without publishing extraction`, async () => {
      await using f = await fixture();
      const archive = rawZip([{ name: "declared.txt" }, { name }]);
      const result = await f.upload({ type: "Group", hash: "A".repeat(64) }, archive);
      expect(result.status).toBe(422);
      expect(f.history.database.all()).toEqual([]);
      expect(await readdir(f.history.profiles.temp)).toEqual([]);
    });
  }

  for (const entries of [
    [],
    [{ name: "x" }, { name: "x" }],
    [{ name: "x" }, { name: "x/child" }],
    [{ name: "link", content: "../outside", mode: 0xa1ff }],
  ]) {
    test(`rejects empty, duplicate, conflicting and symlink ZIP entries: ${JSON.stringify(entries)}`, async () => {
      await using f = await fixture();
      expect((await f.upload({ type: "Group", hash: sha256("") }, rawZip(entries))).status).toBe(422);
      expect(f.history.database.all()).toEqual([]);
      expect(await readdir(f.history.profiles.temp)).toEqual([]);
    });
  }

  test("archive resource limits reject excessive expanded data and entry counts", async () => {
    await using f = await fixture({ maxExtractedBytes: 10, maxArchiveEntries: 1 });
    const cases: Record<string, string>[] = [{ "large.txt": "x".repeat(11) }, { "a.txt": "a", "b.txt": "b" }];
    for (const files of cases) {
      const group = await groupFixture(files);
      expect((await f.upload({ type: "Group", hash: group.hash }, group.bytes)).status).toBe(422);
    }
  });

  for (const corruption of ["all-missing", "one-missing", "changed"]) {
    test(`invalid local Group cannot generate a partial archive (${corruption})`, async () => {
      await using f = await fixture();
      const group = await groupFixture({ "one.txt": "one", "two.txt": "two" });
      await f.upload({ type: "Group", hash: group.hash }, group.bytes);
      const record = f.history.database.all()[0]!;
      const archive = f.history.profiles.storedPath(record, record.transferDataFile);
      await rm(archive);
      if (corruption === "changed") {
        await Bun.write(f.history.profiles.storedPath(record, record.filePaths[0]!), "altered");
      } else {
        for (const path of corruption === "all-missing" ? record.filePaths : record.filePaths.slice(0, 1)) {
          await rm(f.history.profiles.storedPath(record, path));
        }
      }
      expect((await f.request(`/api/history/Group-${group.hash}/data`)).status).toBe(422);
      expect((await readdir(f.history.profiles.workingDir(record))).filter((name) => name.endsWith(".zip"))).toEqual(
        [],
      );
    });
  }
});

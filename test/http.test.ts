import { describe, expect, test } from "bun:test";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileProfileHash, sha256 } from "../src/files";
import { createServer } from "../src/server";
import { transferHashHeader } from "../src/models";
import { auth, fixture, groupFixture, textHistory } from "./helpers";

describe("authenticated HTTP and WebDAV compatibility", () => {
  test("all endpoints reject missing, malformed and invalid Basic credentials", async () => {
    await using f = await fixture();
    for (const path of [
      "/",
      "/api/time",
      "/api/version",
      "/SyncClipboard.json",
      "/file/a",
      "/api/history/statistics",
      "/SyncClipboardHub/negotiate",
    ]) {
      for (const value of ["", "Basic", "Basic !!!", "Basic Og==", "Bearer token"]) {
        const response = await f.request(path, { headers: { authorization: value } });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe('Basic realm="SyncClipboard"');
      }
    }
    expect((await f.request("/", { headers: { authorization: auth.replace("Basic", "bAsIc") } })).status).toBe(200);
    expect(await (await f.request("/")).text()).toBe("Server is running.");
    expect(await (await f.request("/api/version")).text()).toBe("3.3.3");
    expect(Math.abs(Date.parse(await (await f.request("/api/time")).json()) - Date.now())).toBeLessThan(2000);
  });

  test("initial and corrupt current profile return the empty text profile", async () => {
    await using f = await fixture();
    const empty = { type: "Text", hash: sha256(""), text: "", hasData: false, dataName: null, size: 0 };
    expect(await (await f.request("/SyncClipboard.json")).json()).toEqual(empty);
    await f.stop();
    await Bun.write(join(f.config.dataDir, "SyncClipboard.json"), "bad json");
    const restarted = createServer(f.config, { cleanup: false });
    try {
      expect(
        await (await fetch(`${restarted.url}/SyncClipboard.json`, { headers: { authorization: auth } })).json(),
      ).toEqual(empty);
    } finally {
      await restarted.stop();
    }
  });

  test("Basic authentication compares exact UTF-8 credentials and rejects different byte lengths", async () => {
    await using f = await fixture({ username: "用户", password: "p😀:word" });
    for (const [credentials, expectedStatus] of [
      ["用户:p😀:word", 200],
      ["用户:p😈:word", 401],
      ["用户:p😀:wor", 401],
      ["用户:p😀:word\0", 401],
      ["用户:", 401],
      ["访客:p😀:word", 401],
    ] as const) {
      const authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
      expect((await f.request("/", { headers: { authorization } })).status).toBe(expectedStatus);
    }
  });

  for (const omitHash of [true, false]) {
    test(`inline profile persists with server timestamp (omit hash: ${omitHash})`, async () => {
      await using f = await fixture();
      const dto = {
        Type: "Text",
        Text: "中文 😀\r\nhello",
        Hash: omitHash ? "" : sha256("中文 😀\r\nhello").toLowerCase(),
        HasData: false,
        SyncedAt: "2000-01-01T00:00:00Z",
      };
      expect((await f.json("/SyncClipboard.json", "PUT", dto)).status).toBe(200);
      const result = await (await f.request("/SyncClipboard.json")).json();
      expect(result.hash).toBe(sha256(dto.Text));
      expect(result.size).toBe(dto.Text.length);
      expect(result.transferDataHash).toBeUndefined();
      expect(Math.abs(Date.parse(result.syncedAt) - Date.now())).toBeLessThan(2000);
      expect(JSON.parse(await readFile(join(f.config.dataDir, "SyncClipboard.json"), "utf8"))).toEqual(result);
      expect(f.history.database.all()).toHaveLength(1);
      const before = f.history.database.all()[0]!;
      expect(
        (await f.json("/SyncClipboard.json", "PUT", { ...dto, Text: "ignored duplicate", Hash: result.hash })).status,
      ).toBe(200);
      const after = f.history.database.all()[0]!;
      expect(after.text).toBe(dto.Text);
      expect(after.version).toBe(before.version + 1);
    });
  }

  test("invalid inline data does not persist or replace current clipboard", async () => {
    await using f = await fixture();
    await f.json("/SyncClipboard.json", "PUT", { text: "good" });
    const before = await (await f.request("/SyncClipboard.json")).json();
    for (const dto of [
      null,
      [],
      { text: "altered", hash: sha256("original") },
      { type: "File", text: "missing" },
      { text: "x", transferDataHash: sha256("x") },
      { text: "x", transferDataHash: "bad", hasData: true },
    ]) {
      expect((await f.json("/SyncClipboard.json", "PUT", dto)).status).toBe(400);
    }
    expect(await (await f.request("/SyncClipboard.json")).json()).toEqual(before);
    expect(f.history.database.all()).toHaveLength(1);
  });

  for (const [type, name] of [
    ["File", "文件.bin"],
    ["Image", "picture.png"],
    ["File", "auto.PNG"],
  ]) {
    test(`staged ${type} ${name} supports GET/HEAD and persistent history`, async () => {
      await using f = await fixture();
      const bytes = new Uint8Array([0, 1, 2, 255, 10]);
      expect((await f.request("/", { method: "PROPFIND" })).status).toBe(200);
      for (const method of ["PROPFIND", "MKCOL"]) {
        expect((await f.request("/file", { method })).status).toBe(200);
      }
      expect((await f.request(`/file/${encodeURIComponent(name!)}`, { method: "PUT", body: bytes })).status).toBe(200);
      const hash = fileProfileHash(name!, sha256(bytes));
      expect(
        (
          await f.json("/SyncClipboard.json", "PUT", {
            type,
            text: name,
            dataName: name,
            hasData: true,
            hash,
            transferDataHash: sha256(bytes).toLowerCase(),
          })
        ).status,
      ).toBe(200);
      const profile = await (await f.request("/SyncClipboard.json")).json();
      expect(profile.type).toBe(name!.toLowerCase().endsWith("png") ? "Image" : "File");
      expect(profile.size).toBe(bytes.length);
      expect(await Bun.file(join(f.config.dataDir, "file", name!)).exists()).toBe(false);
      const get = await f.request(`/file/${encodeURIComponent(name!)}`);
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
      const head = await f.request(`/file/${encodeURIComponent(name!)}`, { method: "HEAD" });
      expect(head.headers.get("content-length")).toBe(String(bytes.length));
      expect(await head.text()).toBe("");
      expect((await f.request("/file", { method: "DELETE" })).status).toBe(200);
      const data = await f.request(`/api/history/${profile.type}-${hash}/data`);
      expect(data.headers.get(transferHashHeader)).toBe(sha256(bytes));
      expect(new Uint8Array(await data.arrayBuffer())).toEqual(bytes);
    });
  }

  test("missing and mismatched staged attachments fail without changing history", async () => {
    await using f = await fixture();
    const dto = {
      type: "File",
      text: "file.bin",
      dataName: "file.bin",
      hash: fileProfileHash("file.bin", sha256("real")),
      hasData: true,
    };
    expect((await f.json("/SyncClipboard.json", "PUT", dto)).status).toBe(404);
    await f.request("/file/file.bin", { method: "PUT", body: "wrong" });
    expect((await f.json("/SyncClipboard.json", "PUT", dto)).status).toBe(400);
    expect(await Bun.file(join(f.config.dataDir, "file", "file.bin")).text()).toBe("wrong");
    expect(f.history.database.all()).toHaveLength(0);
  });

  test("long text hashes UTF-8 bytes and reports UTF-16 length", async () => {
    await using f = await fixture();
    const text = "😀中文".repeat(5000);
    await f.request("/file/long.txt", { method: "PUT", body: text });
    const dto = { type: "Text", text: text.slice(0, 10240), hash: sha256(text), hasData: true, dataName: "long.txt" };
    expect((await f.json("/SyncClipboard.json", "PUT", dto)).status).toBe(200);
    const profile = await (await f.request("/SyncClipboard.json")).json();
    expect(profile.size).toBe(text.length);
    expect(await Bun.file(join(f.config.dataDir, "file", "long.txt")).exists()).toBe(false);
    expect(await (await f.request(`/api/history/Text-${dto.hash}/data`)).text()).toBe(text);
  });

  test("unsafe names and hash paths cannot write outside storage", async () => {
    await using f = await fixture();
    for (const name of ["..%2Foutside", "%5Coutside", "x%00y", "C%3Afile"]) {
      expect((await f.request(`/file/${name}`, { method: "PUT", body: "bad" })).status).toBe(400);
    }
    expect((await f.json("/SyncClipboard.json", "PUT", { text: "x", hash: "../../outside" })).status).toBe(400);
    expect((await f.json("/SyncClipboard.json", "PUT", { type: "File", hasData: true, dataName: "../x" })).status).toBe(
      400,
    );
    expect((await f.request("/file/missing")).status).toBe(404);
  });

  test("Bun restart preserves current profile, history, and attachment data", async () => {
    await using f = await fixture();
    const group = await groupFixture({ "note.txt": "persist" });
    await f.request("/file/persist.zip", { method: "PUT", body: group.bytes });
    expect(
      (
        await f.json("/SyncClipboard.json", "PUT", {
          type: "Group",
          text: "note.txt",
          hash: group.hash,
          hasData: true,
          dataName: "persist.zip",
        })
      ).status,
    ).toBe(200);
    const before = await (await f.request("/SyncClipboard.json")).json();
    expect(await Bun.file(join(f.config.dataDir, "file", "persist.zip")).exists()).toBe(false);
    await f.stop();
    const restarted = createServer(f.config, { cleanup: false });
    try {
      const request = (path: string) => fetch(`${restarted.url}${path}`, { headers: { authorization: auth } });
      expect(await (await request("/SyncClipboard.json")).json()).toEqual(before);
      const data = await request(`/api/history/Group-${group.hash}/data`);
      expect(new Uint8Array(await data.arrayBuffer())).toEqual(group.bytes);
      expect((await (await request("/api/history/statistics")).json()).activeCount).toBe(1);
    } finally {
      await restarted.stop();
    }
  });

  test("body limit rejects oversized uploads and leaves no partial published file", async () => {
    await using f = await fixture({ maxBodyBytes: 1024 });
    const result = await f.request("/file/large.bin", { method: "PUT", body: "x".repeat(2048) });
    expect(result.status).toBe(413);
    expect(await Bun.file(join(f.config.dataDir, "file", "large.bin")).exists()).toBe(false);
  });

  test("history upload rejects invalid transfer headers and malformed multipart", async () => {
    await using f = await fixture();
    for (const header of ["", "invalid", `${sha256("x")}, ${sha256("y")}`]) {
      expect((await f.upload(textHistory("hello"), undefined, { [transferHashHeader]: header })).status).toBe(400);
    }
    expect((await f.upload(textHistory("hello"), undefined, { [transferHashHeader]: sha256("hello") })).status).toBe(
      400,
    );
    expect(
      (
        await f.request("/api/history", {
          method: "POST",
          headers: { "content-type": "multipart/form-data" },
          body: "broken",
        })
      ).status,
    ).toBe(400);
    expect((await f.request("/api/history", { method: "POST", body: "broken" })).status).toBe(415);
    expect(await readdir(f.history.profiles.temp)).toEqual([]);
    await rm(f.history.profiles.temp, { recursive: true });
  });
});

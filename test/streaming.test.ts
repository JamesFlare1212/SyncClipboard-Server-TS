import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMultipart } from "../src/multipart";
import { receiveFile } from "../src/files";
import { fixture } from "./helpers";

test("truncated multipart streams are rejected and all temporary data is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "syncclipboard-stream-"));
  try {
    const request = new Request("http://localhost/api/history", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=boundary" },
      body: '--boundary\r\nContent-Disposition: form-data; name="data"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\npartial',
    });
    await expect(readMultipart(request, root, 10000)).rejects.toThrow("incomplete");
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("aborting a staged file stream preserves the previous file and removes temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "syncclipboard-stream-"));
  try {
    const path = join(root, "file.bin");
    await Bun.write(path, "previous");
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull(stream) {
        stream.enqueue(new TextEncoder().encode("partial upload"));
        controller.abort();
        stream.close();
      },
    });
    const request = new Request("http://localhost/file/file.bin", {
      method: "PUT",
      body: stream,
      signal: controller.signal,
    });
    await expect(receiveFile(request, path, 10000)).rejects.toThrow();
    expect(await Bun.file(path).text()).toBe("previous");
    expect(await readdir(root)).toEqual(["file.bin"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("aborting a multipart file stream cleans staging and propagates cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "syncclipboard-stream-"));
  try {
    const controller = new AbortController();
    const request = new Request("http://localhost/api/history", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "multipart/form-data; boundary=boundary" },
      body: new ReadableStream<Uint8Array>({
        pull(stream) {
          stream.enqueue(
            new TextEncoder().encode(
              '--boundary\r\nContent-Disposition: form-data; name="data"; filename="a.bin"\r\n\r\npartial',
            ),
          );
          controller.abort(new DOMException("Canceled", "AbortError"));
          stream.close();
        },
      }),
    });
    await expect(readMultipart(request, root, 10000)).rejects.toThrow("Canceled");
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("interactive API documentation and bundled assets are available only when enabled", async () => {
  await using f = await fixture({ swagger: true });
  expect(await (await f.request("/swagger")).text()).toContain("SwaggerUIBundle");
  expect((await f.request("/swagger/swagger-ui.css")).headers.get("content-type")).toContain("text/css");
  expect((await f.request("/swagger/swagger-ui-bundle.js")).status).toBe(200);
  const spec = await (await f.request("/swagger/v1/swagger.json")).json();
  expect(spec.components.schemas.HistoryUpdate.properties.isDelete.type).toBe("boolean");
  expect(spec.paths["/api/history"].post.requestBody.content["multipart/form-data"].schema.properties.data.format).toBe(
    "binary",
  );
  await using disabled = await fixture();
  expect((await disabled.request("/swagger")).status).toBe(404);
});

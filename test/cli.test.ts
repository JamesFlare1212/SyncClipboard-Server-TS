import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auth } from "./helpers";

test("CLI starts from an isolated directory, serves requests, persists data and exits on SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "syncclipboard-cli-"));
  let entry = resolve(import.meta.dir, "../src/index.ts");
  if (process.env.SYNCCLIPBOARD_TEST_BUNDLE) {
    entry = join(root, "index.js");
    await copyFile(resolve(process.env.SYNCCLIPBOARD_TEST_BUNDLE), entry);
  }
  const env = {
    PATH: process.env.PATH,
    SYNCCLIPBOARD_USERNAME: "test",
    SYNCCLIPBOARD_PASSWORD: "pass:word",
    SYNCCLIPBOARD_SWAGGER: "true",
  };
  const child = Bun.spawn(
    [process.execPath, entry, "--port", "0", "--host", "127.0.0.1", "--data-dir", join(root, "data")],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env,
    },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(`Server failed to start: ${await new Response(child.stderr).text()}`);
      }
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    const url = /listening on (http:\/\/[^\s]+)/.exec(output)?.[1];
    expect(url).toBeDefined();
    const probe = (overrides: Record<string, string> = {}) =>
      Bun.spawn([process.execPath, entry, "--healthcheck", "--host", "0.0.0.0", "--port", new URL(url!).port], {
        cwd: root,
        env: { ...env, HTTP_PROXY: "http://127.0.0.1:1", ...overrides },
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    expect(await probe()).toBe(0);
    expect(await probe({ SYNCCLIPBOARD_PASSWORD: "wrong" })).toBe(1);
    const configPath = join(root, "health-config.json");
    await Bun.write(
      configPath,
      JSON.stringify({ AppSettings: { UserName: env.SYNCCLIPBOARD_USERNAME, Password: env.SYNCCLIPBOARD_PASSWORD } }),
    );
    expect(
      await probe({ SYNCCLIPBOARD_USERNAME: "", SYNCCLIPBOARD_PASSWORD: "", SYNCCLIPBOARD_CONFIG: configPath }),
    ).toBe(0);
    const headers = { authorization: auth, "content-type": "application/json" };
    expect((await fetch(`${url}/`, { headers })).status).toBe(200);
    expect(
      (await fetch(`${url}/SyncClipboard.json`, { method: "PUT", headers, body: JSON.stringify({ text: "CLI data" }) }))
        .status,
    ).toBe(200);
    expect((await fetch(`${url}/swagger/swagger-ui-bundle.js`, { headers })).status).toBe(200);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await probe()).toBe(1);
    expect((await Bun.file(join(root, "data/SyncClipboard.json")).json()).text).toBe("CLI data");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

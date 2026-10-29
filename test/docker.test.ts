import { expect, test } from "bun:test";
import { fileProfileHash, sha256 } from "../src/files";
import { transferHashHeader } from "../src/models";

const image = process.env.SYNCCLIPBOARD_TEST_DOCKER_IMAGE;

async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`docker ${args[0]} failed (${code}): ${stderr}`);
  }
  return stdout.trim();
}

test.skipIf(!image)(
  "container runs without root, authenticates, preserves profiles and attachments across recreation, and exits cleanly",
  async () => {
    const name = `syncclipboard-smoke-${crypto.randomUUID()}`;
    const volume = `${name}-data`;
    const platform = process.env.SYNCCLIPBOARD_TEST_DOCKER_PLATFORM;
    const authorization = `Basic ${Buffer.from("smoke:container-test").toString("base64")}`;
    let url = "";
    let passed = false;
    const request = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", authorization);
      return fetch(`${url}${path}`, { ...init, headers, signal: AbortSignal.timeout(5000) });
    };
    const start = async () => {
      await docker(
        "run",
        "--detach",
        "--name",
        name,
        "--health-interval",
        "1s",
        ...(platform ? ["--platform", platform] : []),
        "--publish",
        "127.0.0.1::5033",
        "--mount",
        `type=volume,source=${volume},target=/app/server`,
        "--env",
        "SYNCCLIPBOARD_USERNAME=smoke",
        "--env",
        "SYNCCLIPBOARD_PASSWORD=container-test",
        "--env",
        "SYNCCLIPBOARD_SWAGGER=true",
        image!,
      );
      const address = await docker("port", name, "5033/tcp");
      expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
      url = `http://${address}`;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
          if (
            response.status === 401 &&
            (await docker("inspect", "--format", "{{.State.Health.Status}}", name)) === "healthy"
          ) {
            return;
          }
        } catch {
          // Container networking can be ready before the server and its health check.
        }
        if ((await docker("inspect", "--format", "{{.State.Running}}", name)) !== "true") {
          throw new Error("Container exited before it became ready.");
        }
        await Bun.sleep(100);
      }
      throw new Error("Container did not become ready within 60 seconds.");
    };
    await docker("volume", "create", volume);
    try {
      await start();
      expect(await docker("exec", name, "id", "-u")).not.toBe("0");
      expect((await fetch(url, { signal: AbortSignal.timeout(5000) })).status).toBe(401);
      expect(await (await request("/")).text()).toBe("Server is running.");
      const css = await request("/swagger/swagger-ui.css");
      expect(css.status).toBe(200);
      expect(await css.text()).toContain("swagger-ui");

      const bytes = new Uint8Array([0, 1, 2, 255, 10]);
      const hash = fileProfileHash("persist.bin", sha256(bytes));
      expect((await request("/file/persist.bin", { method: "PUT", body: bytes })).status).toBe(200);
      expect(
        (
          await request("/SyncClipboard.json", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "File",
              text: "persist.bin",
              dataName: "persist.bin",
              hasData: true,
              hash,
              transferDataHash: sha256(bytes),
            }),
          })
        ).status,
      ).toBe(200);
      const profile = await (await request("/SyncClipboard.json")).json();
      expect(profile.hash).toBe(hash);
      expect((await (await request("/api/history/statistics")).json()).activeCount).toBe(1);

      await docker("stop", "--time", "10", name);
      expect(await docker("inspect", "--format", "{{.State.ExitCode}}", name)).toBe("0");
      await docker("rm", name);
      await start();
      expect(await (await request("/SyncClipboard.json")).json()).toEqual(profile);
      expect((await (await request("/api/history/statistics")).json()).activeCount).toBe(1);
      const download = await request(`/api/history/File-${hash}/data`);
      expect(download.status).toBe(200);
      expect(download.headers.get(transferHashHeader)).toBe(sha256(bytes));
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
      passed = true;
    } finally {
      if (!passed) {
        console.error(await docker("logs", name).catch(String));
      }
      await docker("rm", "--force", name).catch(() => {});
      await docker("volume", "rm", volume);
    }
  },
  180_000,
);

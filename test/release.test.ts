import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const prepare = resolve(import.meta.dir, "../.github/scripts/prepare-release.sh");

async function releaseFixture(release: "missing" | "draft" | "published", failures: Record<string, boolean> = {}) {
  const root = await mkdtemp(join(tmpdir(), "syncclipboard-release-"));
  const state = join(root, "state.json");
  const output = join(root, "output");
  const asset = join(root, "server.tar.gz");
  await Bun.write(state, JSON.stringify({ release, ...failures, creates: 0, uploads: 0 }));
  await Bun.write(asset, "verified archive");
  await Bun.write(
    join(root, "gh"),
    `#!/usr/bin/env bun
const file = Bun.file(process.env.RELEASE_TEST_STATE);
const state = await file.json();
const args = process.argv.slice(2);
let code = 0;
if (!["release", "api"].includes(args[0])) {
  throw new Error("Unexpected command");
}
switch (args[0] === "api" ? "view" : args[1]) {
  case "view":
    if (state.failView) {
      process.stdout.write("HTTP/2.0 403 Forbidden\\n\\n{}");
      code = 1;
    } else if (state.release === "missing") {
      process.stdout.write("HTTP/2.0 404 Not Found\\n\\n{}");
      code = 1;
    } else {
      process.stdout.write("HTTP/2.0 200 OK\\ncontent-type: application/json\\n\\n" + String(state.release === "draft"));
    }
    break;
  case "create":
    state.creates++;
    if (state.failCreate || state.release !== "missing") code = 1;
    else state.release = args.includes("--draft") ? "draft" : "published";
    break;
  case "upload":
    state.uploads++;
    if (state.failUpload) code = 1;
    else state.asset = await Bun.file(args[3]).text();
    break;
  default:
    throw new Error("Unexpected release operation");
}
await Bun.write(file, JSON.stringify(state));
process.exit(code);
`,
  );
  await chmod(join(root, "gh"), 0o755);
  const read = () => Bun.file(state).json();
  return {
    asset,
    read,
    async update(values: Record<string, unknown>) {
      await Bun.write(state, JSON.stringify({ ...(await read()), ...values }));
    },
    async run() {
      await Bun.write(output, "");
      const child = Bun.spawn(["bash", prepare, "v1.0.0", asset], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${root}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          RELEASE_TEST_STATE: state,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "test/repository",
        },
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr, output: await Bun.file(output).text() };
    },
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform === "win32")("release preparation with a simulated GitHub CLI", () => {
  test("failed asset upload leaves a draft that a rerun completes without creating another release", async () => {
    await using f = await releaseFixture("missing", { failUpload: true });
    const failed = await f.run();
    expect(failed.code).not.toBe(0);
    expect(failed.output).toBe("");
    expect(await f.read()).toMatchObject({ release: "draft", creates: 1, uploads: 1 });
    await f.update({ failUpload: false });
    expect((await f.run()).output).toBe("published=false\n");
    expect(await f.read()).toMatchObject({ release: "draft", creates: 1, uploads: 2, asset: "verified archive" });
  });

  test("rerunning an already published release skips changes to assets and image tags", async () => {
    await using f = await releaseFixture("published");
    expect(await f.run()).toMatchObject({ code: 0, output: "published=true\n" });
    expect(await f.read()).toEqual({ release: "published", creates: 0, uploads: 0 });
  });

  test("release creation failure stops before uploading or signaling readiness to push images", async () => {
    await using f = await releaseFixture("missing", { failCreate: true });
    const failed = await f.run();
    expect(failed.code).not.toBe(0);
    expect(failed.output).toBe("");
    expect(await f.read()).toMatchObject({ release: "missing", creates: 1, uploads: 0 });
  });

  test("missing assets fail before changing the remote release", async () => {
    await using f = await releaseFixture("missing");
    await rm(f.asset);
    const failed = await f.run();
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("missing or empty");
    expect(await f.read()).toEqual({ release: "missing", creates: 0, uploads: 0 });
  });

  test("API failure is not mistaken for a missing release", async () => {
    await using f = await releaseFixture("missing", { failView: true });
    const failed = await f.run();
    expect(failed.code).not.toBe(0);
    expect(failed.output).toBe("");
    expect(await f.read()).toMatchObject({ release: "missing", creates: 0, uploads: 0 });
  });
});

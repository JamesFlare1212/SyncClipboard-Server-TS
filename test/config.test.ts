import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { normalizeHash } from "../src/models";

describe("configuration and SHA-256 compatibility", () => {
  test("legacy JSON comments and trailing commas, env precedence and retention values", async () => {
    const root = await mkdtemp(join(tmpdir(), "syncclipboard-config-"));
    try {
      await Bun.write(
        join(root, "appsettings.json"),
        `{
        // ASP.NET Core configuration
        "AppSettings": { "UserName": "file-user", "Password": "file-password", "MaxSavedHistoryCount": 10, "HistoryRetentionMinutes": 60, },
        "Kestrel": { "Endpoints": { "http": { "Url": "http://*:5100" } } }
      }`,
      );
      const file = loadConfig(root, {});
      expect(file.username).toBe("file-user");
      expect(file.password).toBe("file-password");
      expect(file.port).toBe(5100);
      expect(file.hostname).toBe("0.0.0.0");
      expect(file.maxHistoryCount).toBe(10);
      expect(file.retentionMinutes).toBe(60);
      expect(file.dataDir).toBe(join(root, "server"));
      const env = loadConfig(root, {
        SYNCCLIPBOARD_USERNAME: "env-user",
        SYNCCLIPBOARD_PASSWORD: "env-pass",
        AppSettings__UserName: "section-user",
        AppSettings__MaxSavedHistoryCount: "0",
        AppSettings__HistoryRetentionMinutes: "120",
        PORT: "5200",
        HOST: "127.0.0.1",
      });
      expect(env.username).toBe("env-user");
      expect(env.password).toBe("env-pass");
      expect(env.port).toBe(5200);
      expect(env.maxHistoryCount).toBe(0);
      expect(env.retentionMinutes).toBe(120);
      expect(loadConfig(root, { SYNCCLIPBOARD_USERNAME: "partial" }).username).toBe("file-user");
      expect(() => loadConfig(root, { PORT: "bad" })).toThrow("PORT");
      expect(() => loadConfig(root, { AppSettings__HistoryRetentionMinutes: "-1" })).toThrow("HistoryRetentionMinutes");
      expect(() => loadConfig(root, { SYNCCLIPBOARD_CONFIG: "missing.json" })).toThrow("not found");
      await Bun.write(join(root, "appsettings.json"), "{broken");
      expect(() => loadConfig(root, {})).toThrow("Invalid configuration");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("default config and explicit TLS PEM configuration", () => {
    const root = "/tmp/syncclipboard-nonexistent-config-directory";
    expect(loadConfig(root, {}).port).toBe(5033);
    expect(loadConfig(root, {}).username).toBe("admin");
    expect(() => loadConfig(root, { ASPNETCORE_URLS: "https://0.0.0.0:5033" })).toThrow("PEM");
    const config = loadConfig(root, {
      ASPNETCORE_URLS: "https://0.0.0.0:5033",
      SYNCCLIPBOARD_TLS_CERT: "cert.pem",
      SYNCCLIPBOARD_TLS_KEY: "key.pem",
    });
    expect(config.tls).toEqual({ cert: join(root, "cert.pem"), key: join(root, "key.pem") });
  });

  test("malformed declared hashes are rejected, missing and lowercase hashes remain supported", () => {
    for (const hash of ["", " ", "malformed", "A".repeat(63), "A".repeat(65), "G".repeat(64), ` ${"A".repeat(64)}`]) {
      expect(() => normalizeHash(hash)).toThrow();
    }
    expect(normalizeHash(null)).toBeUndefined();
    expect(normalizeHash("a".repeat(64))).toBe("A".repeat(64));
  });
});

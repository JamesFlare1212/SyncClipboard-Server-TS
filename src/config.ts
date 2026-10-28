import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";

export interface Config {
  hostname: string;
  port: number;
  dataDir: string;
  username: string;
  password: string;
  maxHistoryCount: number;
  retentionMinutes: number;
  maxBodyBytes: number;
  maxExtractedBytes: number;
  maxArchiveEntries: number;
  swagger: boolean;
  tls?: { cert: string; key: string };
}

function integer(value: unknown, fallback: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (value == null || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}.`);
  }
  return number;
}

export function loadConfig(cwd = process.cwd(), env = process.env): Config {
  const path = resolve(cwd, env.SYNCCLIPBOARD_CONFIG ?? "appsettings.json");
  let settings: Record<string, any> = {};
  if (existsSync(path)) {
    const errors: ParseError[] = [];
    settings = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
    if (errors.length || !settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error(`Invalid configuration: ${path}`);
    }
  } else if (env.SYNCCLIPBOARD_CONFIG) {
    throw new Error(`Configuration not found: ${path}`);
  }
  const app = settings.AppSettings ?? {};
  const endpoint = Object.values(settings.Kestrel?.Endpoints ?? {})[0] as { Url?: string } | undefined;
  const rawUrl = env.ASPNETCORE_URLS ?? settings.Urls ?? endpoint?.Url ?? "http://0.0.0.0:5033";
  if (rawUrl.includes(";")) {
    throw new Error("Configure a single HTTP or HTTPS endpoint.");
  }
  const url = new URL(rawUrl.replace("://*", "://0.0.0.0").replace("://+", "://0.0.0.0"));
  const envCredentials = !!env.SYNCCLIPBOARD_USERNAME && !!env.SYNCCLIPBOARD_PASSWORD;
  const config: Config = {
    hostname: env.HOST ?? url.hostname,
    port: integer(env.PORT ?? url.port, url.protocol === "https:" ? 443 : 80, "PORT", 65535),
    dataDir: resolve(cwd, env.SYNCCLIPBOARD_DATA_DIR ?? "server"),
    username: envCredentials ? env.SYNCCLIPBOARD_USERNAME! : (env.AppSettings__UserName ?? app.UserName ?? "admin"),
    password: envCredentials ? env.SYNCCLIPBOARD_PASSWORD! : (env.AppSettings__Password ?? app.Password ?? "admin"),
    maxHistoryCount: integer(
      env.AppSettings__MaxSavedHistoryCount ?? app.MaxSavedHistoryCount,
      1000,
      "MaxSavedHistoryCount",
    ),
    retentionMinutes: integer(
      env.AppSettings__HistoryRetentionMinutes ?? app.HistoryRetentionMinutes,
      0,
      "HistoryRetentionMinutes",
    ),
    maxBodyBytes: integer(env.SYNCCLIPBOARD_MAX_BODY_BYTES, 2_147_483_647, "SYNCCLIPBOARD_MAX_BODY_BYTES"),
    maxExtractedBytes: integer(
      env.SYNCCLIPBOARD_MAX_EXTRACTED_BYTES,
      2_147_483_647,
      "SYNCCLIPBOARD_MAX_EXTRACTED_BYTES",
    ),
    maxArchiveEntries: integer(env.SYNCCLIPBOARD_MAX_ARCHIVE_ENTRIES, 100_000, "SYNCCLIPBOARD_MAX_ARCHIVE_ENTRIES"),
    swagger:
      env.SYNCCLIPBOARD_SWAGGER === "true" ||
      env.NODE_ENV === "development" ||
      env.ASPNETCORE_ENVIRONMENT === "Development",
  };
  if (typeof config.username !== "string" || typeof config.password !== "string") {
    throw new Error("UserName and Password must be strings.");
  }
  if (url.protocol === "https:") {
    const cert = env.SYNCCLIPBOARD_TLS_CERT ?? settings.Kestrel?.Certificates?.Default?.Path;
    const key = env.SYNCCLIPBOARD_TLS_KEY ?? settings.Kestrel?.Certificates?.Default?.KeyPath;
    if (!cert || !key) {
      throw new Error("HTTPS requires a PEM certificate and key.");
    }
    config.tls = { cert: resolve(cwd, cert), key: resolve(cwd, key) };
  } else if (url.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS endpoints are supported.");
  }
  return config;
}

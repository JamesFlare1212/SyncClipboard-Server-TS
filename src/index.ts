import { parseArgs } from "node:util";
import { loadConfig } from "./config";
import { createServer } from "./server";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string" },
    host: { type: "string" },
    "data-dir": { type: "string" },
    config: { type: "string" },
    urls: { type: "string" },
    help: { type: "boolean", short: "h" },
    healthcheck: { type: "boolean" },
  },
});

if (values.help) {
  console.log(
    "SyncClipboard Server\nUsage: bun start [--port 5033] [--host 0.0.0.0] [--data-dir server] [--config appsettings.json] [--urls http://0.0.0.0:5033] [--healthcheck]",
  );
} else {
  const env = { ...process.env };
  if (values.port) {
    env.PORT = values.port;
  }
  if (values.host) {
    env.HOST = values.host;
  }
  if (values["data-dir"]) {
    env.SYNCCLIPBOARD_DATA_DIR = values["data-dir"];
  }
  if (values.config) {
    env.SYNCCLIPBOARD_CONFIG = values.config;
  }
  if (values.urls) {
    env.ASPNETCORE_URLS = values.urls;
  }
  const config = loadConfig(process.cwd(), env);
  if (values.healthcheck) {
    try {
      const host = config.hostname.replace(/^\[|\]$/g, "");
      const address = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
      const hostname = address.includes(":") ? `[${address}]` : address;
      const response = await fetch(`${config.tls ? "https" : "http"}://${hostname}:${config.port}/`, {
        headers: { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` },
        signal: AbortSignal.timeout(3000),
        proxy: false,
        redirect: "error",
        // This instance may use a self-signed certificate or a certificate for its public hostname.
        ...(config.tls ? { tls: { rejectUnauthorized: false } } : {}),
      });
      if (!response.ok || (await response.text()) !== "Server is running.") {
        throw new Error(`Unexpected health check response: HTTP ${response.status}.`);
      }
      process.exit(0);
    } catch (error) {
      console.error("Health check failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else {
    const app = createServer(config);
    console.log(`SyncClipboard Server listening on ${app.url}`);
    const stop = async () => {
      await app.stop();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
}

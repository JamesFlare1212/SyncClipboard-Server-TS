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
  },
});

if (values.help) {
  console.log(
    "SyncClipboard Server\nUsage: bun start [--port 5033] [--host 0.0.0.0] [--data-dir server] [--config appsettings.json] [--urls http://0.0.0.0:5033]",
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
  const app = createServer(loadConfig(process.cwd(), env));
  console.log(`SyncClipboard Server listening on ${app.url}`);
  const stop = async () => {
    await app.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

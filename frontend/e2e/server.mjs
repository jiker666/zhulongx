import { resolve } from "node:path";
import { loadConfig } from "../../dist/config.js";
import { startApiServer } from "../../dist/server.js";

process.chdir(resolve(import.meta.dirname, "../.."));
const config = await loadConfig("config/default.yaml");
config.server.host = "127.0.0.1";
config.server.port = 17318;
const running = await startApiServer(config);
console.log(`E2E server listening at ${running.url}`);
const close = async () => { await running.close(); process.exit(0); };
process.on("SIGINT", close);
process.on("SIGTERM", close);

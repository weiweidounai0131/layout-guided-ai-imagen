import { startLocalService, stopLocalService } from "./server.mjs";

// The CLI runner starts this small detached process when no healthy local
// service is discoverable. It intentionally exposes only the existing local
// HTTP service; all session/listener state remains in the shared data root.
const service = await startLocalService({
  rootDir: process.env.LAYOUT_GUIDED_PLUGIN_ROOT || undefined,
  dataRoot: process.env.LAYOUT_GUIDED_DATA_DIR || undefined,
  host: process.env.LAYOUT_GUIDED_SERVICE_HOST || "127.0.0.1",
  port: Number.isInteger(Number(process.env.LAYOUT_GUIDED_SERVICE_PORT))
    ? Number(process.env.LAYOUT_GUIDED_SERVICE_PORT)
    : 0
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stopLocalService(service).catch(() => {});
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGHUP", shutdown);
process.once("uncaughtException", async () => shutdown());
process.once("unhandledRejection", async () => shutdown());

// Keep the daemon alive solely through the HTTP server. A detached child has
// no interactive stdin/stdout contract; discovery metadata is written by the
// service itself with mode 0600.

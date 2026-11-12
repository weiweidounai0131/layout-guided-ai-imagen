import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-marketplace-"));
const marketplaceDirectory = path.join(temporaryRoot, ".agents", "plugins");
const pluginLink = path.join(temporaryRoot, "plugins", "layout-guided-ai-imagen");

try {
  await fs.mkdir(marketplaceDirectory, { recursive: true });
  await fs.mkdir(path.dirname(pluginLink), { recursive: true });
  await fs.symlink(root, pluginLink, "dir");
  await fs.writeFile(
    path.join(marketplaceDirectory, "marketplace.json"),
    `${JSON.stringify({
      name: "stage0-local",
      interface: { displayName: "Stage 0 Local" },
      plugins: [{
        name: "layout-guided-ai-imagen",
        source: { source: "local", path: "./plugins/layout-guided-ai-imagen" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity"
      }]
    }, null, 2)}\n`
  );

  const { stdout } = await run("codex", [
    "plugin", "list", "--available", "--json",
    "-c", "marketplaces.stage0_local.source_type=\"local\"",
    "-c", `marketplaces.stage0_local.source=\"${temporaryRoot}\"`
  ], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  const discovered = [...(result.installed ?? []), ...(result.available ?? [])]
    .find((plugin) => plugin.pluginId === "layout-guided-ai-imagen@stage0-local");
  assert.ok(discovered, "Codex CLI did not discover the local plugin");
  assert.equal(discovered.installed, false);
  assert.equal(discovered.enabled, false);
  assert.equal(discovered.version, "0.2.11");
  console.log(JSON.stringify({ pluginId: discovered.pluginId, installed: discovered.installed, version: discovered.version }));
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

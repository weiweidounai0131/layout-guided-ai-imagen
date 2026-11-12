import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.resolve(process.argv[2] || root);
const dataRoot = path.resolve(process.env.LAYOUT_GUIDED_DATA_DIR || await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-mcp-apps-smoke-")));
const cleanupData = !process.env.LAYOUT_GUIDED_DATA_DIR;
const child = spawn(process.execPath, [path.join(pluginRoot, "mcp", "server.mjs")], {
  cwd: pluginRoot,
  env: { ...process.env, LAYOUT_GUIDED_DATA_DIR: dataRoot }
});

let stderr = "";
let stdout = "";
const responses = new Map();
child.stderr.setEncoding("utf8");
child.stdout.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  for (const line of stdout.split("\n").slice(0, -1)) {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined) responses.set(String(message.id), message);
    } catch { /* wait for a complete JSON line */ }
  }
  stdout = stdout.slice(stdout.lastIndexOf("\n") + 1);
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitForResponse(id, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = responses.get(String(id));
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for MCP response ${id}; stderr=${stderr.trim()}`);
}

try {
  const readyDeadline = Date.now() + 10000;
  while (!/service_ready_v11 port=\d+/.test(stderr) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(stderr, /service_ready_v11 port=\d+/);

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "resources/list" });
  send({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "ui://layout-guided-ai-imagen/workbench-v1.html" } });
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "open_layout_workbench", arguments: { session_id: "stage4-host-smoke" } } });

  const initialize = await waitForResponse(1);
  const tools = (await waitForResponse(2)).result.tools;
  const workbenchTool = tools.find((tool) => tool.name === "open_layout_workbench");
  assert.ok(workbenchTool);
  const resources = (await waitForResponse(3)).result.resources;
  const resource = (await waitForResponse(4)).result.contents[0];
  const open = (await waitForResponse(5)).result;
  assert.deepEqual(initialize.result.capabilities.resources, { listChanged: false });
  assert.equal(workbenchTool._meta.ui.resourceUri, "ui://layout-guided-ai-imagen/workbench-v1.html");
  assert.equal(resources[0].uri, workbenchTool._meta.ui.resourceUri);
  assert.equal(resource.mimeType, "text/html;profile=mcp-app");
  for (const bridgeMethod of ["ui/initialize", "ui/notifications/tool-result", "tools/call", "ui/message"]) assert.match(resource.text, new RegExp(bridgeMethod.replaceAll("/", "\\/")));
  assert.equal(open._meta["openai/outputTemplate"], workbenchTool._meta.ui.resourceUri);
  assert.equal(open.structuredContent?.open_policy, "open_in_codex_first; browser_url_only_after_explicit_failure; one_page_per_session");
  process.stdout.write(`${JSON.stringify({
    status: "MCP Apps resource contract passed",
    plugin_root: pluginRoot,
    service_ready: stderr.match(/service_ready_v11 port=(\d+)/)?.[1] || null,
    initialize_capabilities: initialize.result.capabilities,
    tool_resource_uri: workbenchTool._meta.ui.resourceUri,
    resources_list: resources.map((item) => ({ uri: item.uri, mimeType: item.mimeType })),
    resource: { mimeType: resource.mimeType, bytes: resource.text.length, bridge_methods_present: true },
    open: { session_id: open.structuredContent?.session_id, resource_uri: open.structuredContent?.resource_uri, output_template: open._meta["openai/outputTemplate"] }
  })}\n`);
} finally {
  child.kill("SIGTERM");
  if (cleanupData) await fs.rm(dataRoot, { recursive: true, force: true });
}

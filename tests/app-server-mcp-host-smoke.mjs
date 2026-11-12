import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codex = process.env.CODEX_CLI_PATH || "codex";
const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-app-server-smoke-"));
await fs.mkdir(path.join(isolatedHome, "codex-home"), { recursive: true });
const configValue = `mcp_servers.stage4_host={command="node",args=["mcp/server.mjs"],cwd="${root}",enabled=true}`;
const child = spawn(codex, ["app-server", "--listen", "stdio://", "-c", configValue], {
  cwd: root,
  env: { ...process.env, CODEX_HOME: path.join(isolatedHome, "codex-home") }
});

let stdout = "";
let stderr = "";
const responses = new Map();
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  const lines = stdout.split("\n");
  stdout = lines.pop() || "";
  for (const line of lines) {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined) responses.set(String(message.id), message);
    } catch { /* app-server notifications are not needed for this probe */ }
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk; });

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitForResponse(id, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = responses.get(String(id));
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timeout waiting for app-server response ${id}; stderr=${stderr.trim()}`);
}

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "stage4-mcp-host-smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } } });
  const initialize = await waitForResponse(1);
  assert.equal(initialize.error, undefined, JSON.stringify(initialize.error));
  send({ jsonrpc: "2.0", id: 2, method: "mcpServerStatus/list", params: { detail: "full" } });
  const status = await waitForResponse(2);
  assert.equal(status.error, undefined, JSON.stringify(status.error));
  const configured = status.result?.data?.find((server) => server.name === "stage4_host") || status.result?.servers?.find((server) => server.name === "stage4_host") || status.result?.servers?.find((server) => server.name === "stage4-host");
  if (!configured) throw new Error(`stage4_host was not visible in app-server status: ${JSON.stringify(status.result)}`);
  send({ jsonrpc: "2.0", id: 3, method: "thread/start", params: { cwd: root, approvalPolicy: "never", sandbox: "read-only", ephemeral: true } });
  const threadStart = await waitForResponse(3);
  assert.equal(threadStart.error, undefined, JSON.stringify(threadStart.error));
  const threadId = threadStart.result?.thread?.id || threadStart.result?.id;
  if (!threadId) throw new Error(`thread/start did not return a thread id: ${JSON.stringify(threadStart.result)}`);
  send({ jsonrpc: "2.0", id: 4, method: "mcpServer/tool/call", params: { server: configured.name, threadId, tool: "open_layout_workbench", arguments: { session_id: "stage4-app-server-smoke" } } });
  const toolCall = await waitForResponse(4);
  assert.equal(toolCall.error, undefined, JSON.stringify(toolCall.error));
  send({ jsonrpc: "2.0", id: 5, method: "mcpServer/resource/read", params: { server: configured.name, uri: "ui://layout-guided-ai-imagen/workbench-v1.html", originCallId: toolCall.result?.callId || null, threadId } });
  const resource = await waitForResponse(5);
  assert.equal(resource.error, undefined, JSON.stringify(resource.error));
  const content = resource.result?.contents?.[0];
  assert.equal(content?.mimeType, "text/html;profile=mcp-app");
  assert.match(content?.text || "", /ui\/initialize/);
  assert.match(content?.text || "", /ui\/message/);
  process.stdout.write(`${JSON.stringify({
    status: "app-server MCP resource read passed",
    app_server_version: initialize.result?.serverInfo?.version || null,
    mcp_server: configured.name,
    thread_id_present: true,
    tool_call: { structured_content_present: Boolean(toolCall.result?.structuredContent), resource_uri: toolCall.result?._meta?.["openai/outputTemplate"] || null },
    resource: { uri: content.uri, mimeType: content.mimeType, bytes: content.text.length, bridge_methods_present: true }
  })}\n`);
} finally {
  child.kill("SIGTERM");
  await fs.rm(isolatedHome, { recursive: true, force: true });
}

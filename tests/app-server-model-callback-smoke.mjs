import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureEntries = JSON.parse(await fs.readFile(path.join(root, "tests", "fixtures", "stage4-briefs.json"), "utf8"));
const fixture = fixtureEntries.find((entry) => entry.scenario === "candidate-switch");
const sessionId = `stage4-model-callback-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-model-callback-"));
const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-model-home-"));
await fs.mkdir(path.join(isolatedHome, "codex-home"), { recursive: true });
const codex = process.env.CODEX_CLI_PATH || "codex";
const configValue = `mcp_servers.stage4_host={command="node",args=["mcp/server.mjs"],cwd="${root}",enabled=true}`;
const child = spawn(codex, ["app-server", "--listen", "stdio://", "-c", configValue], {
  cwd: root,
  env: {
    ...process.env,
    LAYOUT_GUIDED_DATA_DIR: dataRoot,
    ...(process.env.STAGE4_USE_DEFAULT_CODEX_HOME === "1" ? {} : { CODEX_HOME: path.join(isolatedHome, "codex-home") })
  }
});

let stdout = "";
let stderr = "";
const responses = new Map();
const notifications = [];
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
      else if (message.method) notifications.push(message);
    } catch { /* wait for a complete JSON line */ }
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk; });

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitForResponse(id, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = responses.get(String(id));
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timeout waiting for app-server response ${id}`);
}

async function waitForTurnCompleted(threadId, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const completed = notifications.find((message) => message.method === "turn/completed" && message.params?.threadId === threadId);
    if (completed) return completed;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timeout waiting for turn/completed; notification_count=${notifications.length}`);
}

function parseToolResult(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") return result;
  try { return JSON.parse(text); } catch { return text; }
}

function toolNames(value, names = new Set()) {
  if (!value || typeof value !== "object") return names;
  if (typeof value.name === "string" && (value.type === "mcpToolCall" || value.type === "mcp_tool_call" || value.type === "mcp_tool_call_output" || value.tool || value.method === "mcpServer/tool/call")) names.add(value.name);
  for (const nested of Object.values(value)) toolNames(nested, names);
  return names;
}

function notificationSummary() {
  return notifications.map((message) => ({
    method: message.method,
    param_keys: Object.keys(message.params || {}),
    item_type: message.params?.item?.type || message.params?.item?.itemType || null,
    item_name: message.params?.item?.name || null,
    tool_name: message.params?.name || message.params?.tool || null
  }));
}

let outcome;
try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "stage4-model-callback-smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } } });
  const initialize = await waitForResponse(1);
  if (initialize.error) throw new Error(`initialize failed: ${initialize.error.message}`);
  send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: root, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, model: "gpt-5.6-luna" } });
  const threadStart = await waitForResponse(2);
  if (threadStart.error) throw new Error(`thread/start failed: ${threadStart.error.message}`);
  const threadId = threadStart.result?.thread?.id || threadStart.result?.id;
  if (!threadId) throw new Error(`thread/start returned no thread id: ${JSON.stringify(threadStart.result)}`);

  send({ jsonrpc: "2.0", id: 3, method: "mcpServer/tool/call", params: { server: "stage4_host", threadId, tool: "seed_layout_candidates", arguments: { session_id: sessionId, brief: fixture.brief, candidate_count: 3, auto_start: false } } });
  const seededResponse = await waitForResponse(3);
  if (seededResponse.error) throw new Error(`seed_layout_candidates failed: ${seededResponse.error.message}`);
  const seeded = parseToolResult(seededResponse.result);
  const candidate = seeded.candidates?.find((item) => item.candidate_id === "A");
  if (!candidate) throw new Error(`seed result did not contain candidate A: ${JSON.stringify(seeded)}`);
  send({ jsonrpc: "2.0", id: 4, method: "mcpServer/tool/call", params: { server: "stage4_host", threadId, tool: "submit_layout_change", arguments: { session_id: sessionId, candidate_id: "A", base_revision: 0, request: "将第一个可编辑对象向右移动一点，其他对象和文案保持不变" } } });
  const pendingResponse = await waitForResponse(4);
  if (pendingResponse.error) throw new Error(`submit_layout_change failed: ${pendingResponse.error.message}`);
  const pending = parseToolResult(pendingResponse.result);
  if (!pending.request_id) throw new Error(`submit result did not contain request_id: ${JSON.stringify(pending)}`);

  const prompt = [
    "这是一个隔离的 Stage 4 真实模型回调 smoke，只处理布局 MCP 工具。",
    "禁止调用任何生图、图像输入、web、shell 或文件工具；不要生成图片。",
    `session_id=${sessionId}，candidate_id=A，pending request_id=${pending.request_id}，base_revision=0。`,
    "请先调用 get_sketch_document 读取 A，然后选择第一个 unlocked 对象，用一个最小的 update_object operation 将其 x 增加 1，其他字段保持不变；最后必须调用 resolve_layout_change，status=applied、operations 为该结构化操作、request_id 使用上面的 pending ID。不要只回复说明文字。"
  ].join("\n");
  send({ jsonrpc: "2.0", id: 5, method: "turn/start", params: { threadId, input: [{ type: "text", text: prompt }], model: "gpt-5.6-luna", effort: "max", approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false }, turnTrigger: "stage4-model-callback-smoke" } });
  const turnStart = await waitForResponse(5);
  if (turnStart.error) throw new Error(`turn/start failed: ${turnStart.error.message}`);
  const turnCompleted = await waitForTurnCompleted(threadId);
  send({ jsonrpc: "2.0", id: 6, method: "mcpServer/tool/call", params: { server: "stage4_host", threadId, tool: "get_session_status", arguments: { session_id: sessionId } } });
  const statusResponse = await waitForResponse(6);
  if (statusResponse.error) throw new Error(`get_session_status failed: ${statusResponse.error.message}`);
  const session = parseToolResult(statusResponse.result);
  const requestRecord = session?.layout_requests?.find((item) => item.request_id === pending.request_id);
  const callbackApplied = requestRecord?.status === "applied" && (session?.candidates?.find((item) => item.candidate_id === "A")?.document?.revision || 0) > 0;
  outcome = {
    status: callbackApplied ? "PASS for isolated real model callback" : "UNVERIFIED",
    session_id: sessionId,
    thread_id_present: true,
    model: "gpt-5.6-luna",
    effort: "max",
    turn_status: turnCompleted.params?.turn?.status || null,
    callback: { request_id_present: true, status: requestRecord?.status || null, revision: session?.candidates?.find((item) => item.candidate_id === "A")?.document?.revision || null },
    observed_mcp_tool_names: [...toolNames(notifications)],
    notifications: notificationSummary().slice(-20),
    image_model_called: session?.image_model_called ?? null,
    stderr_tail: stderr.trim().slice(-1000)
  };
} catch (error) {
  outcome = {
    status: "UNVERIFIED",
    reason: error.message,
    session_id: sessionId,
    stderr_tail: stderr.trim().slice(-2000),
    notifications_observed: notificationSummary().slice(-12)
  };
}

process.stdout.write(`${JSON.stringify(outcome)}\n`);
child.kill("SIGTERM");
await fs.rm(dataRoot, { recursive: true, force: true });
await fs.rm(isolatedHome, { recursive: true, force: true });

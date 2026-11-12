import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// This is intentionally an evidence smoke, not a deterministic acceptance
// harness: it asks an isolated model turn to use the bundled CLI when MCP
// tools are unavailable, then reports PASS only if the model actually writes a
// revision through the CLI. The deterministic cross-process proof lives in
// cli-runner.test.mjs.
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "scripts", "layout-guided-ai-imagen.mjs");
const sessionId = `stage4-model-cli-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-model-cli-data-"));
const useDefaultHome = process.env.STAGE4_USE_DEFAULT_CODEX_HOME === "1";
const useDangerSandbox = process.env.STAGE4_MODEL_CLI_SANDBOX === "danger";
const isolatedHome = useDefaultHome ? null : await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-model-cli-home-"));
if (isolatedHome) await fs.mkdir(path.join(isolatedHome, "codex-home"), { recursive: true });
const codex = process.env.CODEX_CLI_PATH || "codex";

async function cli(args) {
  const result = await run(process.execPath, [runner, ...args, "--data-root", dataRoot], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(String(result.stdout).trim().split("\n").at(-1));
}

async function post(serviceUrl, requestPath, body) {
  const response = await fetch(new URL(requestPath, serviceUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

const started = await cli(["start", "--session", sessionId, "--demo"]);
const claimed = await cli(["claim", "--session", sessionId, "--lease-ms", "45000"]);
const pending = await post(started.service_url, `/api/session/${sessionId}/layout-change`, {
  candidate_id: "A",
  base_revision: 0,
  request: "将第一个可编辑对象向右移动一点，其他对象和文案保持不变"
});

const child = spawn(codex, ["app-server", "--listen", "stdio://"], {
  cwd: root,
  env: { ...process.env, ...(isolatedHome ? { CODEX_HOME: path.join(isolatedHome, "codex-home") } : {}) }
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

async function responseFor(id, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = responses.get(String(id));
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timeout waiting for app-server response ${id}`);
}

async function completed(threadId, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = notifications.find((message) => message.method === "turn/completed" && message.params?.threadId === threadId);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timeout waiting for turn completion; notifications=${notifications.length}`);
}

function toolNames(value, names = new Set()) {
  if (!value || typeof value !== "object") return names;
  if (typeof value.name === "string" && (value.type === "commandExecution" || value.type === "command_execution" || value.type === "mcpToolCall" || value.type === "mcp_tool_call" || value.tool)) names.add(value.name);
  for (const nested of Object.values(value)) toolNames(nested, names);
  return names;
}

let outcome;
try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "stage4-model-cli-runner-smoke", version: "0.2.3" }, capabilities: { experimentalApi: true } } });
  const initialize = await responseFor(1);
  if (initialize.error) throw new Error(`initialize failed: ${initialize.error.message}`);
  send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: root, approvalPolicy: "never", sandbox: useDangerSandbox ? "danger-full-access" : "workspace-write", ephemeral: true, model: "gpt-5.6-luna" } });
  const threadStart = await responseFor(2);
  if (threadStart.error) throw new Error(`thread/start failed: ${threadStart.error.message}`);
  const threadId = threadStart.result?.thread?.id || threadStart.result?.id;
  if (!threadId) throw new Error(`thread/start returned no thread id: ${JSON.stringify(threadStart.result)}`);

  const stateFile = claimed.listener_state_file;
  const prompt = [
    "这是一次隔离的 Stage 4 CLI fallback smoke。当前回合没有 Layout MCP tools；必须使用插件随附的 bundled CLI，不得搜索 ~/.codex，不得手写 Node/Python 客户端或 JSON-RPC。",
    `工作目录=${root}`,
    `session_id=${sessionId}`,
    `listener_state_file=${stateFile}`,
    `pending request_id=${pending.request_id}`,
    "请按顺序执行：1) 用 node scripts/layout-guided-ai-imagen.mjs wait --session <id> --state-file <path> --timeout-ms 30000 领取待处理请求；2) 用同一 runner 的 document --session <id> --candidate-id A 读取当前 SketchDocument；3) 只对第一个对象生成一个最小 update_object operation，把它的 x 增加 1，其他字段不变；4) 用 runner 的 resolve --status applied --request-id <id> --operations-json '<array>' 回写；5) 最后用 runner 的 status 检查 revision。不要只回复说明。",
    "不要调用生图、web、Computer Use 或其他外部服务。"
  ].join("\n");
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text: prompt }],
      model: "gpt-5.6-luna",
      effort: "max",
      approvalPolicy: "never",
      sandboxPolicy: useDangerSandbox
        ? { type: "dangerFullAccess" }
        : { type: "workspaceWrite", writableRoots: [root, dataRoot], networkAccess: false },
      turnTrigger: "stage4-model-cli-runner-smoke"
    }
  });
  const turnStart = await responseFor(3);
  if (turnStart.error) throw new Error(`turn/start failed: ${turnStart.error.message}`);
  const turnCompleted = await completed(threadId);
  const snapshotResponse = await fetch(new URL(`/api/session/${sessionId}`, started.service_url));
  const session = await snapshotResponse.json();
  const requestRecord = session.layout_requests?.find((item) => item.request_id === pending.request_id);
  const revision = session.candidates?.find((item) => item.candidate_id === "A")?.document?.revision ?? null;
  outcome = {
    status: requestRecord?.status === "applied" && revision > 0 ? "PASS for isolated model CLI fallback" : "UNVERIFIED",
    session_id: sessionId,
    thread_id_present: true,
    model: "gpt-5.6-luna",
    effort: "max",
    turn_status: turnCompleted.params?.turn?.status || null,
    callback: { request_id_present: true, status: requestRecord?.status || null, revision },
    observed_command_or_tool_names: [...toolNames(notifications)],
    notifications: notifications.slice(-24).map((message) => ({ method: message.method, param_keys: Object.keys(message.params || {}), item_type: message.params?.item?.type || null })),
    stderr_tail: stderr.trim().slice(-1500)
  };
} catch (error) {
  outcome = { status: "UNVERIFIED", reason: error.message, session_id: sessionId, observed_command_or_tool_names: [...toolNames(notifications)], stderr_tail: stderr.trim().slice(-2000), notifications: notifications.slice(-12).map((message) => ({ method: message.method, param_keys: Object.keys(message.params || {}), item_type: message.params?.item?.type || null })) };
}

process.stdout.write(`${JSON.stringify(outcome)}\n`);
child.kill("SIGTERM");
try { process.kill(Number(started.service_pid), "SIGTERM"); } catch { /* already exited */ }
await fs.rm(dataRoot, { recursive: true, force: true });
if (isolatedHome) await fs.rm(isolatedHome, { recursive: true, force: true });

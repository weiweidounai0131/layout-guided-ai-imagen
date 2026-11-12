#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const MODULE_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(MODULE_PATH), "..");
const SERVICE_DAEMON = path.join(PLUGIN_ROOT, "mcp", "service-daemon.mjs");
const DEFAULT_DATA_ROOT = path.join(os.tmpdir(), "layout-guided-ai-imagen-v11");
const SERVICE_DISCOVERY_FILENAME = ".layout-guided-service.json";
const LISTENER_STATE_DIR = ".listeners";
const CLI_VERSION = "0.2.11";
const MAX_WAIT_MS = 30_000;

function usage() {
  return [
    "Layout-Guided AI Imagen CLI runner (Stage 4 listener fallback)",
    "",
    "Usage:",
    "  node scripts/layout-guided-ai-imagen.mjs start --session <id> [--demo]",
    "  node scripts/layout-guided-ai-imagen.mjs prepare --session <id> --brief-file <poster-brief.json> [--candidate-count 3]",
    "  node scripts/layout-guided-ai-imagen.mjs prepare --session <id> --demo",
    "  node scripts/layout-guided-ai-imagen.mjs claim --session <id>",
    "  node scripts/layout-guided-ai-imagen.mjs wait --state-file <path> [--timeout-ms 30000]",
    "  node scripts/layout-guided-ai-imagen.mjs heartbeat --state-file <path>",
    "  node scripts/layout-guided-ai-imagen.mjs resolve --state-file <path> --status applied --operations-file <path>",
    "  node scripts/layout-guided-ai-imagen.mjs cancel --state-file <path> [--request-id <id>]",
    "  node scripts/layout-guided-ai-imagen.mjs release --state-file <path>",
    "  node scripts/layout-guided-ai-imagen.mjs status --session <id>",
    "  node scripts/layout-guided-ai-imagen.mjs confirmation-status --session <id>",
    "  node scripts/layout-guided-ai-imagen.mjs generation-preflight --session <id>",
    "  node scripts/layout-guided-ai-imagen.mjs document --session <id> --candidate-id A",
    "",
    "prepare validates the PosterBrief, injects A/B/C into the same session, waits for committed batches, and is idempotent for the same brief.",
    "A different brief never overwrites an existing session; choose a new session (or an explicit replacement workflow). Invalid JSON/missing fields/conflicts fail closed.",
    "All commands emit one JSON result. Claim writes an opaque lease to a 0600 state file; wait returns one bounded action or timeout heartbeat.",
    "The browser and this runner use the same local service and data root. New non-demo sessions start empty; football content is only the explicit --demo fixture."
  ].join("\n");
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      (options._ ??= []).push(item);
      continue;
    }
    const equals = item.indexOf("=");
    if (equals > 2) {
      options[item.slice(2, equals)] = item.slice(equals + 1);
      continue;
    }
    const key = item.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { command, options };
}

function resolvedDataRoot(options) {
  return path.resolve(String(options["data-root"] || process.env.LAYOUT_GUIDED_DATA_DIR || DEFAULT_DATA_ROOT));
}

function resolvedSessionId(options) {
  const sessionId = String(options.session || options["session-id"] || "demo");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new Error("session id must contain only letters, numbers, _ or -");
  return sessionId;
}

function discoveryPath(dataRoot) {
  return path.join(dataRoot, SERVICE_DISCOVERY_FILENAME);
}

function safeStateName(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

function defaultStatePath(dataRoot, sessionId, listenerId) {
  return path.join(dataRoot, LISTENER_STATE_DIR, `${safeStateName(sessionId)}.${safeStateName(listenerId)}.json`);
}

async function writePrivateJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function pidIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function requestJson(service, requestPath, { method = "GET", body, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(requestPath, service.url), {
      method,
      cache: "no-store",
      signal: controller.signal,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = await response.text();
    let value;
    try { value = JSON.parse(raw); } catch { value = { error: raw || response.statusText }; }
    if (!response.ok) throw new Error(value?.error || `local service request failed (${response.status})`);
    return value;
  } finally {
    clearTimeout(timer);
  }
}

async function healthyDiscovery(dataRoot, discovery) {
  if (!discovery || path.resolve(String(discovery.data_root || "")) !== dataRoot) return null;
  if (!pidIsAlive(discovery.pid)) return null;
  if (typeof discovery.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(discovery.url)) return null;
  try {
    const health = await requestJson(discovery, "/health", { timeoutMs: 1200 });
    if (health?.ok !== true || health?.service !== "layout-guided-ai-imagen-stage4-v11") return null;
    return discovery;
  } catch {
    return null;
  }
}

async function readHealthyDiscovery(dataRoot) {
  try {
    return await healthyDiscovery(dataRoot, await readJson(discoveryPath(dataRoot)));
  } catch {
    return null;
  }
}

async function waitForDiscovery(dataRoot, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const discovered = await readHealthyDiscovery(dataRoot);
    if (discovered) return discovered;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("local layout service did not become healthy");
}

async function ensureService(options) {
  const dataRoot = resolvedDataRoot(options);
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const existing = await readHealthyDiscovery(dataRoot);
  if (existing) return { ...existing, reused: true, data_root: dataRoot };

  const child = spawn(process.execPath, [SERVICE_DAEMON], {
    cwd: PLUGIN_ROOT,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      LAYOUT_GUIDED_DATA_DIR: dataRoot,
      LAYOUT_GUIDED_PLUGIN_ROOT: PLUGIN_ROOT,
      ...(options.port ? { LAYOUT_GUIDED_SERVICE_PORT: String(options.port) } : {})
    }
  });
  child.unref();
  const discovered = await waitForDiscovery(dataRoot);
  return { ...discovered, reused: false, data_root: dataRoot, started_by_cli_pid: child.pid };
}

async function ensureSession(service, sessionId, { demo = false } = {}) {
  return requestJson(service, "/api/session", { method: "POST", body: { session_id: sessionId, ...(demo ? { demo: true } : {}) } });
}

function serviceOutput(service, sessionId, extra = {}) {
  return {
    cli: "layout-guided-ai-imagen",
    cli_version: CLI_VERSION,
    command: extra.command,
    status: extra.status || "ok",
    service_url: service.url,
    browser_url: `${service.url}/?session=${encodeURIComponent(sessionId)}`,
    session_id: sessionId,
    service_pid: Number(service.pid),
    service_reused: Boolean(service.reused),
    data_root: service.data_root,
    ...extra
  };
}

function stateFileFromOptions(options, dataRoot, sessionId, listenerId) {
  if (options["state-file"]) return path.resolve(String(options["state-file"]));
  if (!listenerId) throw new Error("--state-file or --listener-id is required");
  return defaultStatePath(dataRoot, sessionId, listenerId);
}

async function loadListenerState(options, dataRoot, sessionId) {
  const listenerId = options["listener-id"] ? String(options["listener-id"]) : null;
  const filePath = stateFileFromOptions(options, dataRoot, sessionId, listenerId);
  const state = await readJson(filePath);
  if (state?.schema_version !== "layout-listener-state/1" || state.session_id !== sessionId || typeof state.lease_token !== "string") {
    throw new Error("listener state file is invalid");
  }
  return { state, filePath };
}

function explicitSessionOption(options) {
  return options.session !== undefined || options["session-id"] !== undefined;
}

function explicitDataRootOption(options) {
  // An inherited environment value is only the default. A state file must
  // win unless the caller explicitly supplied --data-root, otherwise a
  // shell's stale environment can silently select the wrong session store.
  return options["data-root"] !== undefined;
}

function validatePersistedSessionId(value) {
  const sessionId = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new Error("listener state file is invalid");
  return sessionId;
}

/**
 * Resolve listener commands from their private state file when --session is
 * omitted. The state file is the durable source of truth for a listener
 * continuation; the lease token itself is never included in command output.
 */
async function resolveListenerContext(options) {
  const stateFileOption = options["state-file"] !== undefined;
  const filePath = stateFileOption ? path.resolve(String(options["state-file"])) : null;
  let state = null;
  if (filePath) {
    try {
      state = await readJson(filePath);
    } catch {
      throw new Error("listener state file is invalid");
    }
  }

  const explicitSession = explicitSessionOption(options);
  const persistedSession = state?.session_id ? validatePersistedSessionId(state.session_id) : null;
  const sessionId = explicitSession ? resolvedSessionId(options) : (persistedSession || resolvedSessionId(options));
  if (persistedSession && explicitSession && persistedSession !== sessionId) {
    throw new Error("session does not match listener state file");
  }

  const persistedRoot = state?.data_root
    ? path.resolve(String(state.data_root))
    : (filePath ? path.resolve(path.dirname(path.dirname(filePath))) : null);
  const explicitRoot = explicitDataRootOption(options);
  const dataRoot = explicitRoot ? resolvedDataRoot(options) : (persistedRoot || resolvedDataRoot(options));
  if (persistedRoot && explicitRoot && path.resolve(dataRoot) !== persistedRoot) {
    throw new Error("data root does not match listener state file");
  }

  if (state) {
    if (state.schema_version !== "layout-listener-state/1" || state.session_id !== sessionId || typeof state.lease_token !== "string" || typeof state.listener_id !== "string") {
      throw new Error("listener state file is invalid");
    }
  }
  return { dataRoot, sessionId, state, filePath };
}

async function saveListenerState(filePath, state) {
  await writePrivateJson(filePath, { ...state, schema_version: "layout-listener-state/1" });
}

function parseEventTypes(options) {
  const value = options["event-types"] ?? options["event-type"];
  if (value === undefined) return undefined;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function numberOption(options, name, fallback = undefined) {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function readBriefFile(filePath) {
  if (!filePath) throw new Error("--brief-file is required for prepare (or use --demo explicitly)");
  const resolved = path.resolve(String(filePath));
  let raw;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error("brief file must be a regular file");
    if (stat.size > 2 * 1024 * 1024) throw new Error("brief file is too large");
    raw = await fs.readFile(resolved, "utf8");
  } catch (error) {
    throw new Error(`cannot read brief file: ${error.message}`);
  }
  try {
    const brief = JSON.parse(raw);
    if (!brief || typeof brief !== "object" || Array.isArray(brief)) throw new Error("PosterBrief must be a JSON object");
    return brief;
  } catch (error) {
    throw new Error(`brief file must contain valid JSON: ${error.message}`);
  }
}

function candidateMetadata(snapshot) {
  return (snapshot.candidates ?? []).map((candidate) => ({
    candidate_id: candidate.candidate_id,
    name: candidate.name,
    recommendation: candidate.recommendation,
    status: candidate.status,
    revision: candidate.document?.revision ?? null,
    canvas: candidate.document?.canvas ?? null,
    copy: candidate.document?.objects?.filter((object) => object.type === "text").map((object) => object.copy_ref).filter(Boolean) ?? []
  }));
}

function briefSummary(brief) {
  return {
    canvas: brief.canvas,
    copy_count: Array.isArray(brief.copy) ? brief.copy.length : 0,
    main_visual: brief.main_visual?.description ?? null
  };
}

async function waitForPreparedCandidates(service, sessionId, timeoutMs = 15_000, expectedCount = 3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}`);
    if (snapshot.candidates?.some((candidate) => candidate.status === "failed")) throw new Error("candidate generation failed");
    if (snapshot.candidates?.length === expectedCount && snapshot.candidates.every((candidate) => candidate.status === "complete")) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error("prepare timed out while committing A/B/C candidates");
}

async function runStart(options) {
  const dataRoot = resolvedDataRoot(options);
  const sessionId = resolvedSessionId(options);
  const service = await ensureService(options);
  await ensureSession(service, sessionId, { demo: options.demo === true });
  return serviceOutput(service, sessionId, {
    command: "start",
    data_root: dataRoot,
    workflow: "prepare/open → claim/wait → user UI selection/confirmation",
    confirmation_required: true,
    cli_can_create_confirmation: false
  });
}

async function runPrepare(options) {
  if (!explicitSessionOption(options)) throw new Error("--session is required for prepare");
  if (options.demo === true) {
    if (options["brief-file"]) throw new Error("--demo cannot be combined with --brief-file");
    const result = await runStart(options);
    return { ...result, command: "prepare", demo_fixture: true, next: "open browser_url, then claim/wait; confirmation requires a browser/MCP Apps UI click" };
  }
  const briefInput = await readBriefFile(options["brief-file"]);
  const sessionId = resolvedSessionId(options);
  const dataRoot = resolvedDataRoot(options);
  const service = await ensureService(options);
  const validation = await requestJson(service, "/api/poster-brief/validate", { method: "POST", body: briefInput });
  if (!validation.can_enter_layout) {
    const detail = [validation.status, ...(validation.questions ?? []), ...(validation.conflicts ?? []).map((item) => item.detail)].filter(Boolean).join("; ");
    throw new Error(`PosterBrief is not ready: ${detail}`);
  }
  const normalizedBrief = validation.brief;
  await ensureSession(service, sessionId);
  const existing = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}`);
  if (existing.candidates?.length) {
    if (canonicalJson(existing.poster_brief) !== canonicalJson(normalizedBrief)) {
      throw new Error("session already contains a different PosterBrief; choose a new session or use an explicit replacement workflow");
    }
    const prepared = existing.candidates.length > 0 && existing.candidates.every((candidate) => candidate.status === "complete")
      ? existing
      : await waitForPreparedCandidates(service, sessionId, 15_000, existing.candidates.length || 3);
    return serviceOutput(service, sessionId, {
      command: "prepare",
      status: "prepared",
      idempotent: true,
      data_root: dataRoot,
      brief_fingerprint: fingerprint(normalizedBrief),
      brief_summary: briefSummary(normalizedBrief),
      candidate_count: prepared.candidates.length,
      candidates: candidateMetadata(prepared),
      listener_next: `claim --session ${sessionId} --data-root ${dataRoot} then wait --state-file <listener_state_file>`,
      next: "open browser_url, then claim/wait; confirmation requires a browser/MCP Apps UI click"
    });
  }
  if (existing.poster_brief && canonicalJson(existing.poster_brief) !== canonicalJson(normalizedBrief)) {
    throw new Error("session already contains a different PosterBrief; choose a new session or use an explicit replacement workflow");
  }
  const candidateCount = Number(options["candidate-count"] ?? 3);
  if (!Number.isInteger(candidateCount) || candidateCount < 2 || candidateCount > 3) throw new Error("--candidate-count must be 2 or 3");
  await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}/layout-candidates`, {
    method: "POST",
    body: { brief: normalizedBrief, candidate_count: candidateCount, auto_start: true }
  });
  const prepared = await waitForPreparedCandidates(service, sessionId, 15_000, candidateCount);
  return serviceOutput(service, sessionId, {
    command: "prepare",
    status: "prepared",
    idempotent: false,
    data_root: dataRoot,
    brief_fingerprint: fingerprint(normalizedBrief),
    brief_summary: briefSummary(normalizedBrief),
    candidate_count: prepared.candidates.length,
    candidates: candidateMetadata(prepared),
    listener_next: `claim --session ${sessionId} --data-root ${dataRoot} then wait --state-file <listener_state_file>`,
    next: "open browser_url, then claim/wait; confirmation requires a browser/MCP Apps UI click"
  });
}

async function runStatus(options) {
  const sessionId = resolvedSessionId(options);
  const service = await ensureService(options);
  const snapshot = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}`);
  return serviceOutput(service, sessionId, {
    command: "status",
    session_status: snapshot.status,
    active_candidate_id: snapshot.active_candidate_id,
    event_cursor: snapshot.event_cursor,
    layout_listener: snapshot.layout_listener,
    pending_requests: snapshot.layout_requests?.filter((request) => request.status === "pending").map((request) => ({
      request_id: request.request_id,
      candidate_id: request.candidate_id,
      base_revision: request.base_revision,
      request_length: request.request_length,
      request_hash: request.request_hash,
      claimed: request.claimed
    })) || []
  });
}

async function runDocument(options) {
  const sessionId = resolvedSessionId(options);
  const service = await ensureService(options);
  const snapshot = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}`);
  const candidateId = String(options["candidate-id"] || snapshot.active_candidate_id || "A");
  const candidate = snapshot.candidates?.find((item) => item.candidate_id === candidateId);
  if (!candidate && snapshot.status === "awaiting_brief") {
    return serviceOutput(service, sessionId, {
      command: "document",
      status: "awaiting_brief",
      candidate_id: null,
      revision: null,
      document: null,
      next: "run prepare --session <id> --brief-file <poster-brief.json>"
    });
  }
  if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
  return serviceOutput(service, sessionId, {
    command: "document",
    candidate_id: candidateId,
    revision: candidate.document?.revision ?? null,
    document: candidate.document
  });
}

async function runConfirmationStatus(options) {
  const sessionId = resolvedSessionId(options);
  const service = await ensureService(options);
  const status = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}/ui/confirmation-status`);
  return serviceOutput(service, sessionId, { command: "confirmation-status", ...status, cli_can_create_confirmation: false });
}

async function runGenerationPreflight(options) {
  const sessionId = resolvedSessionId(options);
  const service = await ensureService(options);
  const preflight = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}/generation/preflight`, { method: "POST", body: {} });
  return serviceOutput(service, sessionId, { command: "generation-preflight", ...preflight, cli_can_create_confirmation: false });
}

async function runClaim(options) {
  const context = options["state-file"]
    ? await resolveListenerContext(options)
    : { dataRoot: resolvedDataRoot(options), sessionId: resolvedSessionId(options), state: null, filePath: null };
  const { dataRoot, sessionId } = context;
  const service = await ensureService({ ...options, "data-root": dataRoot });
  await ensureSession(service, sessionId);
  const priorListenerId = options["listener-id"] ? String(options["listener-id"]) : null;
  const priorState = context.state;
  const priorPath = context.filePath || (priorListenerId ? stateFileFromOptions(options, dataRoot, sessionId, priorListenerId) : null);
  const body = {
    session_id: sessionId,
    listener_id: priorState?.listener_id || priorListenerId || undefined,
    lease_token: priorState?.lease_token || undefined,
    transport: "cli_runner",
    lease_ms: numberOption(options, "lease-ms"),
    // A new listener starts at cursor 0 so it can reclaim a pending request
    // whose submission event predates the crashed/expired listener. A
    // continuing listener keeps its durable cursor from the private state.
    after_cursor: numberOption(options, "after-cursor", priorState?.cursor ?? 0)
  };
  const result = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}/layout-listener/claim`, { method: "POST", body });
  if (result.status !== "active") return serviceOutput(service, sessionId, { command: "claim", ...result });
  const statePath = priorPath || defaultStatePath(dataRoot, sessionId, result.listener_id);
  const listenerCursor = Number.isInteger(result.listener?.last_cursor)
    ? result.listener.last_cursor
    : (Number.isInteger(result.next_cursor) ? result.next_cursor : 0);
  await saveListenerState(statePath, {
    session_id: sessionId,
    data_root: dataRoot,
    listener_id: result.listener_id,
    lease_token: result.lease_token,
    cursor: listenerCursor,
    request_id: null,
    transport: "cli_runner",
    service_url: service.url,
    lease_expires_at: result.listener?.lease_expires_at || null
  });
  // The opaque lease is deliberately kept in the private state file rather
  // than printed into logs or the model transcript.
  return serviceOutput(service, sessionId, {
    command: "claim",
    status: "active",
    listener_id: result.listener_id,
    transport: result.listener?.transport || "cli_runner",
    lease_expires_at: result.listener?.lease_expires_at || null,
    cursor: listenerCursor,
    listener_state_file: statePath,
    pending_requests: result.pending_requests || []
  });
}

async function runHeartbeat(options) {
  const { dataRoot, sessionId, state, filePath } = await resolveListenerContext(options);
  const service = await ensureService({ ...options, "data-root": dataRoot });
  const result = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}/layout-listener/heartbeat`, {
    method: "POST",
    body: {
      session_id: sessionId,
      listener_id: state.listener_id,
      lease_token: state.lease_token,
      lease_ms: numberOption(options, "lease-ms"),
      cursor: state.cursor
    }
  });
  await saveListenerState(filePath, { ...state, cursor: result.listener?.last_cursor ?? state.cursor, lease_expires_at: result.listener?.lease_expires_at || null });
  return serviceOutput(service, sessionId, {
    command: "heartbeat",
    status: result.status,
    listener_id: state.listener_id,
    lease_expires_at: result.listener?.lease_expires_at || null,
    cursor: result.listener?.last_cursor ?? state.cursor,
    pending_requests: result.pending_requests || [],
    listener_state_file: filePath
  });
}

async function runWait(options) {
  const { dataRoot, sessionId, state, filePath } = await resolveListenerContext(options);
  const service = await ensureService({ ...options, "data-root": dataRoot });
  const timeoutMs = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(numberOption(options, "timeout-ms", 15_000))));
  const result = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}/layout-listener/wait`, {
    method: "POST",
    timeoutMs: timeoutMs + 5000,
    body: {
      session_id: sessionId,
      listener_id: state.listener_id,
      lease_token: state.lease_token,
      after_cursor: state.cursor,
      timeout_ms: timeoutMs,
      candidate_id: options["candidate-id"] ? String(options["candidate-id"]) : undefined,
      event_types: parseEventTypes(options)
    }
  });
  const nextCursor = Number.isInteger(result.next_cursor) ? result.next_cursor : state.cursor;
  const requestId = result.action?.type === "layout_change" ? result.action.request_id : state.request_id;
  await saveListenerState(filePath, {
    ...state,
    cursor: nextCursor,
    request_id: requestId || null,
    lease_expires_at: result.listener?.lease_expires_at || state.lease_expires_at || null
  });
  return serviceOutput(service, sessionId, {
    command: "wait",
    status: result.status,
    listener_id: state.listener_id,
    cursor: nextCursor,
    listener_state_file: filePath,
    action: result.action || null,
    pending_requests: result.pending_requests || undefined
  });
}

async function readOperations(options) {
  if (options["operations-file"]) return JSON.parse(await fs.readFile(path.resolve(String(options["operations-file"])), "utf8"));
  if (options["operations-json"]) return JSON.parse(String(options["operations-json"]));
  return undefined;
}

async function runResolve(options) {
  const { dataRoot, sessionId, state, filePath } = await resolveListenerContext(options);
  const service = await ensureService({ ...options, "data-root": dataRoot });
  const requestId = String(options["request-id"] || state.request_id || "");
  if (!/^layout-[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error("--request-id is required (or wait for a layout_change first)");
  const status = String(options.status || "");
  if (!["applied", "failed"].includes(status)) throw new Error("--status must be applied or failed");
  const body = {
    status,
    listener_id: state.listener_id,
    lease_token: state.lease_token,
    stream_id: options["stream-id"] ? String(options["stream-id"]) : undefined,
    error_category: options["error-category"] ? String(options["error-category"]).slice(0, 80) : undefined
  };
  if (status === "applied") {
    const operations = await readOperations(options);
    if (!Array.isArray(operations) || operations.length === 0) throw new Error("applied resolution requires --operations-file or --operations-json with a non-empty array");
    body.operations = operations;
  }
  const result = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}/layout-change/${encodeURIComponent(requestId)}/result`, { method: "POST", body });
  await saveListenerState(filePath, { ...state, request_id: null, cursor: Number.isInteger(result.event_cursor) ? result.event_cursor : state.cursor });
  return serviceOutput(service, sessionId, {
    command: "resolve",
    status: result.status,
    listener_id: state.listener_id,
    request_id: requestId,
    revision: result.revision,
    cursor: Number.isInteger(result.event_cursor) ? result.event_cursor : state.cursor,
    listener_state_file: filePath
  });
}

async function runCancel(options) {
  const { dataRoot, sessionId, state, filePath } = await resolveListenerContext(options);
  const service = await ensureService({ ...options, "data-root": dataRoot });
  const requestId = String(options["request-id"] || state.request_id || "");
  if (!/^layout-[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error("--request-id is required (or wait for a layout_change first)");
  const result = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}/layout-change/${encodeURIComponent(requestId)}/cancel`, {
    method: "POST",
    body: { listener_id: state.listener_id, lease_token: state.lease_token, reason: String(options.reason || "cli_cancelled").slice(0, 80) }
  });
  await saveListenerState(filePath, { ...state, request_id: null, cursor: Number.isInteger(result.event_cursor) ? result.event_cursor : state.cursor });
  return serviceOutput(service, sessionId, {
    command: "cancel",
    status: result.status,
    listener_id: state.listener_id,
    request_id: requestId,
    cursor: Number.isInteger(result.event_cursor) ? result.event_cursor : state.cursor,
    listener_state_file: filePath
  });
}

async function runRelease(options) {
  const { dataRoot, sessionId, state, filePath } = await resolveListenerContext(options);
  const service = await ensureService({ ...options, "data-root": dataRoot });
  const result = await requestJson(service, `/api/session/${encodeURIComponent(sessionId)}/layout-listener/release`, {
    method: "POST",
    body: { session_id: sessionId, listener_id: state.listener_id, lease_token: state.lease_token }
  });
  await saveListenerState(filePath, { ...state, request_id: null, cursor: result.next_cursor ?? state.cursor, lease_expires_at: result.listener?.lease_expires_at || null, released: true });
  return serviceOutput(service, sessionId, {
    command: "release",
    status: result.status,
    listener_id: state.listener_id,
    cursor: result.next_cursor ?? state.cursor,
    listener_state_file: filePath,
    pending_requests: result.pending_requests || []
  });
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "help" || command === "--help" || options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const actions = {
    start: runStart,
    serve: runStart,
    prepare: runPrepare,
    status: runStatus,
    document: runDocument,
    "confirmation-status": runConfirmationStatus,
    "generation-preflight": runGenerationPreflight,
    claim: runClaim,
    wait: runWait,
    heartbeat: runHeartbeat,
    resolve: runResolve,
    cancel: runCancel,
    release: runRelease
  };
  const action = actions[command];
  if (!action) throw new Error(`unknown command: ${command}; use help for usage`);
  const result = await action(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`layout-guided-ai-imagen-cli: ${error.message}\n`);
  process.exitCode = 1;
});

import { createServer as createHttpServer } from "node:http";
import { promises as fs } from "node:fs";
import { createHash, createPublicKey, createVerify, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { assessImageCapabilities } from "./capabilities.mjs";
import { buildGenerationRequest } from "./generation-request.mjs";
import { buildLayoutCandidates } from "./layout-candidates.mjs";
import { listLayoutArchetypes } from "./layout-archetypes.mjs";
import { validatePosterBrief } from "./poster-brief.mjs";
import {
  applySketchOperations,
  assertValidSketchDocument,
  buildDetailConstraints,
  createEmptySession,
  createDemoSession,
  findCandidate,
  validateSketchDocument
} from "./sketch-document.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(MODULE_PATH), "..");
const DEFAULT_DATA_ROOT = path.join(os.tmpdir(), "layout-guided-ai-imagen-v11");
const DEFAULT_SESSION_ID = "demo";
const SERVICE_DISCOVERY_FILENAME = ".layout-guided-service.json";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MCP_APP_RESOURCE_URI = "ui://layout-guided-ai-imagen/workbench-v1.html";
const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";
// A browser fallback must never keep one request open forever.  The active
// model turn renews this lease while it loops over bounded waits.  A crashed
// or completed turn therefore becomes reclaimable without leaving the canvas
// in a permanent "waiting for callback" state.
const DEFAULT_LISTENER_LEASE_MS = 45_000;
const MIN_LISTENER_LEASE_MS = 10_000;
const MAX_LISTENER_LEASE_MS = 120_000;
const MAX_LAYOUT_WAIT_MS = 30_000;
const LAYOUT_WAIT_POLL_MS = 200;
// A confirmation intent is deliberately much shorter lived than the canvas
// session.  It is issued only by the UI click path and is bound to the exact
// candidate/revision that was selected in that UI instance.
const UI_SESSION_TTL_MS = 15 * 60_000;
const CONFIRMATION_INTENT_TTL_MS = 60_000;
const MAX_UI_SESSIONS = 8;
const MAX_CONFIRMATION_INTENTS = 16;
const MAX_CONFIRMATION_HISTORY = 32;
const UI_COOKIE_PREFIX = "layout_ui_session";
const MIME_TYPES = {
  "/": "text/html; charset=utf-8",
  "/index.html": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/vendor/fabric.js": "text/javascript; charset=utf-8",
  "/contracts/sketch-document.schema.json": "application/schema+json; charset=utf-8",
  "/contracts/layout-session.schema.json": "application/schema+json; charset=utf-8",
  "/contracts/layout-archetypes.schema.json": "application/schema+json; charset=utf-8",
  "/contracts/poster-brief.schema.json": "application/schema+json; charset=utf-8",
  "/contracts/generation-request.schema.json": "application/schema+json; charset=utf-8"
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-session-id, x-layout-ui-gesture, x-layout-ui-session",
  "access-control-expose-headers": "mcp-session-id"
};

function corsHeadersForRequest(request) {
  const origin = request?.headers?.origin;
  if (typeof origin === "string" && origin && origin !== "null") {
    return {
      ...CORS_HEADERS,
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      vary: "Origin"
    };
  }
  return CORS_HEADERS;
}

const sessionMutationTails = new Map();

async function withSessionMutationLock(dataRoot, sessionId, task) {
  const key = `${path.resolve(dataRoot)}:${sessionId}`;
  const previous = sessionMutationTails.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  sessionMutationTails.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (sessionMutationTails.get(key) === tail) sessionMutationTails.delete(key);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function base64UrlToBuffer(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  try { return Buffer.from(padded, "base64"); } catch { return null; }
}

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== "string") return cookies;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

function canonicalUiAction({ sessionId, uiInstanceId, action, candidateId, revision, challenge }) {
  return JSON.stringify([
    sessionId,
    uiInstanceId,
    action,
    candidateId,
    Number(revision),
    challenge
  ]);
}

function ecdsaRawToDer(signature) {
  if (!Buffer.isBuffer(signature) || signature.length !== 64) return null;
  const encodeInteger = (value) => {
    let integer = Buffer.from(value);
    while (integer.length > 1 && integer[0] === 0) integer = integer.subarray(1);
    if (integer[0] & 0x80) integer = Buffer.concat([Buffer.from([0]), integer]);
    return Buffer.concat([Buffer.from([0x02, integer.length]), integer]);
  };
  const body = Buffer.concat([encodeInteger(signature.subarray(0, 32)), encodeInteger(signature.subarray(32, 64))]);
  if (body.length > 127) return null;
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function verifyUiSignature(uiSession, { sessionId, action, candidateId, revision, challenge, signature }) {
  if (!uiSession || typeof uiSession.public_key_jwk !== "object") return false;
  if (challenge !== uiSession.challenge || typeof signature !== "string") return false;
  const raw = base64UrlToBuffer(signature) ?? (() => {
    try { return Buffer.from(signature, "base64"); } catch { return null; }
  })();
  const der = ecdsaRawToDer(raw);
  if (!der) return false;
  try {
    const verifier = createVerify("sha256");
    verifier.update(canonicalUiAction({
      sessionId,
      uiInstanceId: uiSession.ui_instance_id,
      action,
      candidateId,
      revision,
      challenge
    }));
    verifier.end();
    return verifier.verify(createPublicKey({ key: uiSession.public_key_jwk, format: "jwk" }), der);
  } catch {
    return false;
  }
}

function browserRequestLooksLikeUi(request) {
  const fetchSite = String(request?.headers?.["sec-fetch-site"] ?? "").toLowerCase();
  const fetchMode = String(request?.headers?.["sec-fetch-mode"] ?? "").toLowerCase();
  const fetchDest = String(request?.headers?.["sec-fetch-dest"] ?? "").toLowerCase();
  // These Fetch Metadata headers are emitted by browser fetches from the
  // served workbench.  Requiring them keeps plain curl/Node HTTP callers out
  // of the UI proof path.  The signature/key pair below provides the
  // additional browser-instance binding.
  if (!( ["same-origin", "same-site", "cross-site"].includes(fetchSite))) return false;
  if (!(["cors", "same-origin"].includes(fetchMode))) return false;
  if (fetchDest !== "empty") return false;
  if (fetchSite === "cross-site" && !request?.headers?.origin) return false;
  return request?.headers?.["x-layout-ui-gesture"] === "pointer";
}

function uiCookieName(sessionId) {
  return `${UI_COOKIE_PREFIX}_${sessionId}`;
}

function uiCookieHeader(sessionId, token) {
  return `${uiCookieName(sessionId)}=${token}; Path=/api/session/${sessionId}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(UI_SESSION_TTL_MS / 1000)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function jsonResponse(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...(response.__layoutCorsHeaders ?? CORS_HEADERS),
    ...extraHeaders
  });
  response.end(body);
}

function textResponse(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...(response.__layoutCorsHeaders ?? CORS_HEADERS)
  });
  response.end(body);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readRequestBody(request, maxBytes = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, "request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(request) {
  const raw = await readRequestBody(request);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "request body must be valid JSON");
  }
}

async function atomicWrite(filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, data, { flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function atomicWritePrivate(filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Apply the restrictive mode before the rename so a crash cannot expose
    // a newly-created request record with the normal session mode.
    await fs.writeFile(temporaryPath, data, { flag: "wx", mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

function serviceDiscoveryPath(dataRoot) {
  return path.join(path.resolve(dataRoot), SERVICE_DISCOVERY_FILENAME);
}

async function writeServiceDiscovery(dataRoot, discovery) {
  const root = path.resolve(dataRoot);
  await fs.mkdir(root, { recursive: true });
  await atomicWritePrivate(serviceDiscoveryPath(root), `${JSON.stringify(discovery, null, 2)}\n`);
}

async function removeServiceDiscovery(service) {
  if (!service?.discoveryPath) return;
  try {
    const current = JSON.parse(await fs.readFile(service.discoveryPath, "utf8"));
    if (current?.service_id === service.serviceId && Number(current?.pid) === process.pid) {
      await fs.rm(service.discoveryPath, { force: true });
    }
  } catch {
    // Discovery is best-effort metadata. The runner also verifies the PID and
    // health endpoint before reusing an entry, so a stale file is harmless.
  }
}

function sessionPaths(dataRoot, sessionId) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw httpError(400, "invalid session id");
  const sessionRoot = path.join(dataRoot, sessionId);
  return {
    sessionRoot,
    state: path.join(sessionRoot, "session.json"),
    events: path.join(sessionRoot, "operations.ndjson"),
    layoutRequests: path.join(sessionRoot, "layout-requests"),
    confirmations: path.join(sessionRoot, "confirmations"),
    candidates: path.join(sessionRoot, "candidates")
  };
}

function candidatePaths(paths, candidateId) {
  if (typeof candidateId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(candidateId)) throw httpError(400, "invalid candidate id");
  const root = path.join(paths.candidates, candidateId);
  return {
    root,
    initial: path.join(root, "initial.sketch.json"),
    current: path.join(root, "current.sketch.json"),
    versions: path.join(root, "versions"),
    operations: path.join(root, "operations.ndjson")
  };
}

function layoutRequestPath(paths, requestId) {
  if (typeof requestId !== "string" || !/^layout-[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw httpError(400, "invalid layout request id");
  return path.join(paths.layoutRequests, `${requestId}.json`);
}

async function persistLayoutRequest(paths, requestRecord, requestText) {
  const target = layoutRequestPath(paths, requestRecord.request_id);
  await fs.mkdir(paths.layoutRequests, { recursive: true });
  await atomicWritePrivate(target, `${JSON.stringify({
    schema_version: "layout-change-request/1",
    request_id: requestRecord.request_id,
    candidate_id: requestRecord.candidate_id,
    base_revision: requestRecord.base_revision,
    request_text: requestText,
    submitted_at: requestRecord.submitted_at
  }, null, 2)}\n`);
}

async function readLayoutRequest(paths, requestId) {
  try {
    const value = JSON.parse(await fs.readFile(layoutRequestPath(paths, requestId), "utf8"));
    if (value?.request_id !== requestId || typeof value.request_text !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

async function removeLayoutRequest(paths, requestId) {
  try { await fs.rm(layoutRequestPath(paths, requestId), { force: true }); } catch { /* terminal cleanup is best effort */ }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function listenerLeaseMs(value) {
  if (!Number.isFinite(value)) return DEFAULT_LISTENER_LEASE_MS;
  return Math.max(MIN_LISTENER_LEASE_MS, Math.min(MAX_LISTENER_LEASE_MS, Math.floor(value)));
}

function listenerIsActive(listener, now = Date.now()) {
  return Boolean(listener?.status === "active" && Date.parse(listener.lease_expires_at || "") > now);
}

function sanitizeListener(listener) {
  if (!listener) return null;
  const active = listenerIsActive(listener);
  return {
    listener_id: listener.listener_id,
    transport: listener.transport,
    status: active ? "active" : (listener.status === "released" ? "released" : "expired"),
    lease_expires_at: listener.lease_expires_at,
    last_heartbeat_at: listener.last_heartbeat_at,
    last_cursor: Number.isInteger(listener.last_cursor) ? listener.last_cursor : 0,
    claimed_request_id: listener.claimed_request_id ?? null
  };
}

function normalizeListener(session) {
  if (!Object.hasOwn(session, "layout_listener")) {
    session.layout_listener = null;
    return true;
  }
  if (!session.layout_listener || typeof session.layout_listener !== "object") return false;
  const listener = session.layout_listener;
  let changed = false;
  if (!Number.isInteger(listener.last_cursor) || listener.last_cursor < 0) {
    listener.last_cursor = 0;
    changed = true;
  }
  if (!listener.status) {
    listener.status = "expired";
    changed = true;
  }
  if (!listener.transport) {
    listener.transport = "browser_fallback";
    changed = true;
  }
  if (!Object.hasOwn(listener, "claimed_request_id")) {
    listener.claimed_request_id = null;
    changed = true;
  }
  return changed;
}

function normalizeUiState(session) {
  let changed = false;
  if (!Array.isArray(session.ui_sessions)) {
    session.ui_sessions = [];
    changed = true;
  }
  if (!Array.isArray(session.confirmation_intents)) {
    session.confirmation_intents = [];
    changed = true;
  }
  if (!Object.hasOwn(session, "user_selected_candidate")) {
    session.user_selected_candidate = null;
    changed = true;
  }
  if (!Array.isArray(session.confirmation_history)) {
    session.confirmation_history = [];
    changed = true;
  }
  return changed;
}

function reapExpiredUiState(session, now = Date.now()) {
  let changed = false;
  if (Array.isArray(session.ui_sessions)) {
    const before = session.ui_sessions.length;
    session.ui_sessions = session.ui_sessions.filter((item) => item && Date.parse(item.expires_at || "") > now);
    changed ||= before !== session.ui_sessions.length;
  }
  if (Array.isArray(session.confirmation_intents)) {
    for (const intent of session.confirmation_intents) {
      if (!intent || intent.status !== "issued") continue;
      if (Date.parse(intent.expires_at || "") <= now) {
        intent.status = "expired";
        intent.expired_at = new Date(now).toISOString();
        changed = true;
      }
    }
    const before = session.confirmation_intents.length;
    session.confirmation_intents = session.confirmation_intents.slice(-MAX_CONFIRMATION_INTENTS);
    changed ||= before !== session.confirmation_intents.length;
  }
  return changed;
}

function reapExpiredListener(session) {
  const listener = session.layout_listener;
  if (!listener || listener.status !== "active" || listenerIsActive(listener)) return false;
  listener.status = "expired";
  listener.claimed_request_id = null;
  for (const request of session.layout_requests ?? []) {
    if (request.status === "pending" && request.claimed_listener_id === listener.listener_id) {
      request.claimed_listener_id = null;
      request.claim_expires_at = null;
    }
  }
  return true;
}

async function persistCandidateVersion(paths, candidate, document, { onlyIfMissing = false } = {}) {
  const target = candidatePaths(paths, candidate.candidate_id);
  await fs.mkdir(target.versions, { recursive: true });
  await fs.writeFile(target.operations, "", { flag: "a" });
  const json = `${JSON.stringify(document, null, 2)}\n`;
  const versionPath = path.join(target.versions, `v${document.revision}.json`);
  const readStoredRevision = async (filePath) => {
    try {
      const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
      return Number.isInteger(stored?.revision) ? stored.revision : null;
    } catch {
      return null;
    }
  };
  const currentRevision = onlyIfMissing ? await readStoredRevision(target.current) : null;
  const versionRevision = onlyIfMissing ? await readStoredRevision(versionPath) : null;
  if (!onlyIfMissing || currentRevision !== document.revision) await atomicWrite(target.current, json);
  if (!onlyIfMissing || versionRevision !== document.revision) await atomicWrite(versionPath, json);
  if (!onlyIfMissing || !(await fileExists(target.initial))) {
    await atomicWrite(target.initial, `${JSON.stringify(candidate.initial_document ?? document, null, 2)}\n`);
  }
}

async function appendCandidateOperation(paths, event) {
  if (!event?.candidate_id || event.event !== "sketch_batch" && event.event !== "sketch_complete") return;
  const target = candidatePaths(paths, event.candidate_id);
  await fs.mkdir(target.root, { recursive: true });
  await fs.appendFile(target.operations, `${JSON.stringify(event)}\n`);
}

async function ensureCandidateVersions(paths, session) {
  await fs.mkdir(paths.candidates, { recursive: true });
  for (const candidate of session.candidates ?? []) await persistCandidateVersion(paths, candidate, candidate.document, { onlyIfMissing: true });
}

async function ensureSession(dataRoot, sessionId) {
  const paths = sessionPaths(dataRoot, sessionId);
  await fs.mkdir(paths.sessionRoot, { recursive: true });
  await fs.mkdir(paths.layoutRequests, { recursive: true });
  await fs.mkdir(paths.confirmations, { recursive: true });
  let raw;
  try {
    raw = await fs.readFile(paths.state, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const session = sessionId === DEFAULT_SESSION_ID ? createDemoSession() : createEmptySession(sessionId);
    session.session_id = sessionId;
    await atomicWrite(paths.state, `${JSON.stringify(session, null, 2)}\n`);
    await fs.writeFile(paths.events, "", { flag: "a" });
    await ensureCandidateVersions(paths, session);
    return { paths, session };
  }
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    throw httpError(500, "session state is invalid");
  }
  if (!session || typeof session !== "object" || !Array.isArray(session.candidates)) throw httpError(500, "session state is invalid");
  if (session.session_id && session.session_id !== sessionId) throw httpError(500, "session id does not match its storage path");
  let normalized = false;
  if (session.schema_version === "layout-session/2" || session.schema_version === "layout-session/3") {
    // layout-session/3 added the recoverable listener lease. layout-session/4
    // adds browser-bound UI sessions, user selection metadata, and one-time
    // confirmation intents. Existing local sessions remain readable and are
    // migrated on first access; legacy confirmations are never trusted for
    // generation because they lack a user_ui proof.
    session.schema_version = "layout-session/4";
    normalized = true;
  }
  if (!session.session_id) {
    session.session_id = sessionId;
    normalized = true;
  }
  if (!Number.isInteger(session.next_cursor) || session.next_cursor < 0) {
    session.next_cursor = 0;
    normalized = true;
  }
  if (!session.layout_requests) {
    session.layout_requests = [];
    normalized = true;
  }
  if (normalizeListener(session)) normalized = true;
  if (normalizeUiState(session)) normalized = true;
  if (!session.streams) {
    session.streams = {};
    normalized = true;
  }
  if (!Object.hasOwn(session, "confirmed")) {
    session.confirmed = null;
    normalized = true;
  }
  const listenerReaped = reapExpiredListener(session);
  const uiStateReaped = reapExpiredUiState(session);
  const recovered = await reconcileMissingEvents(session, paths);
  if (recovered || normalized || listenerReaped || uiStateReaped) await atomicWrite(paths.state, `${JSON.stringify(session, null, 2)}\n`);
  await fs.writeFile(paths.events, "", { flag: "a" });
  await ensureCandidateVersions(paths, session);
  return { paths, session };
}

async function saveSession(paths, session) {
  await atomicWrite(paths.state, `${JSON.stringify(session, null, 2)}\n`);
}

export async function createSession(dataRoot, body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(422, "session creation body must be an object");
  const sessionId = body.session_id ?? `session-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const paths = sessionPaths(dataRoot, sessionId);
  if (await fileExists(paths.state)) {
    const { session } = await ensureSession(dataRoot, sessionId);
    return { created: false, ...snapshot(session) };
  }

  const session = body.demo === true || sessionId === DEFAULT_SESSION_ID
    ? createDemoSession()
    : createEmptySession(sessionId);
  session.session_id = sessionId;
  await fs.mkdir(paths.sessionRoot, { recursive: true });
  await fs.mkdir(paths.layoutRequests, { recursive: true });
  await fs.mkdir(paths.confirmations, { recursive: true });
  try {
    await atomicWrite(paths.state, `${JSON.stringify(session, null, 2)}\n`);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await ensureSession(dataRoot, sessionId);
    return { created: false, ...snapshot(existing.session) };
  }
  await fs.writeFile(paths.events, "", { flag: "a" });
  await ensureCandidateVersions(paths, session);
  return { created: true, ...snapshot(session) };
}

function waitForMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function streamSnapshot(stream) {
  return {
    candidate_id: stream.candidate_id,
    stream_id: stream.stream_id,
    last_batch_seq: stream.last_batch_seq,
    last_revision: stream.last_revision,
    status: stream.status,
    next_plan_index: stream.next_plan_index ?? 0
  };
}

function generationCandidates(result, includePlans = false) {
  return result.candidates.map((candidate) => ({
    candidate_id: candidate.candidate_id,
    name: candidate.name,
    recommendation: candidate.recommendation,
    archetype_id: candidate.archetype_id,
    archetype_name: candidate.archetype_name,
    selection_score: candidate.selection_score,
    selection_rationale: candidate.selection_rationale,
    selection_policy: clone(candidate.selection_policy),
    catalog_provenance: clone(candidate.catalog_provenance),
    difference_axes: candidate.difference_axes,
    schematic: candidate.schematic,
    hash: candidate.hash,
    seed_document: candidate.seed_document,
    ...(includePlans ? { operation_batches: candidate.operation_batches, completion: candidate.completion } : {})
  }));
}

async function markStreamFailure(dataRoot, sessionId, candidateId, streamId, error, subscribers) {
  const { paths, session } = await ensureSession(dataRoot, sessionId);
  const candidate = findCandidate(session, candidateId);
  const stream = session.streams?.[`${candidateId}:${streamId}`];
  if (!candidate || !stream) return;
  stream.status = "failed";
  stream.error_category = "local_stream_failure";
  candidate.status = "failed";
  if (candidate.document.status === "generating") candidate.document.status = "editing";
  session.status = "layout_editing";
  const event = await appendEvent(paths, session, {
    event: "sketch_failed",
    session_id: session.session_id,
    candidate_id: candidateId,
    stream_id: streamId,
    revision: candidate.document.revision,
    error_category: "local_stream_failure",
    error_message: String(error?.message ?? "stream failed").slice(0, 160)
  });
  await saveSession(paths, session);
  publishEvent(subscribers, event);
}

async function runCandidateOperationPlan(dataRoot, sessionId, candidateId, streamId, subscribers, { delayMs = 70 } = {}) {
  try {
    const first = await ensureSession(dataRoot, sessionId);
    const stream = first.session.streams?.[`${candidateId}:${streamId}`];
    if (!stream || stream.status === "complete" || stream.status === "failed") return;
    await beginSketch(dataRoot, { session_id: sessionId, candidate_id: candidateId, stream_id: streamId });
    for (const plan of stream.planned_batches ?? []) {
      const latest = await ensureSession(dataRoot, sessionId);
      const latestStream = latest.session.streams?.[`${candidateId}:${streamId}`];
      if (!latestStream || latestStream.status === "interrupted" || latestStream.status === "failed" || latestStream.status === "complete") return;
      if (latestStream.last_batch_seq >= plan.batch_seq) continue;
      if (delayMs > 0) await waitForMilliseconds(delayMs);
      const current = await ensureSession(dataRoot, sessionId);
      const currentStream = current.session.streams?.[`${candidateId}:${streamId}`];
      if (!currentStream || currentStream.status === "interrupted" || currentStream.status === "failed" || currentStream.status === "complete") return;
      await applyBatch(dataRoot, {
        session_id: sessionId,
        candidate_id: candidateId,
        stream_id: streamId,
        batch_seq: plan.batch_seq,
        base_revision: current.session.candidates.find((candidate) => candidate.candidate_id === candidateId)?.document.revision,
        operations: clone(plan.operations)
      }, subscribers);
    }
    const completeState = await ensureSession(dataRoot, sessionId);
    const completeStream = completeState.session.streams?.[`${candidateId}:${streamId}`];
    if (completeStream && completeStream.status !== "interrupted" && completeStream.status !== "failed" && completeStream.status !== "complete") {
      await completeSketch(dataRoot, { session_id: sessionId, candidate_id: candidateId, stream_id: streamId }, subscribers);
    }
  } catch (error) {
    await markStreamFailure(dataRoot, sessionId, candidateId, streamId, error, subscribers);
  }
}

export async function seedLayoutCandidates(dataRoot, body, subscribers = new Set()) {
  if (!body || typeof body !== "object" || typeof body.session_id !== "string") throw httpError(422, "session_id is required");
  const validation = validatePosterBrief(body.brief);
  if (!validation.can_enter_layout) throw httpError(422, `PosterBrief must be ready before layout: ${validation.status}`);
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  if (session.candidates.length && session.poster_brief) {
    if (canonicalJson(session.poster_brief) !== canonicalJson(validation.brief)) {
      throw httpError(409, "session already contains a different PosterBrief; choose a new session or use an explicit replacement workflow");
    }
    return {
      seeded: false,
      idempotent: true,
      session_id: session.session_id,
      status: session.status,
      candidate_count: session.candidates.length,
      candidates: session.candidates.map((candidate) => ({
        candidate_id: candidate.candidate_id,
        name: candidate.name,
        recommendation: candidate.recommendation,
        ...(candidate.archetype_id ? {
          archetype_id: candidate.archetype_id,
          archetype_name: candidate.archetype_name,
          selection_score: candidate.selection_score,
          selection_rationale: candidate.selection_rationale,
          selection_policy: clone(candidate.selection_policy),
          catalog_provenance: clone(candidate.catalog_provenance),
          difference_axes: candidate.difference_axes,
          schematic: clone(candidate.schematic)
        } : {}),
        status: candidate.status,
        seed_document: clone(candidate.initial_document ?? candidate.document)
      })),
      image_model_called: false,
      event_cursor: session.next_cursor
    };
  }
  if (session.candidates.length) throw httpError(409, "session already contains candidates without a PosterBrief; choose a new session");
  if (session.confirmed || session.candidates.some((candidate) => candidate.modified) || session.layout_requests?.some((request) => request.status === "pending")) {
    throw httpError(409, "session already contains user changes or a confirmed layout");
  }
  const result = buildLayoutCandidates(validation.brief, { candidateCount: body.candidate_count ?? 3 });
  const autoStart = body.auto_start !== false;
  const now = new Date().toISOString();
  session.poster_brief = validation.brief;
  session.active_candidate_id = result.candidates[0].candidate_id;
  session.status = "layout_generating";
  session.layout_requests = [];
  session.confirmed = null;
  session.streams = {};
  session.candidates = result.candidates.map((candidate) => {
    const streamId = `ai-layout-${candidate.candidate_id}-${randomUUID().slice(0, 8)}`;
    const seedDocument = clone(candidate.seed_document);
    const streamKey = `${candidate.candidate_id}:${streamId}`;
    session.streams[streamKey] = {
      candidate_id: candidate.candidate_id,
      stream_id: streamId,
      last_batch_seq: 0,
      last_revision: seedDocument.revision,
      next_plan_index: 0,
      status: autoStart ? "generating" : "interrupted",
      role: "generation",
      batch_hashes: {},
      planned_batches: clone(candidate.operation_batches),
      created_at: now
    };
    return {
      candidate_id: candidate.candidate_id,
      name: candidate.name,
      recommendation: candidate.recommendation,
      archetype_id: candidate.archetype_id,
      archetype_name: candidate.archetype_name,
      selection_score: candidate.selection_score,
      selection_rationale: candidate.selection_rationale,
      selection_policy: clone(candidate.selection_policy),
      catalog_provenance: clone(candidate.catalog_provenance),
      difference_axes: candidate.difference_axes,
      schematic: clone(candidate.schematic),
      status: autoStart ? "generating" : "interrupted",
      document: seedDocument,
      initial_document: clone(seedDocument),
      modified: false,
      last_saved_revision: seedDocument.revision
    };
  });
  await ensureCandidateVersions(paths, session);
  await saveSession(paths, session);
  if (autoStart) {
    void (async () => {
      // Keep one session's durable journal writes ordered. Candidates still have
      // independent streams and files; sequential commits avoid cursor races in
      // the deliberately small local service.
      for (const candidate of session.candidates) {
        const stream = Object.values((await ensureSession(dataRoot, session.session_id)).session.streams ?? {}).find((item) => item.candidate_id === candidate.candidate_id);
        if (stream) await runCandidateOperationPlan(dataRoot, session.session_id, candidate.candidate_id, stream.stream_id, subscribers, { delayMs: Number.isFinite(body.batch_delay_ms) ? Math.max(0, Math.min(2000, body.batch_delay_ms)) : 70 });
      }
    })();
  }
  const response = {
    seeded: true,
    session_id: session.session_id,
    status: session.status,
    candidate_count: result.candidates.length,
    streams: Object.fromEntries(Object.entries(session.streams).map(([key, stream]) => [key, streamSnapshot(stream)])),
    candidates: generationCandidates(result, body.include_plans === true),
    validation: result.validation,
    image_model_called: false,
    event_cursor: session.next_cursor
  };
  return response;
}

export async function interruptSketch(dataRoot, body, subscribers = new Set()) {
  if (!body || typeof body.session_id !== "string" || typeof body.candidate_id !== "string" || typeof body.stream_id !== "string") throw httpError(422, "session_id, candidate_id, and stream_id are required");
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  const candidate = requireCandidate(session, body.candidate_id);
  const stream = session.streams?.[`${body.candidate_id}:${body.stream_id}`];
  if (!stream) throw httpError(404, "sketch stream not found");
  stream.status = "interrupted";
  candidate.status = "interrupted";
  candidate.document.status = "editing";
  session.status = "layout_editing";
  const event = await appendEvent(paths, session, {
    event: "sketch_interrupted",
    session_id: session.session_id,
    candidate_id: body.candidate_id,
    stream_id: body.stream_id,
    batch_seq: stream.last_batch_seq,
    revision: candidate.document.revision,
    reason: "user_or_transport_interruption"
  });
  await persistCandidateVersion(paths, candidate, candidate.document);
  await saveSession(paths, session);
  publishEvent(subscribers, event);
  return { session_id: session.session_id, candidate_id: body.candidate_id, stream: streamSnapshot(stream), revision: candidate.document.revision, status: candidate.status };
}

export async function resumeSketch(dataRoot, body, subscribers = new Set()) {
  if (!body || typeof body.session_id !== "string" || typeof body.candidate_id !== "string" || typeof body.stream_id !== "string") throw httpError(422, "session_id, candidate_id, and stream_id are required");
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  const candidate = requireCandidate(session, body.candidate_id);
  const stream = session.streams?.[`${body.candidate_id}:${body.stream_id}`];
  if (!stream) throw httpError(404, "sketch stream not found");
  stream.status = "generating";
  candidate.status = "generating";
  candidate.document.status = "generating";
  session.status = "layout_generating";
  await saveSession(paths, session);
  void runCandidateOperationPlan(dataRoot, body.session_id, body.candidate_id, body.stream_id, subscribers, { delayMs: Number.isFinite(body.batch_delay_ms) ? Math.max(0, Math.min(2000, body.batch_delay_ms)) : 70 });
  return { session_id: session.session_id, candidate_id: body.candidate_id, stream: streamSnapshot(stream), revision: candidate.document.revision, status: candidate.status };
}

function parsePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw httpError(422, "invalid PNG signature");
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") throw httpError(422, "PNG IHDR is missing");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) throw httpError(422, "PNG dimensions are empty");
  return { width, height };
}

function decodePngDataUri(dataUri, name) {
  if (typeof dataUri !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUri)) throw httpError(422, `${name} must be a base64 PNG data URI`);
  const buffer = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");
  const dimensions = parsePng(buffer);
  return { buffer, dimensions };
}

async function readOperationEvents(paths) {
  try {
    const raw = await fs.readFile(paths.events, "utf8");
    return raw.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

async function reconcileMissingEvents(session, paths) {
  const events = await readOperationEvents(paths);
  session.next_cursor ??= 0;
  session.streams ??= {};
  let recovered = false;
  for (const event of events.sort((left, right) => left.cursor - right.cursor)) {
    if (event.cursor <= session.next_cursor) continue;
    if (event.event === "sketch_batch") {
      const candidate = findCandidate(session, event.candidate_id);
      const streamKey = `${event.candidate_id}:${event.stream_id}`;
      const stream = session.streams[streamKey] ?? {
        candidate_id: event.candidate_id,
        stream_id: event.stream_id,
        last_batch_seq: 0,
        last_revision: candidate?.document.revision ?? 0,
        status: "editing",
        role: event.stream_role ?? "user",
        batch_hashes: {}
      };
      if (!candidate) break;
      if (candidate.document.revision === event.base_revision && event.batch_seq === stream.last_batch_seq + 1) {
        candidate.document = applySketchOperations(candidate.document, event.operations);
        candidate.modified = true;
        candidate.last_saved_revision = candidate.document.revision;
        candidate.status = "editing";
        stream.last_batch_seq = event.batch_seq;
        stream.last_revision = candidate.document.revision;
        stream.status = "editing";
        stream.batch_hashes ??= {};
        stream.batch_hashes[event.batch_seq] = event.operation_hash;
        session.streams[streamKey] = stream;
        if (stream.role !== "generation") session.active_candidate_id = event.candidate_id;
        session.status = "layout_editing";
      }
    } else if (event.event === "sketch_complete") {
      const candidate = findCandidate(session, event.candidate_id);
      const stream = session.streams?.[`${event.candidate_id}:${event.stream_id}`];
      if (!candidate || !stream) break;
      candidate.document.status = "complete";
      candidate.status = "complete";
      stream.status = "complete";
      session.status = session.candidates.every((item) => ["complete", "confirmed"].includes(item.status)) ? "layout_ready" : "layout_generating";
    }
    session.next_cursor = event.cursor;
    recovered = true;
  }
  return recovered;
}

function sendSse(response, event) {
  response.write(`id: ${event.cursor}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
}

function publishEvent(subscribers, event) {
  for (const subscriber of subscribers) {
    if (subscriber.session_id !== event.session_id) continue;
    if (subscriber.candidate_id && subscriber.candidate_id !== event.candidate_id) continue;
    try { sendSse(subscriber.response, event); } catch { subscribers.delete(subscriber); }
  }
}

async function appendEvent(paths, session, payload) {
  const event = {
    ...payload,
    event: payload.event ?? "sketch_batch",
    cursor: session.next_cursor + 1,
    created_at: new Date().toISOString()
  };
  await fs.appendFile(paths.events, `${JSON.stringify(event)}\n`);
  session.next_cursor = event.cursor;
  return event;
}

function snapshot(session) {
  reapExpiredListener(session);
  return {
    session_id: session.session_id,
    schema_version: session.schema_version,
    status: session.status,
    active_candidate_id: session.active_candidate_id,
    poster_brief: session.poster_brief,
    candidates: session.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      name: candidate.name,
      recommendation: candidate.recommendation,
      ...(candidate.archetype_id ? {
        archetype_id: candidate.archetype_id,
        archetype_name: candidate.archetype_name,
        selection_score: candidate.selection_score,
        selection_rationale: candidate.selection_rationale,
        selection_policy: clone(candidate.selection_policy),
        catalog_provenance: clone(candidate.catalog_provenance),
        difference_axes: candidate.difference_axes,
        schematic: clone(candidate.schematic)
      } : {}),
      status: candidate.status,
      modified: candidate.modified,
      last_saved_revision: candidate.last_saved_revision,
      initial_document: candidate.initial_document,
      document: candidate.document
    })),
    layout_requests: (session.layout_requests ?? []).map((request) => ({
      request_id: request.request_id,
      candidate_id: request.candidate_id,
      base_revision: request.base_revision,
      request_hash: request.request_hash,
      request_length: request.request_length,
      status: request.status,
      submitted_at: request.submitted_at,
      claimed: Boolean(request.claimed_listener_id),
      claim_expires_at: request.claim_expires_at ?? null
    })),
    layout_listener: sanitizeListener(session.layout_listener),
    user_selected_candidate: session.user_selected_candidate ?? null,
    ui_sessions: (session.ui_sessions ?? []).map(publicUiSession),
    confirmation_intents: (session.confirmation_intents ?? []).map((intent) => ({
      intent_id: intent.intent_id,
      candidate_id: intent.candidate_id,
      revision: intent.revision,
      status: intent.status,
      issued_at: intent.issued_at,
      expires_at: intent.expires_at
    })),
    confirmation_history: session.confirmation_history ?? [],
    confirmed: session.confirmed,
    event_cursor: session.next_cursor,
    storage: "local"
  };
}

function requireCandidate(session, candidateId) {
  const candidate = findCandidate(session, candidateId);
  if (!candidate) throw httpError(404, `candidate not found: ${candidateId}`);
  return candidate;
}

function currentConfirmationForCandidate(session, candidate) {
  const confirmation = session?.confirmed;
  if (!confirmation || confirmation.confirmed_by !== "user_ui") return null;
  if (confirmation.candidate_id !== candidate?.candidate_id) return null;
  if (Number(confirmation.revision) !== Number(candidate?.document?.revision)) return null;
  return confirmation;
}

function assertCandidateEditable(session, candidate) {
  if (currentConfirmationForCandidate(session, candidate)) {
    throw httpError(409, "candidate is confirmed and read-only; return to edit before changing it");
  }
}

function validateBatchBody(body) {
  if (!body || typeof body !== "object") throw httpError(422, "operation batch must be an object");
  for (const field of ["candidate_id", "stream_id"]) {
    if (typeof body[field] !== "string" || !body[field]) throw httpError(422, `${field} is required`);
  }
  if (!Number.isInteger(body.batch_seq) || body.batch_seq < 1) throw httpError(422, "batch_seq must be a positive integer");
  if (!Number.isInteger(body.base_revision) || body.base_revision < 0) throw httpError(422, "base_revision must be a non-negative integer");
  if (!Array.isArray(body.operations) || body.operations.length === 0) throw httpError(422, "operations must be a non-empty array");
}

async function beginSketchUnsafe(dataRoot, body) {
  const { paths, session } = await ensureSession(dataRoot, body?.session_id ?? DEFAULT_SESSION_ID);
  const candidateId = body?.candidate_id ?? session.active_candidate_id;
  const streamId = body?.stream_id;
  if (typeof streamId !== "string" || !streamId) throw httpError(422, "stream_id is required");
  const candidate = requireCandidate(session, candidateId);
  assertCandidateEditable(session, candidate);
  session.streams ??= {};
  const streamKey = `${candidateId}:${streamId}`;
  session.streams[streamKey] ??= { candidate_id: candidateId, stream_id: streamId, last_batch_seq: 0, last_revision: candidate.document.revision, status: "generating", batch_hashes: {} };
  if (session.streams[streamKey].role !== "generation") session.active_candidate_id = candidateId;
  candidate.status = "generating";
  candidate.document.status = "generating";
  session.status = "layout_generating";
  await persistCandidateVersion(paths, candidate, candidate.document);
  await saveSession(paths, session);
  return { session, candidate, stream: session.streams[streamKey] };
}

async function beginSketch(dataRoot, body) {
  return withSessionMutationLock(dataRoot, body?.session_id ?? DEFAULT_SESSION_ID, () => beginSketchUnsafe(dataRoot, body));
}

async function applyBatchUnsafe(dataRoot, body, subscribers) {
  validateBatchBody(body);
  const { paths, session } = await ensureSession(dataRoot, body.session_id ?? DEFAULT_SESSION_ID);
  const candidate = requireCandidate(session, body.candidate_id);
  assertCandidateEditable(session, candidate);
  session.streams ??= {};
  const streamKey = `${body.candidate_id}:${body.stream_id}`;
  const stream = session.streams[streamKey] ?? {
    candidate_id: body.candidate_id,
    stream_id: body.stream_id,
    last_batch_seq: 0,
    last_revision: candidate.document.revision,
    status: "editing",
    batch_hashes: {}
  };
  const operationHash = sha256(JSON.stringify(body.operations));
  const previousHash = stream.batch_hashes?.[body.batch_seq];
  if (body.batch_seq <= stream.last_batch_seq) {
    if (previousHash === operationHash) return { session, candidate, stream, event: null, idempotent: true };
    throw httpError(409, "duplicate batch sequence has a different operation hash");
  }
  if (body.batch_seq !== stream.last_batch_seq + 1) throw httpError(409, `batch sequence gap: expected ${stream.last_batch_seq + 1}`);
  if (body.base_revision !== candidate.document.revision) throw httpError(409, `stale base revision: expected ${candidate.document.revision}`);

  let nextDocument;
  try {
    nextDocument = applySketchOperations(candidate.document, body.operations);
  } catch (error) {
    throw httpError(422, error.message);
  }
  candidate.document = nextDocument;
  candidate.modified = true;
  candidate.last_saved_revision = nextDocument.revision;
  candidate.status = "editing";
  if (stream.role !== "generation") session.active_candidate_id = body.candidate_id;
  session.status = "layout_editing";
  stream.last_batch_seq = body.batch_seq;
  stream.last_revision = nextDocument.revision;
  stream.status = "editing";
  stream.batch_hashes ??= {};
  stream.batch_hashes[body.batch_seq] = operationHash;
  if (Array.isArray(stream.planned_batches)) stream.next_plan_index = Math.max(stream.next_plan_index ?? 0, body.batch_seq);
  session.streams[streamKey] = stream;
  await persistCandidateVersion(paths, candidate, nextDocument);
  const event = await appendEvent(paths, session, {
    event: "sketch_batch",
    session_id: session.session_id,
    candidate_id: body.candidate_id,
    stream_id: body.stream_id,
    batch_seq: body.batch_seq,
    base_revision: body.base_revision,
    revision: nextDocument.revision,
    stream_role: stream.role ?? "user",
    operation_hash: operationHash,
    operations: body.operations
  });
  await appendCandidateOperation(paths, event);
  await saveSession(paths, session);
  publishEvent(subscribers, event);
  return { session, candidate, stream, event, idempotent: false };
}

async function applyBatch(dataRoot, body, subscribers) {
  return withSessionMutationLock(dataRoot, body?.session_id ?? DEFAULT_SESSION_ID, () => applyBatchUnsafe(dataRoot, body, subscribers));
}

async function completeSketchUnsafe(dataRoot, body, subscribers) {
  if (!body || typeof body.session_id !== "string" || typeof body.candidate_id !== "string" || typeof body.stream_id !== "string") throw httpError(422, "session_id, candidate_id, and stream_id are required");
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  const candidate = requireCandidate(session, body.candidate_id);
  const streamKey = `${body.candidate_id}:${body.stream_id}`;
  const stream = session.streams?.[streamKey];
  if (!stream) throw httpError(409, "sketch stream has not started");
  candidate.document.status = "complete";
  candidate.status = "complete";
  stream.status = "complete";
  session.status = session.candidates.every((item) => ["complete", "confirmed"].includes(item.status)) ? "layout_ready" : "layout_generating";
  await persistCandidateVersion(paths, candidate, candidate.document);
  const event = await appendEvent(paths, session, {
    event: "sketch_complete",
    session_id: session.session_id,
    candidate_id: body.candidate_id,
    stream_id: body.stream_id,
    batch_seq: stream.last_batch_seq,
    revision: candidate.document.revision
  });
  await appendCandidateOperation(paths, event);
  await saveSession(paths, session);
  publishEvent(subscribers, event);
  return { session, candidate, stream, event };
}

async function completeSketch(dataRoot, body, subscribers) {
  return withSessionMutationLock(dataRoot, body?.session_id ?? DEFAULT_SESSION_ID, () => completeSketchUnsafe(dataRoot, body, subscribers));
}

async function saveSketchUnsafe(dataRoot, body) {
  if (!body || typeof body.session_id !== "string" || !body.document) throw httpError(422, "session_id and document are required");
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  const document = body.document;
  const candidate = requireCandidate(session, document.candidate_id);
  assertCandidateEditable(session, candidate);
  const errors = validateSketchDocument(document);
  if (errors.length) throw httpError(422, errors.join("; "));
  if (candidate.document.revision !== document.revision) throw httpError(409, `revision mismatch: expected ${candidate.document.revision}`);
  candidate.document = document;
  candidate.modified = true;
  candidate.last_saved_revision = document.revision;
  candidate.status = document.status;
  session.active_candidate_id = candidate.candidate_id;
  session.status = document.status === "complete"
    ? session.candidates.every((item) => ["complete", "confirmed"].includes(item.status)) ? "layout_ready" : "layout_generating"
    : document.status === "confirmed" ? "layout_confirmed" : "layout_editing";
  await persistCandidateVersion(paths, candidate, document);
  await saveSession(paths, session);
  return { session_id: session.session_id, candidate_id: candidate.candidate_id, revision: document.revision, saved: true };
}

async function saveSketch(dataRoot, body) {
  return withSessionMutationLock(dataRoot, body?.session_id ?? DEFAULT_SESSION_ID, () => saveSketchUnsafe(dataRoot, body));
}

function normalizeListenerTransport(value) {
  if (value === "mcp_apps_bridge" || value === "browser_fallback" || value === "cli_runner") return value;
  throw httpError(422, "transport must be mcp_apps_bridge, browser_fallback, or cli_runner");
}

function listenerTokenMatches(listener, token) {
  return Boolean(listener?.token_hash && typeof token === "string" && sha256(token) === listener.token_hash);
}

function requireListener(session, body) {
  const listener = session.layout_listener;
  if (!listener || !listenerIsActive(listener)) throw httpError(409, "layout listener is not active");
  if (typeof body?.listener_id !== "string" || body.listener_id !== listener.listener_id || !listenerTokenMatches(listener, body.lease_token)) {
    throw httpError(409, "layout listener lease is invalid or expired");
  }
  return listener;
}

function requireListenerForRelease(session, body) {
  const listener = session.layout_listener;
  if (!listener || typeof body?.listener_id !== "string" || body.listener_id !== listener.listener_id || !listenerTokenMatches(listener, body.lease_token)) {
    throw httpError(409, "layout listener lease is invalid or expired");
  }
  // Release is a terminal cleanup operation. It remains safe after a lease
  // expires (ensureSession reaps the lease while retaining its token hash),
  // and repeating it is deliberately idempotent for a crashed CLI turn.
  if (listener.status === "active" && !listenerIsActive(listener)) reapExpiredListener(session);
  if (["active", "expired", "released"].includes(listener.status)) return listener;
  throw httpError(409, "layout listener lease is invalid or expired");
}

function pendingRequestSummary(session, candidateId = null) {
  return (session.layout_requests ?? [])
    .filter((request) => request.status === "pending" && (!candidateId || request.candidate_id === candidateId))
    .map((request) => ({
      request_id: request.request_id,
      candidate_id: request.candidate_id,
      base_revision: request.base_revision,
      request_hash: request.request_hash,
      request_length: request.request_length,
      submitted_at: request.submitted_at,
      claimed: Boolean(request.claimed_listener_id),
      claim_expires_at: request.claim_expires_at ?? null
    }));
}

export async function claimLayoutListener(dataRoot, body) {
  if (!body || typeof body.session_id !== "string") throw httpError(422, "session_id is required");
  const transport = normalizeListenerTransport(body.transport ?? "browser_fallback");
  const leaseMs = listenerLeaseMs(body.lease_ms);
  return withSessionMutationLock(dataRoot, body.session_id, async () => {
    const { paths, session } = await ensureSession(dataRoot, body.session_id);
    const now = Date.now();
    const existing = session.layout_listener;
    if (listenerIsActive(existing, now)) {
      if (existing.listener_id !== body.listener_id || !listenerTokenMatches(existing, body.lease_token)) {
        return {
          session_id: session.session_id,
          status: "busy",
          listener: sanitizeListener(existing),
          pending_requests: pendingRequestSummary(session)
        };
      }
      existing.last_heartbeat_at = new Date(now).toISOString();
      existing.lease_expires_at = new Date(now + leaseMs).toISOString();
      if (Number.isInteger(body.after_cursor) && body.after_cursor >= 0) existing.last_cursor = body.after_cursor;
      const claimed = (session.layout_requests ?? []).find((request) => request.request_id === existing.claimed_request_id && request.status === "pending");
      if (claimed) claimed.claim_expires_at = existing.lease_expires_at;
      await saveSession(paths, session);
      return {
        session_id: session.session_id,
        status: "active",
        listener: sanitizeListener(existing),
        listener_id: existing.listener_id,
        lease_token: body.lease_token,
        lease_ms: leaseMs,
        next_cursor: session.next_cursor,
        pending_requests: pendingRequestSummary(session)
      };
    }
    const listenerId = typeof body.listener_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.listener_id)
      ? body.listener_id
      : `listener-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const leaseToken = randomUUID();
    const nowIso = new Date(now).toISOString();
    const listener = {
      listener_id: listenerId,
      transport,
      status: "active",
      token_hash: sha256(leaseToken),
      lease_expires_at: new Date(now + leaseMs).toISOString(),
      last_heartbeat_at: nowIso,
      last_cursor: Number.isInteger(body.after_cursor) && body.after_cursor >= 0 ? body.after_cursor : session.next_cursor,
      claimed_request_id: null
    };
    // An expired/released listener no longer owns any request. A fresh lease
    // can therefore recover pending input after a crashed or finished turn.
    for (const request of session.layout_requests ?? []) {
      if (request.status === "pending" && request.claimed_listener_id && request.claim_expires_at && Date.parse(request.claim_expires_at) <= now) {
        request.claimed_listener_id = null;
        request.claim_expires_at = null;
      }
    }
    session.layout_listener = listener;
    await saveSession(paths, session);
    return {
      session_id: session.session_id,
      status: "active",
      listener: sanitizeListener(listener),
      listener_id: listenerId,
      lease_token: leaseToken,
      lease_ms: leaseMs,
      next_cursor: session.next_cursor,
      pending_requests: pendingRequestSummary(session)
    };
  });
}

export async function heartbeatLayoutListener(dataRoot, body) {
  if (!body || typeof body.session_id !== "string") throw httpError(422, "session_id is required");
  return withSessionMutationLock(dataRoot, body.session_id, async () => {
    const { paths, session } = await ensureSession(dataRoot, body.session_id);
    const listener = requireListener(session, body);
    const now = Date.now();
    const leaseMs = listenerLeaseMs(body.lease_ms);
    listener.last_heartbeat_at = new Date(now).toISOString();
    listener.lease_expires_at = new Date(now + leaseMs).toISOString();
    if (Number.isInteger(body.cursor) && body.cursor >= 0) listener.last_cursor = Math.max(listener.last_cursor ?? 0, body.cursor);
    const claimed = (session.layout_requests ?? []).find((request) => request.request_id === listener.claimed_request_id && request.status === "pending");
    if (claimed) claimed.claim_expires_at = listener.lease_expires_at;
    await saveSession(paths, session);
    return { session_id: session.session_id, status: "active", listener: sanitizeListener(listener), pending_requests: pendingRequestSummary(session), next_cursor: session.next_cursor };
  });
}

export async function releaseLayoutListener(dataRoot, body) {
  if (!body || typeof body.session_id !== "string") throw httpError(422, "session_id is required");
  return withSessionMutationLock(dataRoot, body.session_id, async () => {
    const { paths, session } = await ensureSession(dataRoot, body.session_id);
    const listener = requireListenerForRelease(session, body);
    if (listener.status === "released") {
      return { session_id: session.session_id, status: "released", listener: sanitizeListener(listener), pending_requests: pendingRequestSummary(session), next_cursor: session.next_cursor };
    }
    listener.status = "released";
    listener.last_heartbeat_at = new Date().toISOString();
    listener.claimed_request_id = null;
    for (const request of session.layout_requests ?? []) {
      if (request.status === "pending" && request.claimed_listener_id === listener.listener_id) {
        request.claimed_listener_id = null;
        request.claim_expires_at = null;
      }
    }
    await saveSession(paths, session);
    return { session_id: session.session_id, status: "released", listener: sanitizeListener(listener), pending_requests: pendingRequestSummary(session), next_cursor: session.next_cursor };
  });
}

function waitEventTypes(value) {
  const allowed = new Set(["layout_change", "confirm", "cancel", "layout_change_result"]);
  if (value === undefined) return allowed;
  if (!Array.isArray(value) || value.length === 0) throw httpError(422, "event_types must be a non-empty array");
  const types = new Set(value);
  for (const type of types) if (!allowed.has(type)) throw httpError(422, `unsupported layout listener event type: ${type}`);
  return types;
}

function listenerEventType(event) {
  if (event.event === "layout_change_submitted") return "layout_change";
  if (event.event === "layout_change_applied" || event.event === "layout_change_failed") return "layout_change_result";
  if (event.event === "layout_change_cancelled") return "cancel";
  if (event.event === "layout_confirmed") return "confirm";
  return null;
}

async function claimPendingRequestForListener(dataRoot, sessionId, listenerId, requestId) {
  return withSessionMutationLock(dataRoot, sessionId, async () => {
    const { paths, session } = await ensureSession(dataRoot, sessionId);
    const listener = session.layout_listener;
    if (!listener || listener.listener_id !== listenerId || !listenerIsActive(listener)) return null;
    const request = (session.layout_requests ?? []).find((item) => item.request_id === requestId);
    if (!request || request.status !== "pending") return null;
    if (request.claimed_listener_id && request.claimed_listener_id !== listenerId && request.claim_expires_at && Date.parse(request.claim_expires_at) > Date.now()) return null;
    request.claimed_listener_id = listenerId;
    request.claim_expires_at = listener.lease_expires_at;
    listener.claimed_request_id = requestId;
    await saveSession(paths, session);
    return { paths, session, listener, request };
  });
}

async function inspectLayoutListener(dataRoot, body) {
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  const listener = session.layout_listener;
  if (!listener || listener.listener_id !== body.listener_id || !listenerTokenMatches(listener, body.lease_token) || !listenerIsActive(listener)) return { status: "listener_expired", paths, session };
  return { status: "active", paths, session, listener };
}

function buildLayoutListenerEvent(event, requestRecord, requestData) {
  const type = listenerEventType(event);
  return {
    type,
    event: event.event,
    cursor: event.cursor,
    session_id: event.session_id,
    candidate_id: event.candidate_id ?? null,
    request_id: event.request_id ?? null,
    base_revision: event.base_revision ?? null,
    revision: event.revision ?? null,
    status: requestRecord?.status ?? null,
    request: requestData?.request_text ?? null
  };
}

export async function waitForLayoutAction(dataRoot, body) {
  if (!body || typeof body.session_id !== "string" || typeof body.listener_id !== "string" || typeof body.lease_token !== "string") {
    throw httpError(422, "session_id, listener_id, and lease_token are required");
  }
  const timeoutMs = Number.isFinite(body.timeout_ms) ? Math.max(0, Math.min(MAX_LAYOUT_WAIT_MS, Math.floor(body.timeout_ms))) : 15_000;
  const types = waitEventTypes(body.event_types);
  let cursor = Number.isInteger(body.after_cursor) && body.after_cursor >= 0 ? body.after_cursor : 0;
  const candidateId = body.candidate_id ?? null;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const inspected = await inspectLayoutListener(dataRoot, body);
    if (inspected.status !== "active") return { session_id: body.session_id, status: inspected.status, next_cursor: cursor, listener: sanitizeListener(inspected.session?.layout_listener) };
    const { paths, session, listener } = inspected;
    const events = await readOperationEvents(paths);
    for (const event of events.sort((left, right) => left.cursor - right.cursor)) {
      if (event.cursor <= cursor) continue;
      cursor = event.cursor;
      if (candidateId && event.candidate_id !== candidateId) continue;
      const type = listenerEventType(event);
      if (!type || !types.has(type)) continue;
      const requestRecord = event.request_id ? (session.layout_requests ?? []).find((item) => item.request_id === event.request_id) : null;
      if (type === "layout_change" && requestRecord?.status === "pending") {
        const claimed = await claimPendingRequestForListener(dataRoot, body.session_id, listener.listener_id, requestRecord.request_id);
        if (!claimed) continue;
        const requestData = await readLayoutRequest(claimed.paths, requestRecord.request_id);
        if (!requestData) {
          // Do not leave a request permanently claimed if a controlled request
          // record was lost during a crash or manual cleanup.
          await resolveLayoutChange(dataRoot, { session_id: body.session_id, request_id: requestRecord.request_id, status: "failed", error_category: "request_data_unavailable" });
          continue;
        }
        return {
          session_id: body.session_id,
          status: "event",
          next_cursor: cursor,
          listener: sanitizeListener(claimed.listener),
          action: buildLayoutListenerEvent(event, requestRecord, requestData)
        };
      }
      if (type !== "layout_change") {
        return { session_id: body.session_id, status: "event", next_cursor: cursor, listener: sanitizeListener(listener), action: buildLayoutListenerEvent(event, requestRecord, null) };
      }
    }
    const current = await inspectLayoutListener(dataRoot, body);
    if (current.status !== "active") return { session_id: body.session_id, status: current.status, next_cursor: cursor, listener: sanitizeListener(current.session?.layout_listener) };
    if (timeoutMs === 0 || Date.now() >= deadline) {
      // A bounded wait doubles as a heartbeat so a healthy loop can remain
      // connected while still yielding control to the host between calls.
      const heartbeat = await heartbeatLayoutListener(dataRoot, { ...body, cursor, lease_ms: body.lease_ms });
      return { session_id: body.session_id, status: "timeout", next_cursor: cursor, listener: heartbeat.listener, pending_requests: heartbeat.pending_requests };
    }
    await waitForMilliseconds(Math.min(LAYOUT_WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

export async function cancelLayoutChange(dataRoot, body, subscribers = new Set()) {
  if (!body || typeof body.session_id !== "string" || typeof body.request_id !== "string") throw httpError(422, "session_id and request_id are required");
  return withSessionMutationLock(dataRoot, body.session_id, async () => {
    const { paths, session } = await ensureSession(dataRoot, body.session_id);
    const request = (session.layout_requests ?? []).find((item) => item.request_id === body.request_id);
    if (!request) throw httpError(404, "layout change request not found");
    if (request.status !== "pending") return { session_id: session.session_id, request_id: request.request_id, candidate_id: request.candidate_id, status: request.status };
    if (body.listener_id || body.lease_token) requireListener(session, body);
    request.status = "cancelled";
    request.error_category = typeof body.reason === "string" ? body.reason.slice(0, 80) : "user_cancelled";
    request.claimed_listener_id = null;
    request.claim_expires_at = null;
    if (session.layout_listener?.claimed_request_id === request.request_id) session.layout_listener.claimed_request_id = null;
    const event = await appendEvent(paths, session, {
      event: "layout_change_cancelled",
      session_id: session.session_id,
      candidate_id: request.candidate_id,
      request_id: request.request_id,
      base_revision: request.base_revision,
      error_category: request.error_category
    });
    session.status = findCandidate(session, request.candidate_id)?.status === "confirmed" ? "layout_confirmed" : "layout_editing";
    await saveSession(paths, session);
    publishEvent(subscribers, event);
    await removeLayoutRequest(paths, request.request_id);
    return { session_id: session.session_id, request_id: request.request_id, candidate_id: request.candidate_id, status: request.status, event_cursor: event.cursor };
  });
}

export async function submitLayoutChange(dataRoot, body) {
  if (!body || typeof body.session_id !== "string" || typeof body.request !== "string") throw httpError(422, "session_id and request are required");
  const request = body.request.trim();
  if (!request) throw httpError(422, "request must not be empty");
  if (request.length > 32 * 1024) throw httpError(413, "request is too long");
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  const candidateId = body.candidate_id ?? session.active_candidate_id;
  const candidate = requireCandidate(session, candidateId);
  assertCandidateEditable(session, candidate);
  const baseRevision = body.base_revision ?? candidate.document.revision;
  if (!Number.isInteger(baseRevision) || baseRevision < 0) throw httpError(422, "base_revision must be a non-negative integer");
  if (baseRevision !== candidate.document.revision) throw httpError(409, `stale base revision: expected ${candidate.document.revision}`);

  const requestHash = sha256(request);
  const duplicate = (session.layout_requests ?? []).find((item) => item.status === "pending"
    && item.candidate_id === candidate.candidate_id
    && item.base_revision === baseRevision
    && item.request_hash === requestHash);
  if (duplicate) {
    return {
      session_id: session.session_id,
      request_id: duplicate.request_id,
      candidate_id: duplicate.candidate_id,
      base_revision: duplicate.base_revision,
      revision: candidate.document.revision,
      status: duplicate.status,
      idempotent: true,
      listener: sanitizeListener(session.layout_listener),
      listener_available: listenerIsActive(session.layout_listener)
    };
  }

  const requestId = `layout-${randomUUID()}`;
  const requestRecord = {
    request_id: requestId,
    candidate_id: candidate.candidate_id,
    base_revision: baseRevision,
    request_hash: requestHash,
    request_length: request.length,
    status: "pending",
    submitted_at: new Date().toISOString(),
    claimed_listener_id: null,
    claim_expires_at: null
  };
  session.layout_requests ??= [];
  session.layout_requests.push(requestRecord);
  session.active_candidate_id = candidate.candidate_id;
  session.status = "layout_change_pending";
  await persistLayoutRequest(paths, requestRecord, request);
  await appendEvent(paths, session, {
    event: "layout_change_submitted",
    session_id: session.session_id,
    candidate_id: candidate.candidate_id,
    request_id: requestId,
    base_revision: baseRevision,
    request_hash: requestRecord.request_hash
  });
  await saveSession(paths, session);
  return {
    session_id: session.session_id,
    request_id: requestId,
    candidate_id: candidate.candidate_id,
    base_revision: baseRevision,
    revision: candidate.document.revision,
    status: "pending",
    idempotent: false,
    listener: sanitizeListener(session.layout_listener),
    listener_available: listenerIsActive(session.layout_listener)
  };
}

export async function resolveLayoutChange(dataRoot, body, subscribers = new Set()) {
  if (!body || typeof body.session_id !== "string" || typeof body.request_id !== "string" || !["applied", "failed"].includes(body.status)) {
    throw httpError(422, "session_id, request_id, and status(applied|failed) are required");
  }
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  const request = (session.layout_requests ?? []).find((item) => item.request_id === body.request_id);
  if (!request) throw httpError(404, "layout change request not found");
  if (request.status !== "pending") return { session_id: session.session_id, request_id: request.request_id, candidate_id: request.candidate_id, status: request.status, revision: findCandidate(session, request.candidate_id)?.document.revision ?? request.base_revision };
  if (body.listener_id || body.lease_token) {
    const listener = requireListener(session, body);
    if (request.claimed_listener_id && request.claimed_listener_id !== listener.listener_id) throw httpError(409, "layout change is claimed by another active listener");
  }
  const candidate = requireCandidate(session, request.candidate_id);
  if (body.status === "failed") {
    request.status = "failed";
    request.error_category = typeof body.error_category === "string" ? body.error_category.slice(0, 80) : "host_callback_failed";
    request.claimed_listener_id = null;
    request.claim_expires_at = null;
    if (session.layout_listener?.claimed_request_id === request.request_id) session.layout_listener.claimed_request_id = null;
    session.status = candidate.status === "confirmed" ? "layout_confirmed" : "layout_editing";
    const event = await appendEvent(paths, session, {
      event: "layout_change_failed",
      session_id: session.session_id,
      candidate_id: candidate.candidate_id,
      request_id: request.request_id,
      base_revision: request.base_revision,
      error_category: request.error_category
    });
    await saveSession(paths, session);
    publishEvent(subscribers, event);
    await removeLayoutRequest(paths, request.request_id);
    return { session_id: session.session_id, request_id: request.request_id, candidate_id: candidate.candidate_id, status: request.status, revision: candidate.document.revision, error_category: request.error_category };
  }
  if (!Array.isArray(body.operations) || body.operations.length === 0) throw httpError(422, "applied layout change requires structured operations");
  if (candidate.document.revision !== request.base_revision) throw httpError(409, `revision mismatch: expected ${candidate.document.revision}`);
  const streamId = typeof body.stream_id === "string" && body.stream_id ? body.stream_id : `ai-change-${request.request_id}`;
  await beginSketch(dataRoot, { session_id: session.session_id, candidate_id: candidate.candidate_id, stream_id: streamId });
  const applied = await applyBatch(dataRoot, {
    session_id: session.session_id,
    candidate_id: candidate.candidate_id,
    stream_id: streamId,
    batch_seq: 1,
    base_revision: request.base_revision,
    operations: body.operations
  }, subscribers);
  const updated = await ensureSession(dataRoot, session.session_id);
  const updatedRequest = updated.session.layout_requests.find((item) => item.request_id === request.request_id);
  updatedRequest.status = "applied";
  updatedRequest.applied_revision = applied.candidate.document.revision;
  updatedRequest.claimed_listener_id = null;
  updatedRequest.claim_expires_at = null;
  if (updated.session.layout_listener?.claimed_request_id === request.request_id) updated.session.layout_listener.claimed_request_id = null;
  updated.session.status = "layout_editing";
  const event = await appendEvent(updated.paths, updated.session, {
    event: "layout_change_applied",
    session_id: updated.session.session_id,
    candidate_id: candidate.candidate_id,
    request_id: request.request_id,
    base_revision: request.base_revision,
    revision: applied.candidate.document.revision
  });
  await saveSession(updated.paths, updated.session);
  publishEvent(subscribers, event);
  await removeLayoutRequest(updated.paths, request.request_id);
  return { session_id: updated.session.session_id, request_id: request.request_id, candidate_id: candidate.candidate_id, status: "applied", revision: applied.candidate.document.revision, event_cursor: event.cursor };
}

function requireConfirmationIntent(session, sessionId, request, body, candidateId, revision) {
  if (!request) throw httpError(403, "human UI confirmation proof is required");
  const uiSession = uiSessionForRequest(session, sessionId, request, body);
  if (!uiSession) throw httpError(403, "UI session is missing, expired, or not bound to this browser");
  if (typeof body?.confirmation_intent !== "string" || body.confirmation_intent.length < 32) throw httpError(403, "one-time UI confirmation intent is required");
  const intent = (session.confirmation_intents ?? []).find((item) => item && item.token_hash === sha256(body.confirmation_intent));
  if (!intent || intent.status !== "issued") throw httpError(409, "confirmation intent is invalid, expired, or already consumed");
  if (Date.parse(intent.expires_at || "") <= Date.now()) {
    intent.status = "expired";
    intent.expired_at = new Date().toISOString();
    throw httpError(409, "confirmation intent has expired");
  }
  if (intent.ui_instance_id !== uiSession.ui_instance_id || intent.candidate_id !== candidateId || intent.revision !== revision) {
    throw httpError(409, "confirmation intent is bound to a different UI, candidate, or revision");
  }
  const selected = session.user_selected_candidate;
  if (!selected || selected.ui_instance_id !== uiSession.ui_instance_id || selected.candidate_id !== candidateId || selected.revision !== revision) {
    throw httpError(409, "explicit user candidate selection is missing or stale");
  }
  return { uiSession, intent, selected };
}

async function confirmLayoutUnsafe(dataRoot, body, subscribers = new Set(), request = null) {
  if (!body || typeof body.session_id !== "string" || !body.document) throw httpError(422, "session_id and document are required");
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  const document = JSON.parse(JSON.stringify(body.document));
  const candidate = requireCandidate(session, document.candidate_id);
  const errors = validateSketchDocument(document);
  if (errors.length) throw httpError(422, errors.join("; "));
  if (candidate.document.revision !== document.revision) throw httpError(409, `revision mismatch: expected ${candidate.document.revision}`);
  const layoutVersion = `v${document.revision}`;
  if (session.confirmed?.candidate_id === candidate.candidate_id && session.confirmed?.layout_version === layoutVersion) {
    if (session.confirmed.confirmed_by === "user_ui") return session.confirmed;
    throw httpError(409, "legacy confirmation has no human UI proof and cannot be reused");
  }
  const { uiSession, intent, selected } = requireConfirmationIntent(session, body.session_id, request, body, candidate.candidate_id, document.revision);
  if (document.annotations.some((annotation) => annotation.status !== "valid")) throw httpError(422, "one or more annotation anchors are invalid");
  const clean = decodePngDataUri(body.clean_png_data_uri, "clean_png_data_uri");
  const annotated = decodePngDataUri(body.annotated_png_data_uri, "annotated_png_data_uri");
  const expected = { width: document.canvas.width, height: document.canvas.height };
  for (const [name, png] of [["clean", clean], ["annotated", annotated]]) {
    if (png.dimensions.width !== expected.width || png.dimensions.height !== expected.height) throw httpError(422, `${name} PNG dimensions do not match canvas`);
  }
  const detailConstraints = Array.isArray(body.detail_constraints) ? body.detail_constraints : buildDetailConstraints(document);
  assertDetailConstraintsMatchDocument(detailConstraints, document);
  const invalidDetail = detailConstraints.some((constraint) => constraint.status === "invalid" || constraint.must_not_render !== true);
  if (invalidDetail) throw httpError(422, "detail constraints contain invalid or renderable annotations");

  const confirmationRoot = path.join(paths.confirmations, candidate.candidate_id, layoutVersion);
  await fs.mkdir(confirmationRoot, { recursive: true });
  const relativeRoot = path.relative(paths.sessionRoot, confirmationRoot);
  const jsonBytes = Buffer.from(`${JSON.stringify({ ...document, status: "confirmed" }, null, 2)}\n`);
  const constraintsBytes = Buffer.from(`${JSON.stringify(detailConstraints, null, 2)}\n`);
  const confirmationId = `confirmation-${randomUUID().replaceAll("-", "")}`;
  const confirmation = {
    schema_version: "layout-confirmation/1",
    session_id: session.session_id,
    candidate_id: candidate.candidate_id,
    layout_version: layoutVersion,
    revision: document.revision,
    files: {
      sketch_json: path.join(relativeRoot, "current.sketch.json"),
      clean_png: path.join(relativeRoot, "layout.clean.png"),
      annotated_png: path.join(relativeRoot, "layout.annotated.png"),
      detail_constraints: path.join(relativeRoot, "detail-constraints.json")
    },
    hashes: {
      sketch_json_sha256: sha256(jsonBytes),
      clean_png_sha256: sha256(clean.buffer),
      annotated_png_sha256: sha256(annotated.buffer),
      detail_constraints_sha256: sha256(constraintsBytes)
    },
    dimensions: expected,
    confirmed_at: new Date().toISOString(),
    confirmed_by: "user_ui",
    confirmation_id: confirmationId,
    ui_instance_id: uiSession.ui_instance_id,
    user_selected_candidate: selected
  };
  await atomicWrite(path.join(confirmationRoot, "current.sketch.json"), jsonBytes);
  await atomicWrite(path.join(confirmationRoot, "layout.clean.png"), clean.buffer);
  await atomicWrite(path.join(confirmationRoot, "layout.annotated.png"), annotated.buffer);
  await atomicWrite(path.join(confirmationRoot, "detail-constraints.json"), constraintsBytes);
  await atomicWrite(path.join(confirmationRoot, "confirmation.json"), `${JSON.stringify(confirmation, null, 2)}\n`);

  document.status = "confirmed";
  candidate.document = document;
  candidate.status = "confirmed";
  candidate.last_saved_revision = document.revision;
  session.active_candidate_id = candidate.candidate_id;
  session.status = "layout_confirmed";
  session.confirmed = confirmation;
  intent.status = "consumed";
  intent.consumed_at = confirmation.confirmed_at;
  intent.confirmation_id = confirmationId;
  intent.confirmed_by = "user_ui";
  uiSession.selected_candidate_id = candidate.candidate_id;
  uiSession.selected_revision = document.revision;
  const confirmationEvent = await appendEvent(paths, session, {
    event: "layout_confirmed",
    session_id: session.session_id,
    candidate_id: candidate.candidate_id,
    revision: document.revision,
    layout_version: layoutVersion
  });
  await persistCandidateVersion(paths, candidate, document);
  await saveSession(paths, session);
  publishEvent(subscribers, confirmationEvent);
  // The event is a lightweight wake-up signal. It carries no copy, image
  // bytes, or credentials; wait_for_layout_action reads only status metadata.
  return { ...confirmation, event_cursor: confirmationEvent.cursor };
}

async function confirmLayout(dataRoot, body, subscribers = new Set(), request = null) {
  if (!body || typeof body.session_id !== "string") throw httpError(422, "session_id is required");
  return withSessionMutationLock(dataRoot, body.session_id, () => confirmLayoutUnsafe(dataRoot, body, subscribers, request));
}

function resolveConfirmedFile(paths, relativeFile) {
  if (typeof relativeFile !== "string") throw httpError(500, "confirmed file path is invalid");
  const sessionRoot = path.resolve(paths.sessionRoot);
  const target = path.resolve(paths.sessionRoot, relativeFile);
  if (!target.startsWith(`${sessionRoot}${path.sep}`)) throw httpError(500, "confirmed file path escapes session storage");
  return target;
}

export async function getConfirmedInputs(dataRoot, body = {}) {
  if (!body || typeof body.session_id !== "string") throw httpError(422, "session_id is required");
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  const confirmation = session.confirmed;
  if (!confirmation) return { session_id: session.session_id, status: "not_confirmed", storage: "local" };
  const available = {};
  for (const [name, relativeFile] of Object.entries(confirmation.files ?? {})) available[name] = await fileExists(resolveConfirmedFile(paths, relativeFile));
  return {
    session_id: session.session_id,
    status: "confirmed",
    candidate_id: confirmation.candidate_id,
    layout_version: confirmation.layout_version,
    revision: confirmation.revision,
    files: confirmation.files,
    hashes: confirmation.hashes,
    dimensions: confirmation.dimensions,
    confirmed_at: confirmation.confirmed_at,
    confirmed_by: confirmation.confirmed_by ?? null,
    confirmation_id: confirmation.confirmation_id ?? null,
    ui_instance_id: confirmation.ui_instance_id ?? null,
    user_selected_candidate: confirmation.user_selected_candidate ?? null,
    available,
    storage: "local"
  };
}

function browserRequestIsWorkbenchUi(request) {
  const fetchSite = String(request?.headers?.["sec-fetch-site"] ?? "").toLowerCase();
  const fetchMode = String(request?.headers?.["sec-fetch-mode"] ?? "").toLowerCase();
  const fetchDest = String(request?.headers?.["sec-fetch-dest"] ?? "").toLowerCase();
  if (!( ["same-origin", "same-site", "cross-site"].includes(fetchSite) && ["cors", "same-origin"].includes(fetchMode) && fetchDest === "empty")) return false;
  return fetchSite !== "cross-site" || Boolean(request?.headers?.origin);
}

function uiSessionForRequest(session, sessionId, request, body = {}) {
  const token = parseCookies(request?.headers?.cookie)[uiCookieName(sessionId)]
    || request?.headers?.["x-layout-ui-session"]
    || body?.ui_session_capability;
  if (!token) return null;
  return (session.ui_sessions ?? []).find((item) => item && item.token_hash === sha256(token) && Date.parse(item.expires_at || "") > Date.now()) ?? null;
}

function requireUiSessionAction(session, sessionId, request, body, action) {
  if (!browserRequestIsWorkbenchUi(request)) throw httpError(403, "human UI confirmation requires a browser workbench request");
  if (!browserRequestLooksLikeUi(request)) throw httpError(403, "human UI confirmation requires an explicit UI pointer gesture");
  const uiSession = uiSessionForRequest(session, sessionId, request, body);
  if (!uiSession) throw httpError(403, "UI session is missing, expired, or not bound to this browser");
  if (body?.ui_instance_id !== uiSession.ui_instance_id) throw httpError(403, "UI instance is invalid");
  if (!verifyUiSignature(uiSession, {
    sessionId,
    action,
    candidateId: body?.candidate_id,
    revision: body?.revision,
    challenge: body?.challenge,
    signature: body?.signature
  })) throw httpError(403, "UI gesture proof is invalid or already superseded");
  return uiSession;
}

function rotateUiChallenge(uiSession) {
  uiSession.challenge = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  return uiSession.challenge;
}

function publicUiSession(uiSession) {
  if (!uiSession) return null;
  return {
    ui_instance_id: uiSession.ui_instance_id,
    expires_at: uiSession.expires_at,
    selected_candidate_id: uiSession.selected_candidate_id ?? null,
    selected_revision: Number.isInteger(uiSession.selected_revision) ? uiSession.selected_revision : null
  };
}

export async function bootstrapUiSession(dataRoot, body, request) {
  if (!body || typeof body.session_id !== "string" || typeof body.public_key_jwk !== "object" || Array.isArray(body.public_key_jwk)) {
    throw httpError(422, "session_id and public_key_jwk are required");
  }
  if (!browserRequestIsWorkbenchUi(request)) throw httpError(403, "UI bootstrap must come from the served workbench");
  try {
    const key = body.public_key_jwk;
    if (key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string") throw new Error("unsupported UI key");
    createPublicKey({ key, format: "jwk" });
  } catch {
    throw httpError(422, "public_key_jwk must be a valid P-256 public key");
  }
  return withSessionMutationLock(dataRoot, body.session_id, async () => {
    const { paths, session } = await ensureSession(dataRoot, body.session_id);
    const now = Date.now();
    reapExpiredUiState(session, now);
    const uiToken = randomUUID() + randomUUID();
    const uiSession = {
      ui_instance_id: `ui-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      token_hash: sha256(uiToken),
      public_key_jwk: clone(body.public_key_jwk),
      challenge: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + UI_SESSION_TTL_MS).toISOString(),
      selected_candidate_id: null,
      selected_revision: null
    };
    session.ui_sessions = [uiSession, ...(session.ui_sessions ?? [])].slice(0, MAX_UI_SESSIONS);
    await saveSession(paths, session);
    const response = {
      session_id: session.session_id,
      ui_instance_id: uiSession.ui_instance_id,
      challenge: uiSession.challenge,
      expires_at: uiSession.expires_at,
      selected_candidate: null
    };
    const requestOrigin = request?.headers?.origin;
    const requestHost = request?.headers?.host ? `http://${request.headers.host}` : null;
    if (requestOrigin && requestOrigin !== requestHost) response.ui_session_capability = uiToken;
    // Keep the raw cookie exclusively in the Set-Cookie header.  It must not
    // be exposed to page JavaScript, MCP output, logs, or status snapshots.
    Object.defineProperty(response, "_setCookie", { value: uiCookieHeader(body.session_id, uiToken), enumerable: false });
    return response;
  });
}

export async function selectUiCandidate(dataRoot, body, request) {
  if (!body || typeof body.session_id !== "string" || typeof body.candidate_id !== "string" || !Number.isInteger(body.revision)) {
    throw httpError(422, "session_id, candidate_id, and revision are required");
  }
  return withSessionMutationLock(dataRoot, body.session_id, async () => {
    const { paths, session } = await ensureSession(dataRoot, body.session_id);
    const uiSession = requireUiSessionAction(session, body.session_id, request, body, "select_candidate");
    const candidate = requireCandidate(session, body.candidate_id);
    // The candidate may receive another committed drawing batch between the
    // thumbnail render and the click. Selection is still valid for the
    // visible candidate; bind the recorded selection to the server's latest
    // revision. Confirmation intent issuance remains exact-revision strict.
    if (body.revision > candidate.document.revision) throw httpError(409, `revision mismatch: expected ${candidate.document.revision}`);
    // Selection is allowed while a candidate is still being drawn so the UI
    // can follow it. The confirmation-intent gate below remains strict and
    // refuses generating/interrupted candidates until their revision is final.
    if (candidate.status === "failed") throw httpError(409, "candidate is not selectable after a failed stream");
    session.user_selected_candidate = {
      candidate_id: candidate.candidate_id,
      revision: candidate.document.revision,
      ui_instance_id: uiSession.ui_instance_id,
      selected_at: new Date().toISOString()
    };
    uiSession.selected_candidate_id = candidate.candidate_id;
    uiSession.selected_revision = candidate.document.revision;
    for (const intent of session.confirmation_intents ?? []) {
      if (intent.status === "issued" && (intent.candidate_id !== candidate.candidate_id || intent.revision !== candidate.document.revision)) {
        intent.status = "invalidated";
        intent.invalidated_at = new Date().toISOString();
      }
    }
    const nextChallenge = rotateUiChallenge(uiSession);
    await saveSession(paths, session);
    return {
      session_id: session.session_id,
      status: "selected",
      candidate_id: candidate.candidate_id,
      revision: candidate.document.revision,
      user_selected_candidate: session.user_selected_candidate,
      ui_instance_id: uiSession.ui_instance_id,
      next_challenge: nextChallenge,
      expires_at: uiSession.expires_at
    };
  });
}

export async function issueConfirmationIntent(dataRoot, body, request) {
  if (!body || typeof body.session_id !== "string" || typeof body.candidate_id !== "string" || !Number.isInteger(body.revision)) {
    throw httpError(422, "session_id, candidate_id, and revision are required");
  }
  return withSessionMutationLock(dataRoot, body.session_id, async () => {
    const { paths, session } = await ensureSession(dataRoot, body.session_id);
    const uiSession = requireUiSessionAction(session, body.session_id, request, body, "issue_confirmation_intent");
    const candidate = requireCandidate(session, body.candidate_id);
    if (candidate.document.revision !== body.revision) throw httpError(409, `revision mismatch: expected ${candidate.document.revision}`);
    const selected = session.user_selected_candidate;
    if (!selected || selected.candidate_id !== candidate.candidate_id || selected.revision !== candidate.document.revision || selected.ui_instance_id !== uiSession.ui_instance_id) {
      throw httpError(409, "explicit user candidate selection is required before confirmation");
    }
    if (!["complete", "editing"].includes(candidate.status) || candidate.document.status === "generating") throw httpError(409, "candidate is not ready for confirmation");
    if (candidate.document.annotations.some((annotation) => annotation.status !== "valid")) throw httpError(422, "one or more annotation anchors are invalid");
    reapExpiredUiState(session);
    const token = randomUUID() + randomUUID();
    const intentId = `intent-${randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    const intent = {
      intent_id: intentId,
      token_hash: sha256(token),
      ui_instance_id: uiSession.ui_instance_id,
      candidate_id: candidate.candidate_id,
      revision: candidate.document.revision,
      status: "issued",
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + CONFIRMATION_INTENT_TTL_MS).toISOString(),
      consumed_at: null,
      confirmation_id: null
    };
    session.confirmation_intents = [intent, ...(session.confirmation_intents ?? [])].slice(0, MAX_CONFIRMATION_INTENTS);
    const nextChallenge = rotateUiChallenge(uiSession);
    await saveSession(paths, session);
    return {
      session_id: session.session_id,
      status: "issued",
      intent_id: intentId,
      confirmation_intent: token,
      candidate_id: candidate.candidate_id,
      revision: candidate.document.revision,
      ui_instance_id: uiSession.ui_instance_id,
      issued_at: intent.issued_at,
      expires_at: intent.expires_at,
      next_challenge: nextChallenge
    };
  });
}

export async function getConfirmationStatus(dataRoot, body = {}) {
  if (!body || typeof body.session_id !== "string") throw httpError(422, "session_id is required");
  const { session } = await ensureSession(dataRoot, body.session_id);
  const confirmation = session.confirmed;
  return {
    session_id: session.session_id,
    status: confirmation?.confirmed_by === "user_ui" ? "confirmed" : "not_confirmed",
    candidate_id: confirmation?.candidate_id ?? null,
    revision: confirmation?.revision ?? null,
    confirmed_by: confirmation?.confirmed_by ?? null,
    user_selected_candidate: session.user_selected_candidate ?? null,
    confirmation_history: session.confirmation_history ?? [],
    intents: (session.confirmation_intents ?? []).map((intent) => ({
      intent_id: intent.intent_id,
      candidate_id: intent.candidate_id,
      revision: intent.revision,
      status: intent.status,
      issued_at: intent.issued_at,
      expires_at: intent.expires_at
    }))
  };
}

export async function returnToLayoutEditing(dataRoot, body, request, subscribers = new Set()) {
  if (!body || typeof body.session_id !== "string" || typeof body.candidate_id !== "string" || !Number.isInteger(body.revision)) {
    throw httpError(422, "session_id, candidate_id, and revision are required");
  }
  return withSessionMutationLock(dataRoot, body.session_id, async () => {
    const { paths, session } = await ensureSession(dataRoot, body.session_id);
    const uiSession = requireUiSessionAction(session, body.session_id, request, body, "return_to_edit");
    const confirmation = session.confirmed;
    if (!confirmation || confirmation.confirmed_by !== "user_ui") throw httpError(409, "there is no current user-confirmed layout to return to edit");
    if (confirmation.candidate_id !== body.candidate_id || Number(confirmation.revision) !== body.revision) {
      throw httpError(409, "return-to-edit target does not match the current confirmation");
    }
    const candidate = requireCandidate(session, body.candidate_id);
    if (candidate.document.revision !== body.revision) throw httpError(409, `revision mismatch: expected ${candidate.document.revision}`);

    const previousConfirmation = clone(confirmation);
    session.confirmation_history = [
      previousConfirmation,
      ...(session.confirmation_history ?? []).filter((item) => item?.confirmation_id !== previousConfirmation.confirmation_id)
    ].slice(0, MAX_CONFIRMATION_HISTORY);

    const nextDocument = clone(candidate.document);
    nextDocument.revision = Number(candidate.document.revision) + 1;
    nextDocument.status = "editing";
    const documentErrors = validateSketchDocument(nextDocument);
    if (documentErrors.length) throw httpError(422, documentErrors.join("; "));
    candidate.document = nextDocument;
    candidate.status = "editing";
    candidate.modified = true;
    candidate.last_saved_revision = nextDocument.revision;
    session.active_candidate_id = candidate.candidate_id;
    session.confirmed = null;
    session.user_selected_candidate = null;
    for (const intent of session.confirmation_intents ?? []) {
      if (intent.status === "issued") {
        intent.status = "invalidated";
        intent.invalidated_at = new Date().toISOString();
      }
    }
    uiSession.selected_candidate_id = null;
    uiSession.selected_revision = null;
    const nextChallenge = rotateUiChallenge(uiSession);
    session.status = "layout_editing";
    await persistCandidateVersion(paths, candidate, nextDocument);
    const event = await appendEvent(paths, session, {
      event: "layout_returned_to_edit",
      session_id: session.session_id,
      candidate_id: candidate.candidate_id,
      previous_revision: previousConfirmation.revision,
      revision: nextDocument.revision,
      confirmation_id: previousConfirmation.confirmation_id,
      layout_version: previousConfirmation.layout_version
    });
    await saveSession(paths, session);
    publishEvent(subscribers, event);
    return {
      session_id: session.session_id,
      status: "editing",
      candidate_id: candidate.candidate_id,
      previous_confirmation: previousConfirmation,
      previous_revision: previousConfirmation.revision,
      revision: nextDocument.revision,
      next_challenge: nextChallenge,
      event_cursor: event.cursor,
      confirmation_history_count: session.confirmation_history.length
    };
  });
}

function assertDetailConstraintsMatchDocument(detailConstraints, document) {
  if (!Array.isArray(detailConstraints)) throw httpError(422, "detail constraints must be an array");
  const expected = buildDetailConstraints(document);
  if (detailConstraints.length !== expected.length) throw httpError(422, "detail constraints do not match annotations");
  const actualByAnnotationId = new Map();
  for (const constraint of detailConstraints) {
    if (!constraint || typeof constraint !== "object" || typeof constraint.annotation_id !== "string") {
      throw httpError(422, "detail constraints contain an invalid annotation identity");
    }
    if (actualByAnnotationId.has(constraint.annotation_id)) {
      throw httpError(422, `detail constraints contain duplicate annotation: ${constraint.annotation_id}`);
    }
    actualByAnnotationId.set(constraint.annotation_id, constraint);
  }
  for (const expectedConstraint of expected) {
    const actual = actualByAnnotationId.get(expectedConstraint.annotation_id);
    if (!actual) throw httpError(422, `detail constraint is missing annotation: ${expectedConstraint.annotation_id}`);
    for (const field of ["detail_id", "annotation_id", "instruction", "category", "polarity", "status", "must_not_render"]) {
      if (actual[field] !== expectedConstraint[field]) {
        throw httpError(422, `detail constraint does not match annotation ${expectedConstraint.annotation_id}: ${field}`);
      }
    }
    for (const field of ["target", "anchor", "marker"]) {
      if (canonicalJson(actual[field]) !== canonicalJson(expectedConstraint[field])) {
        throw httpError(422, `detail constraint does not match annotation ${expectedConstraint.annotation_id}: ${field}`);
      }
    }
  }
}

function generationBlocked(sessionId, reason, details = {}) {
  return { allow: false, session_id: sessionId, reason, ...details };
}

async function readAndVerifyFile(filePath, expectedHash, name) {
  try {
    const bytes = await fs.readFile(filePath);
    if (!bytes.length) return { ok: false, reason: `${name}_empty` };
    if (typeof expectedHash !== "string" || sha256(bytes) !== expectedHash) return { ok: false, reason: `${name}_hash_mismatch` };
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: `${name}_missing` };
  }
}

export async function generationPreflight(dataRoot, body = {}) {
  if (!body || typeof body.session_id !== "string") throw httpError(422, "session_id is required");
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  const confirmation = session.confirmed;
  if (!confirmation || confirmation.confirmed_by !== "user_ui" || typeof confirmation.confirmation_id !== "string") {
    return generationBlocked(session.session_id, "human_ui_confirmation_required", { confirmed_by: confirmation?.confirmed_by ?? null });
  }
  const candidate = findCandidate(session, confirmation.candidate_id);
  if (!candidate) return generationBlocked(session.session_id, "confirmed_candidate_missing");
  if (candidate.document.revision !== confirmation.revision) {
    return generationBlocked(session.session_id, "confirmed_revision_stale", { candidate_revision: candidate.document.revision, confirmed_revision: confirmation.revision });
  }
  const files = {};
  for (const [name, relativeFile] of Object.entries(confirmation.files ?? {})) {
    try { files[name] = resolveConfirmedFile(paths, relativeFile); } catch { return generationBlocked(session.session_id, `${name}_path_invalid`); }
  }
  const checks = [
    ["sketch_json", confirmation.hashes?.sketch_json_sha256],
    ["clean_png", confirmation.hashes?.clean_png_sha256],
    ["annotated_png", confirmation.hashes?.annotated_png_sha256],
    ["detail_constraints", confirmation.hashes?.detail_constraints_sha256]
  ];
  const loaded = {};
  for (const [name, expectedHash] of checks) {
    const result = await readAndVerifyFile(files[name], expectedHash, name);
    if (!result.ok) return generationBlocked(session.session_id, result.reason);
    loaded[name] = result.bytes;
  }
  let sketch;
  let detailConstraints;
  try {
    sketch = JSON.parse(loaded.sketch_json.toString("utf8"));
    detailConstraints = JSON.parse(loaded.detail_constraints.toString("utf8"));
  } catch {
    return generationBlocked(session.session_id, "confirmed_json_invalid");
  }
  if (sketch.candidate_id !== confirmation.candidate_id || sketch.revision !== confirmation.revision || sketch.status !== "confirmed") {
    return generationBlocked(session.session_id, "confirmed_sketch_identity_mismatch");
  }
  if (!Array.isArray(detailConstraints) || detailConstraints.length !== sketch.annotations?.length || detailConstraints.some((item) => item.status === "invalid" || item.must_not_render !== true)) {
    return generationBlocked(session.session_id, "confirmed_detail_constraints_invalid");
  }
  for (const [name, expected] of [["clean_png", confirmation.hashes.clean_png_sha256], ["annotated_png", confirmation.hashes.annotated_png_sha256]]) {
    try {
      const dimensions = parsePng(loaded[name]);
      if (dimensions.width !== confirmation.dimensions?.width || dimensions.height !== confirmation.dimensions?.height) return generationBlocked(session.session_id, `${name}_dimensions_mismatch`);
    } catch {
      return generationBlocked(session.session_id, `${name}_invalid_png`);
    }
    if (!expected) return generationBlocked(session.session_id, `${name}_hash_missing`);
  }
  return {
    allow: true,
    session_id: session.session_id,
    confirmation_id: confirmation.confirmation_id,
    confirmed_by: confirmation.confirmed_by,
    ui_instance_id: confirmation.ui_instance_id,
    candidate_id: confirmation.candidate_id,
    revision: confirmation.revision,
    layout_version: confirmation.layout_version,
    dimensions: confirmation.dimensions,
    files: confirmation.files,
    hashes: confirmation.hashes,
    user_selected_candidate: confirmation.user_selected_candidate ?? null
  };
}

export async function buildGenerationRequestPreview(dataRoot, body = {}) {
  const preflight = await generationPreflight(dataRoot, body);
  if (!preflight.allow) return preflight;
  const { paths, session } = await ensureSession(dataRoot, body.session_id);
  const persistedConfirmation = session.confirmed;
  const resolvedFiles = {};
  try {
    for (const [name, relativeFile] of Object.entries(persistedConfirmation.files ?? {})) {
      resolvedFiles[name] = resolveConfirmedFile(paths, relativeFile);
    }
  } catch {
    return generationBlocked(body.session_id, "confirmed_file_refs_unavailable");
  }
  let detailConstraints;
  try {
    detailConstraints = JSON.parse(await fs.readFile(resolvedFiles.detail_constraints, "utf8"));
  } catch {
    return generationBlocked(body.session_id, "confirmed_detail_constraints_unavailable");
  }
  try {
    // Persisted confirmations intentionally keep paths relative to the
    // session root. The formal preview is the host-facing boundary: it maps
    // those records to absolute local refs and flattens persisted hashes so a
    // model never needs an ad-hoc import or hand-written verification object.
    const verifiedConfirmation = {
      ...persistedConfirmation,
      sketch_json_path: resolvedFiles.sketch_json,
      clean_png_path: resolvedFiles.clean_png,
      annotated_png_path: resolvedFiles.annotated_png,
      detail_constraints_path: resolvedFiles.detail_constraints,
      sketch_json_sha256: persistedConfirmation.hashes?.sketch_json_sha256,
      clean_png_sha256: persistedConfirmation.hashes?.clean_png_sha256,
      annotated_png_sha256: persistedConfirmation.hashes?.annotated_png_sha256,
      detail_constraints_sha256: persistedConfirmation.hashes?.detail_constraints_sha256,
      files: { ...persistedConfirmation.files, absolute: resolvedFiles }
    };
    const request = buildGenerationRequest({
      brief: session.poster_brief,
      confirmation: { ...verifiedConfirmation, detail_constraints: detailConstraints },
      verification: {
        source: "layout-service",
        persisted: true,
        session_id: session.session_id,
        confirmation_id: session.confirmed.confirmation_id,
        confirmed_by: "user_ui"
      }
    });
    return { allow: true, preflight, request };
  } catch (error) {
    return generationBlocked(body.session_id, "generation_request_invalid", { error: error.message });
  }
}

async function serveStatic(rootDir, requestPath, response) {
  if (!Object.hasOwn(MIME_TYPES, requestPath)) return textResponse(response, 404, "Not found");
  const filePath = requestPath === "/vendor/fabric.js"
    ? path.join(rootDir, "web", "vendor", "fabric.js")
    : requestPath === "/contracts/sketch-document.schema.json"
      ? path.join(rootDir, "contracts", "sketch-document.schema.json")
    : requestPath === "/contracts/layout-session.schema.json"
      ? path.join(rootDir, "contracts", "layout-session.schema.json")
    : requestPath === "/contracts/layout-archetypes.schema.json"
      ? path.join(rootDir, "contracts", "layout-archetypes.schema.json")
      : requestPath === "/contracts/poster-brief.schema.json"
        ? path.join(rootDir, "contracts", "poster-brief.schema.json")
        : requestPath === "/contracts/generation-request.schema.json"
          ? path.join(rootDir, "contracts", "generation-request.schema.json")
          : path.join(rootDir, "web", requestPath === "/" ? "index.html" : requestPath.slice(1));
  try {
    const body = await fs.readFile(filePath);
    response.writeHead(200, { "content-type": MIME_TYPES[requestPath], "cache-control": "no-store", "content-length": body.length, ...(response.__layoutCorsHeaders ?? CORS_HEADERS) });
    response.end(body);
  } catch {
    textResponse(response, 500, "Static asset unavailable");
  }
}

const mcpAppHtmlCache = new Map();

async function buildMcpAppHtml(rootDir, serviceUrl) {
  const cacheKey = `${path.resolve(rootDir)}:${serviceUrl}`;
  const cached = mcpAppHtmlCache.get(cacheKey);
  if (cached) return cached;
  const [html, styles, fabric, app] = await Promise.all([
    fs.readFile(path.join(rootDir, "web", "index.html"), "utf8"),
    fs.readFile(path.join(rootDir, "web", "styles.css"), "utf8"),
    fs.readFile(path.join(rootDir, "web", "vendor", "fabric.js"), "utf8"),
    fs.readFile(path.join(rootDir, "web", "app.js"), "utf8")
  ]);
  const bootstrap = `<script>window.__layoutGuidedApiBase=${JSON.stringify(serviceUrl)};</script>`;
  const embedded = html
    .replace('<link rel="stylesheet" href="/styles.css" />', `<style data-layout-guided-styles>\n${styles}\n</style>`)
    .replace('<script src="/vendor/fabric.js"></script>', `<script data-layout-guided-fabric>\n${fabric}\n</script>`)
    .replace('<script type="module" src="/app.js"></script>', `${bootstrap}<script type="module">\n${app}\n</script>`);
  if (embedded.includes('href="/styles.css"') || embedded.includes('src="/vendor/fabric.js"') || embedded.includes('src="/app.js"')) {
    throw httpError(500, "MCP Apps resource could not inline the workbench assets");
  }
  mcpAppHtmlCache.set(cacheKey, embedded);
  return embedded;
}

async function buildMcpAppResource(service) {
  return {
    uri: MCP_APP_RESOURCE_URI,
    name: "layout-guided-ai-imagen-workbench",
    title: "Layout-Guided AI Imagen workbench",
    description: "Editable Fabric canvas for comparing and confirming local poster layout candidates.",
    mimeType: MCP_APP_RESOURCE_MIME,
    text: await buildMcpAppHtml(service.rootDir, service.url),
    _meta: {
      ui: {
        prefersBorder: false,
        csp: {
          connectDomains: [service.url],
          resourceDomains: []
        }
      },
      "openai/widgetDescription": "Compare editable poster layout candidates. In a real MCP Apps bridge, submit through tools/call and ui/message; in an ordinary browser fallback, rely on a short-lived wait_for_layout_action listener lease and report when no AI listener is connected."
    }
  };
}

async function handleEvents({ dataRoot, request, response, sessionId, candidateId, after, subscribers }) {
  const { paths } = await ensureSession(dataRoot, sessionId);
  const events = await readOperationEvents(paths);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(response.__layoutCorsHeaders ?? CORS_HEADERS)
  });
  response.flushHeaders?.();
  for (const event of events) {
    if (event.cursor <= after || (candidateId && event.candidate_id !== candidateId)) continue;
    sendSse(response, event);
  }
  const subscriber = { session_id: sessionId, candidate_id: candidateId, response };
  subscribers.add(subscriber);
  const keepAlive = setInterval(() => {
    try { response.write(": keep-alive\n\n"); } catch { clearInterval(keepAlive); subscribers.delete(subscriber); }
  }, 15000);
  keepAlive.unref?.();
  const cleanup = () => {
    clearInterval(keepAlive);
    subscribers.delete(subscriber);
  };
  request.on("close", cleanup);
  response.on("close", cleanup);
}

async function handleHttpRequest({ rootDir, dataRoot, request, response, subscribers }) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const requestPath = requestUrl.pathname;
  response.__layoutCorsHeaders = corsHeadersForRequest(request);
  if (request.method === "OPTIONS") {
    response.writeHead(204, response.__layoutCorsHeaders);
    response.end();
    return;
  }
  if (request.method === "GET" && requestPath === "/health") {
    jsonResponse(response, 200, { ok: true, service: "layout-guided-ai-imagen-stage4-v11", storage: "local", canvas: "fabric.js", schema: "sketch-document/1", session_schema: "layout-session/4" });
    return;
  }
  if (request.method === "POST" && requestPath === "/api/session") {
    const result = await createSession(dataRoot, await readJsonBody(request));
    jsonResponse(response, result.created ? 201 : 200, result);
    return;
  }
  if (request.method === "POST" && requestPath === "/api/poster-brief/validate") {
    jsonResponse(response, 200, validatePosterBrief(await readJsonBody(request)));
    return;
  }
  if (request.method === "POST" && requestPath === "/api/layout-candidates") {
    const body = await readJsonBody(request);
    const validation = validatePosterBrief(body.brief);
    if (!validation.can_enter_layout) {
      jsonResponse(response, 422, validation);
      return;
    }
    jsonResponse(response, 200, buildLayoutCandidates(validation.brief, { candidateCount: body.candidate_count }));
    return;
  }
  const uiMatch = requestPath.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})\/ui\/(bootstrap|select|confirmation-intent|confirmation-status|return-to-edit)$/);
  if (uiMatch) {
    const sessionId = uiMatch[1];
    const action = uiMatch[2];
    if (request.method === "POST" && action === "bootstrap") {
      const result = await bootstrapUiSession(dataRoot, { ...await readJsonBody(request), session_id: sessionId }, request);
      jsonResponse(response, 201, result, { "set-cookie": result._setCookie });
      return;
    }
    if (request.method === "POST" && action === "select") {
      jsonResponse(response, 200, await selectUiCandidate(dataRoot, { ...await readJsonBody(request), session_id: sessionId }, request));
      return;
    }
    if (request.method === "POST" && action === "confirmation-intent") {
      jsonResponse(response, 200, await issueConfirmationIntent(dataRoot, { ...await readJsonBody(request), session_id: sessionId }, request));
      return;
    }
    if (request.method === "POST" && action === "return-to-edit") {
      jsonResponse(response, 200, await returnToLayoutEditing(dataRoot, { ...await readJsonBody(request), session_id: sessionId }, request, subscribers));
      return;
    }
    if (request.method === "GET" && action === "confirmation-status") {
      jsonResponse(response, 200, await getConfirmationStatus(dataRoot, { session_id: sessionId }));
      return;
    }
  }
  const generationPreflightMatch = requestPath.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})\/generation\/preflight$/);
  if (generationPreflightMatch && request.method === "POST") {
    jsonResponse(response, 200, await generationPreflight(dataRoot, { ...await readJsonBody(request), session_id: generationPreflightMatch[1] }));
    return;
  }
  const listenerMatch = requestPath.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})\/layout-listener\/(claim|heartbeat|release|wait)$/);
  if (listenerMatch && request.method === "POST") {
    const sessionId = listenerMatch[1];
    const action = listenerMatch[2];
    const body = { ...await readJsonBody(request), session_id: sessionId };
    const result = action === "claim"
      ? await claimLayoutListener(dataRoot, body)
      : action === "heartbeat"
        ? await heartbeatLayoutListener(dataRoot, body)
        : action === "release"
          ? await releaseLayoutListener(dataRoot, body)
          : await waitForLayoutAction(dataRoot, body);
    jsonResponse(response, 200, result);
    return;
  }
  const layoutResultMatch = requestPath.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})\/layout-change\/([A-Za-z0-9_-]{1,128})\/result$/);
  if (layoutResultMatch && request.method === "POST") {
    const body = await readJsonBody(request);
    jsonResponse(response, 200, await resolveLayoutChange(dataRoot, { ...body, session_id: layoutResultMatch[1], request_id: layoutResultMatch[2] }, subscribers));
    return;
  }
  const layoutCancelMatch = requestPath.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})\/layout-change\/([A-Za-z0-9_-]{1,128})\/cancel$/);
  if (layoutCancelMatch && request.method === "POST") {
    const body = await readJsonBody(request);
    jsonResponse(response, 200, await cancelLayoutChange(dataRoot, { ...body, session_id: layoutCancelMatch[1], request_id: layoutCancelMatch[2] }, subscribers));
    return;
  }
  const sessionMatch = requestPath.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})(?:\/(sketch|ops|begin|complete|confirm|confirmed|layout-change|events|layout-candidates)|\/generation\/(interrupt|resume))?$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const endpoint = sessionMatch[2] ?? null;
    const generationAction = sessionMatch[3] ?? null;
    if (request.method === "GET" && endpoint === null) {
      const { session } = await ensureSession(dataRoot, sessionId);
      jsonResponse(response, 200, snapshot(session));
      return;
    }
    if (request.method === "GET" && endpoint === "events") {
      const after = Number(requestUrl.searchParams.get("after") ?? 0);
      if (!Number.isInteger(after) || after < 0) throw httpError(422, "after must be a non-negative integer");
      if (["json", "poll"].includes(requestUrl.searchParams.get("format"))) {
        const { paths } = await ensureSession(dataRoot, sessionId);
        const allEvents = await readOperationEvents(paths);
        const candidateFilter = requestUrl.searchParams.get("candidate_id");
        const events = allEvents.filter((event) => event.cursor > after && (!candidateFilter || event.candidate_id === candidateFilter));
        const nextCursor = allEvents.reduce((cursor, event) => Math.max(cursor, Number(event.cursor) || 0), after);
        jsonResponse(response, 200, { session_id: sessionId, after, next_cursor: nextCursor, events });
        return;
      }
      await handleEvents({ dataRoot, request, response, sessionId, candidateId: requestUrl.searchParams.get("candidate_id"), after, subscribers });
      return;
    }
    if (request.method === "PUT" && endpoint === "sketch") {
      jsonResponse(response, 200, await saveSketch(dataRoot, { ...await readJsonBody(request), session_id: sessionId }));
      return;
    }
    if (request.method === "POST" && endpoint === "begin") {
      const body = await readJsonBody(request);
      const result = await beginSketch(dataRoot, { ...body, session_id: sessionId });
      jsonResponse(response, 200, { session_id: sessionId, candidate_id: result.candidate.candidate_id, stream_id: result.stream.stream_id, revision: result.candidate.document.revision, status: result.candidate.document.status });
      return;
    }
    if (request.method === "POST" && endpoint === "ops") {
      const result = await applyBatch(dataRoot, { ...await readJsonBody(request), session_id: sessionId }, subscribers);
      jsonResponse(response, result.idempotent ? 200 : 201, {
        session_id: sessionId,
        candidate_id: result.candidate.candidate_id,
        revision: result.candidate.document.revision,
        idempotent: result.idempotent,
        event: result.event,
        document: result.candidate.document
      });
      return;
    }
    if (request.method === "POST" && endpoint === "complete") {
      const result = await completeSketch(dataRoot, { ...await readJsonBody(request), session_id: sessionId }, subscribers);
      jsonResponse(response, 200, { session_id: sessionId, candidate_id: result.candidate.candidate_id, revision: result.candidate.document.revision, status: result.candidate.document.status, event: result.event });
      return;
    }
    if (request.method === "POST" && endpoint === "confirm") {
      jsonResponse(response, 201, await confirmLayout(dataRoot, { ...await readJsonBody(request), session_id: sessionId }, subscribers, request));
      return;
    }
    if (request.method === "POST" && endpoint === "layout-change") {
      jsonResponse(response, 202, await submitLayoutChange(dataRoot, { ...await readJsonBody(request), session_id: sessionId }));
      return;
    }
    if (request.method === "POST" && endpoint === "layout-candidates") {
      jsonResponse(response, 200, await seedLayoutCandidates(dataRoot, { ...await readJsonBody(request), session_id: sessionId }, subscribers));
      return;
    }
    if (request.method === "POST" && generationAction === "interrupt") {
      jsonResponse(response, 200, await interruptSketch(dataRoot, { ...await readJsonBody(request), session_id: sessionId }, subscribers));
      return;
    }
    if (request.method === "POST" && generationAction === "resume") {
      jsonResponse(response, 200, await resumeSketch(dataRoot, { ...await readJsonBody(request), session_id: sessionId }, subscribers));
      return;
    }
    if (request.method === "GET" && endpoint === "confirmed") {
      jsonResponse(response, 200, await getConfirmedInputs(dataRoot, { session_id: sessionId }));
      return;
    }
  }
  if (request.method === "GET" && MIME_TYPES[requestPath]) {
    await serveStatic(rootDir, requestPath, response);
    return;
  }
  textResponse(response, 404, "Not found");
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(server.address()); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function listenWithFallback(server, host, preferredPort) {
  try {
    return await listen(server, host, preferredPort);
  } catch (error) {
    if (error.code !== "EADDRINUSE" || preferredPort === 0) throw error;
    return listen(server, host, 0);
  }
}

export async function startLocalService({ rootDir = PLUGIN_ROOT, dataRoot = process.env.LAYOUT_GUIDED_DATA_DIR || DEFAULT_DATA_ROOT, host = "127.0.0.1", port = 0 } = {}) {
  const subscribers = new Set();
  const resolvedDataRoot = path.resolve(dataRoot);
  const server = createHttpServer((request, response) => {
    handleHttpRequest({ rootDir, dataRoot: resolvedDataRoot, request, response, subscribers }).catch((error) => {
      if (response.headersSent) {
        try { response.end(); } catch { /* response already closed */ }
        return;
      }
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      jsonResponse(response, statusCode, { error: error.message });
    });
  });
  const address = await listenWithFallback(server, host, port);
  const actualPort = typeof address === "object" && address ? address.port : port;
  const serviceId = randomUUID();
  const discoveryPath = serviceDiscoveryPath(resolvedDataRoot);
  const service = {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    dataRoot: resolvedDataRoot,
    rootDir,
    subscribers,
    serviceId,
    discoveryPath,
    startedAt: new Date().toISOString()
  };
  await writeServiceDiscovery(resolvedDataRoot, {
    schema_version: "layout-guided-service/1",
    service_id: serviceId,
    pid: process.pid,
    host,
    port: actualPort,
    url: service.url,
    data_root: resolvedDataRoot,
    root_dir: path.resolve(rootDir),
    started_at: service.startedAt,
    protocol: "local-http-v1"
  });
  return service;
}

export async function stopLocalService(service) {
  if (!service?.server) return;
  for (const subscriber of service.subscribers ?? []) {
    try { subscriber.response.destroy(); } catch { /* response already closed */ }
  }
  service.subscribers?.clear();
  await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
  await removeServiceDiscovery(service);
}

const TOOL_DEFINITIONS = [
  {
    name: "open_layout_workbench",
    description: "Open the V1.1 local lightweight sketch canvas. In MCP Apps hosts the resource uses the verified ui bridge; ordinary browser fallback requires an active bounded listener lease.",
    inputSchema: { type: "object", properties: { session_id: { type: "string", default: DEFAULT_SESSION_ID } }, additionalProperties: false },
    _meta: {
      ui: { resourceUri: MCP_APP_RESOURCE_URI },
      "openai/outputTemplate": MCP_APP_RESOURCE_URI
    }
  },
  {
    name: "create_session",
    description: "Create a local layout session without overwriting an existing session; omitted IDs receive a generated ID.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, additionalProperties: false }
  },
  {
    name: "validate_poster_brief",
    description: "Validate a structured PosterBrief, preserve its exact copy, and report only missing fields, conflicts, and attachment failures; this does not perform NLP or OCR.",
    inputSchema: { type: "object", properties: { brief: { type: "object" } }, required: ["brief"], additionalProperties: false }
  },
  {
    name: "build_layout_candidates",
    description: "Build 2 or 3 deterministic SketchDocument layout candidates from the product-owned layout-archetype catalog, with selection scores, rationale, difference axes, and schematic previews; it never calls an image model.",
    inputSchema: {
      type: "object",
      properties: { brief: { type: "object" }, candidate_count: { type: "integer", minimum: 2, maximum: 3, default: 3 } },
      required: ["brief"],
      additionalProperties: false
    }
  },
  {
    name: "list_layout_archetypes",
    description: "List the product-owned layout-archetype catalog and provenance boundary so a host model can inspect fit signals, composition grammar, difference axes, schematic definitions, and the deterministic local-fallback selection policy before explaining a layout choice; real-model aesthetic selection remains unverified.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "seed_layout_candidates",
    description: "Seed a ready PosterBrief's 2 or 3 candidates into one local session and optionally start their committed operation streams; it never calls an image model.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        brief: { type: "object" },
        candidate_count: { type: "integer", minimum: 2, maximum: 3, default: 3 },
        auto_start: { type: "boolean", default: true },
        batch_delay_ms: { type: "integer", minimum: 0, maximum: 2000 },
        include_plans: { type: "boolean", default: false }
      },
      required: ["session_id", "brief"],
      additionalProperties: false
    }
  },
  {
    name: "get_session_status",
    description: "Return local session status, candidates, revision, and confirmation state.",
    inputSchema: { type: "object", properties: { session_id: { type: "string", default: DEFAULT_SESSION_ID } }, additionalProperties: false }
  },
  {
    name: "get_sketch_document",
    description: "Read the current product-owned SketchDocument for one candidate.",
    inputSchema: { type: "object", properties: { session_id: { type: "string", default: DEFAULT_SESSION_ID }, candidate_id: { type: "string", default: "A" } }, additionalProperties: false }
  },
  {
    name: "begin_sketch",
    description: "Start an AI or user sketch operation stream.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string", default: DEFAULT_SESSION_ID }, candidate_id: { type: "string" }, stream_id: { type: "string" } },
      required: ["stream_id"],
      additionalProperties: false
    }
  },
  {
    name: "apply_sketch_ops",
    description: "Atomically apply one ordered, idempotent SketchDocument operation batch.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", default: DEFAULT_SESSION_ID },
        candidate_id: { type: "string" },
        stream_id: { type: "string" },
        batch_seq: { type: "integer", minimum: 1 },
        base_revision: { type: "integer", minimum: 0 },
        operations: { type: "array", minItems: 1 }
      },
      required: ["candidate_id", "stream_id", "batch_seq", "base_revision", "operations"],
      additionalProperties: false
    }
  },
  {
    name: "complete_sketch",
    description: "Complete a sketch stream without replaying an animation.",
    inputSchema: { type: "object", properties: { session_id: { type: "string", default: DEFAULT_SESSION_ID }, candidate_id: { type: "string" }, stream_id: { type: "string" } }, required: ["candidate_id", "stream_id"], additionalProperties: false }
  },
  {
    name: "interrupt_sketch",
    description: "Mark one local operation stream interrupted while preserving its last committed revision for cursor recovery.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" }, candidate_id: { type: "string" }, stream_id: { type: "string" } }, required: ["session_id", "candidate_id", "stream_id"], additionalProperties: false }
  },
  {
    name: "resume_sketch",
    description: "Resume a stored local operation plan from its last committed batch; no animation replay is used.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" }, candidate_id: { type: "string" }, stream_id: { type: "string" }, batch_delay_ms: { type: "integer", minimum: 0, maximum: 2000 } }, required: ["session_id", "candidate_id", "stream_id"], additionalProperties: false }
  },
  {
    name: "save_sketch_version",
    description: "Persist the current SketchDocument revision for a candidate and keep its initial, current, and versioned local files.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" }, document: { type: "object" } }, required: ["session_id", "document"], additionalProperties: false }
  },
  {
    name: "submit_layout_change",
    description: "Submit a natural-language broad-structure layout change request as a recoverable pending record; region relationships and hierarchy may change, while final typography/style remains image-model creative freedom. Request text is kept only in a private local session request record, never in logs or status snapshots.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, candidate_id: { type: "string" }, base_revision: { type: "integer", minimum: 0 }, request: { type: "string", minLength: 1, maxLength: 32768 } },
      required: ["session_id", "request"],
      additionalProperties: false
    }
  },
  {
    name: "claim_layout_listener",
    description: "Claim a short-lived, renewable listener lease for a browser fallback, bundled CLI runner, or MCP Apps turn. Expired leases make pending layout requests reclaimable; if MCP tools are absent, route through the bundled CLI rather than hand-writing a client.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        listener_id: { type: "string" },
        lease_token: { type: "string" },
        transport: { enum: ["browser_fallback", "mcp_apps_bridge", "cli_runner"], default: "browser_fallback" },
        lease_ms: { type: "integer", minimum: 10000, maximum: 120000 },
        after_cursor: { type: "integer", minimum: 0 }
      },
      required: ["session_id"],
      additionalProperties: false
    }
  },
  {
    name: "heartbeat_layout_listener",
    description: "Renew a layout listener lease and its event cursor. Call between bounded waits so a live model turn remains connected.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        listener_id: { type: "string" },
        lease_token: { type: "string" },
        lease_ms: { type: "integer", minimum: 10000, maximum: 120000 },
        cursor: { type: "integer", minimum: 0 }
      },
      required: ["session_id", "listener_id", "lease_token"],
      additionalProperties: false
    }
  },
  {
    name: "wait_for_layout_action",
    description: "Wait for one layout_change, confirm, cancel, or layout_change_result event using a renewable listener lease. Each call is finite (at most 30 seconds) and returns a cursor/heartbeat so the workflow can loop without an infinite blocking tool call.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        listener_id: { type: "string" },
        lease_token: { type: "string" },
        after_cursor: { type: "integer", minimum: 0 },
        timeout_ms: { type: "integer", minimum: 0, maximum: 30000 },
        candidate_id: { type: "string" },
        event_types: { type: "array", items: { enum: ["layout_change", "confirm", "cancel", "layout_change_result"] } }
      },
      required: ["session_id", "listener_id", "lease_token"],
      additionalProperties: false
    }
  },
  {
    name: "release_layout_listener",
    description: "Release a layout listener lease. Pending requests remain recoverable and can be reclaimed by a later listener.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, listener_id: { type: "string" }, lease_token: { type: "string" } },
      required: ["session_id", "listener_id", "lease_token"],
      additionalProperties: false
    }
  },
  {
    name: "cancel_layout_change",
    description: "Cancel one pending layout change without changing the current SketchDocument; the cancellation wakes a waiting listener and remains recoverable in session state.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, request_id: { type: "string" }, listener_id: { type: "string" }, lease_token: { type: "string" }, reason: { type: "string", maxLength: 80 } },
      required: ["session_id", "request_id"],
      additionalProperties: false
    }
  },
  {
    name: "resolve_layout_change",
    description: "Accept an explicit host callback result for a pending layout request; only structured operations are applied, and a failed callback preserves the last document.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, request_id: { type: "string" }, status: { enum: ["applied", "failed"] }, operations: { type: "array" }, stream_id: { type: "string" }, error_category: { type: "string" } },
      required: ["session_id", "request_id", "status"],
      additionalProperties: false
    }
  },
  {
    name: "confirm_layout",
    description: "Consume a one-time confirmation intent created by an explicit browser/MCP Apps UI click. Direct MCP/HTTP/CLI calls and confirmed_by fields are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        document: { type: "object" },
        clean_png_data_uri: { type: "string" },
        annotated_png_data_uri: { type: "string" },
        detail_constraints: { type: "array" },
        confirmation_intent: { type: "string" }
      },
      required: ["session_id", "document", "clean_png_data_uri", "annotated_png_data_uri"],
      additionalProperties: false
    }
  },
  {
    name: "get_confirmed_inputs",
    description: "Read confirmed layout export metadata and local file availability without loading image bytes into the tool response.",
    inputSchema: { type: "object", properties: { session_id: { type: "string", default: DEFAULT_SESSION_ID } }, required: ["session_id"], additionalProperties: false }
  },
  {
    name: "assess_image_capability",
    description: "Evaluate explicit host evidence for image generation and image input without calling an image tool.",
    inputSchema: {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              can_generate_image: { type: ["boolean", "null"] },
              accepts_image_input: { type: ["boolean", "null"] },
              max_image_inputs: { type: ["integer", "null"], minimum: 0 },
              evidence: { type: "string" }
            },
            required: ["can_generate_image", "accepts_image_input"],
            additionalProperties: false
          }
        }
      },
      required: ["candidates"],
      additionalProperties: false
    }
  },
  {
    name: "generation_preflight",
    description: "Fail-closed check of the server-persisted user_ui confirmation and its matching local exports before any image generation or package build.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false }
  },
  {
    name: "build_generation_request_preview",
    description: "Build a generation-request/3 preview only from a server-persisted user_ui confirmation. The service maps session-relative confirmed files to absolute local refs, flattens persisted hashes, and returns hard_constraints, soft_layout_guidance, and creative_freedom; do not import the internal builder or construct verification objects in the model turn.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false }
  }
];

let activeService;
let mcpStdioReady = false;

async function getActiveService() {
  activeService ??= await startLocalService();
  return activeService;
}

function writeMcpMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function mcpText(id, value, { structuredContent, meta } = {}) {
  const result = { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  if (meta !== undefined) result._meta = meta;
  writeMcpMessage({ jsonrpc: "2.0", id, result });
}

async function handleMcpMessage(message) {
  const id = message.id;
  if (message.method === "notifications/initialized") return;
  if (message.method === "ping") {
    if (id !== undefined) writeMcpMessage({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (message.method === "initialize") {
    await getActiveService();
    writeMcpMessage({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, resources: { listChanged: false } },
        serverInfo: { name: "layout-guided-ai-imagen", version: "0.2.11" }
      }
    });
    return;
  }
  if (message.method === "tools/list") {
    writeMcpMessage({ jsonrpc: "2.0", id, result: { tools: TOOL_DEFINITIONS } });
    return;
  }
  if (message.method === "resources/list") {
    writeMcpMessage({
      jsonrpc: "2.0",
      id,
      result: {
        resources: [{
          uri: MCP_APP_RESOURCE_URI,
          name: "layout-guided-ai-imagen-workbench",
          title: "Layout-Guided AI Imagen workbench",
          description: "Editable Fabric canvas for comparing and confirming local poster layout candidates.",
          mimeType: MCP_APP_RESOURCE_MIME
        }]
      }
    });
    return;
  }
  if (message.method === "resources/read") {
    const service = await getActiveService();
    if (message.params?.uri !== MCP_APP_RESOURCE_URI) {
      if (id !== undefined) writeMcpMessage({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown resource URI: ${message.params?.uri ?? ""}` } });
      return;
    }
    const resource = await buildMcpAppResource(service);
    writeMcpMessage({ jsonrpc: "2.0", id, result: { contents: [resource] } });
    return;
  }
  if (message.method !== "tools/call") {
    if (id !== undefined) writeMcpMessage({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported method: ${message.method}` } });
    return;
  }
  const service = await getActiveService();
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  try {
    if (name === "open_layout_workbench") {
      const requestedSessionId = args.session_id ?? DEFAULT_SESSION_ID;
      const workbenchUrl = `${service.url}/?session=${encodeURIComponent(requestedSessionId)}`;
      mcpText(id, workbenchUrl, {
        structuredContent: {
          session_id: requestedSessionId,
          url: workbenchUrl,
          resource_uri: MCP_APP_RESOURCE_URI,
          connection_modes: {
            mcp_apps_bridge: "host-detected-only",
            browser_fallback: "requires_claim_layout_listener_and_bounded_waits"
          },
          open_policy: "open_in_codex_first; browser_url_only_after_explicit_failure; one_page_per_session",
          lifecycle: "keep_current_turn_active_until_confirm_cancel_or_listener_release"
        },
        meta: { "openai/outputTemplate": MCP_APP_RESOURCE_URI }
      });
    } else if (name === "create_session") {
      mcpText(id, await createSession(service.dataRoot, args));
    } else if (name === "validate_poster_brief") {
      mcpText(id, validatePosterBrief(args.brief));
    } else if (name === "list_layout_archetypes") {
      mcpText(id, listLayoutArchetypes());
    } else if (name === "build_layout_candidates") {
      const validation = validatePosterBrief(args.brief);
      if (!validation.can_enter_layout) mcpText(id, validation);
      else mcpText(id, buildLayoutCandidates(validation.brief, { candidateCount: args.candidate_count }));
    } else if (name === "seed_layout_candidates") {
      mcpText(id, await seedLayoutCandidates(service.dataRoot, args, service.subscribers));
    } else if (name === "get_session_status") {
      const { session } = await ensureSession(service.dataRoot, args.session_id ?? DEFAULT_SESSION_ID);
      mcpText(id, snapshot(session));
    } else if (name === "get_sketch_document") {
      const { session } = await ensureSession(service.dataRoot, args.session_id ?? DEFAULT_SESSION_ID);
      mcpText(id, requireCandidate(session, args.candidate_id ?? session.active_candidate_id).document);
    } else if (name === "begin_sketch") {
      const result = await beginSketch(service.dataRoot, { ...args, session_id: args.session_id ?? DEFAULT_SESSION_ID });
      mcpText(id, { candidate_id: result.candidate.candidate_id, stream_id: result.stream.stream_id, revision: result.candidate.document.revision, status: result.candidate.document.status });
    } else if (name === "apply_sketch_ops") {
      const result = await applyBatch(service.dataRoot, { ...args, session_id: args.session_id ?? DEFAULT_SESSION_ID }, service.subscribers);
      mcpText(id, { candidate_id: result.candidate.candidate_id, stream_id: result.stream.stream_id, batch_seq: args.batch_seq, revision: result.candidate.document.revision, idempotent: result.idempotent, event_cursor: result.event?.cursor ?? null });
    } else if (name === "complete_sketch") {
      const result = await completeSketch(service.dataRoot, { ...args, session_id: args.session_id ?? DEFAULT_SESSION_ID }, service.subscribers);
      mcpText(id, { candidate_id: result.candidate.candidate_id, revision: result.candidate.document.revision, status: result.candidate.document.status, event_cursor: result.event.cursor });
    } else if (name === "interrupt_sketch") {
      mcpText(id, await interruptSketch(service.dataRoot, args, service.subscribers));
    } else if (name === "resume_sketch") {
      mcpText(id, await resumeSketch(service.dataRoot, args, service.subscribers));
    } else if (name === "save_sketch_version") {
      mcpText(id, await saveSketch(service.dataRoot, args));
    } else if (name === "submit_layout_change") {
      const result = await submitLayoutChange(service.dataRoot, args);
      mcpText(id, result, { structuredContent: result });
    } else if (name === "claim_layout_listener") {
      const result = await claimLayoutListener(service.dataRoot, args);
      mcpText(id, result, { structuredContent: result });
    } else if (name === "heartbeat_layout_listener") {
      const result = await heartbeatLayoutListener(service.dataRoot, args);
      mcpText(id, result, { structuredContent: result });
    } else if (name === "wait_for_layout_action") {
      const result = await waitForLayoutAction(service.dataRoot, args);
      mcpText(id, result, { structuredContent: result });
    } else if (name === "release_layout_listener") {
      const result = await releaseLayoutListener(service.dataRoot, args);
      mcpText(id, result, { structuredContent: result });
    } else if (name === "cancel_layout_change") {
      const result = await cancelLayoutChange(service.dataRoot, args, service.subscribers);
      mcpText(id, result, { structuredContent: result });
    } else if (name === "resolve_layout_change") {
      const result = await resolveLayoutChange(service.dataRoot, args, service.subscribers);
      mcpText(id, result, { structuredContent: result });
    } else if (name === "confirm_layout") {
      mcpText(id, await confirmLayout(service.dataRoot, args, service.subscribers));
    } else if (name === "get_confirmed_inputs") {
      mcpText(id, await getConfirmedInputs(service.dataRoot, { session_id: args.session_id ?? DEFAULT_SESSION_ID }));
    } else if (name === "assess_image_capability") {
      mcpText(id, assessImageCapabilities(args.candidates));
    } else if (name === "generation_preflight") {
      mcpText(id, await generationPreflight(service.dataRoot, args));
    } else if (name === "build_generation_request_preview") {
      mcpText(id, await buildGenerationRequestPreview(service.dataRoot, args));
    } else {
      writeMcpMessage({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } });
    }
  } catch (error) {
    writeMcpMessage({ jsonrpc: "2.0", id, error: { code: -32000, message: error.message } });
  }
}

async function runMcpServer() {
  const service = await getActiveService();
  mcpStdioReady = true;
  process.stderr.write(`layout_guided_ai_imagen_service_ready_v11 port=${service.port}\n`);
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    let newlineIndex;
    while ((newlineIndex = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, newlineIndex).trim();
      input = input.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        handleMcpMessage(message).catch((error) => {
          if (message.id !== undefined) writeMcpMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } });
        });
      } catch {
        process.stderr.write("layout_guided_ai_imagen_invalid_mcp_message\n");
      }
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) runMcpServer();

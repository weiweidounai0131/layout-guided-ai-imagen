import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { test, before, after } from "node:test";
import { buildDetailConstraints } from "../mcp/sketch-document.mjs";
import { startLocalService, stopLocalService } from "../mcp/server.mjs";
import { createUiSession, confirmWithUi } from "./ui-confirmation-helper.mjs";

const fixtureEntries = JSON.parse(await fs.readFile(new URL("./fixtures/stage4-briefs.json", import.meta.url), "utf8"));
let dataRoot;
let service;

function request(serviceInfo, requestPath, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, serviceInfo.url);
    const payload = body === undefined ? null : JSON.stringify(body);
    const requestObject = http.request(url, {
      method,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let value = raw;
        try { value = JSON.parse(raw); } catch { /* text */ }
        resolve({ status: response.statusCode, value });
      });
    });
    requestObject.on("error", reject);
    if (payload) requestObject.write(payload);
    requestObject.end();
  });
}

function fixture(name) {
  return fixtureEntries.find((entry) => entry.scenario === name);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function pngDataUri(width, height, rgba = [11, 20, 36, 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width * 4 + 1);
    pixels[offset] = 0;
    for (let column = 0; column < width; column += 1) Buffer.from(rgba).copy(pixels, offset + 1 + column * 4);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function seed(sessionId, scenario, options = {}) {
  const result = await request(service, `/api/session/${sessionId}/layout-candidates`, {
    method: "POST",
    body: { brief: fixture(scenario).brief, candidate_count: 3, include_plans: true, ...options }
  });
  assert.equal(result.status, 200, result.value.error);
  return result.value;
}

function streamId(seedResult, candidateId) {
  const key = Object.keys(seedResult.streams).find((item) => item.startsWith(`${candidateId}:`));
  assert.ok(key);
  return seedResult.streams[key].stream_id;
}

function candidatePlan(seedResult, candidateId) {
  const candidate = seedResult.candidates.find((item) => item.candidate_id === candidateId);
  assert.ok(candidate);
  return candidate.operation_batches;
}

async function snapshot(sessionId) {
  const result = await request(service, `/api/session/${sessionId}`);
  assert.equal(result.status, 200);
  return result.value;
}

async function commitPlan(sessionId, seedResult, candidateId) {
  const stream = streamId(seedResult, candidateId);
  const started = await request(service, `/api/session/${sessionId}/begin`, { method: "POST", body: { candidate_id: candidateId, stream_id: stream } });
  assert.equal(started.status, 200);
  let revision = started.value.revision;
  for (const batch of candidatePlan(seedResult, candidateId)) {
    const applied = await request(service, `/api/session/${sessionId}/ops`, {
      method: "POST",
      body: { candidate_id: candidateId, stream_id: stream, batch_seq: batch.batch_seq, base_revision: revision, operations: batch.operations }
    });
    assert.equal(applied.status, 201, applied.value.error);
    revision = applied.value.revision;
  }
  const completed = await request(service, `/api/session/${sessionId}/complete`, { method: "POST", body: { candidate_id: candidateId, stream_id: stream } });
  assert.equal(completed.status, 200);
  return { stream, revision };
}

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("timeout waiting for Stage 4 local state");
}

before(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-stage4-test-"));
  service = await startLocalService({ dataRoot });
});

after(async () => {
  await stopLocalService(service);
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("seeds a ready brief into one session with isolated candidate files and streams", async () => {
  const seeded = await seed("stage4-isolation", "candidate-switch", { auto_start: false });
  assert.equal(seeded.candidate_count, 3);
  const initial = await snapshot("stage4-isolation");
  assert.deepEqual(initial.candidates.map((candidate) => candidate.candidate_id), ["A", "B", "C"]);
  for (const candidateId of ["A", "B", "C"]) {
    const candidateRoot = path.join(dataRoot, "stage4-isolation", "candidates", candidateId);
    for (const fileName of ["initial.sketch.json", "current.sketch.json", "operations.ndjson", path.join("versions", "v0.json")]) await fs.access(path.join(candidateRoot, fileName));
  }
  await commitPlan("stage4-isolation", seeded, "A");
  const afterA = await snapshot("stage4-isolation");
  assert.equal(afterA.candidates.find((candidate) => candidate.candidate_id === "A").status, "complete");
  assert.equal(afterA.candidates.find((candidate) => candidate.candidate_id === "B").document.revision, 0);
  const aEvents = (await fs.readFile(path.join(dataRoot, "stage4-isolation", "candidates", "A", "operations.ndjson"), "utf8")).trim().split("\n");
  assert.equal(aEvents.length, candidatePlan(seeded, "A").length + 1);
});

test("auto-starts sequential committed batches, preserves cursor polling, and resumes an interrupted stream", async () => {
  const seeded = await seed("stage4-resume", "interruption-resume", { auto_start: true, batch_delay_ms: 0 });
  const completed = await waitFor(async () => {
    const current = await snapshot("stage4-resume");
    return current.candidates.every((candidate) => candidate.status === "complete") ? current : null;
  }, 8000);
  assert.equal(completed.candidates.every((candidate) => candidate.document.revision === candidatePlan(seeded, "A").length), true);
  assert.equal(completed.active_candidate_id, "A");
  assert.equal(completed.event_cursor, candidatePlan(seeded, "A").length * 3 + 3);
  const poll = await request(service, `/api/session/stage4-resume/events?candidate_id=A&after=0&format=poll`);
  assert.equal(poll.status, 200);
  assert.equal(poll.value.events.filter((event) => event.event === "sketch_batch").length, candidatePlan(seeded, "A").length);

  const manual = await seed("stage4-manual-resume", "interruption-resume", { auto_start: false });
  const stream = streamId(manual, "A");
  await request(service, "/api/session/stage4-manual-resume/begin", { method: "POST", body: { candidate_id: "A", stream_id: stream } });
  const first = candidatePlan(manual, "A")[0];
  await request(service, "/api/session/stage4-manual-resume/ops", { method: "POST", body: { candidate_id: "A", stream_id: stream, batch_seq: 1, base_revision: 0, operations: first.operations } });
  const interrupted = await request(service, "/api/session/stage4-manual-resume/generation/interrupt", { method: "POST", body: { candidate_id: "A", stream_id: stream } });
  assert.equal(interrupted.status, 200);
  assert.equal((await snapshot("stage4-manual-resume")).candidates.find((candidate) => candidate.candidate_id === "A").document.revision, 1);
  const resumed = await request(service, "/api/session/stage4-manual-resume/generation/resume", { method: "POST", body: { candidate_id: "A", stream_id: stream, batch_delay_ms: 0 } });
  assert.equal(resumed.status, 200);
  const final = await waitFor(async () => {
    const current = await snapshot("stage4-manual-resume");
    return current.candidates.find((candidate) => candidate.candidate_id === "A")?.status === "complete" ? current : null;
  });
  assert.equal(final.candidates.find((candidate) => candidate.candidate_id === "A").document.revision, candidatePlan(manual, "A").length);
});

test("rejects stale batches without mutation and keeps failed natural-language callbacks recoverable", async () => {
  const seeded = await seed("stage4-conflict", "revision-conflict", { auto_start: false });
  const stream = streamId(seeded, "A");
  await request(service, "/api/session/stage4-conflict/begin", { method: "POST", body: { candidate_id: "A", stream_id: stream } });
  const first = candidatePlan(seeded, "A")[0];
  await request(service, "/api/session/stage4-conflict/ops", { method: "POST", body: { candidate_id: "A", stream_id: stream, batch_seq: 1, base_revision: 0, operations: first.operations } });
  const before = await snapshot("stage4-conflict");
  const stale = await request(service, "/api/session/stage4-conflict/ops", { method: "POST", body: { candidate_id: "A", stream_id: "stale", batch_seq: 1, base_revision: 0, operations: first.operations } });
  assert.equal(stale.status, 409);
  const after = await snapshot("stage4-conflict");
  assert.equal(after.candidates.find((candidate) => candidate.candidate_id === "A").document.revision, before.candidates.find((candidate) => candidate.candidate_id === "A").document.revision);

  const pending = await request(service, "/api/session/stage4-conflict/layout-change", { method: "POST", body: { candidate_id: "A", base_revision: before.candidates.find((candidate) => candidate.candidate_id === "A").document.revision, request: "标题下移一些，但其他修改保持不变" } });
  assert.equal(pending.status, 202);
  const failed = await request(service, `/api/session/stage4-conflict/layout-change/${pending.value.request_id}/result`, { method: "POST", body: { status: "failed", error_category: "host_callback_unavailable" } });
  assert.equal(failed.status, 200);
  const preserved = await snapshot("stage4-conflict");
  assert.equal(preserved.layout_requests.at(-1).status, "failed");
  assert.equal(preserved.candidates.find((candidate) => candidate.candidate_id === "A").document.revision, before.candidates.find((candidate) => candidate.candidate_id === "A").document.revision);
  const log = await fs.readFile(path.join(dataRoot, "stage4-conflict", "operations.ndjson"), "utf8");
  assert.doesNotMatch(log, /标题下移/);
});

test("applies only an explicit structured host callback and records a new revision", async () => {
  const seeded = await seed("stage4-callback", "candidate-switch", { auto_start: false });
  const stream = streamId(seeded, "A");
  await request(service, "/api/session/stage4-callback/begin", { method: "POST", body: { candidate_id: "A", stream_id: stream } });
  const first = candidatePlan(seeded, "A")[0];
  await request(service, "/api/session/stage4-callback/ops", { method: "POST", body: { candidate_id: "A", stream_id: stream, batch_seq: 1, base_revision: 0, operations: first.operations } });
  const second = candidatePlan(seeded, "A")[1];
  await request(service, "/api/session/stage4-callback/ops", { method: "POST", body: { candidate_id: "A", stream_id: stream, batch_seq: 2, base_revision: 1, operations: second.operations } });
  const current = await snapshot("stage4-callback");
  const title = current.candidates.find((candidate) => candidate.candidate_id === "A").document.objects.find((object) => object.type === "image_placeholder");
  const pending = await request(service, "/api/session/stage4-callback/layout-change", { method: "POST", body: { candidate_id: "A", base_revision: 2, request: "只移动主视觉，其他对象保持不变" } });
  assert.equal(pending.status, 202);
  const applied = await request(service, `/api/session/stage4-callback/layout-change/${pending.value.request_id}/result`, {
    method: "POST",
    body: { status: "applied", operations: [{ type: "update_object", object_id: title.id, patch: { x: title.x + 12 } }] }
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.value.status, "applied");
  const after = await snapshot("stage4-callback");
  assert.equal(after.layout_requests.at(-1).status, "applied");
  assert.equal(after.candidates.find((candidate) => candidate.candidate_id === "A").document.revision, 3);
});

test("marks deleted annotation targets invalid while preserving stable IDs and blocking confirmation", async () => {
  const seeded = await seed("stage4-anchor", "invalid-anchor", { auto_start: true, batch_delay_ms: 0 });
  const complete = await waitFor(() => snapshot("stage4-anchor").then((current) => current.candidates.every((candidate) => candidate.status === "complete") ? current : null));
  const candidate = complete.candidates.find((item) => item.candidate_id === "A");
  const targetObjectId = candidate.document.annotations[0].target.object_id;
  const stream = `anchor-user-${Date.now()}`;
  await request(service, "/api/session/stage4-anchor/begin", { method: "POST", body: { candidate_id: "A", stream_id: stream } });
  const deleted = await request(service, "/api/session/stage4-anchor/ops", { method: "POST", body: { candidate_id: "A", stream_id: stream, batch_seq: 1, base_revision: candidate.document.revision, operations: [{ type: "delete_object", object_id: targetObjectId }] } });
  assert.equal(deleted.status, 201);
  const after = await snapshot("stage4-anchor");
  const annotations = after.candidates.find((item) => item.candidate_id === "A").document.annotations;
  assert.ok(annotations.every((annotation) => annotation.status === "invalid" && annotation.invalid_reason === "target_deleted"));
  assert.equal(annotations[0].target.object_id, targetObjectId);
  assert.equal(after.status, "layout_editing");
  assert.equal(seeded.image_model_called, false);
});

test("uses an idempotent bounded listener lease and resolves a submitted request", async () => {
  const sessionId = "stage4-listener-roundtrip";
  const seeded = await seed(sessionId, "candidate-switch", { auto_start: false });
  const submitted = await request(service, `/api/session/${sessionId}/layout-change`, {
    method: "POST",
    body: { candidate_id: "A", base_revision: 0, request: "将第一个对象向右移动一点，其他对象保持不变" }
  });
  assert.equal(submitted.status, 202);
  assert.equal(submitted.value.listener_available, false);
  const duplicate = await request(service, `/api/session/${sessionId}/layout-change`, {
    method: "POST",
    body: { candidate_id: "A", base_revision: 0, request: "将第一个对象向右移动一点，其他对象保持不变" }
  });
  assert.equal(duplicate.value.request_id, submitted.value.request_id);
  assert.equal(duplicate.value.idempotent, true);

  const claim = await request(service, `/api/session/${sessionId}/layout-listener/claim`, {
    method: "POST",
    body: { listener_id: "listener-roundtrip", transport: "browser_fallback", lease_ms: 10000, after_cursor: 0 }
  });
  assert.equal(claim.status, 200);
  assert.equal(claim.value.status, "active");
  assert.ok(claim.value.lease_token);
  const waited = await request(service, `/api/session/${sessionId}/layout-listener/wait`, {
    method: "POST",
    body: { listener_id: claim.value.listener_id, lease_token: claim.value.lease_token, after_cursor: 0, timeout_ms: 3000, event_types: ["layout_change"] }
  });
  assert.equal(waited.value.status, "event");
  assert.equal(waited.value.action.type, "layout_change");
  assert.equal(waited.value.action.request_id, submitted.value.request_id);
  assert.equal(waited.value.action.request, "将第一个对象向右移动一点，其他对象保持不变");
  const privateRequestPath = path.join(dataRoot, sessionId, "layout-requests", `${submitted.value.request_id}.json`);
  assert.equal((await fs.stat(privateRequestPath)).mode & 0o777, 0o600);

  const current = (await snapshot(sessionId)).candidates.find((candidate) => candidate.candidate_id === "A");
  const object = seeded.candidates.find((candidate) => candidate.candidate_id === "A").operation_batches[0].operations[0].object;
  const applied = await request(service, `/api/session/${sessionId}/layout-change/${submitted.value.request_id}/result`, {
    method: "POST",
    body: {
      status: "applied",
      listener_id: claim.value.listener_id,
      lease_token: claim.value.lease_token,
      operations: [{ type: "add_object", object: { ...object, x: object.x + 1 } }]
    }
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.value.status, "applied");
  assert.equal((await snapshot(sessionId)).candidates.find((candidate) => candidate.candidate_id === "A").document.revision, 1);
  await assert.rejects(() => fs.access(privateRequestPath));
  const appliedAgain = await request(service, `/api/session/${sessionId}/layout-change/${submitted.value.request_id}/result`, { method: "POST", body: { status: "applied", operations: [] } });
  assert.equal(appliedAgain.value.status, "applied");
  const heartbeat = await request(service, `/api/session/${sessionId}/layout-listener/heartbeat`, {
    method: "POST",
    body: { listener_id: claim.value.listener_id, lease_token: claim.value.lease_token, cursor: waited.value.next_cursor }
  });
  assert.equal(heartbeat.value.status, "active");
});

test("bounded wait times out, cancel wakes a listener, and released listeners allow reclaim", async () => {
  const sessionId = "stage4-listener-recovery";
  await seed(sessionId, "candidate-switch", { auto_start: false });
  const firstClaim = await request(service, `/api/session/${sessionId}/layout-listener/claim`, { method: "POST", body: { listener_id: "listener-first", lease_ms: 10000 } });
  const timeoutStarted = Date.now();
  const timeout = await request(service, `/api/session/${sessionId}/layout-listener/wait`, {
    method: "POST",
    body: { listener_id: firstClaim.value.listener_id, lease_token: firstClaim.value.lease_token, after_cursor: firstClaim.value.next_cursor, timeout_ms: 120, event_types: ["layout_change"] }
  });
  assert.equal(timeout.value.status, "timeout");
  assert.ok(Date.now() - timeoutStarted < 2000);

  const submitted = await request(service, `/api/session/${sessionId}/layout-change`, {
    method: "POST",
    body: { candidate_id: "A", base_revision: 0, request: "只调整标题位置" }
  });
  assert.equal(submitted.value.listener_available, true);
  const waitCancel = request(service, `/api/session/${sessionId}/layout-listener/wait`, {
    method: "POST",
    body: { listener_id: firstClaim.value.listener_id, lease_token: firstClaim.value.lease_token, after_cursor: submitted.value ? (await snapshot(sessionId)).event_cursor : 0, timeout_ms: 2000, event_types: ["cancel"] }
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const cancelled = await request(service, `/api/session/${sessionId}/layout-change/${submitted.value.request_id}/cancel`, { method: "POST", body: { reason: "user_cancelled" } });
  assert.equal(cancelled.value.status, "cancelled");
  // The wait starts after submission and therefore observes the explicit
  // cancellation event rather than replaying the original request.
  const waitedCancel = await waitCancel;
  assert.equal(waitedCancel.value.status, "event");
  assert.equal(waitedCancel.value.action.type, "cancel");

  const second = await request(service, `/api/session/${sessionId}/layout-change`, { method: "POST", body: { candidate_id: "A", base_revision: 0, request: "再次移动标题" } });
  assert.equal(second.value.status, "pending");
  const released = await request(service, `/api/session/${sessionId}/layout-listener/release`, { method: "POST", body: { listener_id: firstClaim.value.listener_id, lease_token: firstClaim.value.lease_token } });
  assert.equal(released.value.status, "released");
  const reclaim = await request(service, `/api/session/${sessionId}/layout-listener/claim`, { method: "POST", body: { listener_id: "listener-reconnected", lease_ms: 10000, after_cursor: 0 } });
  assert.equal(reclaim.value.status, "active");
  assert.ok(reclaim.value.pending_requests.some((item) => item.request_id === second.value.request_id));
  const reclaimed = await request(service, `/api/session/${sessionId}/layout-listener/wait`, { method: "POST", body: { listener_id: reclaim.value.listener_id, lease_token: reclaim.value.lease_token, after_cursor: 0, timeout_ms: 2000, event_types: ["layout_change"] } });
  assert.equal(reclaimed.value.status, "event");
  assert.equal(reclaimed.value.action.request_id, second.value.request_id);
});

test("confirm event wakes a listener without exposing request text in status or journal", async () => {
  const sessionId = "stage4-listener-confirm";
  await seed(sessionId, "candidate-switch", { auto_start: true, batch_delay_ms: 0 });
  await waitFor(async () => (await snapshot(sessionId)).status === "layout_ready", 5000);
  const claim = await request(service, `/api/session/${sessionId}/layout-listener/claim`, { method: "POST", body: { listener_id: "listener-confirm", lease_ms: 10000, after_cursor: 0 } });
  const waitConfirm = request(service, `/api/session/${sessionId}/layout-listener/wait`, {
    method: "POST",
    body: { listener_id: claim.value.listener_id, lease_token: claim.value.lease_token, after_cursor: 0, timeout_ms: 3000, event_types: ["confirm"] }
  });
  const current = (await snapshot(sessionId)).candidates.find((candidate) => candidate.candidate_id === "A");
  const ui = await createUiSession(service, sessionId);
  const confirmed = await confirmWithUi(ui, {
    document: current.document,
    clean_png_data_uri: pngDataUri(current.document.canvas.width, current.document.canvas.height),
    annotated_png_data_uri: pngDataUri(current.document.canvas.width, current.document.canvas.height, [11, 20, 37, 255]),
    detail_constraints: buildDetailConstraints(current.document)
  });
  assert.equal(confirmed.response.status, 201);
  const waited = await waitConfirm;
  assert.equal(waited.value.status, "event");
  assert.equal(waited.value.action.type, "confirm");
  assert.equal(waited.value.action.revision, current.document.revision);
  const statusJson = await fs.readFile(path.join(dataRoot, sessionId, "session.json"), "utf8");
  const eventsJson = await fs.readFile(path.join(dataRoot, sessionId, "operations.ndjson"), "utf8");
  assert.doesNotMatch(statusJson, /用户修改|再次移动标题/);
  assert.doesNotMatch(eventsJson, /用户修改|再次移动标题/);
});

test("reclaims a pending request after an expired lease", async () => {
  const sessionId = "stage4-listener-expiry";
  await seed(sessionId, "candidate-switch", { auto_start: false });
  const first = await request(service, `/api/session/${sessionId}/layout-listener/claim`, { method: "POST", body: { listener_id: "listener-expired", lease_ms: 10000, after_cursor: 0 } });
  const submitted = await request(service, `/api/session/${sessionId}/layout-change`, { method: "POST", body: { candidate_id: "A", base_revision: 0, request: "过期后仍应能恢复的布局调整" } });
  assert.equal(submitted.value.listener_available, true);
  const sessionPath = path.join(dataRoot, sessionId, "session.json");
  const persisted = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  persisted.layout_listener.lease_expires_at = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(sessionPath, `${JSON.stringify(persisted, null, 2)}\n`);
  const reclaimed = await request(service, `/api/session/${sessionId}/layout-listener/claim`, { method: "POST", body: { listener_id: "listener-after-expiry", lease_ms: 10000, after_cursor: 0 } });
  assert.equal(reclaimed.value.status, "active");
  assert.ok(reclaimed.value.pending_requests.some((item) => item.request_id === submitted.value.request_id && item.claimed === false));
  const waited = await request(service, `/api/session/${sessionId}/layout-listener/wait`, { method: "POST", body: { listener_id: reclaimed.value.listener_id, lease_token: reclaimed.value.lease_token, after_cursor: 0, timeout_ms: 1000, event_types: ["layout_change"] } });
  assert.equal(waited.value.status, "event");
  assert.equal(waited.value.action.request_id, submitted.value.request_id);
  assert.equal(waited.value.action.request, "过期后仍应能恢复的布局调整");
});

test("advertises and serves the MCP Apps workbench resource over the plugin stdio entry", async () => {
  const child = spawn(process.execPath, [path.join(process.cwd(), "mcp", "server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, LAYOUT_GUIDED_DATA_DIR: dataRoot }
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const responseFor = (id) => {
    const line = stdout.trim().split("\n").find((item) => item.includes(`\"id\":${id}`));
    return line ? JSON.parse(line) : null;
  };
  try {
    await waitFor(() => /service_ready_v11 port=\d+/.test(stderr));
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await waitFor(() => responseFor(1));
    const initializeResponse = responseFor(1);
    assert.deepEqual(initializeResponse.result.capabilities.resources, { listChanged: false });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await waitFor(() => responseFor(2));
    const tools = responseFor(2).result.tools;
    const workbenchTool = tools.find((tool) => tool.name === "open_layout_workbench");
    assert.equal(workbenchTool._meta.ui.resourceUri, "ui://layout-guided-ai-imagen/workbench-v1.html");
    assert.equal(workbenchTool._meta["openai/outputTemplate"], workbenchTool._meta.ui.resourceUri);

    send({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} });
    await waitFor(() => responseFor(3));
    assert.deepEqual(responseFor(3).result.resources.map((resource) => resource.uri), [workbenchTool._meta.ui.resourceUri]);

    send({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: workbenchTool._meta.ui.resourceUri } });
    await waitFor(() => responseFor(4), 8000);
    const resource = responseFor(4).result.contents[0];
    assert.equal(resource.mimeType, "text/html;profile=mcp-app");
    assert.match(resource.text, /ui\/initialize/);
    assert.match(resource.text, /ui\/notifications\/tool-result/);
    assert.match(resource.text, /tools\/call/);
    assert.match(resource.text, /ui\/message/);
    assert.match(resource.text, /__layoutGuidedApiBase/);
  } finally {
    child.kill("SIGTERM");
  }
});

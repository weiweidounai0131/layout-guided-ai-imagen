import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import { buildDetailConstraints } from "../mcp/sketch-document.mjs";
import { buildGenerationRequestPreview, startLocalService, stopLocalService } from "../mcp/server.mjs";
import { createUiSession, selectCandidate, issueIntent, returnToEdit, confirmWithUi } from "./ui-confirmation-helper.mjs";

let service;
let dataRoot;

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
  return `data:image/png;base64,${Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0))
  ]).toString("base64")}`;
}

function request(pathname, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, service.url);
    const payload = body === undefined ? null : JSON.stringify(body);
    const requestObject = http.request(url, {
      method,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let value;
        try { value = JSON.parse(raw); } catch { value = raw; }
        resolve({ status: response.statusCode, value, headers: response.headers });
      });
    });
    requestObject.on("error", reject);
    if (payload) requestObject.write(payload);
    requestObject.end();
  });
}

async function snapshot(sessionId) {
  return (await request(`/api/session/${sessionId}`)).value;
}

async function freshSession(sessionId) {
  await request("/api/session", { method: "POST", body: { session_id: sessionId, demo: true } });
  return snapshot(sessionId);
}

async function validConfirmationInput(sessionId, candidateId = "A") {
  const session = await snapshot(sessionId);
  const candidate = session.candidates.find((item) => item.candidate_id === candidateId);
  return {
    document: candidate.document,
    clean_png_data_uri: pngDataUri(candidate.document.canvas.width, candidate.document.canvas.height),
    annotated_png_data_uri: pngDataUri(candidate.document.canvas.width, candidate.document.canvas.height, [11, 20, 37, 255]),
    detail_constraints: buildDetailConstraints(candidate.document)
  };
}

async function confirmUsingExistingIntent(ui, input, token) {
  return request(`/api/session/${ui.sessionId}/confirm`, {
    method: "POST",
    headers: {
      cookie: `layout_ui_session_${ui.sessionId}=${ui.cookie}`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors"
    },
    body: { ...input, confirmation_intent: token }
  });
}

before(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-confirmation-gate-"));
  service = await startLocalService({ dataRoot });
});

after(async () => {
  await stopLocalService(service);
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("rejects direct HTTP confirmation and spoofed confirmed_by without UI proof", async () => {
  const sessionId = "gate-direct-http";
  await freshSession(sessionId);
  const input = await validConfirmationInput(sessionId);
  const result = await request(`/api/session/${sessionId}/confirm`, {
    method: "POST",
    body: { ...input, confirmed_by: "user", confirmation_intent: "fake" }
  });
  assert.equal(result.status, 403);
  assert.equal((await snapshot(sessionId)).confirmed, null);
});

test("rejects a direct MCP confirm call even when the payload spoofs confirmed_by", async () => {
  const sessionId = "gate-mcp-spoof";
  const session = await freshSession(sessionId);
  const child = spawn(process.execPath, [path.resolve(process.cwd(), "mcp/server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, LAYOUT_GUIDED_DATA_DIR: dataRoot },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const waitFor = async (predicate, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`MCP test timed out: ${stderr.slice(-400)}`);
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    await waitFor(() => /service_ready_v11/.test(stderr));
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await waitFor(() => stdout.includes('"id":1'));
    const candidate = session.candidates.find((item) => item.candidate_id === "A");
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "confirm_layout",
        arguments: {
          session_id: sessionId,
          document: candidate.document,
          clean_png_data_uri: pngDataUri(candidate.document.canvas.width, candidate.document.canvas.height),
          annotated_png_data_uri: pngDataUri(candidate.document.canvas.width, candidate.document.canvas.height),
          detail_constraints: buildDetailConstraints(candidate.document),
          confirmed_by: "user",
          confirmation_intent: "fake"
        }
      }
    });
    await waitFor(() => stdout.split("\n").some((line) => line.includes('"id":2')));
    const response = JSON.parse(stdout.trim().split("\n").find((line) => line.includes('"id":2')));
    assert.equal(response.error.code, -32000);
    assert.match(response.error.message, /human UI confirmation proof|one-time UI confirmation intent/);
    assert.equal((await snapshot(sessionId)).confirmed, null);
  } finally {
    child.kill("SIGTERM");
  }
});

test("default active A is not a selection; selected-but-unconfirmed remains blocked", async () => {
  const sessionId = "gate-selection-required";
  await freshSession(sessionId);
  const ui = await createUiSession(service, sessionId);
  const intentWithoutSelection = await issueIntent(ui, "A", 0);
  assert.equal(intentWithoutSelection.response.status, 409);
  const selected = await selectCandidate(ui, "A", 0);
  assert.equal(selected.response.status, 200);
  const preflight = await request(`/api/session/${sessionId}/generation/preflight`, { method: "POST", body: {} });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.value.allow, false);
  assert.equal(preflight.value.reason, "human_ui_confirmation_required");
});

test("real UI selection and confirmation records user_ui proof and unlocks preflight/preview", async () => {
  const sessionId = "gate-ui-success";
  await freshSession(sessionId);
  const ui = await createUiSession(service, sessionId);
  const input = await validConfirmationInput(sessionId);
  const result = await confirmWithUi(ui, { ...input });
  assert.equal(result.response.status, 201);
  assert.equal(result.value.confirmed_by, "user_ui");
  assert.equal(result.value.user_selected_candidate.candidate_id, "A");
  assert.equal(result.value.user_selected_candidate.revision, 0);
  const preflight = await request(`/api/session/${sessionId}/generation/preflight`, { method: "POST", body: {} });
  assert.equal(preflight.value.allow, true);
  const formalPreview = await buildGenerationRequestPreview(dataRoot, { session_id: sessionId });
  assert.equal(formalPreview.allow, true);
  assert.equal(formalPreview.request.schema_version, "generation-request/3");
  assert.equal(formalPreview.request.confirmed_files.clean_png_sha256, result.value.hashes.clean_png_sha256);
  assert.ok(path.isAbsolute(formalPreview.request.confirmed_files.clean_png_ref));
  assert.ok(formalPreview.request.creative_prompt.hard_constraints.length > 0);
  assert.ok(formalPreview.request.creative_prompt.soft_layout_guidance.length > 0);
  assert.ok(formalPreview.request.creative_prompt.creative_freedom.length > 0);
  const preview = await request(`/api/session/${sessionId}/generation/preflight`, { method: "POST", body: { confirmation: { confirmed_by: "user" } } });
  assert.equal(preview.value.allow, true);
  const confirmed = await request(`/api/session/${sessionId}/confirmed`);
  assert.equal(confirmed.value.confirmed_by, "user_ui");
});

test("intent is single-use and cannot cross candidate or revision", async () => {
  const sessionId = "gate-intent-binding";
  await freshSession(sessionId);
  const ui = await createUiSession(service, sessionId);
  const selected = await selectCandidate(ui, "A", 0);
  assert.equal(selected.response.status, 200);
  const issued = await issueIntent(ui, "A", 0);
  assert.equal(issued.response.status, 200);
  const inputA = await validConfirmationInput(sessionId, "A");
  const crossCandidate = await confirmUsingExistingIntent(ui, { ...inputA, document: { ...inputA.document, candidate_id: "B" } }, issued.value.confirmation_intent);
  assert.equal(crossCandidate.status, 409);
  const success = await confirmUsingExistingIntent(ui, inputA, issued.value.confirmation_intent);
  assert.equal(success.status, 201);
  const replay = await confirmUsingExistingIntent(ui, inputA, issued.value.confirmation_intent);
  assert.equal(replay.status, 201);
  assert.equal(replay.value.confirmation_id, success.value.confirmation_id);
});

test("failed export does not create a confirmation or generation package", async () => {
  const sessionId = "gate-export-failure";
  await freshSession(sessionId);
  const ui = await createUiSession(service, sessionId);
  const input = await validConfirmationInput(sessionId);
  const selected = await selectCandidate(ui, "A", 0);
  assert.equal(selected.response.status, 200);
  const issued = await issueIntent(ui, "A", 0);
  assert.equal(issued.response.status, 200);
  const failed = await confirmUsingExistingIntent(ui, { ...input, clean_png_data_uri: "data:image/png;base64,ZmFrZQ==" }, issued.value.confirmation_intent);
  assert.equal(failed.status, 422);
  assert.equal((await snapshot(sessionId)).confirmed, null);
  const preflight = await request(`/api/session/${sessionId}/generation/preflight`, { method: "POST", body: {} });
  assert.equal(preflight.value.allow, false);
});

test("requires exact detail constraints and keeps the last confirmed revision read-only until return-to-edit", async () => {
  const sessionId = "gate-readonly-return-edit";
  await freshSession(sessionId);
  const ui = await createUiSession(service, sessionId);
  const input = await validConfirmationInput(sessionId);
  const selected = await selectCandidate(ui, "A", 0);
  assert.equal(selected.response.status, 200);
  const issued = await issueIntent(ui, "A", 0);
  assert.equal(issued.response.status, 200);
  const mismatched = {
    ...input,
    detail_constraints: input.detail_constraints.map((constraint, index) => index === 0 ? { ...constraint, instruction: `${constraint.instruction}（错配）` } : constraint)
  };
  const rejected = await confirmUsingExistingIntent(ui, mismatched, issued.value.confirmation_intent);
  assert.equal(rejected.status, 422);
  assert.match(rejected.value.error, /detail constraint does not match annotation/);
  assert.equal((await snapshot(sessionId)).confirmed, null);

  const confirmed = await confirmWithUi(ui, input);
  assert.equal(confirmed.response.status, 201);
  assert.equal(confirmed.value.revision, 0);
  const directOps = await request(`/api/session/${sessionId}/ops`, {
    method: "POST",
    body: {
      candidate_id: "A",
      stream_id: "direct-after-confirm",
      batch_seq: 1,
      base_revision: 0,
      operations: [{ type: "update_object", object_id: input.document.objects[0].id, patch: { x: 1 } }]
    }
  });
  assert.equal(directOps.status, 409);
  const confirmedSnapshot = await snapshot(sessionId);
  assert.equal(confirmedSnapshot.candidates.find((candidate) => candidate.candidate_id === "A").status, "confirmed");

  const returned = await returnToEdit(ui, "A", 0);
  assert.equal(returned.response.status, 200, returned.value.error);
  assert.equal(returned.value.status, "editing");
  assert.equal(returned.value.revision, 1);
  const editingSnapshot = await snapshot(sessionId);
  assert.equal(editingSnapshot.confirmed, null);
  assert.equal(editingSnapshot.confirmation_history.length, 1);
  assert.equal(editingSnapshot.candidates.find((candidate) => candidate.candidate_id === "A").document.revision, 1);
  assert.equal(editingSnapshot.candidates.find((candidate) => candidate.candidate_id === "A").status, "editing");
  for (const relativeFile of Object.values(confirmed.value.files)) await fs.access(path.join(dataRoot, sessionId, relativeFile));

  const missingSelection = await issueIntent(ui, "A", 1);
  assert.equal(missingSelection.response.status, 409);
  const selectedAgain = await selectCandidate(ui, "A", 1);
  assert.equal(selectedAgain.response.status, 200);
  const confirmedAgain = await confirmWithUi(ui, await validConfirmationInput(sessionId, "A"));
  assert.equal(confirmedAgain.response.status, 201);
  assert.equal(confirmedAgain.value.revision, 1);
  assert.equal((await snapshot(sessionId)).confirmation_history.length, 1);
});

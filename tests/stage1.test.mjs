import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { test, before, after } from "node:test";
import { buildDetailConstraints, createDemoSession } from "../mcp/sketch-document.mjs";
import { startLocalService, stopLocalService } from "../mcp/server.mjs";
import { createUiSession, confirmWithUi } from "./ui-confirmation-helper.mjs";

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

function pngDataUri(width, height, rgba) {
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

async function collectTempFiles(root) {
  const found = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await collectTempFiles(entryPath));
    else if (entry.name.endsWith(".tmp")) found.push(entryPath);
  }
  return found;
}

before(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-stage1-test-"));
  service = await startLocalService({ dataRoot });
});

after(async () => {
  await stopLocalService(service);
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("creates a local session without overwriting and materializes candidate version files", async () => {
  const created = await request(service, "/api/session", { method: "POST", body: { session_id: "stage1-session", demo: true } });
  assert.equal(created.status, 201);
  assert.equal(created.value.created, true);
  assert.equal(created.value.session_id, "stage1-session");
  assert.deepEqual(created.value.layout_requests, []);

  const repeated = await request(service, "/api/session", { method: "POST", body: { session_id: "stage1-session", demo: true } });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.value.created, false);
  assert.equal(repeated.value.candidates[0].document.revision, 0);

  for (const fileName of [
    "initial.sketch.json",
    "current.sketch.json",
    path.join("versions", "v0.json")
  ]) await fs.access(path.join(dataRoot, "stage1-session", "candidates", "A", fileName));
  const initial = JSON.parse(await fs.readFile(path.join(dataRoot, "stage1-session", "candidates", "A", "initial.sketch.json"), "utf8"));
  assert.equal(initial.revision, 0);
  assert.equal(initial.status, "complete");

  const unconfirmed = await request(service, "/api/session/stage1-session/confirmed");
  assert.equal(unconfirmed.status, 200);
  assert.equal(unconfirmed.value.status, "not_confirmed");

  const briefValidation = await request(service, "/api/poster-brief/validate", {
    method: "POST",
    body: {
      canvas: { aspect_ratio: "8:11" },
      copy: [{ id: "title", text: "原文标题" }],
      main_visual: { description: "家庭客厅场景" }
    }
  });
  assert.equal(briefValidation.status, 200);
  assert.equal(briefValidation.value.status, "ready");

  const candidates = await request(service, "/api/layout-candidates", {
    method: "POST",
    body: {
      candidate_count: 2,
      brief: {
        canvas: { aspect_ratio: "8:11" },
        copy: [{ id: "title", role: "title", text: "原文标题" }],
        main_visual: { description: "家庭客厅场景" }
      }
    }
  });
  assert.equal(candidates.status, 200);
  assert.equal(candidates.value.candidate_count, 2);
  assert.equal(candidates.value.image_model_called, false);
  const blockedCandidates = await request(service, "/api/layout-candidates", {
    method: "POST",
    body: { brief: { canvas: { aspect_ratio: "8:11" }, copy: [], main_visual: {} } }
  });
  assert.equal(blockedCandidates.status, 422);
  assert.equal(blockedCandidates.value.status, "needs_input");
});

test("new production sessions start empty and await a PosterBrief", async () => {
  const created = await request(service, "/api/session", { method: "POST", body: { session_id: "stage1-empty-session" } });
  assert.equal(created.status, 201);
  assert.equal(created.value.status, "awaiting_brief");
  assert.deepEqual(created.value.candidates, []);
  assert.equal(created.value.poster_brief, null);
  const repeated = await request(service, "/api/session", { method: "POST", body: { session_id: "stage1-empty-session" } });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.value.status, "awaiting_brief");
  assert.deepEqual(repeated.value.candidates, []);
});

test("migrates a 0.2.8-style session in place while keeping legacy candidates readable", async () => {
  const sessionId = "stage1-legacy-028";
  const legacy = createDemoSession();
  legacy.session_id = sessionId;
  legacy.schema_version = "layout-session/3";
  delete legacy.ui_sessions;
  delete legacy.confirmation_intents;
  delete legacy.user_selected_candidate;
  delete legacy.confirmation_history;
  delete legacy.streams;
  legacy.candidates = legacy.candidates.map((candidate) => {
    const copy = { ...candidate };
    for (const key of ["archetype_id", "archetype_name", "selection_score", "selection_rationale", "selection_policy", "catalog_provenance", "difference_axes", "schematic"]) delete copy[key];
    return copy;
  });
  const sessionRoot = path.join(dataRoot, sessionId);
  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.writeFile(path.join(sessionRoot, "session.json"), `${JSON.stringify(legacy, null, 2)}\n`);
  await fs.writeFile(path.join(sessionRoot, "operations.ndjson"), "");

  const migrated = await request(service, `/api/session/${sessionId}`);
  assert.equal(migrated.status, 200);
  assert.equal(migrated.value.schema_version, "layout-session/4");
  assert.equal(migrated.value.candidates.length, 3);
  assert.equal(migrated.value.candidates.every((candidate) => !candidate.archetype_id && !candidate.selection_policy), true);
  const persisted = JSON.parse(await fs.readFile(path.join(sessionRoot, "session.json"), "utf8"));
  assert.equal(persisted.schema_version, "layout-session/4");
  assert.equal(Array.isArray(persisted.ui_sessions), true);
  assert.equal(Array.isArray(persisted.confirmation_intents), true);
});

test("saves revisions, keeps the initial version, and restores the current document after restart", async () => {
  const before = (await request(service, "/api/session/stage1-session")).value;
  const candidate = before.candidates.find((item) => item.candidate_id === "A");
  const objectId = candidate.document.objects[0].id;
  await request(service, "/api/session/stage1-session/begin", {
    method: "POST",
    body: { candidate_id: "A", stream_id: "stage1-stream" }
  });
  const applied = await request(service, "/api/session/stage1-session/ops", {
    method: "POST",
    body: {
      candidate_id: "A",
      stream_id: "stage1-stream",
      batch_seq: 1,
      base_revision: candidate.document.revision,
      operations: [{ type: "update_object", object_id: objectId, patch: { x: 112 } }]
    }
  });
  assert.equal(applied.status, 201);
  assert.equal(applied.value.revision, 1);

  const saved = await request(service, "/api/session/stage1-session/sketch", {
    method: "PUT",
    body: { document: applied.value.document }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.revision, 1);
  const currentPath = path.join(dataRoot, "stage1-session", "candidates", "A", "current.sketch.json");
  const versionPath = path.join(dataRoot, "stage1-session", "candidates", "A", "versions", "v1.json");
  assert.equal(JSON.parse(await fs.readFile(currentPath, "utf8")).revision, 1);
  assert.equal(JSON.parse(await fs.readFile(versionPath, "utf8")).revision, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataRoot, "stage1-session", "candidates", "A", "initial.sketch.json"), "utf8")).revision, 0);

  await stopLocalService(service);
  service = await startLocalService({ dataRoot });
  const restored = await request(service, "/api/session/stage1-session");
  assert.equal(restored.status, 200);
  assert.equal(restored.value.candidates.find((item) => item.candidate_id === "A").document.revision, 1);
  assert.equal(restored.value.event_cursor, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(currentPath, "utf8")).objects.find((object) => object.id === objectId).x, 112);
});

test("submits a pending layout request without persisting the request text", async () => {
  const requestText = "把主视觉中的路由器移到人物下方，并保持标题和三条卖点的原位置。";
  const result = await request(service, "/api/session/stage1-session/layout-change", {
    method: "POST",
    body: { candidate_id: "A", base_revision: 1, request: requestText }
  });
  assert.equal(result.status, 202);
  assert.equal(result.value.status, "pending");
  assert.equal(result.value.base_revision, 1);
  assert.equal(result.value.request_id.startsWith("layout-"), true);

  const sessionJson = await fs.readFile(path.join(dataRoot, "stage1-session", "session.json"), "utf8");
  const eventsJson = await fs.readFile(path.join(dataRoot, "stage1-session", "operations.ndjson"), "utf8");
  assert.doesNotMatch(sessionJson, new RegExp(requestText));
  assert.doesNotMatch(eventsJson, new RegExp(requestText));
  const snapshot = (await request(service, "/api/session/stage1-session")).value;
  assert.equal(snapshot.status, "layout_change_pending");
  assert.equal(snapshot.layout_requests.length, 1);
  assert.equal("request" in snapshot.layout_requests[0], false);
  assert.equal(snapshot.layout_requests[0].request_length, requestText.length);
});

test("confirms one revision and reads export metadata without returning image bytes", async () => {
  const snapshot = (await request(service, "/api/session/stage1-session")).value;
  const candidate = snapshot.candidates.find((item) => item.candidate_id === "B");
  const clean = pngDataUri(800, 1100, [11, 20, 36, 255]);
  const annotated = pngDataUri(800, 1100, [11, 20, 37, 255]);
  const body = {
    document: candidate.document,
    clean_png_data_uri: clean,
    annotated_png_data_uri: annotated,
    detail_constraints: buildDetailConstraints(candidate.document)
  };
  const ui = await createUiSession(service, "stage1-session");
  const confirmed = await confirmWithUi(ui, body);
  assert.equal(confirmed.response.status, 201);
  const inputs = await request(service, "/api/session/stage1-session/confirmed");
  assert.equal(inputs.status, 200);
  assert.equal(inputs.value.status, "confirmed");
  assert.equal(inputs.value.candidate_id, "B");
  assert.equal(inputs.value.revision, 0);
  assert.equal(Object.values(inputs.value.available).every(Boolean), true);
  assert.equal("clean_png_data_uri" in inputs.value, false);
  assert.equal("annotated_png_data_uri" in inputs.value, false);

  const repeated = await request(service, "/api/session/stage1-session/confirm", { method: "POST", body });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.value.confirmed_at, confirmed.value.confirmed_at);
  assert.deepEqual(await collectTempFiles(path.join(dataRoot, "stage1-session")), []);
});

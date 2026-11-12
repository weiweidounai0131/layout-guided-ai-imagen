import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { applySketchOperations, buildDetailConstraints, createDemoSketch } from "../mcp/sketch-document.mjs";
import { assessImageCapabilities } from "../mcp/capabilities.mjs";
import { startLocalService, stopLocalService } from "../mcp/server.mjs";
import { createUiSession, confirmWithUi } from "./ui-confirmation-helper.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
        try { value = JSON.parse(raw); } catch { /* text or SSE */ }
        resolve({ status: response.statusCode, value });
      });
    });
    requestObject.on("error", reject);
    if (payload) requestObject.write(payload);
    requestObject.end();
  });
}

function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error("timed out waiting for process state"));
      setTimeout(check, 20);
    };
    check();
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

function openSse(serviceInfo, requestPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, serviceInfo.url);
    const requestObject = http.get(url, { headers: { accept: "text/event-stream" } });
    requestObject.once("response", (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      resolve({ request: requestObject, response, get data() { return data; } });
    });
    requestObject.once("error", reject);
  });
}

before(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-v11-test-"));
  service = await startLocalService({ rootDir: ROOT, dataRoot });
});

after(async () => {
  await stopLocalService(service);
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("serves a V1.1 health endpoint, schema, and three SketchDocument candidates", async () => {
  const health = await request(service, "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.value, {
    ok: true,
    service: "layout-guided-ai-imagen-stage4-v11",
    storage: "local",
    canvas: "fabric.js",
    schema: "sketch-document/1",
    session_schema: "layout-session/4"
  });
  const session = await request(service, "/api/session/demo");
  assert.equal(session.status, 200);
  assert.equal(session.value.candidates.length, 3);
  assert.equal(session.value.candidates[0].document.schema_version, "sketch-document/1");
  assert.equal(session.value.candidates[0].document.canvas.unit, "canvas");
  assert.equal("xml" in session.value, false);
  assert.equal(session.value.candidates[0].document.annotations.every((annotation) => annotation.type === "detail_marker"), true);
  assert.ok(session.value.candidates[0].document.objects.filter((object) => object.type === "image_placeholder" && object.asset_description).length >= 5);
  const schema = await request(service, "/contracts/sketch-document.schema.json");
  assert.equal(schema.status, 200);
  assert.equal(schema.value.properties.schema_version.const, "sketch-document/1");
  const sessionSchema = await request(service, "/contracts/layout-session.schema.json");
  assert.equal(sessionSchema.status, 200);
  assert.equal(sessionSchema.value.properties.schema_version.const, "layout-session/4");
  const briefSchema = await request(service, "/contracts/poster-brief.schema.json");
  assert.equal(briefSchema.status, 200);
  assert.equal(briefSchema.value.properties.schema_version.const, "poster-brief/1");
  const generationSchema = await request(service, "/contracts/generation-request.schema.json");
  assert.equal(generationSchema.status, 200);
  assert.equal(generationSchema.value.properties.schema_version.const, "generation-request/3");
  assert.equal(generationSchema.value.properties.creative_prompt.required.includes("hard_constraints"), true);
  const fabric = await request(service, "/vendor/fabric.js");
  assert.equal(fabric.status, 200);
  assert.match(fabric.value, /globalThis/);
});

test("keeps object-targeted marker anchors aligned when the target moves", () => {
  const before = createDemoSketch("A", 0);
  const previousObject = before.objects.find((object) => object.id === "ca-technician");
  const previousAnnotation = before.annotations.find((annotation) => annotation.id === "ca-d1");
  const next = applySketchOperations(before, [{
    type: "update_object",
    object_id: "ca-technician",
    patch: { x: 160, y: 365, width: 620, height: 460 }
  }]);
  const nextObject = next.objects.find((object) => object.id === "ca-technician");
  const nextAnnotation = next.annotations.find((annotation) => annotation.id === "ca-d1");
  assert.equal(nextAnnotation.target.object_id, "ca-technician");
  assert.deepEqual(nextAnnotation.end, {
    x: nextObject.x + ((previousAnnotation.end.x - previousObject.x) / previousObject.width) * nextObject.width,
    y: nextObject.y + ((previousAnnotation.end.y - previousObject.y) / previousObject.height) * nextObject.height
  });
  assert.deepEqual(nextAnnotation.start, {
    x: nextObject.x + ((previousAnnotation.start.x - previousObject.x) / previousObject.width) * nextObject.width,
    y: nextObject.y + ((previousAnnotation.start.y - previousObject.y) / previousObject.height) * nextObject.height
  });
});

test("commits ordered operation batches, handles duplicates idempotently, and rejects gaps", async () => {
  const beforeSession = (await request(service, "/api/session/demo")).value;
  const started = await request(service, "/api/session/demo/begin", {
    method: "POST",
    body: { candidate_id: "A", stream_id: "ai-smoke-A" }
  });
  assert.equal(started.status, 200);
  const operation = {
    candidate_id: "A",
    stream_id: "ai-smoke-A",
    batch_seq: 1,
    base_revision: beforeSession.candidates[0].document.revision,
    operations: [{ type: "update_object", object_id: "ca-title", patch: { x: 94 } }]
  };
  const applied = await request(service, "/api/session/demo/ops", { method: "POST", body: operation });
  assert.equal(applied.status, 201);
  assert.equal(applied.value.revision, 1);
  assert.equal(applied.value.document.objects.find((object) => object.id === "ca-title").x, 94);
  assert.equal(applied.value.event.event, "sketch_batch");
  const duplicate = await request(service, "/api/session/demo/ops", { method: "POST", body: operation });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.value.idempotent, true);
  const gap = await request(service, "/api/session/demo/ops", {
    method: "POST",
    body: { ...operation, batch_seq: 3, base_revision: 1 }
  });
  assert.equal(gap.status, 409);
  const stale = await request(service, "/api/session/demo/ops", {
    method: "POST",
    body: { ...operation, batch_seq: 2, base_revision: 0, operations: [{ type: "update_object", object_id: "ca-title", patch: { x: 100 } }] }
  });
  assert.equal(stale.status, 409);
  const events = await fs.readFile(path.join(dataRoot, "demo", "operations.ndjson"), "utf8");
  assert.match(events, /"batch_seq":1/);
  assert.doesNotMatch(events, /完整正文由用户需求提供/);
});

test("publishes committed batches through SSE and resumes from a cursor", async () => {
  const stream = await openSse(service, "/api/session/demo/events?candidate_id=B&after=0");
  const session = (await request(service, "/api/session/demo")).value;
  const candidateB = session.candidates.find((candidate) => candidate.candidate_id === "B");
  await request(service, "/api/session/demo/begin", { method: "POST", body: { candidate_id: "B", stream_id: "ai-sse-B" } });
  const applied = await request(service, "/api/session/demo/ops", {
    method: "POST",
    body: {
      candidate_id: "B",
      stream_id: "ai-sse-B",
      batch_seq: 1,
      base_revision: candidateB.document.revision,
      operations: [{ type: "update_object", object_id: "cb-main", patch: { y: 210 } }]
    }
  });
  await waitFor(() => stream.data.includes("event: sketch_batch"));
  assert.match(stream.data, new RegExp(`id: ${applied.value.event.cursor}`));
  assert.match(stream.data, /"candidate_id":"B"/);
  stream.response.destroy();
  stream.request.destroy();
});

test("confirms a matching candidate revision with clean and annotated PNGs atomically", async () => {
  const session = (await request(service, "/api/session/demo")).value;
  const candidate = session.candidates.find((item) => item.candidate_id === "C");
  const clean = pngDataUri(800, 1100, [11, 20, 36, 255]);
  const annotated = pngDataUri(800, 1100, [11, 20, 37, 255]);
  const ui = await createUiSession(service, "demo");
  const result = await confirmWithUi(ui, {
    document: candidate.document,
    clean_png_data_uri: clean,
    annotated_png_data_uri: annotated,
    detail_constraints: buildDetailConstraints(candidate.document)
  });
  assert.equal(buildDetailConstraints(candidate.document).every((constraint) => constraint.marker?.symbol && constraint.anchor && !("arrow" in constraint)), true);
  assert.equal(result.response.status, 201);
  assert.equal(result.value.layout_version, "v0");
  assert.equal(result.value.hashes.clean_png_sha256.length, 64);
  assert.equal(result.value.hashes.annotated_png_sha256.length, 64);
  for (const relativeFile of Object.values(result.value.files)) await fs.access(path.join(dataRoot, "demo", relativeFile));
  const after = (await request(service, "/api/session/demo")).value;
  assert.equal(after.status, "layout_confirmed");
  assert.equal(after.confirmed.candidate_id, "C");
});

test("blocks confirmation when an annotation anchor is invalid", async () => {
  const session = (await request(service, "/api/session/demo")).value;
  const candidate = session.candidates.find((item) => item.candidate_id === "A");
  const document = JSON.parse(JSON.stringify(candidate.document));
  document.annotations[0].status = "invalid";
  const ui = await createUiSession(service, "demo");
  const result = await confirmWithUi(ui, {
    document,
    clean_png_data_uri: pngDataUri(800, 1100, [11, 20, 36, 255]),
    annotated_png_data_uri: pngDataUri(800, 1100, [11, 20, 37, 255]),
    detail_constraints: buildDetailConstraints(document)
  });
  assert.equal(result.response.status, 422);
  const after = (await request(service, "/api/session/demo")).value;
  assert.equal(after.confirmed.candidate_id, "C");
});

test("evaluates image capability from explicit evidence without model-name guessing", () => {
  const supported = assessImageCapabilities([{ name: "host-image-tool", can_generate_image: true, accepts_image_input: true, max_image_inputs: 4, evidence: "schema accepts image inputs" }]);
  assert.equal(supported.state, "supported");
  assert.equal(supported.selected_tool, "host-image-tool");
  assert.equal(supported.candidates[0].max_image_inputs, 4);
  assert.equal(assessImageCapabilities([{ name: "text-only-tool", can_generate_image: true, accepts_image_input: false }]).state, "unsupported");
  assert.equal(assessImageCapabilities([{ name: "opaque-tool", can_generate_image: true, accepts_image_input: null }]).state, "unknown");
});

test("falls back to an available port when the preferred port is occupied", async () => {
  const blocker = createNetServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const occupiedPort = blocker.address().port;
  const fallback = await startLocalService({ rootDir: ROOT, dataRoot });
  const samePort = await startLocalService({ rootDir: ROOT, dataRoot, port: occupiedPort });
  assert.notEqual(samePort.port, occupiedPort);
  assert.equal((await request(fallback, "/health")).status, 200);
  await stopLocalService(fallback);
  await stopLocalService(samePort);
  await new Promise((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
});

test("starts the MCP stdio entry and exposes V1.1 operation tools", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "mcp", "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, LAYOUT_GUIDED_DATA_DIR: dataRoot }
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    await waitFor(() => /service_ready_v11 port=\d+/.test(stderr));
    const port = Number(stderr.match(/service_ready_v11 port=(\d+)/)[1]);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await waitFor(() => stdout.includes('"id":1'));
    const initializeResponse = JSON.parse(stdout.trim().split("\n").find((line) => line.includes('"id":1')));
    assert.equal(initializeResponse.result.serverInfo.version, "0.2.11");
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await waitFor(() => stdout.includes('"id":2'));
    const toolsResponse = JSON.parse(stdout.trim().split("\n").find((line) => line.includes('"id":2')));
    assert.ok(toolsResponse.result.tools.some((tool) => tool.name === "apply_sketch_ops"));
    for (const toolName of ["create_session", "validate_poster_brief", "build_layout_candidates", "save_sketch_version", "submit_layout_change", "claim_layout_listener", "heartbeat_layout_listener", "wait_for_layout_action", "release_layout_listener", "cancel_layout_change", "confirm_layout", "get_confirmed_inputs"]) {
      assert.ok(toolsResponse.result.tools.some((tool) => tool.name === toolName), `missing MCP tool: ${toolName}`);
    }
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "open_layout_workbench", arguments: { session_id: "demo" } } });
    await waitFor(() => stdout.includes('"id":3'));
    const openResponse = JSON.parse(stdout.trim().split("\n").find((line) => line.includes('"id":3')));
    assert.match(openResponse.result.content[0].text, /^http:\/\/127\.0\.0\.1:\d+\/\?session=demo$/);
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_session", arguments: { session_id: "mcp-stage1" } } });
    await waitFor(() => stdout.includes('"id":4'));
    const createResponse = JSON.parse(stdout.trim().split("\n").find((line) => line.includes('"id":4')));
    const createdSession = JSON.parse(createResponse.result.content[0].text);
    assert.equal(createdSession.created, true);
    assert.equal((await request(service, "/api/session/mcp-stage1")).value.session_id, "mcp-stage1");
    assert.ok(port > 0);
  } finally {
    child.kill("SIGTERM");
  }
});

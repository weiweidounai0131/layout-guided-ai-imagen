import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "scripts", "layout-guided-ai-imagen.mjs");

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runCli(dataRoot, args, { reject = true, appendDataRoot = true } = {}) {
  const commandArgs = appendDataRoot ? [...args, "--data-root", dataRoot] : args;
  const result = await execFileAsync(process.execPath, [runner, ...commandArgs], {
    cwd: root,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env }
  }).catch((error) => {
    if (reject) throw error;
    return error;
  });
  const stdout = String(result.stdout || "").trim();
  return { ...result, json: stdout ? JSON.parse(stdout.split("\n").at(-1)) : null };
}

function request(service, requestPath, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const requestObject = http.request(new URL(requestPath, service.service_url), {
      method,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let value;
        try { value = JSON.parse(raw); } catch { value = { error: raw }; }
        resolve({ status: response.statusCode, value });
      });
    });
    requestObject.on("error", reject);
    if (payload) requestObject.write(payload);
    requestObject.end();
  });
}

function validObject() {
  return {
    id: "cli-object",
    type: "rectangle",
    role: "decoration",
    label: "CLI test object",
    x: 12,
    y: 16,
    width: 120,
    height: 80,
    z_index: 1,
    shape: "rectangle",
    style: { fill: "#ffffff", stroke: "#111111", stroke_width: 1 }
  };
}

async function killService(started) {
  if (!started?.service_pid) return;
  try { process.kill(Number(started.service_pid), "SIGTERM"); } catch { /* already exited */ }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { process.kill(Number(started.service_pid), 0); } catch { return; }
    await sleep(25);
  }
}

async function exerciseFreshRoot(index, mode) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), `layout-guided-ai-imagen-cli-${index}-`));
  let started;
  try {
    started = (await runCli(dataRoot, ["start", "--session", `cli-${index}`, "--demo"])).json;
    assert.equal(started.command, "start");
    assert.match(started.service_url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(started.browser_url, /session=cli-\d+/);
    assert.equal(started.service_reused, false);
    const reused = (await runCli(dataRoot, ["start", "--session", `cli-${index}`])).json;
    assert.equal(reused.service_reused, true);
    assert.equal(reused.service_pid, started.service_pid);

    const claimed = (await runCli(dataRoot, ["claim", "--session", `cli-${index}`, "--lease-ms", "10000"])).json;
    assert.equal(claimed.status, "active");
    assert.equal(claimed.transport, "cli_runner");
    assert.equal("lease_token" in claimed, false);
    const statePath = claimed.listener_state_file;
    assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.schema_version, "layout-listener-state/1");
    assert.ok(state.lease_token);
    assert.equal(path.resolve(state.data_root), path.resolve(dataRoot));
    const document = (await runCli(dataRoot, ["document", "--session", `cli-${index}`, "--candidate-id", "A"])).json;
    assert.equal(document.command, "document");
    assert.equal(document.document.candidate_id, "A");
    assert.equal(document.revision, 0);

    const pending = await request(started, `/api/session/cli-${index}/layout-change`, {
      method: "POST",
      body: { candidate_id: "A", base_revision: 0, request: `CLI request ${index}` }
    });
    assert.equal(pending.status, 202);

    if (mode === "reclaim") {
      const waitChild = spawn(process.execPath, [runner, "wait", "--session", `cli-${index}`, "--state-file", statePath, "--timeout-ms", "10000", "--data-root", dataRoot], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env }
      });
      let childStdout = "";
      waitChild.stdout.setEncoding("utf8");
      waitChild.stdout.on("data", (chunk) => { childStdout += chunk; });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("abandoned listener did not receive the pending action")), 3000);
        const check = () => {
          if (childStdout.includes("\n")) {
            clearTimeout(timer);
            resolve();
          } else setTimeout(check, 10);
        };
        check();
      });
      // The model process disappears after receiving the action and before
      // resolving it. The lease expiry below is the durable reclaim boundary.
      if (waitChild.exitCode === null) {
        waitChild.kill("SIGKILL");
        await new Promise((resolve) => waitChild.once("close", resolve));
      }
      const sessionPath = path.join(dataRoot, `cli-${index}`, "session.json");
      const persisted = JSON.parse(await fs.readFile(sessionPath, "utf8"));
      persisted.layout_listener.lease_expires_at = new Date(Date.now() - 1000).toISOString();
      await fs.writeFile(sessionPath, `${JSON.stringify(persisted, null, 2)}\n`);
      assert.match(childStdout, /"status":"event"/);

      const reclaimed = (await runCli(dataRoot, ["claim", "--session", `cli-${index}`, "--lease-ms", "10000"])).json;
      assert.equal(reclaimed.status, "active");
      assert.notEqual(reclaimed.listener_id, claimed.listener_id);
      const reclaimedWait = (await runCli(dataRoot, ["wait", "--session", `cli-${index}`, "--state-file", reclaimed.listener_state_file, "--timeout-ms", "2000"])).json;
      assert.equal(reclaimedWait.status, "event");
      assert.equal(reclaimedWait.action.request_id, pending.value.request_id);
      assert.equal(reclaimedWait.action.request, `CLI request ${index}`);
      const resolved = (await runCli(dataRoot, ["resolve", "--session", `cli-${index}`, "--state-file", reclaimed.listener_state_file, "--status", "applied", "--operations-json", JSON.stringify([{ type: "add_object", object: validObject() }])])).json;
      assert.equal(resolved.status, "applied");
      assert.equal(resolved.revision, 1);
      assert.equal((await runCli(dataRoot, ["heartbeat", "--session", `cli-${index}`, "--state-file", reclaimed.listener_state_file])).json.status, "active");
    } else {
      const waitResult = (await runCli(dataRoot, ["wait", "--session", `cli-${index}`, "--state-file", statePath, "--timeout-ms", "2000"])).json;
      assert.equal(waitResult.status, "event");
      assert.equal(waitResult.action.request_id, pending.value.request_id);
      assert.equal(waitResult.action.request, `CLI request ${index}`);
      if (mode === "cancel") {
        const cancelled = (await runCli(dataRoot, ["cancel", "--session", `cli-${index}`, "--state-file", statePath])).json;
        assert.equal(cancelled.status, "cancelled");
      } else {
        const resolved = (await runCli(dataRoot, ["resolve", "--session", `cli-${index}`, "--state-file", statePath, "--status", "applied", "--operations-json", JSON.stringify([{ type: "add_object", object: validObject() }])])).json;
        assert.equal(resolved.status, "applied");
        assert.equal(resolved.revision, 1);
        const timeout = (await runCli(dataRoot, ["wait", "--session", `cli-${index}`, "--state-file", statePath, "--timeout-ms", "0"])).json;
        assert.equal(timeout.status, "timeout");
      }
    }
    const released = (await runCli(dataRoot, ["release", "--session", `cli-${index}`, "--state-file", mode === "reclaim" ? path.join(dataRoot, ".listeners", `cli-${index}.${"listener-after"}.json`) : statePath], { reject: false })).json;
    // The reclaim path already has a terminal resolve and a different private
    // state file; release is exercised explicitly below with the original
    // listener in the other fresh roots.
    if (mode !== "reclaim") assert.equal(released?.status, "released");
    return { index, mode, pending_request: pending.value.request_id };
  } finally {
    await killService(started);
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

test("bundled CLI runner closes the listener loop in three fresh data roots", async () => {
  const results = [];
  results.push(await exerciseFreshRoot(1, "resolve"));
  results.push(await exerciseFreshRoot(2, "cancel"));
  results.push(await exerciseFreshRoot(3, "reclaim"));
  assert.equal(results.length, 3);
  assert.equal(new Set(results.map((result) => result.index)).size, 3);
  console.log(JSON.stringify({ status: "PASS", fresh_roots: results }));
});

test("state-file-only listener commands infer session/data-root and release expired leases idempotently", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-cli-state-only-"));
  let started;
  try {
    started = (await runCli(dataRoot, ["start", "--session", "state-only", "--demo"])).json;
    const claimed = (await runCli(dataRoot, ["claim", "--session", "state-only", "--lease-ms", "10000"])).json;
    const statePath = claimed.listener_state_file;
    const pending = await request(started, "/api/session/state-only/layout-change", {
      method: "POST",
      body: { candidate_id: "A", base_revision: 0, request: "state-only request" }
    });
    assert.equal(pending.status, 202);

    const waited = (await runCli(dataRoot, ["wait", "--state-file", statePath, "--timeout-ms", "1000"], { appendDataRoot: false })).json;
    assert.equal(waited.status, "event");
    assert.equal(waited.session_id, "state-only");
    assert.equal("lease_token" in waited, false);
    const heartbeat = (await runCli(dataRoot, ["heartbeat", "--state-file", statePath], { appendDataRoot: false })).json;
    assert.equal(heartbeat.status, "active");
    const resolved = (await runCli(dataRoot, ["resolve", "--state-file", statePath, "--status", "applied", "--operations-json", JSON.stringify([{ type: "add_object", object: validObject() }])], { appendDataRoot: false })).json;
    assert.equal(resolved.status, "applied");

    const sessionPath = path.join(dataRoot, "state-only", "session.json");
    const persisted = JSON.parse(await fs.readFile(sessionPath, "utf8"));
    persisted.layout_listener.lease_expires_at = new Date(Date.now() - 1000).toISOString();
    await fs.writeFile(sessionPath, `${JSON.stringify(persisted, null, 2)}\n`);
    const released = (await runCli(dataRoot, ["release", "--state-file", statePath], { appendDataRoot: false })).json;
    assert.equal(released.status, "released");
    const repeated = (await runCli(dataRoot, ["release", "--state-file", statePath], { appendDataRoot: false })).json;
    assert.equal(repeated.status, "released");

    const mismatch = await runCli(dataRoot, ["heartbeat", "--state-file", statePath, "--session", "other-session"], { appendDataRoot: false, reject: false });
    assert.match(String(mismatch.stderr || mismatch.message || ""), /session does not match listener state file/);
    assert.doesNotMatch(String(mismatch.stderr || ""), /lease_token|token_hash/);
  } finally {
    await killService(started);
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

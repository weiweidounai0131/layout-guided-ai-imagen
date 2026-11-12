import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startLocalService, stopLocalService } from "../mcp/server.mjs";

const playwrightModule = process.env.LAYOUT_GUIDED_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error("Set LAYOUT_GUIDED_PLAYWRIGHT_MODULE to a local Playwright ESM entry before running the CLI listener browser smoke.");
const { chromium } = await import(playwrightModule);
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "scripts", "layout-guided-ai-imagen.mjs");
const fixtureEntries = JSON.parse(await fs.readFile(path.join(root, "tests", "fixtures", "stage4-briefs.json"), "utf8"));
const fixture = fixtureEntries.find((entry) => entry.scenario === "candidate-switch");
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-cli-browser-"));
const sessionId = "stage4-cli-browser";
const service = await startLocalService({ rootDir: root, dataRoot });
const browser = await chromium.launch({ headless: true });

async function runCli(args) {
  const result = await run(process.execPath, [runner, ...args, "--data-root", dataRoot], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(String(result.stdout).trim().split("\n").at(-1));
}

async function post(pathname, body) {
  const response = await fetch(`${service.url}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  assert.ok(response.ok, value.error || `POST ${pathname} failed`);
  return value;
}

try {
  const seeded = await post(`/api/session/${sessionId}/layout-candidates`, { brief: fixture.brief, candidate_count: 3, auto_start: true, batch_delay_ms: 0, include_plans: true });
  assert.equal(seeded.candidate_count, 3);
  const started = await runCli(["start", "--session", sessionId]);
  assert.equal(started.service_reused, true);
  const claimed = await runCli(["claim", "--session", sessionId, "--lease-ms", "10000"]);
  assert.equal(claimed.transport, "cli_runner");

  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(`${service.url}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "V1.1 轻量画板已加载", null, { timeout: 20000 });
  await page.waitForFunction(() => Number(document.querySelector("#revision-state")?.textContent) > 0, null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector("#listener-state")?.textContent.includes("CLI listener"), null, { timeout: 10000 });
  assert.match(await page.locator("#listener-state").textContent(), /AI 已连接 · CLI listener/);

  await page.fill("#layout-change-input", "将第一个可编辑对象向右移动一点，其他对象保持不变");
  await page.click("#layout-change-button");
  await page.waitForFunction(() => document.querySelector("#layout-change-state")?.textContent.includes("AI 已连接"), null, { timeout: 10000 });
  const waited = await runCli(["wait", "--session", sessionId, "--state-file", claimed.listener_state_file, "--timeout-ms", "3000"]);
  assert.equal(waited.status, "event");
  assert.equal(waited.action.type, "layout_change");
  const document = await page.evaluate(() => window.__layoutGuidedApp.document);
  const first = document.objects[0];
  const resolved = await runCli([
    "resolve",
    "--session", sessionId,
    "--state-file", claimed.listener_state_file,
    "--request-id", waited.action.request_id,
    "--status", "applied",
    "--operations-json", JSON.stringify([{ type: "update_object", object_id: first.id, patch: { x: first.x + 1 } }])
  ]);
  assert.equal(resolved.status, "applied");
  await page.waitForFunction((revision) => Number(document.querySelector("#revision-state")?.textContent) === revision, resolved.revision, { timeout: 10000 });
  await page.close();
  console.log(JSON.stringify({ status: "PASS", listener_state: "AI 已连接 · CLI listener", revision: resolved.revision, service_reused: started.service_reused }));
} finally {
  await browser.close();
  await stopLocalService(service);
  await fs.rm(dataRoot, { recursive: true, force: true });
}

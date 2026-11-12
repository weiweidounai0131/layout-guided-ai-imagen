import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "scripts", "layout-guided-ai-imagen.mjs");
const playwrightModule = process.env.LAYOUT_GUIDED_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error("Set LAYOUT_GUIDED_PLAYWRIGHT_MODULE for the public CLI prepare browser smoke.");
const { chromium } = await import(playwrightModule);

const brief = {
  schema_version: "poster-brief/1",
  canvas: { width: 1080, height: 1440, aspect_ratio: "3:4" },
  copy: [
    { id: "title", role: "title", text: "秋季新品发布会", must_preserve: true },
    { id: "time", role: "meta", text: "9月20日 19:30", must_preserve: true },
    { id: "venue", role: "meta", text: "广州国际会议中心", must_preserve: true },
    { id: "cta", role: "cta", text: "立即预约", must_preserve: true }
  ],
  main_visual: { description: "一款银色智能手表悬浮在深蓝色科技空间中。", asset_refs: ["asset-watch"] },
  style: { purpose: "新品发布会海报", direction: "高级、克制、未来科技感", palette: "深蓝、银色、少量冷白", lighting: "柔和轮廓光与空间光束", materials: "金属、玻璃、细腻雾气" },
  assets: [{ id: "asset-watch", role: "main_visual", source_ref: "brief-defined-silver-smartwatch", status: "described" }],
  constraints: { must_include: ["银色智能手表", "深蓝色科技空间"], must_not_include: ["足球、球场、电视赛事画面、序号标记、局部说明文字"] }
};

async function runCli(dataRoot, args, { reject = true } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [runner, ...args, "--data-root", dataRoot], { cwd: root, maxBuffer: 4 * 1024 * 1024, env: { ...process.env } });
    const raw = String(result.stdout || "").trim();
    return { ...result, json: raw ? JSON.parse(raw.split("\n").at(-1)) : null };
  } catch (error) {
    if (reject) throw error;
    return error;
  }
}

async function stopService(pid) {
  try { process.kill(Number(pid), "SIGTERM"); } catch { return; }
  for (let index = 0; index < 80; index += 1) {
    try { process.kill(Number(pid), 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-cli-prepare-blackbox-"));
const briefFile = path.join(dataRoot, "autumn-watch.brief.json");
const differentBriefFile = path.join(dataRoot, "different.brief.json");
const invalidJsonFile = path.join(dataRoot, "invalid-json.brief.json");
const invalidBriefFile = path.join(dataRoot, "invalid-brief.json");
await fs.writeFile(briefFile, `${JSON.stringify(brief, null, 2)}\n`);
await fs.writeFile(differentBriefFile, `${JSON.stringify({ ...brief, copy: [{ ...brief.copy[0], text: "另一份海报" }] }, null, 2)}\n`);
await fs.writeFile(invalidJsonFile, "{not-json\n");
await fs.writeFile(invalidBriefFile, `${JSON.stringify({ canvas: { width: 1080, height: 1440 }, copy: [] }, null, 2)}\n`);

const sessionId = `blackbox-autumn-watch-20260915-${Math.random().toString(16).slice(2, 10)}`;
let servicePid = null;
const browser = await chromium.launch({ headless: true });
try {
  const help = await execFileAsync(process.execPath, [runner, "--help"], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
  assert.match(String(help.stdout), /prepare --session <id> --brief-file <poster-brief\.json>/);
  assert.match(String(help.stdout), /same session/);

  const prepared = (await runCli(dataRoot, ["prepare", "--session", sessionId, "--brief-file", briefFile])).json;
  servicePid = prepared.service_pid;
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.idempotent, false);
  assert.equal(prepared.candidate_count, 3);
  assert.equal(prepared.brief_summary.canvas.width, 1080);
  assert.match(prepared.browser_url, new RegExp(`session=${sessionId}`));
  assert.match(prepared.listener_next, /claim --session/);
  assert.doesNotMatch(JSON.stringify(prepared), /足球|球场|世界杯|电视赛事/);

  const repeated = (await runCli(dataRoot, ["prepare", "--session", sessionId, "--brief-file", briefFile])).json;
  assert.equal(repeated.status, "prepared");
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.brief_fingerprint, prepared.brief_fingerprint);

  const status = (await runCli(dataRoot, ["status", "--session", sessionId])).json;
  assert.equal(status.pending_requests.length, 0);
  const document = (await runCli(dataRoot, ["document", "--session", sessionId, "--candidate-id", "A"])).json;
  assert.equal(document.document.canvas.width, 1080);
  assert.equal(document.document.canvas.height, 1440);
  assert.ok(document.document.objects.some((object) => object.text === "秋季新品发布会"));
  assert.doesNotMatch(JSON.stringify(document), /足球|球场|世界杯|电视赛事/);

  const different = await runCli(dataRoot, ["prepare", "--session", sessionId, "--brief-file", differentBriefFile], { reject: false });
  assert.match(String(different.stderr || different.message || ""), /different PosterBrief/);
  const invalidJson = await runCli(dataRoot, ["prepare", "--session", `invalid-json-${sessionId}`, "--brief-file", invalidJsonFile], { reject: false });
  assert.match(String(invalidJson.stderr || invalidJson.message || ""), /valid JSON/);
  const invalidBrief = await runCli(dataRoot, ["prepare", "--session", `invalid-brief-${sessionId}`, "--brief-file", invalidBriefFile], { reject: false });
  assert.match(String(invalidBrief.stderr || invalidBrief.message || ""), /PosterBrief is not ready/);

  const emptyId = `empty-${sessionId}`;
  const emptyStart = (await runCli(dataRoot, ["start", "--session", emptyId])).json;
  assert.equal(emptyStart.status, "ok");
  const emptyStatus = (await runCli(dataRoot, ["status", "--session", emptyId])).json;
  assert.equal(emptyStatus.session_status, "awaiting_brief");
  assert.deepEqual(emptyStatus.pending_requests, []);
  const emptyDocument = (await runCli(dataRoot, ["document", "--session", emptyId])).json;
  assert.equal(emptyDocument.status, "awaiting_brief");
  assert.equal(emptyDocument.document, null);

  const demo = (await runCli(dataRoot, ["start", "--session", "demo", "--demo"])).json;
  assert.equal(demo.status, "ok");
  const demoDocument = (await runCli(dataRoot, ["document", "--session", "demo", "--candidate-id", "A"])).json;
  assert.match(JSON.stringify(demoDocument), /足球|世界杯/);

  const emptyPage = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await emptyPage.goto(emptyStart.browser_url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await emptyPage.waitForFunction(() => document.querySelector("#status")?.textContent === "V1.1 轻量画板已加载", null, { timeout: 20000 });
    assert.equal(await emptyPage.locator(".candidate-card").count(), 0);
    assert.equal(await emptyPage.locator("#candidate-title").textContent(), "等待 PosterBrief");
  } finally {
    await emptyPage.close();
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(prepared.browser_url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "V1.1 轻量画板已加载", null, { timeout: 20000 });
    assert.equal(await page.locator(".candidate-card").count(), 3);
    assert.match(await page.locator("#brief-summary").textContent(), /1080×1440/);
    assert.match(await page.locator("#brief-summary").textContent(), /银色智能手表/);
    assert.doesNotMatch(await page.locator("body").textContent(), /足球|世界杯|球场/);
  } finally {
    await page.close();
  }
  console.log(JSON.stringify({ status: "PASS", session_id: sessionId, candidate_count: prepared.candidate_count, idempotent_repeat: repeated.idempotent, empty_session: emptyStatus.session_status, explicit_demo_fixture: true, browser_candidates: 3 }));
} finally {
  await browser.close();
  await stopService(servicePid);
  await fs.rm(dataRoot, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalService, stopLocalService } from "../mcp/server.mjs";

const playwrightModule = process.env.LAYOUT_GUIDED_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error("Set LAYOUT_GUIDED_PLAYWRIGHT_MODULE to a local Playwright ESM entry before running this smoke test.");
const { chromium } = await import(playwrightModule);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionId = "demo";
const dataRoot = process.env.LAYOUT_GUIDED_DATA_ROOT
  ? path.resolve(process.env.LAYOUT_GUIDED_DATA_ROOT)
  : await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-v11-browser-"));
const cleanupData = !process.env.LAYOUT_GUIDED_DATA_ROOT;
const service = await startLocalService({ rootDir: root, dataRoot });
const browser = await chromium.launch({ headless: true });
let page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

async function post(pathname, body) {
  const response = await fetch(`${service.url}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const value = await response.json();
  assert.ok(response.ok, value.error || `POST ${pathname} failed`);
  return value;
}

try {
  await page.goto(service.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "V1.1 轻量画板已加载", null, { timeout: 20000 });
  assert.equal(await page.locator(".candidate-card").count(), 3);
  assert.equal(await page.locator(".candidate-card[data-archetype-id]").count(), 3);
  assert.equal(await page.locator(".candidate-meta").allTextContents().then((labels) => labels.some((label) => /revision/i.test(label))), false);
  const previewArchetypes = await page.locator(".candidate-card").evaluateAll((cards) => cards.map((card) => ({ id: card.dataset.candidateId, archetypeId: card.dataset.archetypeId, thumb: Boolean(card.querySelector(".candidate-thumb")) })));
  assert.equal(previewArchetypes.every((item) => item.archetypeId && item.thumb), true);
  assert.equal(await page.evaluate(() => Boolean(window.fabric?.Canvas)), true);
  assert.equal(await page.locator("#drawio-frame").count(), 0);
  assert.equal(await page.locator(".color-swatch:not(.rainbow)").first().evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(29, 29, 31)");
  assert.equal(await page.locator("#canvas-guidance").textContent(), "画板只展示海报内容，局部说明见右侧序号。");

  const initial = await page.evaluate(() => ({
    candidate: document.querySelector("#candidate-state")?.textContent,
    revision: document.querySelector("#revision-state")?.textContent,
    annotations: document.querySelectorAll(".annotation-item").length
  }));
  assert.equal(initial.candidate, "A");
  assert.equal(initial.revision, "0");
  assert.equal(initial.annotations, 3);
  assert.equal(await page.locator(".annotation-title span:first-child").first().textContent(), "①");
  assert.ok((await page.locator(".annotation-target").first().textContent()).includes("素材说明"));

  const snapshot = await (await fetch(`${service.url}/api/session/${sessionId}`)).json();
  const current = snapshot.candidates.find((candidate) => candidate.candidate_id === "A");
  assert.ok(current.archetype_id);
  assert.equal(current.archetype_id, previewArchetypes.find((item) => item.id === "A").archetypeId);
  assert.ok(current.schematic?.elements?.length >= 2);
  assert.equal(current.document.objects.some((object) => object.id === "ca-kicker"), false);
  assert.equal(current.document.objects.some((object) => object.id === "ca-gesture"), false);
  assert.ok(current.document.objects.filter((object) => object.type === "image_placeholder" && object.asset_description).length >= 5);
  if (process.env.LAYOUT_GUIDED_SCREENSHOT) {
    await fs.mkdir(path.dirname(path.resolve(process.env.LAYOUT_GUIDED_SCREENSHOT)), { recursive: true });
    await page.screenshot({ path: path.resolve(process.env.LAYOUT_GUIDED_SCREENSHOT), fullPage: true });
  }
  await post(`/api/session/${sessionId}/begin`, { candidate_id: "A", stream_id: "browser-ai-A" });
  const applied = await post(`/api/session/${sessionId}/ops`, {
    candidate_id: "A",
    stream_id: "browser-ai-A",
    batch_seq: 1,
    base_revision: current.document.revision,
    operations: [{ type: "update_object", object_id: "ca-title", patch: { x: 118 } }]
  });
  await page.waitForFunction((revision) => document.querySelector("#revision-state")?.textContent === String(revision), applied.revision, { timeout: 10000 });
  assert.equal(await page.locator("#stream-state").textContent(), "收到已提交操作");

  await page.click('[data-tool="rectangle"]');
  const canvasBox = await page.locator("#sketch-canvas").boundingBox();
  assert.ok(canvasBox);
  await page.mouse.click(canvasBox.x + canvasBox.width * 0.94, canvasBox.y + canvasBox.height * 0.5);
  await page.waitForFunction(() => Number(document.querySelector("#revision-state")?.textContent) >= 2, null, { timeout: 10000 });

  await page.fill("#annotation-input", "保持局部材质清晰，序号标记和说明不得出现在成图中。");
  await page.click("#annotation-button");
  await page.waitForFunction(() => document.querySelectorAll(".annotation-item").length === 4, null, { timeout: 10000 });

  // A default active candidate is not a human selection. Record the explicit
  // candidate-card click before exercising the confirmation gate.
  await page.click('[data-candidate-id="A"]');
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("已明确选择方案 A"), null, { timeout: 10000 });
  await page.click("#confirm-button");
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("布局已确认"), null, { timeout: 30000 });
  assert.equal(await page.locator("#export-state").textContent(), "双 PNG 已保存");
  assert.equal(await page.locator("#save-state").textContent(), "已确认 · 方案 A · v3");
  assert.equal(await page.locator("#confirm-button").isDisabled(), true);
  assert.equal(await page.locator("#return-edit-button").isVisible(), true);
  assert.match(await page.locator("#confirmed-summary").textContent(), /方案 A · v3/);
  assert.equal(await page.locator("#feedback-modal").isHidden(), false);
  assert.equal(await page.locator("#feedback-modal-title").textContent(), "已收到你的确认，请回到对话查看后续生成");
  assert.match(await page.locator("#feedback-modal-countdown").textContent(), /秒后自动关闭/);
  const duplicateFeedback = await page.evaluate(() => [
    window.__layoutGuidedFeedback.show({ eventKey: "browser-duplicate" }),
    window.__layoutGuidedFeedback.show({ eventKey: "browser-duplicate" })
  ]);
  assert.deepEqual(duplicateFeedback, [true, false]);
  await page.click("#feedback-modal-close");
  assert.equal(await page.locator("#feedback-modal").isHidden(), true);
  await page.click("#conversation-help-button");
  assert.match(await page.locator("#status").textContent(), /请回到原对话/);
  await page.evaluate(() => window.__layoutGuidedFeedback.show({ eventKey: "browser-auto-close", durationMs: 1000 }));
  assert.equal(await page.locator("#feedback-modal").isHidden(), false);
  await page.waitForTimeout(1250);
  assert.equal(await page.locator("#feedback-modal").isHidden(), true);

  const confirmed = await (await fetch(`${service.url}/api/session/${sessionId}`)).json();
  assert.equal(confirmed.status, "layout_confirmed");
  assert.equal(confirmed.confirmed.candidate_id, "A");
  for (const relativeFile of Object.values(confirmed.confirmed.files)) await fs.access(path.join(dataRoot, sessionId, relativeFile));

  await page.close();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(service.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "V1.1 轻量画板已加载", null, { timeout: 20000 });
  const reopened = await page.evaluate(() => ({
    candidate: document.querySelector("#candidate-state")?.textContent,
    revision: document.querySelector("#revision-state")?.textContent,
    annotations: document.querySelectorAll(".annotation-item").length,
    exportState: document.querySelector("#export-state")?.textContent
  }));
  assert.deepEqual(reopened, { candidate: "A", revision: "3", annotations: 4, exportState: "双 PNG 未导出" });
  const mobile = await browser.newPage({ viewport: { width: 720, height: 1000 } });
  try {
    await mobile.goto(service.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await mobile.waitForFunction(() => document.querySelector("#status")?.textContent === "V1.1 轻量画板已加载", null, { timeout: 20000 });
    const mobileMetrics = await mobile.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      columns: getComputedStyle(document.querySelector(".workspace")).gridTemplateColumns
    }));
    assert.ok(mobileMetrics.scrollWidth <= mobileMetrics.viewportWidth + 1);
    assert.equal(mobileMetrics.columns.split(" ").length, 1);
  } finally {
    await mobile.close();
  }
  console.log(JSON.stringify({ status: "V1.1 browser smoke passed", confirmedRevision: reopened.revision, files: Object.keys(confirmed.confirmed.files) }));
} finally {
  await page.close().catch(() => {});
  await browser.close();
  await stopLocalService(service);
  if (cleanupData) await fs.rm(dataRoot, { recursive: true, force: true });
}

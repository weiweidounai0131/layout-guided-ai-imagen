import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startLocalService, stopLocalService } from "../mcp/server.mjs";

const playwrightModule = process.env.LAYOUT_GUIDED_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error("Set LAYOUT_GUIDED_PLAYWRIGHT_MODULE to a local Playwright ESM entry before running this UI regression.");
const { chromium } = await import(playwrightModule);
const root = path.resolve(process.cwd());
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-ui-regression-"));
const service = await startLocalService({ rootDir: root, dataRoot });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
const screenshotDirectory = process.env.LAYOUT_GUIDED_UI_REGRESSION_EVIDENCE
  ? path.resolve(process.env.LAYOUT_GUIDED_UI_REGRESSION_EVIDENCE)
  : null;
if (screenshotDirectory) await fs.mkdir(screenshotDirectory, { recursive: true });

async function snapshot() {
  const response = await fetch(`${service.url}/api/session/demo`);
  assert.equal(response.ok, true);
  return response.json();
}

try {
  await page.goto(`${service.url}/?session=demo`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "V1.1 轻量画板已加载", null, { timeout: 20000 });
  assert.equal(await page.locator(".candidate-card[data-archetype-id]").count(), 3);
  assert.equal(await page.locator(".candidate-thumb").count(), 3);
  assert.equal(await page.locator(".candidate-rationale").count(), 3);
  assert.equal((await page.locator("#candidate-title").textContent()).includes("AI 推荐"), false);
  assert.match(await page.locator("#candidate-title").textContent(), /本地评分候选/);
  assert.equal(await page.locator('.candidate-card[data-selection-method="local_fallback"]').count(), 3);
  assert.equal(await page.locator('.candidate-card[data-evidence-status="unverified"]').count(), 3);
  assert.equal(await page.locator(".candidate-meta").allTextContents().then((labels) => labels.some((label) => /revision/i.test(label))), false);
  const initialPreviewState = await page.evaluate(() => ({
    session: window.__layoutGuidedApp.session.candidates.map((candidate) => ({ id: candidate.candidate_id, archetypeId: candidate.archetype_id, hasSchematic: Boolean(candidate.schematic?.elements?.length) })),
    cards: [...document.querySelectorAll(".candidate-card")].map((card) => ({ id: card.dataset.candidateId, archetypeId: card.dataset.archetypeId }))
  }));
  assert.equal(initialPreviewState.session.every((item) => item.archetypeId && item.hasSchematic), true);
  assert.deepEqual(initialPreviewState.cards.map((item) => item.archetypeId), initialPreviewState.session.map((item) => item.archetypeId));
  assert.equal(await page.locator("#width-input").count(), 0);
  assert.equal(await page.locator(".chrome-actions #undo-button").count(), 0);
  assert.equal(await page.locator(".canvas-toolbar #undo-button").count(), 1);
  assert.equal(await page.locator(".canvas-toolbar #redo-button").count(), 1);
  assert.equal(await page.locator(".toolbar-separator").count(), 1);
  const historyIcons = await page.evaluate(() => [...document.querySelectorAll(".history-button")].map((button) => {
    const icon = button.querySelector("svg.history-icon");
    const paths = [...(icon?.querySelectorAll("path") ?? [])];
    return {
      id: button.id,
      viewBox: icon?.getAttribute("viewBox"),
      ariaHidden: icon?.getAttribute("aria-hidden"),
      focusable: icon?.getAttribute("focusable"),
      pathCount: paths.length,
      stroke: getComputedStyle(icon).stroke,
      strokeWidth: getComputedStyle(icon).strokeWidth,
      lineCap: getComputedStyle(icon).strokeLinecap,
      lineJoin: getComputedStyle(icon).strokeLinejoin,
      text: button.textContent?.trim() || ""
    };
  }));
  assert.deepEqual(historyIcons.map((icon) => icon.id), ["undo-button", "redo-button"]);
  assert.ok(historyIcons.every((icon) => icon.viewBox === "0 0 18 18" && icon.ariaHidden === "true" && icon.focusable === "false" && icon.pathCount === 2 && icon.strokeWidth === "1.65px" && icon.lineCap === "round" && icon.lineJoin === "round" && icon.text === ""));
  assert.equal(await page.locator("#undo-button").isDisabled(), true);
  assert.equal(await page.locator("#redo-button").isDisabled(), true);
  assert.equal(await page.locator("#zoom-out-button").count(), 0);
  assert.equal(await page.locator("#zoom-level").count(), 0);
  assert.equal(await page.locator("#zoom-in-button").count(), 0);
  assert.equal(await page.locator("#zoom-fit-button").count(), 0);
  assert.equal(await page.locator(".canvas-zoom-control").count(), 0);
  assert.equal(await page.evaluate(() => window.__layoutGuidedView), undefined);
  assert.equal(await page.evaluate(() => Object.keys(window.__layoutGuidedApp).some((key) => /zoom/i.test(key))), false);
  const readCanvas = () => page.evaluate(() => {
    const app = window.__layoutGuidedApp;
    const element = app.canvas.getElement();
    const rect = element.getBoundingClientRect();
    const scale = Number(document.querySelector(".canvas-frame")?.dataset.canvasScale || 0);
    const scene = app.canvas.getScenePoint({ clientX: rect.left + 50 * scale, clientY: rect.top + 50 * scale });
    const dataUri = app.canvas.toDataURL({ format: "png", multiplier: 1 });
    const bytes = Uint8Array.from(atob(dataUri.split(",")[1]), (character) => character.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    return {
      document: JSON.parse(JSON.stringify(app.document)),
      canvas: [app.canvas.getWidth(), app.canvas.getHeight()],
      fabricZoom: app.canvas.getZoom?.() ?? null,
      display: { width: rect.width, height: rect.height, scale },
      exportDimensions: [view.getUint32(16), view.getUint32(20)],
      scene: { x: scene.x, y: scene.y }
    };
  });
  const initialDocumentSnapshot = await readCanvas();
  assert.ok(initialDocumentSnapshot.display.scale > 0 && initialDocumentSnapshot.display.scale <= 1);
  assert.deepEqual(initialDocumentSnapshot.canvas, [800, 1100]);
  assert.deepEqual(initialDocumentSnapshot.exportDimensions, initialDocumentSnapshot.canvas);
  assert.equal(initialDocumentSnapshot.fabricZoom, 1);
  assert.ok(Math.abs(initialDocumentSnapshot.scene.x - 50) < 0.6);
  assert.ok(Math.abs(initialDocumentSnapshot.scene.y - 50) < 0.6);
  await page.setViewportSize({ width: 1024, height: 1100 });
  await page.waitForTimeout(150);
  const resizedView = await readCanvas();
  assert.notEqual(resizedView.display.scale, initialDocumentSnapshot.display.scale);
  assert.deepEqual(resizedView.canvas, initialDocumentSnapshot.canvas);
  assert.deepEqual(resizedView.document, initialDocumentSnapshot.document);
  assert.deepEqual(resizedView.exportDimensions, initialDocumentSnapshot.exportDimensions);
  assert.equal(resizedView.fabricZoom, 1);
  assert.ok(Math.abs(resizedView.scene.x - 50) < 0.6);
  assert.ok(Math.abs(resizedView.scene.y - 50) < 0.6);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.waitForTimeout(150);
  await page.click('[data-candidate-id="A"]');
  await page.click("#confirm-button");
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("布局已确认"), null, { timeout: 30000 });
  assert.equal(await page.locator("#confirm-button").isDisabled(), true);
  assert.equal(await page.locator("#return-edit-button").isVisible(), true);
  assert.match(await page.locator("#confirmed-summary").textContent(), /方案 A · v0/);
  assert.equal(await page.locator("#layout-change-form").isHidden(), true);
  const readOnlyObjects = await page.evaluate(() => [...window.__layoutGuidedApp.objectMap.values()].every((object) => object.selectable === false && object.evented === false));
  assert.equal(readOnlyObjects, true);
  await page.click("#feedback-modal-close");
  if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "readonly-confirmed.png"), fullPage: true });

  await page.evaluate(() => { window.__layoutGuidedUiCloseCalls = 0; window.close = () => { window.__layoutGuidedUiCloseCalls += 1; }; });
  await page.click("#conversation-help-button");
  assert.equal(await page.evaluate(() => window.__layoutGuidedUiCloseCalls), 0);
  assert.match(await page.locator("#status").textContent(), /请回到原对话/);

  await page.click("#return-edit-button");
  await page.waitForFunction(() => document.querySelector("#revision-state")?.textContent === "1", null, { timeout: 20000 });
  assert.equal(await page.locator("#confirmation-state").isHidden(), true);
  assert.equal(await page.locator("#return-edit-button").isHidden(), true);
  assert.equal(await page.locator("#export-state").textContent(), "双 PNG 未导出");
  assert.notEqual(await page.locator("#export-state").getAttribute("data-tone"), "ok");
  const afterReturn = await snapshot();
  assert.equal(afterReturn.confirmed, null);
  assert.equal(afterReturn.confirmation_history.length, 1);
  assert.equal(afterReturn.confirmation_history[0].layout_version, "v0");
  assert.equal(afterReturn.candidates.find((candidate) => candidate.candidate_id === "A").document.revision, 1);
  if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "returned-edit-r1.png"), fullPage: true });

  const beforeShortcut = await page.evaluate(() => window.__layoutGuidedApp.document.objects.length);
  await page.fill("#layout-change-input", "Backspace 不应删除画布对象");
  await page.press("#layout-change-input", "Backspace");
  await page.press("#layout-change-input", "Control+z");
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.__layoutGuidedApp.document.objects.length), beforeShortcut);

  for (const width of [1440, 1024, 768, 560, 390, 195]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "V1.1 轻量画板已加载", null, { timeout: 20000 });
    const metrics = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const rightEdge = (element) => element ? element.getBoundingClientRect().right : 0;
      const contentRight = (element) => element
        ? Math.max(rightEdge(element), ...[...element.querySelectorAll("*")].map((child) => rightEdge(child)))
        : 0;
      const toolbar = rect(".canvas-toolbar");
      const confirm = rect("#confirm-button");
      const frame = rect(".canvas-frame");
      const stage = rect(".canvas-stage");
      return {
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        columns: getComputedStyle(document.querySelector(".workspace")).gridTemplateColumns,
        toolbarRight: toolbar?.right ?? 0,
        confirmRight: confirm?.right ?? 0,
        conversationHelpRight: rightEdge(document.querySelector("#conversation-help-button")),
        chromeActionsRight: contentRight(document.querySelector(".chrome-actions")),
        candidateCardRight: Math.max(...[...document.querySelectorAll(".candidate-card")].map((card) => contentRight(card))),
        canvasWithinStage: Boolean(frame && stage && frame.right <= stage.right + 1),
        canvasScale: document.querySelector(".canvas-frame")?.dataset.canvasScale || null
      };
    });
    assert.ok(metrics.scrollWidth <= metrics.width + 1, `${width}px horizontal overflow: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.toolbarRight <= metrics.width + 1, `${width}px toolbar overflow: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.confirmRight <= metrics.width + 1, `${width}px confirm overflow: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.conversationHelpRight <= metrics.width + 1, `${width}px top guidance overflow: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.chromeActionsRight <= metrics.width + 1, `${width}px top actions overflow: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.candidateCardRight <= metrics.width + 1, `${width}px candidate content overflow: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.canvasWithinStage, true);
    assert.ok(Number(metrics.canvasScale) > 0 && Number(metrics.canvasScale) <= 1);
  }
  console.log(JSON.stringify({ status: "UI no-zoom/auto-fit/readonly/return-edit/close/responsive regression passed", widths: [1440, 1024, 768, 560, 390, 195], device_scale_factor: 2 }));
} finally {
  await page.close().catch(() => {});
  await browser.close();
  await stopLocalService(service);
  await fs.rm(dataRoot, { recursive: true, force: true });
}

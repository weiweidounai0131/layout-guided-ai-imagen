import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalService, stopLocalService } from "../mcp/server.mjs";

const playwrightModule = process.env.LAYOUT_GUIDED_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error("Set LAYOUT_GUIDED_PLAYWRIGHT_MODULE to a local Playwright ESM entry before running Stage 4 browser evidence.");
const { chromium } = await import(playwrightModule);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = JSON.parse(await fs.readFile(path.join(root, "tests/fixtures/stage4-briefs.json"), "utf8"));
const evidenceRoot = path.resolve(process.env.LAYOUT_GUIDED_STAGE4_EVIDENCE || path.join(root, "docs/evidence/stage-4"));
await fs.mkdir(evidenceRoot, { recursive: true });
const dataRoot = process.env.LAYOUT_GUIDED_DATA_ROOT
  ? path.resolve(process.env.LAYOUT_GUIDED_DATA_ROOT)
  : await fs.mkdtemp(path.join(os.tmpdir(), "layout-guided-ai-imagen-v11-stage4-browser-"));
const cleanupData = !process.env.LAYOUT_GUIDED_DATA_ROOT;
const service = await startLocalService({ rootDir: root, dataRoot });
const browser = await chromium.launch({ headless: true });
const pages = new Set();
const results = { status: "running", fixtures: fixtures.map((fixture) => fixture.scenario), evidence_root: evidenceRoot, sessions: {} };

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  pages.add(page);
  return page;
}

async function closePage(page) {
  pages.delete(page);
  await page.close().catch(() => {});
}

async function request(pathname, body, expectedStatuses = [200, 201, 202]) {
  const response = await fetch(`${service.url}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const value = await response.json();
  assert.ok(expectedStatuses.includes(response.status), value.error || `POST ${pathname} returned ${response.status}`);
  return value;
}

async function requestRaw(pathname, body) {
  const response = await fetch(`${service.url}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  let value = null;
  try { value = await response.json(); } catch { /* no JSON body */ }
  return { status: response.status, value };
}

async function getSnapshot(sessionId) {
  const response = await fetch(`${service.url}/api/session/${sessionId}`);
  assert.ok(response.ok);
  return response.json();
}

async function waitForSnapshot(sessionId, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let snapshot = await getSnapshot(sessionId);
  while (!predicate(snapshot)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for session ${sessionId}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    snapshot = await getSnapshot(sessionId);
  }
  return snapshot;
}

async function seed(sessionId, fixture, options = {}) {
  return request(`/api/session/${sessionId}/layout-candidates`, {
    brief: fixture.brief,
    candidate_count: 3,
    include_plans: true,
    ...options
  });
}

async function openWorkbench(page, sessionId) {
  await page.goto(`${service.url}/?session=${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "V1.1 轻量画板已加载", null, { timeout: 20000 });
  assert.equal(await page.locator(".candidate-card").count(), 3);
  assert.equal(await page.locator("#candidate-state").textContent(), "A");
}

async function capture(page, filename) {
  await page.screenshot({ path: path.join(evidenceRoot, filename), fullPage: true });
}

function streamIdFrom(seedResult, candidateId = "A") {
  return seedResult.streams[Object.keys(seedResult.streams).find((key) => key.startsWith(`${candidateId}:`))].stream_id;
}

function plannedCandidate(seedResult, candidateId = "A") {
  return seedResult.candidates.find((candidate) => candidate.candidate_id === candidateId);
}

try {
  const switchSession = "stage4-candidate-switch";
  const switchSeed = await seed(switchSession, fixtures.find((fixture) => fixture.scenario === "candidate-switch"), { auto_start: true, batch_delay_ms: 1000 });
  const switchPage = await newPage();
  await openWorkbench(switchPage, switchSession);
  await switchPage.waitForFunction(() => Number(document.querySelector("#revision-state")?.textContent) >= 2, null, { timeout: 20000 });
  const firstBatch = await switchPage.locator("#stream-state").getAttribute("data-batch-seq");
  assert.ok(firstBatch, "the canvas must expose the committed batch sequence");
  await capture(switchPage, "stage-4-candidate-stream.png");
  const switchComplete = await waitForSnapshot(switchSession, (snapshot) => snapshot.candidates.every((candidate) => candidate.status === "complete"));
  const revisions = Object.fromEntries(switchComplete.candidates.map((candidate) => [candidate.candidate_id, candidate.document.revision]));
  await switchPage.locator(".annotation-item").first().click();
  assert.equal(await switchPage.locator(".annotation-item.active").count(), 1);
  const markerPoint = await switchPage.evaluate(() => {
    const annotation = window.__layoutGuidedApp.document.annotations[0];
    return { x: annotation.end.x / window.__layoutGuidedApp.document.canvas.width, y: annotation.end.y / window.__layoutGuidedApp.document.canvas.height };
  });
  const markerBox = await switchPage.locator("#sketch-canvas").boundingBox();
  assert.ok(markerBox);
  await switchPage.mouse.click(markerBox.x + markerBox.width * markerPoint.x, markerBox.y + markerBox.height * markerPoint.y);
  assert.equal(await switchPage.locator(".annotation-item.active").count(), 1);
  await switchPage.click('[data-candidate-id="B"]');
  await switchPage.waitForFunction(() => document.querySelector("#candidate-state")?.textContent === "B", null, { timeout: 10000 });
  await switchPage.waitForTimeout(120);
  await switchPage.click('[data-candidate-id="C"]');
  await switchPage.waitForFunction(() => document.querySelector("#candidate-state")?.textContent === "C", null, { timeout: 10000 });
  assert.equal(await switchPage.locator(".candidate-card.active").getAttribute("data-candidate-id"), "C");
  await switchPage.click('[data-candidate-id="A"]');
  await switchPage.waitForFunction(() => document.querySelector("#candidate-state")?.textContent === "A", null, { timeout: 10000 });
  await switchPage.fill("#layout-change-input", "标题下移一些，但保持其他对象和文案不变");
  await switchPage.click("#layout-change-button");
  const pendingSwitch = await waitForSnapshot(switchSession, (snapshot) => snapshot.layout_requests?.some((request) => request.status === "pending"));
  await switchPage.waitForFunction(() => document.querySelector("#layout-change-state")?.textContent.includes("AI 监听已断开"), null, { timeout: 10000 });
  assert.match(await switchPage.locator("#listener-state").textContent(), /AI 监听已断开/);
  assert.equal(await switchPage.locator("#layout-change-copy-button").isVisible(), true);
  const requestRecord = pendingSwitch.layout_requests.at(-1);
  assert.equal(requestRecord.status, "pending");
  const failedCallback = await request(`/api/session/${switchSession}/layout-change/${requestRecord.request_id}/result`, { status: "failed", error_category: "host_callback_unavailable" });
  assert.equal(failedCallback.status, "failed");
  await switchPage.waitForFunction(() => document.querySelector("#layout-change-state")?.textContent.includes("当前版本已保留"), null, { timeout: 10000 });
  await capture(switchPage, "stage-4-candidate-switch.png");
  results.sessions[switchSession] = { candidate_revisions: revisions, first_visible_batch: Number(firstBatch), failed_callback_preserved: true, browser_fallback_listener_disconnected: true, recovery_copy_action_visible: true };
  await closePage(switchPage);

  const reopenSession = "stage4-reopen-recovery";
  await seed(reopenSession, fixtures.find((fixture) => fixture.scenario === "reopen-recovery"), { auto_start: true, batch_delay_ms: 20 });
  const reopenPage = await newPage();
  await openWorkbench(reopenPage, reopenSession);
  const completeBeforeEdit = await waitForSnapshot(reopenSession, (snapshot) => snapshot.candidates.every((candidate) => candidate.status === "complete"));
  const revisionBeforeEdit = completeBeforeEdit.candidates.find((candidate) => candidate.candidate_id === "A").document.revision;
  await reopenPage.waitForFunction((revision) => Number(document.querySelector("#revision-state")?.textContent) === revision, revisionBeforeEdit, { timeout: 20000 });
  await reopenPage.click('[data-tool="rectangle"]');
  const canvasBox = await reopenPage.locator("#sketch-canvas").boundingBox();
  assert.ok(canvasBox);
  await reopenPage.mouse.click(canvasBox.x + canvasBox.width * 0.93, canvasBox.y + canvasBox.height * 0.56);
  await reopenPage.waitForFunction((revision) => Number(document.querySelector("#revision-state")?.textContent) > revision, revisionBeforeEdit, { timeout: 10000 });
  const addedRevision = Number(await reopenPage.locator("#revision-state").textContent());
  await reopenPage.click("#undo-button");
  await reopenPage.waitForFunction((revision) => Number(document.querySelector("#revision-state")?.textContent) === revision + 1, addedRevision, { timeout: 10000 });
  const undoRevision = Number(await reopenPage.locator("#revision-state").textContent());
  await reopenPage.click("#redo-button");
  await reopenPage.waitForFunction((revision) => Number(document.querySelector("#revision-state")?.textContent) === revision + 1, undoRevision, { timeout: 10000 });
  const editedRevision = Number(await reopenPage.locator("#revision-state").textContent());
  await capture(reopenPage, "stage-4-edit-history.png");
  await capture(reopenPage, "stage-4-reopen-before-close.png");
  await closePage(reopenPage);
  const reopenedPage = await newPage();
  await openWorkbench(reopenedPage, reopenSession);
  await reopenedPage.waitForFunction((revision) => Number(document.querySelector("#revision-state")?.textContent) === revision, editedRevision, { timeout: 20000 });
  assert.equal(Number(await reopenedPage.locator("#revision-state").textContent()), editedRevision);
  await capture(reopenedPage, "stage-4-reopen.png");
  await reopenedPage.click("#restore-button");
  await reopenedPage.waitForFunction((revision) => Number(document.querySelector("#revision-state")?.textContent) === revision + 1, editedRevision, { timeout: 10000 });
  const restoredRevision = Number(await reopenedPage.locator("#revision-state").textContent());
  const restoredSnapshot = await getSnapshot(reopenSession);
  const restoredDocument = restoredSnapshot.candidates.find((candidate) => candidate.candidate_id === "A").document;
  assert.equal(restoredDocument.objects.length, 0);
  await capture(reopenedPage, "stage-4-restore-initial.png");
  results.sessions[reopenSession] = { revision_before_edit: revisionBeforeEdit, added_revision: addedRevision, undo_revision: undoRevision, redo_revision: editedRevision, revision_after_reopen: editedRevision, restored_revision: restoredRevision, restored_initial: restoredDocument.objects.length === 0 };
  await closePage(reopenedPage);

  const interruptSession = "stage4-interruption-resume";
  const interruptSeed = await seed(interruptSession, fixtures.find((fixture) => fixture.scenario === "interruption-resume"), { auto_start: false });
  const interruptPage = await newPage();
  await openWorkbench(interruptPage, interruptSession);
  const interruptStream = streamIdFrom(interruptSeed);
  const interruptPlan = plannedCandidate(interruptSeed);
  await request(`/api/session/${interruptSession}/begin`, { candidate_id: "A", stream_id: interruptStream });
  await request(`/api/session/${interruptSession}/ops`, { candidate_id: "A", stream_id: interruptStream, batch_seq: 1, base_revision: 0, operations: interruptPlan.operation_batches[0].operations });
  await interruptPage.waitForFunction(() => Number(document.querySelector("#revision-state")?.textContent) === 1, null, { timeout: 10000 });
  await request(`/api/session/${interruptSession}/generation/interrupt`, { candidate_id: "A", stream_id: interruptStream });
  await interruptPage.waitForFunction(() => document.querySelector("#stream-state")?.textContent === "流已中断，等待续传", null, { timeout: 10000 });
  await interruptPage.route(`**/api/session/${interruptSession}/events*`, async (route) => {
    if (route.request().url().includes("format=poll")) await route.continue();
    else await route.abort();
  });
  await interruptPage.reload({ waitUntil: "domcontentloaded" });
  await interruptPage.waitForFunction(() => document.querySelector("#status")?.textContent === "V1.1 轻量画板已加载", null, { timeout: 20000 });
  await interruptPage.waitForFunction(() => document.querySelector("#stream-state")?.textContent.includes("轮询"), null, { timeout: 10000 });
  await request(`/api/session/${interruptSession}/generation/resume`, { candidate_id: "A", stream_id: interruptStream, batch_delay_ms: 20 });
  const interruptComplete = await waitForSnapshot(interruptSession, (snapshot) => snapshot.candidates.find((candidate) => candidate.candidate_id === "A")?.status === "complete");
  const interruptFinalRevision = interruptComplete.candidates.find((candidate) => candidate.candidate_id === "A").document.revision;
  await interruptPage.waitForFunction((revision) => Number(document.querySelector("#revision-state")?.textContent) === revision, interruptFinalRevision, { timeout: 20000 });
  await capture(interruptPage, "stage-4-interruption-poll.png");
  results.sessions[interruptSession] = { interrupted_revision: 1, resumed_revision: interruptFinalRevision, cursor: interruptComplete.event_cursor, resumed_via_poll: true };
  await closePage(interruptPage);

  const conflictSession = "stage4-revision-conflict";
  const conflictSeed = await seed(conflictSession, fixtures.find((fixture) => fixture.scenario === "revision-conflict"), { auto_start: false });
  const conflictStream = streamIdFrom(conflictSeed);
  const conflictPlan = plannedCandidate(conflictSeed);
  await request(`/api/session/${conflictSession}/begin`, { candidate_id: "A", stream_id: conflictStream });
  await request(`/api/session/${conflictSession}/ops`, { candidate_id: "A", stream_id: conflictStream, batch_seq: 1, base_revision: 0, operations: conflictPlan.operation_batches[0].operations });
  const conflictBefore = await getSnapshot(conflictSession);
  const stale = await requestRaw(`/api/session/${conflictSession}/ops`, { candidate_id: "A", stream_id: "stale-user", batch_seq: 1, base_revision: 0, operations: [{ type: "update_object", object_id: conflictPlan.operation_batches[0].operations[0].object.id, patch: { x: 20 } }] });
  assert.equal(stale.status, 409);
  const conflictAfter = await getSnapshot(conflictSession);
  assert.equal(conflictAfter.candidates.find((candidate) => candidate.candidate_id === "A").document.revision, conflictBefore.candidates.find((candidate) => candidate.candidate_id === "A").document.revision);
  const conflictPage = await newPage();
  await openWorkbench(conflictPage, conflictSession);
  await capture(conflictPage, "stage-4-revision-conflict.png");
  results.sessions[conflictSession] = { rejected_status: stale.status, revision_before: conflictBefore.candidates.find((candidate) => candidate.candidate_id === "A").document.revision, revision_after: conflictAfter.candidates.find((candidate) => candidate.candidate_id === "A").document.revision };
  await closePage(conflictPage);

  const invalidSession = "stage4-invalid-anchor";
  await seed(invalidSession, fixtures.find((fixture) => fixture.scenario === "invalid-anchor"), { auto_start: true, batch_delay_ms: 15 });
  const invalidPage = await newPage();
  await openWorkbench(invalidPage, invalidSession);
  const invalidComplete = await waitForSnapshot(invalidSession, (snapshot) => snapshot.candidates.every((candidate) => candidate.status === "complete"));
  const invalidCandidate = invalidComplete.candidates.find((candidate) => candidate.candidate_id === "A");
  const targetObjectId = invalidCandidate.document.annotations[0].target.object_id;
  const invalidRevision = invalidCandidate.document.revision;
  const invalidStream = `invalid-user-${Date.now()}`;
  await request(`/api/session/${invalidSession}/begin`, { candidate_id: "A", stream_id: invalidStream });
  await request(`/api/session/${invalidSession}/ops`, { candidate_id: "A", stream_id: invalidStream, batch_seq: 1, base_revision: invalidRevision, operations: [{ type: "delete_object", object_id: targetObjectId }] });
  await invalidPage.waitForFunction(() => document.querySelectorAll(".annotation-item.invalid").length >= 1, null, { timeout: 10000 });
  await invalidPage.click("#confirm-button");
  await invalidPage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("失效"), null, { timeout: 10000 });
  assert.equal(await invalidPage.locator("#feedback-modal").isHidden(), true);
  const invalidAfter = await getSnapshot(invalidSession);
  assert.notEqual(invalidAfter.status, "layout_confirmed");
  await capture(invalidPage, "stage-4-invalid-anchor.png");
  results.sessions[invalidSession] = { target_deleted: true, invalid_markers: await invalidPage.locator(".annotation-item.invalid").count(), confirmation_blocked: invalidAfter.status !== "layout_confirmed" };
  await closePage(invalidPage);

  results.status = "Stage 4 browser evidence passed";
  results.fresh_run_contract = "Each invocation uses an externally supplied fresh data root and evidence root; candidate-selection refresh races are guarded by a selection generation token.";
  await fs.writeFile(path.join(evidenceRoot, "stage-4-browser-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results));
} finally {
  for (const page of [...pages]) await closePage(page);
  await browser.close();
  await stopLocalService(service);
  if (cleanupData) await fs.rm(dataRoot, { recursive: true, force: true });
}

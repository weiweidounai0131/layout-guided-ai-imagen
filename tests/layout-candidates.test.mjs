import assert from "node:assert/strict";
import { test } from "node:test";
import { applySketchOperations } from "../mcp/sketch-document.mjs";
import { buildLayoutCandidates, validateCandidateSet } from "../mcp/layout-candidates.mjs";

const brief = {
  schema_version: "poster-brief/1",
  canvas: { width: 800, height: 1100, aspect_ratio: "8:11" },
  copy: [
    { id: "title", role: "title", text: "看球不断网，精彩不掉线", must_preserve: true },
    { id: "subtitle", role: "subtitle", text: "世界杯开赛，家里的网络我来守。", must_preserve: true },
    { id: "benefit-live", role: "benefit", text: "直播不卡顿", must_preserve: true },
    { id: "benefit-cast", role: "benefit", text: "投屏更稳定", must_preserve: true },
    { id: "footer", role: "footer", text: "网络有问题，随时找我们", must_preserve: true }
  ],
  main_visual: { description: "夜间客厅看球，电视播放足球比赛，装维人员检查路由器。", asset_refs: ["scene"] },
  style: { direction: "真实、热闹、有节日氛围", palette: "深蓝与暖黄" },
  assets: [
    { id: "scene", role: "main_visual", description: "夜间家庭看球主场景" },
    { id: "technician", role: "person", description: "蓝色工装装维人员" },
    { id: "tv", role: "screen_content", description: "明确的足球赛事直播画面" },
    { id: "router", role: "product", description: "家庭路由器和稳定网络信号" }
  ],
  detail_requirements: [
    { id: "D1", asset_ref: "technician", instruction: "人物面部和服务身份保持清晰。", category: "subject_detail" },
    { id: "D2", asset_ref: "tv", instruction: "电视画面必须明确是足球赛事直播。", category: "screen_detail" }
  ],
  constraints: { must_include: ["家庭看球", "家庭路由器"], must_not_include: ["水印"] }
};

test("builds three valid candidates with high-granularity copy, assets, markers, and hashes", () => {
  const result = buildLayoutCandidates(brief);
  assert.equal(result.schema_version, "layout-candidates/1");
  assert.equal(result.candidate_count, 3);
  assert.equal(result.image_model_called, false);
  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.candidates.map((candidate) => candidate.candidate_id), ["A", "B", "C"]);
  assert.equal(new Set(result.candidates.map((candidate) => candidate.hash)).size, 3);
  assert.equal(new Set(result.candidates.map((candidate) => {
    const main = candidate.document.objects.find((object) => object.asset_role === "main_visual");
    return [main.x, main.y, main.width, main.height].join(":");
  })).size, 3);
  for (const candidate of result.candidates) {
    assert.ok(candidate.document.objects.some((object) => object.type === "text" && object.copy_ref === "title"));
    assert.ok(candidate.document.objects.filter((object) => object.type === "image_placeholder" && object.asset_description).length >= 4);
    assert.deepEqual(candidate.document.annotations.map((annotation) => annotation.label), ["D1", "D2"]);
    assert.ok(candidate.operation_batches.length >= 3);
    assert.equal(candidate.operation_batches.at(-1).revision, candidate.document.revision);
  }
});

test("replaying the ordered operation plan reconstructs each final document", () => {
  const result = buildLayoutCandidates(brief, { candidateCount: 2 });
  assert.equal(result.candidate_count, 2);
  for (const candidate of result.candidates) {
    let replayed = candidate.seed_document;
    for (const batch of candidate.operation_batches) {
      assert.equal(batch.base_revision, replayed.revision);
      replayed = applySketchOperations(replayed, batch.operations);
    }
    replayed.status = "complete";
    assert.deepEqual(replayed, candidate.document);
  }
});

test("does not build layout candidates from an incomplete brief", () => {
  assert.throws(
    () => buildLayoutCandidates({ canvas: { aspect_ratio: "8:11" }, copy: [], main_visual: {} }),
    /PosterBrief must be ready before layout: needs_input/
  );
});

test("candidate-set validation isolates invalid candidate data", () => {
  const result = buildLayoutCandidates(brief);
  const invalid = { ...result.candidates[0], hash: "broken" };
  const validation = validateCandidateSet([result.candidates[0], invalid]);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("duplicate")));
});

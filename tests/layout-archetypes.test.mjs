import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  LAYOUT_ARCHETYPES,
  LAYOUT_ARCHETYPE_SELECTION_POLICY,
  deriveBriefSignals,
  listLayoutArchetypes,
  selectLayoutArchetypes,
  validateLayoutArchetypeCatalog
} from "../mcp/layout-archetypes.mjs";
import { buildLayoutCandidates, validateCandidateSet } from "../mcp/layout-candidates.mjs";

const root = path.resolve(process.cwd());

function brief(overrides = {}) {
  return {
    schema_version: "poster-brief/1",
    canvas: { width: 800, height: 1100, aspect_ratio: "8:11" },
    copy: [
      { id: "title", role: "title", text: "一件好产品", must_preserve: true },
      { id: "subtitle", role: "subtitle", text: "清晰表达价值", must_preserve: true }
    ],
    main_visual: { description: "单件产品主视觉", asset_refs: ["main"] },
    style: { direction: "极简高级留白", palette: "黑白" },
    purpose: "产品介绍",
    assets: [{ id: "main", role: "main_visual", description: "单件产品主视觉" }],
    detail_requirements: [],
    constraints: { must_include: [], must_not_include: [] },
    ...overrides
  };
}

test("catalog has a stable product-owned schema and schematic for every archetype", async () => {
  const schema = JSON.parse(await fs.readFile(path.join(root, "contracts", "layout-archetypes.schema.json"), "utf8"));
  assert.equal(schema.properties.schema_version.const, "layout-archetypes/1");
  assert.equal(schema.required.includes("selection_policy"), true);
  assert.equal(schema.properties.selection_policy.properties.execution.const, "local_fallback");
  assert.equal(schema.properties.selection_policy.properties.aesthetic_evidence.const, "unverified");
  assert.equal(validateLayoutArchetypeCatalog().valid, true);
  const listed = listLayoutArchetypes();
  assert.deepEqual(listed.selection_policy, LAYOUT_ARCHETYPE_SELECTION_POLICY);
  assert.equal(listed.selection_policy.execution, "local_fallback");
  assert.equal(listed.selection_policy.model_call, false);
  assert.equal(listed.selection_policy.aesthetic_evidence, "unverified");
  assert.deepEqual(LAYOUT_ARCHETYPES.map((item) => item.id), [
    "center-hero", "bold-type", "split-columns", "top-bottom", "title-led", "module-grid",
    "framed-scene", "diagonal-flow", "full-bleed", "minimal-space", "information-stack", "editorial-grid"
  ]);
  assert.equal(new Set(LAYOUT_ARCHETYPES.map((item) => item.id)).size, LAYOUT_ARCHETYPES.length);
  for (const archetype of LAYOUT_ARCHETYPES) {
    assert.match(archetype.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(archetype.fit_signals.length >= 1);
    assert.ok(archetype.difference_axes.length >= 2);
    assert.equal(archetype.schematic.viewBox, "0 0 120 160");
    assert.ok(archetype.schematic.elements.length >= 2);
  }
});

test("selector adapts to different brief signals and keeps three candidates materially distinct", () => {
  const minimal = selectLayoutArchetypes(brief());
  const denseBrief = brief({
    copy: [
      { id: "title", role: "title", text: "校园课程安排与报名须知", must_preserve: true },
      { id: "subtitle", role: "subtitle", text: "时间地点规则一次看懂", must_preserve: true },
      { id: "body", role: "body", text: "课程内容与流程说明", must_preserve: true },
      { id: "b1", role: "benefit", text: "模块一服务内容", must_preserve: true },
      { id: "b2", role: "benefit", text: "模块二服务内容", must_preserve: true },
      { id: "b3", role: "benefit", text: "参数与联系方式", must_preserve: true },
      { id: "b4", role: "benefit", text: "报名条件与步骤", must_preserve: true },
      { id: "footer", role: "footer", text: "立即报名", must_preserve: true }
    ],
    main_visual: { description: "产品参数和服务模块的信息场景", asset_refs: ["main"] },
    style: { direction: "正式专业信息", palette: "蓝灰" },
    purpose: "活动通知海报"
  });
  const dense = selectLayoutArchetypes(denseBrief);
  const dynamic = selectLayoutArchetypes(brief({
    copy: [
      { id: "title", role: "title", text: "速度开场", must_preserve: true },
      { id: "subtitle", role: "subtitle", text: "赛事直播即刻开始", must_preserve: true },
      { id: "cta", role: "cta", text: "立即参与", must_preserve: true }
    ],
    main_visual: { description: "运动员在城市户外高速奔跑的动感场景", asset_refs: ["main"] },
    style: { direction: "运动动感、速度、对角", palette: "高对比" },
    purpose: "赛事活动"
  }));
  for (const result of [minimal, dense, dynamic]) {
    assert.equal(result.selected.length, 3);
    assert.equal(new Set(result.selected.map((item) => item.id)).size, 3);
    assert.equal(new Set(result.selected.map((item) => JSON.stringify(item.schematic))).size, 3);
    assert.ok(new Set(result.selected.flatMap((item) => item.difference_axes)).size >= 6);
    assert.ok(result.selected.every((item) => typeof item.selection_rationale === "string" && item.selection_rationale.length > 0));
    assert.ok(result.selected.every((item) => Number.isFinite(item.selection_score)));
  }
  assert.notDeepEqual(minimal.selected.map((item) => item.id), dense.selected.map((item) => item.id));
  assert.notDeepEqual(dense.selected.map((item) => item.id), dynamic.selected.map((item) => item.id));
  const signalSet = deriveBriefSignals(denseBrief);
  assert.equal(signalSet.copy_dense, true);
  assert.equal(signalSet.modular_content, true);
});

test("selector is deterministic and candidate metadata remains stable for the same brief", () => {
  const source = brief();
  const first = selectLayoutArchetypes(source);
  const second = selectLayoutArchetypes(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(second, first);
  const candidates = buildLayoutCandidates(source).candidates;
  const built = buildLayoutCandidates(source);
  assert.deepEqual(built.selection_policy, LAYOUT_ARCHETYPE_SELECTION_POLICY);
  assert.deepEqual(candidates.map((item) => item.archetype_id), first.selected.map((item) => item.id));
  assert.ok(candidates.every((item) => item.selection_policy?.execution === "local_fallback"));
  assert.ok(candidates.every((item) => item.schematic?.elements?.length >= 2));
});

test("old candidate records without archetype metadata stay valid", () => {
  const result = buildLayoutCandidates(brief());
  const legacy = result.candidates.map(({ archetype_id, archetype_name, selection_score, selection_rationale, schematic, ...candidate }) => candidate);
  assert.equal(validateCandidateSet(legacy).valid, true);
  assert.ok(legacy.every((candidate) => !candidate.archetype_id));
});

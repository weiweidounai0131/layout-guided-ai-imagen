import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePosterBrief, validatePosterBrief } from "../mcp/poster-brief.mjs";

const completeBrief = {
  schema_version: "poster-brief/1",
  canvas: { width: 800, height: 1100, aspect_ratio: "8:11" },
  copy: [
    { id: "title", role: "title", text: "看球不断网，精彩不掉线", must_preserve: true },
    { id: "footer", role: "footer", text: "网络有问题，随时找我们", must_preserve: true }
  ],
  purpose: "世界杯家庭看球服务海报",
  main_visual: { description: "夜间客厅看球，电视播放足球比赛，网络装维人员在右侧检查路由器。" },
  style: { direction: "真实、热闹、有节日氛围", palette: "深蓝与暖黄" },
  assets: [{ id: "technician", role: "person", description: "蓝色工装装维人员" }],
  references: {
    image_refs: [{ ref: "technician-reference.png", role: "person_reference", status: "ready" }],
    style_refs: [{ ref: "night-style.png", role: "style_reference", status: "ready" }]
  },
  layout_reference: { ref: "user-layout.png", role: "layout_reference", status: "ready" },
  constraints: { must_include: ["足球赛事画面"], must_not_include: ["水印"] }
};

test("accepts a complete brief and preserves copy verbatim", () => {
  const result = validatePosterBrief(completeBrief);
  assert.equal(result.status, "ready");
  assert.equal(result.can_enter_layout, true);
  assert.equal(result.brief.schema_version, "poster-brief/1");
  assert.deepEqual(result.brief.copy.map((item) => item.text), completeBrief.copy.map((item) => item.text));
  assert.deepEqual(result.brief.references.image_refs, completeBrief.references.image_refs);
});

test("reports only the missing required inputs needed before layout", () => {
  const result = validatePosterBrief({ canvas: { aspect_ratio: "8:11" }, copy: [], main_visual: {} });
  assert.equal(result.status, "needs_input");
  assert.equal(result.can_enter_layout, false);
  assert.deepEqual(result.missing.map((item) => item.path), ["copy", "main_visual.description"]);
  assert.equal(result.questions.length, 2);
  assert.equal(result.questions.some((question) => question.includes("尺寸")), false);
});

test("blocks contradictory dimensions and duplicate asset IDs", () => {
  const result = validatePosterBrief({
    ...completeBrief,
    canvas: { width: 800, height: 1000, aspect_ratio: "8:11" },
    copy: [...completeBrief.copy, { id: "title", role: "duplicate", text: "重复标题" }],
    assets: [
      { id: "same", role: "person" },
      { id: "same", role: "product" }
    ]
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.can_enter_layout, false);
  assert.ok(result.conflicts.some((conflict) => conflict.type === "canvas_ratio_mismatch"));
  assert.ok(result.conflicts.some((conflict) => conflict.type === "duplicate_asset_id"));
  assert.ok(result.conflicts.some((conflict) => conflict.type === "copy_structure_conflict"));
});

test("preserves the brief when a required attachment fails", () => {
  const brief = {
    ...completeBrief,
    attachments: [{ id: "logo", role: "brand_logo", required: true, status: "failed", error_type: "decode_failed", source_ref: "logo.png" }]
  };
  const result = validatePosterBrief(brief);
  assert.equal(result.status, "attachment_error");
  assert.equal(result.can_enter_layout, false);
  assert.deepEqual(result.brief.attachments, brief.attachments);
  assert.equal(result.attachment_errors[0].error_type, "decode_failed");
});

test("normalization never rewrites user copy text", () => {
  const brief = { copy: [{ text: "  保留前后空格  " }], canvas: { aspect_ratio: "1:1" }, main_visual: { description: "主体" } };
  assert.equal(normalizePosterBrief(brief).copy[0].text, brief.copy[0].text);
});

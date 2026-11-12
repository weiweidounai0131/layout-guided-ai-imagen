import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCreativePrompt, buildGenerationRequest } from "../mcp/generation-request.mjs";

const brief = {
  schema_version: "poster-brief/1",
  canvas: { width: 1080, height: 1440, aspect_ratio: "3:4" },
  copy: [
    { id: "title", role: "title", text: "完整标题：连接未来", must_preserve: true },
    { id: "body", role: "body", text: "完整正文，不得删改。", must_preserve: true }
  ],
  main_visual: { description: "一颗被光纤网络环绕的地球", asset_refs: ["asset-main"] },
  style: {
    purpose: "科技主题海报",
    direction: "未来感、真实质感的通信科技视觉",
    lighting: "冷蓝光与暖白节点光",
    palette: "深蓝、冰蓝、少量暖白",
    materials: "玻璃、金属、细腻雾气"
  },
  assets: [{ id: "asset-main", role: "main_visual", source_ref: "local-main.png" }],
  references: { style_refs: [{ ref: "style-reference.png", role: "style_reference" }] },
  constraints: { must_include: ["主体地球"], must_not_include: ["品牌水印"] }
};

const confirmation = {
  session_id: "session-01",
  candidate_id: "A",
  layout_version: "v3",
  confirmation_id: "confirmation-test-01",
  confirmed_by: "user_ui",
  sketch_json_path: "current.sketch.json",
  clean_png_path: "layout.clean.png",
  annotated_png_path: "layout.annotated.png",
  sketch_json_sha256: "c".repeat(64),
  clean_png_sha256: "a".repeat(64),
  annotated_png_sha256: "b".repeat(64),
  detail_constraints: [{
    detail_id: "D1",
    annotation_id: "ann-1",
    target: { kind: "object", object_id: "main" },
    marker: { symbol: "①", point: { x: 4, y: 4 } },
    anchor: { x: 4, y: 4 },
    instruction: "保持主体清晰，冷蓝轮廓光。",
    category: "subject_detail",
    polarity: "positive",
    status: "valid",
    must_not_render: true
  }]
};

test("builds a dual-conditioned request with separate visual framework and user references", () => {
  const request = buildGenerationRequest({ brief, confirmation, verification: { source: "layout-service", persisted: true, session_id: confirmation.session_id, confirmation_id: confirmation.confirmation_id } });
  assert.equal(request.schema_version, "generation-request/3");
  assert.equal(request.visual_framework.clean.role, "visual_framework");
  assert.equal(request.visual_framework.annotated.role, "annotated_framework");
  assert.deepEqual(request.visual_framework.controls, ["position", "proportion", "hierarchy", "reading_path", "whitespace"]);
  assert.deepEqual(request.image_inputs.map((input) => input.role), ["visual_framework", "annotated_framework", "main_visual", "style_reference"]);
  assert.match(request.creative_prompt.text, /未来感、真实质感的通信科技视觉/);
  assert.match(request.creative_prompt.text, /完整标题：连接未来/);
  assert.match(request.creative_prompt.text, /完整正文，不得删改。/);
  assert.match(request.creative_prompt.text, /D1/);
  assert.match(request.creative_prompt.text, /编号标记/);
  assert.equal(request.creative_prompt.verbatim_copy[1], "完整正文，不得删改。");
  assert.equal(request.dispatch.image_count, 1);
  assert.equal(request.dispatch.auto_retry, false);
  assert.equal(request.image_input_plan.single_image.text_must_repeat_framework_and_details, true);
  assert.equal(request.image_input_plan.single_image.user_reference_images_require_user_choice, true);
  assert.ok(request.creative_prompt.hard_constraints.length > 0);
  assert.ok(request.creative_prompt.soft_layout_guidance.some((item) => item.includes("大致结构")));
  assert.ok(request.creative_prompt.creative_freedom.some((item) => item.includes("字体")));
  assert.match(request.creative_prompt.text, /不是最终视觉成品，也不是像素复刻模板/);
});

test("accepts persisted nested confirmation hashes without treating canvas typography as hard style", () => {
  const persisted = {
    session_id: confirmation.session_id,
    candidate_id: confirmation.candidate_id,
    layout_version: confirmation.layout_version,
    confirmation_id: confirmation.confirmation_id,
    confirmed_by: "user_ui",
    files: { sketch_json: "current.sketch.json", clean_png: "layout.clean.png", annotated_png: "layout.annotated.png" },
    hashes: {
      sketch_json_sha256: confirmation.sketch_json_sha256,
      clean_png_sha256: confirmation.clean_png_sha256,
      annotated_png_sha256: confirmation.annotated_png_sha256
    }
  };
  const request = buildGenerationRequest({ brief, confirmation: persisted, verification: { source: "layout-service", persisted: true, session_id: persisted.session_id, confirmation_id: persisted.confirmation_id } });
  assert.equal(request.confirmed_files.clean_png_sha256, confirmation.clean_png_sha256);
  assert.equal(request.creative_prompt.layout_semantics, "broad_structure_guidance_not_pixel_replication");
});

test("keeps 秋季新品发布会 verbatim while allowing expressive title packaging", () => {
  const seasonalBrief = { ...brief, copy: [{ id: "title", role: "title", text: "秋季新品发布会", must_preserve: true }] };
  const text = buildCreativePrompt(seasonalBrief);
  assert.match(text, /“秋季新品发布会”必须逐字保留/);
  assert.match(text, /高级字体、层次、字距、材质和标题包装/);
  assert.match(text, /不要机械复刻画板文字的字号、字体、色块或边框/);
});

test("fails closed when a visual framework or creative brief is incomplete", () => {
  const verification = { source: "layout-service", persisted: true, session_id: confirmation.session_id, confirmation_id: confirmation.confirmation_id };
  assert.throws(() => buildCreativePrompt({ ...brief, main_visual: { description: "" } }), /brief.main_visual.description is required/);
  assert.throws(() => buildGenerationRequest({ brief, confirmation: { ...confirmation, clean_png_path: "" }, verification }), /confirmation.clean_png_path is required/);
  assert.throws(() => buildGenerationRequest({ brief, confirmation: { ...confirmation, annotated_png_sha256: "" }, verification }), /confirmation.annotated_png_sha256 is required/);
  assert.throws(() => buildGenerationRequest({ brief, confirmation }), /server-verified persisted confirmation/);
});

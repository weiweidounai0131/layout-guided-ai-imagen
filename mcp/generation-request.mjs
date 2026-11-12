const HELPER_ELEMENT_EXCLUSIONS = ["占位框", "标签", "编号标记", "网格", "箭头", "辅助线", "UI 控件", "占位颜色", "局部说明文字", "批注文字"];

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.length > 0))];
}

function normalizeImageReference(reference, role) {
  if (typeof reference === "string" && reference.length > 0) return { ref: reference, role };
  if (reference && typeof reference === "object") {
    const ref = reference.path ?? reference.ref ?? reference.source_ref;
    if (typeof ref === "string" && ref.length > 0) return { ref, role: reference.role ?? role };
  }
  return null;
}

function formatCopy(copy) {
  return copy.map((item) => `- ${item.role ?? item.id ?? "copy"}: ${item.text}`).join("\n");
}

function formatAssets(assets) {
  if (!assets.length) return "未提供额外素材";
  return assets.map((asset) => {
    const source = asset.source_ref ? `（用户参考图 ${asset.source_ref}）` : "";
    return `- ${asset.id ?? "asset"}: ${asset.role ?? "auxiliary"}${source}`;
  }).join("\n");
}

function formatDetailConstraints(constraints) {
  if (!constraints.length) return "未提供局部标记说明";
  return constraints.map((constraint) => {
    const target = constraint.target?.kind === "object"
      ? `对象 ${constraint.target.object_id}`
      : `区域 ${constraint.target?.region ?? "未命名区域"}`;
    const marker = constraint.marker?.symbol ?? constraint.detail_id ?? constraint.annotation_id;
    return `- ${marker} ${constraint.detail_id ?? constraint.annotation_id}（${target}）：${constraint.instruction}`;
  }).join("\n");
}

function constraintLayers(brief, detailConstraints) {
  const constraints = brief.constraints && typeof brief.constraints === "object" ? brief.constraints : {};
  const framework = brief.visual_framework && typeof brief.visual_framework === "object" ? brief.visual_framework : {};
  const hardConstraints = [
    `画布尺寸与比例：${brief.canvas.width}×${brief.canvas.height}${brief.canvas.aspect_ratio ? `（${brief.canvas.aspect_ratio}）` : ""}`,
    "所有完整文案逐字保留，不得删改、漏字或擅自改写",
    ...uniqueStrings(constraints.must_include).map((item) => `必须包含：${item}`),
    ...uniqueStrings(constraints.must_not_include).map((item) => `不得出现：${item}`),
    ...detailConstraints.map((item) => `用户明确局部要求：${item.detail_id ?? item.annotation_id ?? "detail"} — ${item.instruction}`),
    ...uniqueStrings(constraints.hard_constraints)
  ];
  const softLayoutGuidance = [
    "只把确认后的画布作为大致结构参考：区域关系、信息层级、主体占比、阅读动线与留白优先",
    "允许在区域内部自然重排、换行和微调；不要把画板上的像素坐标、占位框、色块或边框当成成品规范",
    ...(Array.isArray(framework.soft_layout_guidance) ? framework.soft_layout_guidance : []),
    ...(Array.isArray(constraints.soft_layout_guidance) ? constraints.soft_layout_guidance : [])
  ];
  const creativeFreedom = [
    "字体、字号、字重、字距、换行、标题造型与艺术包装由生图模型按主题审美决定",
    "背景、主视觉、材质、描边、装饰、光影、配色和整图融合由生图模型统一设计",
    "不要默认用程序把朴素文字精确贴回画板；标题应作为最终视觉的一部分被设计，而不是机械复刻画板样式",
    "除非用户明确锁定某一项，否则画板的 fontFamily、fontSize、fill、stroke、边框和占位色均不是硬约束",
    ...uniqueStrings(constraints.creative_freedom)
  ];
  return { hardConstraints, softLayoutGuidance, creativeFreedom };
}

export function buildCreativePrompt(brief, detailConstraints = []) {
  requireObject(brief, "brief");
  requireObject(brief.canvas, "brief.canvas");
  requireObject(brief.main_visual, "brief.main_visual");
  const copy = Array.isArray(brief.copy) ? brief.copy : [];
  if (!copy.length) throw new Error("brief.copy is required");
  copy.forEach((item, index) => requireText(item?.text, `brief.copy[${index}].text`));

  const style = brief.style && typeof brief.style === "object" ? brief.style : {};
  const constraints = brief.constraints && typeof brief.constraints === "object" ? brief.constraints : {};
  const assets = Array.isArray(brief.assets) ? brief.assets : [];
  const mustKeep = uniqueStrings(constraints.must_include);
  const mustAvoid = uniqueStrings([...(constraints.must_not_include ?? []), ...HELPER_ELEMENT_EXCLUSIONS]);
  const canvas = [brief.canvas.width, brief.canvas.height].every((value) => Number.isFinite(value))
    ? `${brief.canvas.width}×${brief.canvas.height}`
    : (brief.canvas.aspect_ratio ?? "按确认画布比例");

  const layers = constraintLayers(brief, detailConstraints);
  const titleCopy = copy.find((item) => item.role === "title" || item.id === "title")?.text;
  const titleGuidance = titleCopy
    ? `标题语义示例： “${titleCopy}”必须逐字保留，但可以做高级字体、层次、字距、材质和标题包装；不要机械复刻画板文字的字号、字体、色块或边框。`
    : "标题文字必须逐字保留，但其字体、字号与艺术包装由生图模型按主题决定。";
  return [
    "视觉框架角色：确认后的干净视觉框架只提供大致结构参考，控制区域关系、比例、信息层级、阅读动线和留白；它不是最终视觉成品，也不是像素复刻模板。",
    "批注视觉框架角色：画布内的序号标记只用于把局部区域映射到右侧细节约束；序号、箭头、批注文字和辅助框不得被渲染。",
    "硬约束、软布局指引和创意自由度分层执行：只有硬约束与用户明确锁定项必须严格遵守；软布局在区域关系和层级上参考，创意细节交给生图模型。",
    `目标画布：${canvas}`,
    `主体与场景：${requireText(brief.main_visual.description, "brief.main_visual.description")}`,
    `视觉风格与媒介：${style.direction ?? "根据主体和用途选择合适的视觉风格"}`,
    `用途：${style.purpose ?? "海报"}`,
    `光线、配色与材质：${[style.lighting, style.palette, style.materials].filter(Boolean).join("；") || "根据视觉风格自然匹配"}`,
    `完整文案（必须逐字保留，不得删改）：\n${formatCopy(copy)}`,
    titleGuidance,
    `用户参考图角色：\n${formatAssets(assets)}`,
    `局部细节约束（编号必须对应批注视觉框架）：\n${formatDetailConstraints(detailConstraints)}`,
    `HARD_CONSTRAINTS（严格）：\n${layers.hardConstraints.map((item) => `- ${item}`).join("\n")}`,
    `SOFT_LAYOUT_GUIDANCE（大致结构，可在区域内自然调整）：\n${layers.softLayoutGuidance.map((item) => `- ${item}`).join("\n")}`,
    `CREATIVE_FREEDOM（交给生图模型）：\n${layers.creativeFreedom.map((item) => `- ${item}`).join("\n")}`,
    `必须保留：${mustKeep.length ? mustKeep.join("；") : "完整文案、主体和用户明确提供的素材"}`,
    `禁止出现：${mustAvoid.join("、")}`
  ].join("\n");
}

function collectUserReferences(brief) {
  const references = [];
  for (const asset of Array.isArray(brief.assets) ? brief.assets : []) {
    const normalized = normalizeImageReference(asset.source_ref, asset.role ?? "auxiliary_asset");
    if (normalized) references.push(normalized);
  }
  for (const reference of Array.isArray(brief.references?.style_refs) ? brief.references.style_refs : []) {
    const normalized = normalizeImageReference(reference, "style_reference");
    if (normalized) references.push(normalized);
  }
  for (const reference of Array.isArray(brief.references?.image_refs) ? brief.references.image_refs : []) {
    const normalized = normalizeImageReference(reference, "user_reference_image");
    if (normalized) references.push(normalized);
  }
  return references;
}

function confirmedFile(confirmation, ...keys) {
  for (const key of keys) {
    if (typeof confirmation[key] === "string" && confirmation[key]) return confirmation[key];
    if (typeof confirmation.files?.[key] === "string" && confirmation.files[key]) return confirmation.files[key];
  }
  return null;
}

function requireVerifiedGenerationContext(confirmation, verification) {
  if (!verification || verification.source !== "layout-service" || verification.persisted !== true) {
    throw new Error("generation request requires a server-verified persisted confirmation");
  }
  if (confirmation.confirmed_by !== "user_ui") throw new Error("generation request requires confirmed_by=user_ui");
  if (typeof confirmation.confirmation_id !== "string" || confirmation.confirmation_id.length === 0) throw new Error("confirmation.confirmation_id is required");
  if (verification.session_id !== confirmation.session_id || verification.confirmation_id !== confirmation.confirmation_id) {
    throw new Error("generation request confirmation verification does not match the persisted record");
  }
}

export function buildGenerationRequest({ brief, confirmation, verification }) {
  requireObject(brief, "brief");
  requireObject(confirmation, "confirmation");
  requireVerifiedGenerationContext(confirmation, verification);
  const sessionId = requireText(confirmation.session_id, "confirmation.session_id");
  const candidateId = requireText(confirmation.candidate_id, "confirmation.candidate_id");
  const layoutVersion = requireText(confirmation.layout_version, "confirmation.layout_version");
  const cleanRef = confirmedFile(confirmation, "clean_png_ref", "clean_png_path", "clean_png", "visual_framework_ref", "visual_framework_path", "png_path", "png_ref");
  const annotatedRef = confirmedFile(confirmation, "annotated_png_ref", "annotated_png_path", "annotated_png", "annotated_framework_ref", "annotated_framework_path");
  const sketchRef = confirmedFile(confirmation, "sketch_json_ref", "sketch_json_path", "sketch_json");
  requireText(cleanRef, "confirmation.clean_png_path");
  requireText(annotatedRef, "confirmation.annotated_png_path");
  const persistedHashes = confirmation.hashes && typeof confirmation.hashes === "object" ? confirmation.hashes : {};
  const sketchHash = confirmation.sketch_json_sha256 ?? persistedHashes.sketch_json_sha256;
  const cleanHash = confirmation.clean_png_sha256 ?? confirmation.png_sha256 ?? persistedHashes.clean_png_sha256;
  const annotatedHash = confirmation.annotated_png_sha256 ?? persistedHashes.annotated_png_sha256;
  const detailHash = confirmation.detail_constraints_sha256 ?? persistedHashes.detail_constraints_sha256;
  requireText(cleanHash, "confirmation.clean_png_sha256");
  requireText(annotatedHash, "confirmation.annotated_png_sha256");

  const detailConstraints = Array.isArray(confirmation.detail_constraints) ? confirmation.detail_constraints : [];
  const userReferences = collectUserReferences(brief);
  const frameworkInputs = [
    { ref: cleanRef, role: "visual_framework" },
    { ref: annotatedRef, role: "annotated_framework" }
  ];
  const allInputs = [...frameworkInputs, ...userReferences];
  const text = buildCreativePrompt(brief, detailConstraints);
  const layers = constraintLayers(brief, detailConstraints);

  return {
    schema_version: "generation-request/3",
    session_id: sessionId,
    candidate_id: candidateId,
    layout_version: layoutVersion,
    confirmation_id: confirmation.confirmation_id,
    confirmed_by: confirmation.confirmed_by,
    confirmed_files: {
      sketch_json_ref: sketchRef,
      clean_png_ref: cleanRef,
      annotated_png_ref: annotatedRef,
      sketch_json_sha256: sketchHash ?? null,
      clean_png_sha256: cleanHash,
      annotated_png_sha256: annotatedHash,
      detail_constraints_sha256: detailHash ?? null
    },
    visual_framework: {
      clean: { ref: cleanRef, role: "visual_framework" },
      annotated: { ref: annotatedRef, role: "annotated_framework" },
      controls: ["position", "proportion", "hierarchy", "reading_path", "whitespace"],
      excludes: HELPER_ELEMENT_EXCLUSIONS
    },
    image_input_plan: {
      multi_image: {
        image_inputs: allInputs,
        user_reference_images: userReferences,
        requires_confirmation_if_host_rejects: true
      },
      single_image: {
        image_inputs: [{ ref: annotatedRef, role: "annotated_framework" }],
        text_must_repeat_framework_and_details: true,
        user_reference_images_require_user_choice: userReferences.length > 0,
        omitted_without_confirmation: userReferences
      }
    },
    image_inputs: allInputs,
    creative_prompt: {
      text,
      subject: brief.main_visual.description,
      style: brief.style?.direction ?? null,
      lighting_and_palette: [brief.style?.lighting, brief.style?.palette, brief.style?.materials].filter(Boolean),
      verbatim_copy: (brief.copy ?? []).map((item) => item.text),
      detail_constraints: detailConstraints,
      user_reference_roles: userReferences,
      must_keep: uniqueStrings(brief.constraints?.must_include),
      must_avoid: uniqueStrings([...(brief.constraints?.must_not_include ?? []), ...HELPER_ELEMENT_EXCLUSIONS]),
      hard_constraints: layers.hardConstraints,
      soft_layout_guidance: layers.softLayoutGuidance,
      creative_freedom: layers.creativeFreedom,
      layout_semantics: "broad_structure_guidance_not_pixel_replication"
    },
    dispatch: {
      image_count: 1,
      user_trigger_required: true,
      auto_retry: false,
      layout_revision: layoutVersion,
      confirmation_id: confirmation.confirmation_id,
      confirmed_by: "user_ui"
    }
  };
}

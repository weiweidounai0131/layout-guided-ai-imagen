const SCHEMA_VERSION = "sketch-document/1";
import { getLayoutArchetype, LAYOUT_ARCHETYPE_SELECTION_POLICY } from "./layout-archetypes.mjs";

export const SKETCH_SCHEMA_VERSION = SCHEMA_VERSION;
export const OBJECT_TYPES = new Set([
  "text",
  "rectangle",
  "rounded_rectangle",
  "ellipse",
  "image_placeholder",
  "freehand_path"
]);
export const ANNOTATION_TYPES = new Set(["detail_marker", "detail_arrow", "detail_note"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function point(x, y) {
  return { x, y };
}

function textObject(id, x, y, width, height, text, style, extra = {}) {
  return {
    id,
    type: "text",
    x,
    y,
    width,
    height,
    z_index: extra.z_index ?? 3,
    style: {
      fill: style.fill ?? "#1d1d1f",
      font_size: style.font_size ?? 28,
      font_weight: style.font_weight ?? 500,
      text_align: style.text_align ?? "left",
      line_height: style.line_height ?? 1.15
    },
    text,
    text_role: extra.text_role ?? "label",
    copy_ref: extra.copy_ref ?? null,
    summary: extra.summary ?? null
  };
}

function rectangleObject(id, type, x, y, width, height, style, extra = {}) {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    z_index: extra.z_index ?? 1,
    style: {
      fill: style.fill ?? "transparent",
      stroke: style.stroke ?? "#4e77a9",
      stroke_width: style.stroke_width ?? 2,
      radius: style.radius ?? 0,
      opacity: style.opacity ?? 1
    },
    label: extra.label ?? null,
    asset_ref: extra.asset_ref ?? null,
    asset_role: extra.asset_role ?? null,
    asset_description: extra.asset_description ?? null,
    summary: extra.summary ?? null,
    locked: extra.locked ?? false
  };
}

function ellipseObject(id, x, y, width, height, style, extra = {}) {
  return {
    id,
    type: "ellipse",
    x,
    y,
    width,
    height,
    z_index: extra.z_index ?? 1,
    style: {
      fill: style.fill ?? "transparent",
      stroke: style.stroke ?? "#4e77a9",
      stroke_width: style.stroke_width ?? 2,
      opacity: style.opacity ?? 1
    },
    label: extra.label ?? null,
    asset_role: extra.asset_role ?? null,
    asset_description: extra.asset_description ?? null,
    summary: extra.summary ?? null,
    locked: extra.locked ?? false
  };
}

function imagePlaceholder(id, x, y, width, height, label, assetRef, description, style = {}, extra = {}) {
  return rectangleObject(id, "image_placeholder", x, y, width, height, {
    fill: "#f7f9fc",
    stroke: "#9aa8bb",
    stroke_width: 2,
    radius: 14,
    opacity: 1,
    ...style
  }, {
    ...extra,
    label,
    asset_ref: assetRef,
    asset_role: extra.asset_role ?? "supporting_visual",
    asset_description: description,
    summary: description
  });
}

function placeholderAnnotation(id, label, start, end, target, note, category, polarity = "positive") {
  return {
    id,
    type: "detail_marker",
    label,
    start,
    end,
    target,
    note,
    category,
    polarity,
    render_in_final: false,
    status: "valid",
    invalid_reason: null
  };
}

function markerAnnotation(id, label, anchor, target, note, category, polarity = "positive") {
  return placeholderAnnotation(id, label, anchor, anchor, target, note, category, polarity);
}

const CIRCLED_NUMBERS = ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

function markerSymbol(label) {
  const number = Number(String(label ?? "").replace(/^D/, ""));
  return CIRCLED_NUMBERS[number] ?? label ?? "标记";
}

export function createDemoSketch(candidateId = "A", variant = 0) {
  const layouts = [
    {
      name: "A · 主视觉居中",
      recommendation: "标题先建立传播记忆，主视觉集中表现家庭看球和装维服务。",
      main: { x: 70, y: 330, width: 660, height: 500 },
      copy: { x: 70, y: 865, width: 660, height: 170 },
      title: { x: 70, y: 58, width: 660, height: 112 }
    },
    {
      name: "B · 上下分区",
      recommendation: "上部信息更紧凑，下部主视觉更早进入阅读路径。",
      main: { x: 70, y: 315, width: 660, height: 450 },
      copy: { x: 70, y: 835, width: 660, height: 195 },
      title: { x: 70, y: 58, width: 660, height: 112 }
    },
    {
      name: "C · 对角阅读动线",
      recommendation: "通过左上标题、右侧人物和底部服务承诺形成斜向阅读路径。",
      main: { x: 105, y: 330, width: 590, height: 500 },
      copy: { x: 70, y: 865, width: 660, height: 170 },
      title: { x: 70, y: 58, width: 660, height: 112 }
    }
  ];
  const layout = layouts[variant % layouts.length];
  const prefix = `c${candidateId.toLowerCase()}`;
  const main = layout.main;
  const box = (xRatio, yRatio, widthRatio, heightRatio) => ({
    x: Math.round(main.x + main.width * xRatio),
    y: Math.round(main.y + main.height * yRatio),
    width: Math.round(main.width * widthRatio),
    height: Math.round(main.height * heightRatio)
  });
  const family = box(0.05, 0.48, 0.40, 0.3);
  const tv = box(0.06, 0.17, 0.42, 0.28);
  const technician = box(0.61, 0.3, 0.32, 0.52);
  const router = box(0.35, 0.79, 0.28, 0.12);
  const devices = box(0.68, 0.79, 0.25, 0.12);
  const callout = box(0.62, 0.06, 0.31, 0.18);
  const posterCopy = {
    title: "看球不断网，\n精彩不掉线",
    subtitle: "世界杯开赛，家里的网络我来守。",
    benefitLive: "直播不卡顿",
    benefitCast: "投屏更稳定",
    benefitGoal: "进球瞬间不错过",
    callout: "安心看球，\n网络我来管！",
    footerTitle: "网络有问题，随时找我们",
    footerSubtitle: "广州电信装维师傅，您的专属网络管家"
  };
  const sceneDescription = "夜间客厅看世界杯的家庭场景，电视播放足球比赛，蓝色工装电信装维师傅位于右侧，手持平板或检查路由器，前景出现手机、平板和笔记本。";
  const objects = [
    rectangleObject(`${prefix}-background`, "rectangle", 0, 0, 800, 1100, {
      fill: "#ffffff",
      stroke: "#ffffff",
      stroke_width: 0
    }, { z_index: 0, locked: true }),
    textObject(`${prefix}-title`, layout.title.x, layout.title.y, layout.title.width, layout.title.height, posterCopy.title, {
      fill: "#1d1d1f",
      font_size: 46,
      font_weight: 760,
      line_height: 1.08
    }, { text_role: "short_copy", copy_ref: "title", z_index: 4 }),
    textObject(`${prefix}-subtitle`, 72, 188, 650, 36, posterCopy.subtitle, {
      fill: "#667085",
      font_size: 20,
      font_weight: 520
    }, { text_role: "short_copy", copy_ref: "subtitle", z_index: 4 }),
    ...[
      { id: "benefit-live", x: 70, width: 195, text: posterCopy.benefitLive, ref: "benefit_live" },
      { id: "benefit-cast", x: 278, width: 195, text: posterCopy.benefitCast, ref: "benefit_cast" },
      { id: "benefit-goal", x: 486, width: 244, text: posterCopy.benefitGoal, ref: "benefit_goal" }
    ].flatMap((benefit) => [
      rectangleObject(`${prefix}-${benefit.id}-box`, "rounded_rectangle", benefit.x, 242, benefit.width, 44, {
        fill: "#f1f5fa",
        stroke: "#b8c6d8",
        stroke_width: 1.5,
        radius: 22
      }, { z_index: 2, label: `文案按钮：${benefit.text}` }),
      textObject(`${prefix}-${benefit.id}-text`, benefit.x + 10, 253, benefit.width - 20, 24, benefit.text, {
        fill: "#334155",
        font_size: 16,
        font_weight: 650,
        text_align: "center"
      }, { text_role: "short_copy", copy_ref: benefit.ref, z_index: 4 })
    ]),
    imagePlaceholder(`${prefix}-main`, main.x, main.y, main.width, main.height, "主视觉素材", "asset-main-scene", sceneDescription, {
      fill: "#fbfcfe",
      stroke: "#9aa8bb",
      radius: 22
    }, { z_index: 1, asset_role: "composite_scene" }),
    textObject(`${prefix}-main-label`, main.x + 22, main.y + 20, main.width - 44, 52, "主视觉素材\n夜间客厅看世界杯，人物与设备同时出现", {
      fill: "#59677a",
      font_size: 15,
      font_weight: 650,
      line_height: 1.25
    }, { text_role: "asset_summary", summary: sceneDescription, z_index: 4 }),
    imagePlaceholder(`${prefix}-family`, family.x, family.y, family.width, family.height, "素材：家庭看球", "asset-family-viewers", "客厅里一家人围坐看球，人物位于画面左下区域，作为生活氛围和观看需求的来源。", {
      fill: "#f7f8fa",
      stroke: "#c0c9d5",
      radius: 14
    }, { z_index: 2, asset_role: "people" }),
    textObject(`${prefix}-family-label`, family.x + 12, family.y + family.height * .38, family.width - 24, 52, "素材\n一家人围坐看球", {
      fill: "#59677a",
      font_size: 15,
      font_weight: 650,
      text_align: "center",
      line_height: 1.25
    }, { text_role: "asset_label", z_index: 4 }),
    imagePlaceholder(`${prefix}-tv`, tv.x, tv.y, tv.width, tv.height, "素材：足球赛事电视画面", "asset-tv-football", "电视屏幕中播放足球比赛，包含绿茵场、球员、球门和现场灯光，位于主视觉左侧。", {
      fill: "#eef3f9",
      stroke: "#a8b8ca",
      radius: 10
    }, { z_index: 3, asset_role: "screen_content" }),
    textObject(`${prefix}-tv-label`, tv.x + 12, tv.y + tv.height * .36, tv.width - 24, 54, "素材\n电视播放足球比赛", {
      fill: "#4d5f75",
      font_size: 15,
      font_weight: 650,
      text_align: "center",
      line_height: 1.25
    }, { text_role: "asset_label", z_index: 4 }),
    imagePlaceholder(`${prefix}-technician`, technician.x, technician.y, technician.width, technician.height, "素材：电信装维师傅", "asset-technician", "蓝色工装的电信装维师傅，站在主视觉右侧，手持平板或检查网络设备，负责传达服务角色。", {
      fill: "#edf4ff",
      stroke: "#8eabd2",
      radius: 18
    }, { z_index: 3, asset_role: "person" }),
    textObject(`${prefix}-technician-label`, technician.x + 14, technician.y + technician.height * .38, technician.width - 28, 88, "人物素材\n蓝色工装装维师傅\n位于画面右侧，手持平板", {
      fill: "#42648f",
      font_size: 15,
      font_weight: 650,
      text_align: "center",
      line_height: 1.24
    }, { text_role: "asset_label", z_index: 4 }),
    imagePlaceholder(`${prefix}-router`, router.x, router.y, router.width, router.height, "素材：家庭路由器", "asset-home-router", "桌面中央的家庭路由器，使用稳定网络或无线信号作为视觉符号。", {
      fill: "#f1f7f4",
      stroke: "#a8c7b5",
      radius: 12
    }, { z_index: 3, asset_role: "product" }),
    textObject(`${prefix}-router-label`, router.x + 10, router.y + 21, router.width - 20, 28, "产品素材：家庭路由器", {
      fill: "#4b765d",
      font_size: 14,
      font_weight: 650,
      text_align: "center"
    }, { text_role: "asset_label", z_index: 4 }),
    imagePlaceholder(`${prefix}-devices`, devices.x, devices.y, devices.width, devices.height, "素材：终端设备", "asset-connected-devices", "手机、平板、笔记本等终端显示足球内容，分布在主视觉下方或前景。", {
      fill: "#f8f9fb",
      stroke: "#c0c9d5",
      radius: 12
    }, { z_index: 3, asset_role: "supporting_devices" }),
    textObject(`${prefix}-devices-label`, devices.x + 8, devices.y + 20, devices.width - 16, 34, "素材：手机、平板、笔记本", {
      fill: "#59677a",
      font_size: 13,
      font_weight: 650,
      text_align: "center"
    }, { text_role: "asset_label", z_index: 4 }),
    rectangleObject(`${prefix}-callout-box`, "rounded_rectangle", callout.x, callout.y, callout.width, callout.height, {
      fill: "#f4f7fc",
      stroke: "#a8b8cc",
      stroke_width: 1.5,
      radius: 14
    }, { z_index: 3, label: "对白气泡" }),
    textObject(`${prefix}-callout-text`, callout.x + 12, callout.y + 16, callout.width - 24, callout.height - 24, posterCopy.callout, {
      fill: "#2e3f55",
      font_size: 16,
      font_weight: 680,
      text_align: "center",
      line_height: 1.2
    }, { text_role: "short_copy", copy_ref: "callout", z_index: 4 }),
    rectangleObject(`${prefix}-copy`, "rounded_rectangle", layout.copy.x, layout.copy.y, layout.copy.width, layout.copy.height, {
      fill: "#f7f9fc",
      stroke: "#b8c4d3",
      stroke_width: 1.5,
      radius: 18
    }, { z_index: 1, label: "底部服务文案区" }),
    textObject(`${prefix}-copy-title`, layout.copy.x + 24, layout.copy.y + 25, layout.copy.width - 48, 42, posterCopy.footerTitle, {
      fill: "#4f78c9",
      font_size: 28,
      font_weight: 720,
      text_align: "center"
    }, { text_role: "short_copy", copy_ref: "footer_title", z_index: 4 }),
    textObject(`${prefix}-copy-subtitle`, layout.copy.x + 24, layout.copy.y + 80, layout.copy.width - 48, 34, posterCopy.footerSubtitle, {
      fill: "#667085",
      font_size: 16,
      font_weight: 520,
      text_align: "center"
    }, { text_role: "short_copy", copy_ref: "footer_subtitle", z_index: 4 })
  ];
  const technicianAnchor = point(technician.x + technician.width * .86, technician.y + technician.height * .16);
  const tvAnchor = point(tv.x + tv.width * .84, tv.y + tv.height * .16);
  const routerAnchor = point(router.x + router.width * .5, router.y + router.height * .5);
  const document = {
    schema_version: SCHEMA_VERSION,
    candidate_id: candidateId,
    name: layout.name,
    recommendation: layout.recommendation,
    revision: 0,
    status: "complete",
    canvas: { width: 800, height: 1100, unit: "canvas" },
    objects,
    annotations: [
      markerAnnotation(
        `${prefix}-d1`,
        "D1",
        technicianAnchor,
        { kind: "object", object_id: `${prefix}-technician` },
        "蓝色工装电信装维师傅位于主视觉右侧，手持平板或检查网络设备，人物面部和服务身份需要清晰。",
        "asset_detail"
      ),
      markerAnnotation(
        `${prefix}-d2`,
        "D2",
        tvAnchor,
        { kind: "object", object_id: `${prefix}-tv` },
        "电视素材放在主视觉左侧，画面必须明确是足球赛事直播，不能变成抽象色块。",
        "asset_detail"
      ),
      markerAnnotation(
        `${prefix}-d3`,
        "D3",
        routerAnchor,
        { kind: "object", object_id: `${prefix}-router` },
        "路由器位于主视觉下方偏中位置，用稳定网络或无线信号表达服务价值。",
        "asset_detail"
      )
    ]
  };
  return document;
}

export function createDemoSession() {
  const demoArchetypeIds = ["center-hero", "top-bottom", "diagonal-flow"];
  const candidates = ["A", "B", "C"].map((candidateId, index) => {
    const document = createDemoSketch(candidateId, index);
    const archetype = getLayoutArchetype(demoArchetypeIds[index]);
    return {
      candidate_id: candidateId,
      name: archetype ? `${candidateId} · ${archetype.name}` : document.name,
      recommendation: archetype?.description ?? document.recommendation,
      ...(archetype ? {
        archetype_id: archetype.id,
        archetype_name: archetype.name,
        selection_score: 50,
        selection_rationale: "演示会话保留稳定的版式示意，用于说明布局关系。",
        selection_policy: clone(LAYOUT_ARCHETYPE_SELECTION_POLICY),
        catalog_provenance: clone(archetype.provenance),
        difference_axes: archetype.difference_axes,
        schematic: clone(archetype.schematic)
      } : {}),
      status: "complete",
      document,
      initial_document: clone(document),
      modified: false,
      last_saved_revision: document.revision
    };
  });
  return {
    schema_version: "layout-session/4",
    session_id: "demo",
    status: "layout_ready",
    active_candidate_id: "A",
    poster_brief: {
      canvas: { width: 800, height: 1100, aspect_ratio: "8:11" },
      copy: [
        { id: "title", role: "title", text: "看球不断网，精彩不掉线", must_preserve: true },
        { id: "subtitle", role: "subtitle", text: "世界杯开赛，家里的网络我来守。", must_preserve: true },
        { id: "benefit_live", role: "benefit", text: "直播不卡顿", must_preserve: true },
        { id: "benefit_cast", role: "benefit", text: "投屏更稳定", must_preserve: true },
        { id: "benefit_goal", role: "benefit", text: "进球瞬间不错过", must_preserve: true },
        { id: "callout", role: "callout", text: "安心看球，网络我来管！", must_preserve: true },
        { id: "footer_title", role: "footer_title", text: "网络有问题，随时找我们", must_preserve: true },
        { id: "footer_subtitle", role: "footer_subtitle", text: "广州电信装维师傅，您的专属网络管家", must_preserve: true }
      ],
      main_visual: {
        description: "夜间客厅看世界杯的家庭场景，电视播放足球比赛，蓝色工装电信装维师傅位于右侧，手持平板或检查路由器，前景出现手机、平板和笔记本。",
        asset_refs: ["asset-main-scene", "asset-family-viewers", "asset-tv-football", "asset-technician", "asset-home-router", "asset-connected-devices"]
      },
      style: {
        direction: "真实、热闹、有节日氛围的世界杯家庭看球海报",
        palette: "深蓝夜景、足球场绿色、暖黄色灯光和电信蓝色工装",
        lighting: "夜间城市与球场灯光，人物面部清晰，设备有可识别的网络状态光",
        materials: "真实人物、客厅木质家具、电视屏幕、路由器、手机平板和笔记本"
      },
      assets: [
        { id: "asset-main-scene", role: "main_visual", source_ref: "brief-defined-composite-scene", status: "described" },
        { id: "asset-family-viewers", role: "supporting_people", source_ref: "brief-defined-family", status: "described" },
        { id: "asset-tv-football", role: "screen_content", source_ref: "brief-defined-football-screen", status: "described" },
        { id: "asset-technician", role: "person", source_ref: "brief-defined-technician", status: "described" },
        { id: "asset-home-router", role: "product", source_ref: "brief-defined-router", status: "described" },
        { id: "asset-connected-devices", role: "supporting_devices", source_ref: "brief-defined-devices", status: "described" }
      ],
      constraints: {
        must_include: ["完整原始文案", "家庭看球场景", "电信装维师傅", "电视足球赛事画面", "家庭路由器", "联网终端设备"],
        must_not_include: ["序号标记、局部说明文字、辅助占位框"]
      }
    },
    candidates,
    layout_requests: [],
    layout_listener: null,
    user_selected_candidate: null,
    ui_sessions: [],
    confirmation_intents: [],
    confirmation_history: [],
    confirmed: null,
    next_cursor: 0
  };
}

// Production sessions start empty and wait for a validated PosterBrief. The
// football poster remains available only as the explicit `demo` fixture used
// by local smoke tests and backwards-compatible demo URLs.
export function createEmptySession(sessionId = "session") {
  return {
    schema_version: "layout-session/4",
    session_id: sessionId,
    status: "awaiting_brief",
    active_candidate_id: null,
    poster_brief: null,
    candidates: [],
    streams: {},
    layout_requests: [],
    layout_listener: null,
    user_selected_candidate: null,
    ui_sessions: [],
    confirmation_intents: [],
    confirmation_history: [],
    confirmed: null,
    next_cursor: 0
  };
}

export function validateSketchDocument(document) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) return ["document must be an object"];
  if (document.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (typeof document.candidate_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(document.candidate_id)) errors.push("candidate_id is invalid");
  if (!Number.isInteger(document.revision) || document.revision < 0) errors.push("revision must be a non-negative integer");
  if (!document.canvas || !Number.isFinite(document.canvas.width) || !Number.isFinite(document.canvas.height) || document.canvas.width <= 0 || document.canvas.height <= 0) {
    errors.push("canvas width and height must be positive numbers");
  }
  if (!Array.isArray(document.objects)) errors.push("objects must be an array");
  if (!Array.isArray(document.annotations)) errors.push("annotations must be an array");

  const objectIds = new Set();
  for (const [index, object] of (document.objects ?? []).entries()) {
    if (!object || typeof object !== "object") {
      errors.push(`objects[${index}] must be an object`);
      continue;
    }
    if (typeof object.id !== "string" || !object.id) errors.push(`objects[${index}].id is required`);
    else if (objectIds.has(object.id)) errors.push(`duplicate object id: ${object.id}`);
    else objectIds.add(object.id);
    if (!OBJECT_TYPES.has(object.type)) errors.push(`objects[${index}].type is unsupported`);
    for (const field of ["x", "y", "width", "height"]) {
      if (!Number.isFinite(object[field])) errors.push(`objects[${index}].${field} must be a number`);
    }
    if (Number.isFinite(object.width) && object.width <= 0) errors.push(`objects[${index}].width must be positive`);
    if (Number.isFinite(object.height) && object.height <= 0) errors.push(`objects[${index}].height must be positive`);
    if (object.type === "freehand_path" && (!Array.isArray(object.points) || object.points.length < 2)) errors.push(`objects[${index}].points must contain at least two points`);
  }

  const annotationIds = new Set();
  for (const [index, annotation] of (document.annotations ?? []).entries()) {
    if (!annotation || typeof annotation !== "object") {
      errors.push(`annotations[${index}] must be an object`);
      continue;
    }
    if (typeof annotation.id !== "string" || !annotation.id) errors.push(`annotations[${index}].id is required`);
    else if (annotationIds.has(annotation.id)) errors.push(`duplicate annotation id: ${annotation.id}`);
    else annotationIds.add(annotation.id);
    if (!ANNOTATION_TYPES.has(annotation.type)) errors.push(`annotations[${index}].type is unsupported`);
    if (annotation.render_in_final !== false) errors.push(`annotations[${index}].render_in_final must be false`);
    if (!annotation.note || typeof annotation.note !== "string") errors.push(`annotations[${index}].note is required`);
    if (!annotation.start || !Number.isFinite(annotation.start.x) || !Number.isFinite(annotation.start.y)) errors.push(`annotations[${index}].start is invalid`);
    if (!annotation.end || !Number.isFinite(annotation.end.x) || !Number.isFinite(annotation.end.y)) errors.push(`annotations[${index}].end is invalid`);
    const target = annotation.target;
    if (!target || !["object", "region"].includes(target.kind)) errors.push(`annotations[${index}].target is invalid`);
    if (target?.kind === "object" && (!target.object_id || !objectIds.has(target.object_id))) {
      const expectedDeletedTarget = annotation.status === "invalid" && annotation.invalid_reason === "target_deleted";
      if (!expectedDeletedTarget) errors.push(`annotations[${index}] target object is missing`);
    }
  }
  return errors;
}

export function assertValidSketchDocument(document) {
  const errors = validateSketchDocument(document);
  if (errors.length) throw new Error(`invalid SketchDocument: ${errors.join("; ")}`);
  return document;
}

function mergeObject(existing, patch) {
  const next = { ...existing, ...patch, id: existing.id };
  if (patch.style) next.style = { ...(existing.style ?? {}), ...patch.style };
  return next;
}

function pointRelativeToObject(point, object) {
  return {
    x: (point.x - object.x) / Math.max(1, object.width),
    y: (point.y - object.y) / Math.max(1, object.height)
  };
}

function pointFromObjectRatio(ratio, object) {
  return {
    x: object.x + ratio.x * object.width,
    y: object.y + ratio.y * object.height
  };
}

function moveObjectAnnotations(document, previousObject, nextObject) {
  document.annotations = document.annotations.map((annotation) => {
    if (annotation.target?.kind !== "object" || annotation.target.object_id !== previousObject.id) return annotation;
    return {
      ...annotation,
      start: pointFromObjectRatio(pointRelativeToObject(annotation.start, previousObject), nextObject),
      end: pointFromObjectRatio(pointRelativeToObject(annotation.end, previousObject), nextObject)
    };
  });
}

function markInvalidAnnotations(document) {
  const objectIds = new Set(document.objects.map((object) => object.id));
  document.annotations = document.annotations.map((annotation) => {
    if (annotation.target?.kind !== "object") return annotation;
    if (objectIds.has(annotation.target.object_id)) {
      if (annotation.status === "invalid" && annotation.invalid_reason === "target_deleted") {
        return { ...annotation, status: "valid", invalid_reason: null };
      }
      return annotation;
    }
    return { ...annotation, status: "invalid", invalid_reason: "target_deleted" };
  });
}

export function applySketchOperations(document, operations) {
  assertValidSketchDocument(document);
  if (!Array.isArray(operations) || operations.length === 0) throw new Error("operations must be a non-empty array");
  const next = clone(document);
  const objectIds = new Set(next.objects.map((object) => object.id));
  const annotationIds = new Set(next.annotations.map((annotation) => annotation.id));

  for (const [index, operation] of operations.entries()) {
    if (!operation || typeof operation !== "object" || typeof operation.type !== "string") throw new Error(`operation[${index}] is invalid`);
    if (operation.type === "add_object") {
      const object = clone(operation.object);
      if (!object?.id || objectIds.has(object.id)) throw new Error(`operation[${index}] object id already exists`);
      next.objects.push(object);
      objectIds.add(object.id);
    } else if (operation.type === "update_object") {
      const objectIndex = next.objects.findIndex((item) => item.id === operation.object_id);
      if (objectIndex < 0) throw new Error(`operation[${index}] object not found`);
      const previousObject = next.objects[objectIndex];
      const nextObject = mergeObject(previousObject, clone(operation.patch ?? {}));
      next.objects[objectIndex] = nextObject;
      moveObjectAnnotations(next, previousObject, nextObject);
    } else if (operation.type === "delete_object") {
      const objectIndex = next.objects.findIndex((item) => item.id === operation.object_id);
      if (objectIndex < 0) throw new Error(`operation[${index}] object not found`);
      next.objects.splice(objectIndex, 1);
      objectIds.delete(operation.object_id);
    } else if (operation.type === "add_annotation") {
      const annotation = clone(operation.annotation);
      if (!annotation?.id || annotationIds.has(annotation.id)) throw new Error(`operation[${index}] annotation id already exists`);
      next.annotations.push(annotation);
      annotationIds.add(annotation.id);
    } else if (operation.type === "update_annotation") {
      const annotationIndex = next.annotations.findIndex((item) => item.id === operation.annotation_id);
      if (annotationIndex < 0) throw new Error(`operation[${index}] annotation not found`);
      const current = next.annotations[annotationIndex];
      next.annotations[annotationIndex] = { ...current, ...clone(operation.patch ?? {}), id: current.id, render_in_final: false };
    } else if (operation.type === "delete_annotation") {
      const annotationIndex = next.annotations.findIndex((item) => item.id === operation.annotation_id);
      if (annotationIndex < 0) throw new Error(`operation[${index}] annotation not found`);
      next.annotations.splice(annotationIndex, 1);
      annotationIds.delete(operation.annotation_id);
    } else {
      throw new Error(`operation[${index}] type is unsupported: ${operation.type}`);
    }
  }

  markInvalidAnnotations(next);
  next.revision += 1;
  next.status = "editing";
  assertValidSketchDocument(next);
  return next;
}

export function buildDetailConstraints(document) {
  assertValidSketchDocument(document);
  return document.annotations.map((annotation) => ({
    detail_id: annotation.label ?? annotation.id,
    annotation_id: annotation.id,
    target: clone(annotation.target),
    marker: { symbol: markerSymbol(annotation.label), point: clone(annotation.end) },
    anchor: clone(annotation.end),
    instruction: annotation.note,
    category: annotation.category ?? "detail",
    polarity: annotation.polarity ?? "positive",
    status: annotation.status ?? "valid",
    must_not_render: annotation.render_in_final === false
  }));
}

export function findCandidate(session, candidateId) {
  return session.candidates.find((candidate) => candidate.candidate_id === candidateId) ?? null;
}

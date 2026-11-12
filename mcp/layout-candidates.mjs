import { createHash } from "node:crypto";
import {
  applySketchOperations,
  assertValidSketchDocument,
  validateSketchDocument
} from "./sketch-document.mjs";
import { validatePosterBrief } from "./poster-brief.mjs";
import { LAYOUT_ARCHETYPE_SELECTION_POLICY, selectLayoutArchetypes } from "./layout-archetypes.mjs";

const SCHEMA_VERSION = "layout-candidates/1";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function round(value) {
  return Math.round(value);
}

function isPositive(value) {
  return Number.isFinite(value) && value > 0;
}

function parseRatio(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return null;
  return Number(match[1]) / Number(match[2]);
}

function resolveCanvas(canvas) {
  const ratio = parseRatio(canvas.aspect_ratio) ?? 8 / 11;
  let width = isPositive(canvas.width) ? canvas.width : null;
  let height = isPositive(canvas.height) ? canvas.height : null;
  if (!width && !height) width = 800;
  if (!height) height = width / ratio;
  if (!width) width = height * ratio;
  return { width: round(width), height: round(height), unit: "canvas" };
}

function clampBox(x, y, width, height, canvas) {
  const safeWidth = Math.max(1, Math.min(width, canvas.width));
  const safeHeight = Math.max(1, Math.min(height, canvas.height));
  return {
    x: round(Math.max(0, Math.min(x, canvas.width - safeWidth))),
    y: round(Math.max(0, Math.min(y, canvas.height - safeHeight))),
    width: round(safeWidth),
    height: round(safeHeight)
  };
}

function textHeight(text, width, fontSize, maximum) {
  const charactersPerLine = Math.max(4, Math.floor(width / Math.max(fontSize * 0.86, 1)));
  const lines = Math.max(1, Math.ceil(String(text).length / charactersPerLine));
  return Math.min(maximum, Math.max(fontSize * 1.25, lines * fontSize * 1.22));
}

function textObject(id, item, box, { fontSize = 24, align = "left", weight = 560, role = "copy" } = {}) {
  return {
    id,
    type: "text",
    ...box,
    z_index: 4,
    style: {
      fill: "#1d1d1f",
      font_size: fontSize,
      font_weight: weight,
      text_align: align,
      line_height: 1.16
    },
    text: item.text,
    text_role: item.role ?? role,
    copy_ref: item.id ?? id,
    summary: item.text
  };
}

function boxObject(id, type, box, style, extra = {}) {
  return {
    id,
    type,
    ...box,
    z_index: extra.z_index ?? 1,
    style: {
      fill: style.fill ?? "transparent",
      stroke: style.stroke ?? "#8da2bd",
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

function markerAnnotation(id, label, anchor, target, note, category = "detail", polarity = "positive") {
  return {
    id,
    type: "detail_marker",
    label,
    start: clone(anchor),
    end: clone(anchor),
    target,
    note,
    category,
    polarity,
    render_in_final: false,
    status: "valid",
    invalid_reason: null
  };
}

function slug(value, fallback) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function copyRoles(copy) {
  const titleIndex = copy.findIndex((item) => /title|headline|标题/i.test(String(item.role ?? "")));
  const subtitleIndex = copy.findIndex((item, index) => index !== titleIndex && /subtitle|subhead|副标题|说明/i.test(String(item.role ?? "")));
  const footerIndexes = copy.map((item, index) => /footer|cta|action|底部|行动/i.test(String(item.role ?? "")) ? index : -1).filter((index) => index >= 0);
  return {
    titleIndex: titleIndex >= 0 ? titleIndex : 0,
    subtitleIndex,
    footerIndexes,
    remainingIndexes: copy.map((_, index) => index).filter((index) => index !== (titleIndex >= 0 ? titleIndex : 0) && index !== subtitleIndex && !footerIndexes.includes(index))
  };
}

function assetRecords(brief) {
  const assets = Array.isArray(brief.assets) ? brief.assets.filter((asset) => asset && typeof asset.id === "string" && asset.id) : [];
  const assetRefs = Array.isArray(brief.main_visual.asset_refs) ? brief.main_visual.asset_refs : [];
  const mainRef = assetRefs.find((ref) => typeof ref === "string" && ref) ?? assets.find((asset) => asset.role === "main_visual")?.id ?? "asset-main-visual";
  const hasMain = assets.some((asset) => asset.id === mainRef);
  const main = hasMain
    ? assets.find((asset) => asset.id === mainRef)
    : { id: mainRef, role: "main_visual", description: brief.main_visual.description, source_ref: null };
  const rest = assets.filter((asset) => asset.id !== main.id);
  return [main, ...rest];
}

function layoutBox(spec, canvas, fallback) {
  const source = spec && typeof spec === "object" ? spec : fallback;
  return clampBox(
    canvas.width * Number(source?.x ?? fallback.x),
    canvas.height * Number(source?.y ?? fallback.y),
    canvas.width * Number(source?.width ?? fallback.width),
    canvas.height * Number(source?.height ?? fallback.height),
    canvas
  );
}

function placeCopyObjects(brief, canvas, archetype, prefix, heroBox) {
  const copy = brief.copy;
  const roles = copyRoles(copy);
  const objects = [];
  const margin = Math.max(24, round(Math.min(canvas.width, canvas.height) * 0.08));
  const title = copy[roles.titleIndex];
  const geometry = archetype?.geometry ?? {};
  const titleSpec = geometry.title ?? { x: 0.08, y: 0.07, width: 0.84, align: "center" };
  const titleFallback = { x: margin / canvas.width, y: margin / canvas.height, width: 1 - (margin * 2) / canvas.width, height: 0.12 };
  const titleBox = layoutBox(titleSpec, canvas, titleFallback);
  const titleScale = Number(titleSpec.scale) > 0 ? Number(titleSpec.scale) : 1;
  const titleFont = Math.max(22, Math.min(58, round(canvas.width * (title.text.length > 18 ? 0.055 : 0.065) * titleScale)));
  titleBox.height = Math.min(canvas.height * 0.23, Math.max(titleBox.height, textHeight(title.text, titleBox.width, titleFont, canvas.height * 0.23)));
  objects.push(textObject(`${prefix}-copy-${slug(title.id, "title")}`, title, titleBox, { fontSize: titleFont, weight: 760, align: titleSpec.align ?? "center", role: "title" }));

  let subtitleBottom = titleBox.y + titleBox.height;
  if (roles.subtitleIndex >= 0) {
    const subtitle = copy[roles.subtitleIndex];
    const subtitleWidth = Math.max(80, Math.min(canvas.width - margin * 2, titleBox.width));
    const subtitleFont = Math.max(14, Math.min(24, round(canvas.width * 0.027)));
    const subtitleBox = clampBox(titleBox.x, subtitleBottom + 12, subtitleWidth, textHeight(subtitle.text, subtitleWidth, subtitleFont, canvas.height * 0.11), canvas);
    objects.push(textObject(`${prefix}-copy-${slug(subtitle.id, "subtitle")}`, subtitle, subtitleBox, { fontSize: subtitleFont, weight: 520, align: titleSpec.align ?? "center", role: "subtitle" }));
    subtitleBottom = subtitleBox.y + subtitleBox.height;
  }

  const items = roles.remainingIndexes.map((index) => copy[index]);
  const copyMode = geometry.copy_mode ?? "center_stack";
  const gap = 12;
  const itemFont = Math.max(13, Math.min(24, round(canvas.width * (copyMode === "dense_stack" ? 0.022 : 0.024))));
  const addItem = (item, itemIndex, x, y, width, align = "left", maximumHeight = 96) => {
    const safeWidth = Math.max(60, Math.min(canvas.width - margin * 2, round(width)));
    const box = clampBox(x, y, safeWidth, textHeight(item.text, safeWidth, itemFont, maximumHeight), canvas);
    objects.push(textObject(`${prefix}-copy-${slug(item.id, `copy-${itemIndex + 1}`)}`, item, box, { fontSize: itemFont, weight: 600, align, role: "supporting_copy" }));
    return box;
  };

  if (copyMode === "overlay") {
    items.forEach((item, itemIndex) => addItem(item, itemIndex, heroBox.x + margin * 0.7, heroBox.y + heroBox.height - (items.length - itemIndex) * (itemFont * 1.6 + gap), heroBox.width - margin * 1.4, "left", 70));
  } else if (copyMode === "minimal") {
    items.forEach((item, itemIndex) => addItem(item, itemIndex, Math.max(margin, heroBox.x), heroBox.y + heroBox.height + 18 + itemIndex * (itemFont * 1.5 + gap), Math.min(heroBox.width, canvas.width - margin * 2), "center", 58));
  } else if (copyMode === "bottom_stack") {
    const columnWidth = Math.max(90, (canvas.width - margin * 2 - gap) / 2);
    items.forEach((item, itemIndex) => {
      const column = itemIndex % 2;
      const row = Math.floor(itemIndex / 2);
      addItem(item, itemIndex, margin + column * (columnWidth + gap), heroBox.y + heroBox.height + 18 + row * 58, columnWidth, column === 0 ? "left" : "right", 50);
    });
  } else if (copyMode === "top_stack") {
    const columnWidth = Math.max(90, (canvas.width - margin * 2 - gap) / 2);
    items.forEach((item, itemIndex) => {
      const column = itemIndex % 2;
      const row = Math.floor(itemIndex / 2);
      addItem(item, itemIndex, margin + column * (columnWidth + gap), subtitleBottom + 18 + row * 58, columnWidth, column === 0 ? "left" : "right", 50);
    });
  } else if (copyMode === "dense_grid") {
    const columns = Math.min(3, Math.max(1, items.length));
    const itemWidth = Math.max(70, (canvas.width - margin * 2 - gap * (columns - 1)) / columns);
    items.forEach((item, itemIndex) => {
      const column = itemIndex % columns;
      const row = Math.floor(itemIndex / columns);
      addItem(item, itemIndex, margin + column * (itemWidth + gap), Math.max(subtitleBottom + 18, round(canvas.height * 0.21)) + row * 58, itemWidth, "left", 50);
    });
  } else if (copyMode === "right_stack") {
    const columnWidth = Math.max(90, Math.min(canvas.width * 0.3, canvas.width - margin * 2));
    let y = Math.max(subtitleBottom + 24, round(canvas.height * 0.35));
    items.forEach((item, itemIndex) => {
      const box = addItem(item, itemIndex, canvas.width - margin - columnWidth, y, columnWidth, "right");
      y += box.height + gap;
    });
  } else {
    const columns = Math.min(3, Math.max(1, items.length));
    const itemWidth = Math.max(70, (canvas.width - margin * 2 - gap * (columns - 1)) / columns);
    items.forEach((item, itemIndex) => {
      const column = itemIndex % columns;
      const row = Math.floor(itemIndex / columns);
      addItem(item, itemIndex, margin + column * (itemWidth + gap), Math.max(heroBox.y + heroBox.height + 18, round(canvas.height * 0.79) - (Math.ceil(items.length / columns) - row) * 56), itemWidth, "center", 70);
    });
  }

  const footerItems = roles.footerIndexes;
  if (footerItems.length) {
    const footerMargin = Math.max(20, round(canvas.width * 0.06));
    const footerWidth = canvas.width - footerMargin * 2;
    const footerHeight = Math.max(44, Math.min(canvas.height * 0.16, footerItems.reduce((total, index) => total + textHeight(copy[index].text, footerWidth, 18, 90) + 8, 0)));
    let y = canvas.height - footerMargin - footerHeight;
    footerItems.forEach((index) => {
      const item = copy[index];
      const fontSize = Math.max(14, Math.min(24, round(canvas.width * 0.027)));
      const height = textHeight(item.text, footerWidth, fontSize, footerHeight);
      const itemBox = clampBox(footerMargin, y, footerWidth, height, canvas);
      objects.push(textObject(`${prefix}-copy-${slug(item.id, `footer-${index + 1}`)}`, item, itemBox, { fontSize, weight: 700, align: "center", role: "footer" }));
      y += itemBox.height + 8;
    });
  }
  return objects;
}

function placeAssetObjects(brief, canvas, archetype, prefix, heroBox) {
  const assets = assetRecords(brief);
  const [main, ...supporting] = assets;
  const objects = [];
  const assetObjectIds = new Map();
  const mainObjectId = `${prefix}-asset-${slug(main.id, "main-visual")}`;
  const mainDescription = main.description || brief.main_visual.description;
  objects.push(boxObject(mainObjectId, "image_placeholder", heroBox, {
    fill: "#f7f9fc",
    stroke: "#7d93b0",
    stroke_width: 2,
    radius: 16
  }, {
    z_index: 1,
    label: `主视觉 · ${main.role ?? "main_visual"}`,
    asset_ref: main.id,
    asset_role: main.role ?? "main_visual",
    asset_description: mainDescription,
    summary: mainDescription
  }));
  assetObjectIds.set(main.id, mainObjectId);

  const inner = {
    x: heroBox.x + 16,
    y: heroBox.y + 16,
    width: Math.max(40, heroBox.width - 32),
    height: Math.max(40, heroBox.height - 32)
  };
  const assetMode = archetype?.geometry?.asset_mode ?? "balanced";
  const columns = assetMode === "stack"
    ? 1
    : assetMode === "grid"
      ? Math.min(3, Math.max(1, supporting.length))
      : Math.min(3, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, supporting.length)))));
  const rows = Math.max(1, Math.ceil(Math.max(1, supporting.length) / columns));
  const gap = 10;
  const cellWidth = Math.max(30, (inner.width - gap * (columns - 1)) / columns);
  const cellHeight = Math.max(30, Math.min(116, (inner.height - gap * (rows - 1)) / rows));
  supporting.forEach((asset, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const box = clampBox(inner.x + column * (cellWidth + gap), inner.y + inner.height - (rows - row) * (cellHeight + gap) + gap, cellWidth, cellHeight, canvas);
    const objectId = `${prefix}-asset-${slug(asset.id, `support-${index + 1}`)}`;
    const description = asset.description || `${asset.role ?? "supporting_visual"}，服务于主视觉：${brief.main_visual.description}`;
    objects.push(boxObject(objectId, "image_placeholder", box, {
      fill: "#eef3fa",
      stroke: "#a9bad0",
      stroke_width: 1.5,
      radius: 10,
      opacity: 0.96
    }, {
      z_index: 2,
      label: asset.role ?? "supporting_visual",
      asset_ref: asset.id,
      asset_role: asset.role ?? "supporting_visual",
      asset_description: description,
      summary: description
    }));
    assetObjectIds.set(asset.id, objectId);
  });
  return { objects, assetObjectIds, mainObjectId };
}

function placeAnnotations(brief, canvas, prefix, assetObjectIds, allObjectIds, mainObjectId, heroBox) {
  const requirements = Array.isArray(brief.detail_requirements) ? brief.detail_requirements : [];
  return requirements.map((detail, index) => {
    const rawLabel = typeof detail?.id === "string" && /^D\d+$/.test(detail.id) ? detail.id : `D${index + 1}`;
    const targetObjectId = detail?.target_object_id && allObjectIds.has(detail.target_object_id)
      ? detail.target_object_id
      : detail?.asset_ref && assetObjectIds.get(detail.asset_ref)
        ? assetObjectIds.get(detail.asset_ref)
        : mainObjectId;
    const target = { kind: "object", object_id: targetObjectId };
    const ordinal = index + 1;
    const anchor = {
      x: round(heroBox.x + heroBox.width * (0.18 + ((ordinal * 0.19) % 0.62))),
      y: round(heroBox.y + heroBox.height * (0.2 + ((ordinal * 0.23) % 0.56)))
    };
    const note = detail?.instruction ?? detail?.note ?? detail?.description ?? "保持该局部的主体关系和材质清晰。";
    return markerAnnotation(`${prefix}-d${ordinal}`, rawLabel, anchor, target, note, detail?.category ?? "detail", detail?.polarity ?? "positive");
  });
}

function buildCandidate(brief, candidateId, selectedArchetype) {
  const canvas = resolveCanvas(brief.canvas);
  const archetype = selectedArchetype;
  const prefix = `c${candidateId.toLowerCase()}`;
  const margin = Math.max(24, round(Math.min(canvas.width, canvas.height) * 0.08));
  const heroBox = layoutBox(archetype?.geometry?.hero, canvas, { x: margin / canvas.width, y: 0.34, width: 1 - (margin * 2) / canvas.width, height: 0.4 });
  const objects = [boxObject(`${prefix}-background`, "rectangle", { x: 0, y: 0, width: canvas.width, height: canvas.height }, {
    fill: "#ffffff",
    stroke: "#ffffff",
    stroke_width: 0
  }, { z_index: 0, locked: true })];
  objects.push(...placeCopyObjects(brief, canvas, archetype, prefix, heroBox));
  const assetLayout = placeAssetObjects(brief, canvas, archetype, prefix, heroBox);
  objects.push(...assetLayout.objects);
  const annotations = placeAnnotations(brief, canvas, prefix, assetLayout.assetObjectIds, new Set(objects.map((object) => object.id).concat(assetLayout.objects.map((object) => object.id))), assetLayout.mainObjectId, heroBox);
  const seedDocument = {
    schema_version: "sketch-document/1",
    candidate_id: candidateId,
    name: `${candidateId} · ${archetype.name}`,
    recommendation: archetype.description,
    revision: 0,
    status: "waiting",
    canvas,
    objects: [],
    annotations: []
  };
  const groupedOperations = [
    objects.filter((object) => object.id === `${prefix}-background`),
    objects.filter((object) => object.type === "image_placeholder"),
    objects.filter((object) => object.type === "text"),
    objects.filter((object) => object.type !== "text" && object.type !== "image_placeholder" && object.id !== `${prefix}-background`),
    annotations
  ].filter((group) => group.length > 0);
  const operationBatches = [];
  let replayed = seedDocument;
  groupedOperations.forEach((group, index) => {
    const operations = group.map((item) => item.type === "detail_marker" || item.type === "detail_note" || item.type === "detail_arrow"
      ? { type: "add_annotation", annotation: clone(item) }
      : { type: "add_object", object: clone(item) });
    const baseRevision = replayed.revision;
    replayed = applySketchOperations(replayed, operations);
    operationBatches.push({
      batch_seq: index + 1,
      base_revision: baseRevision,
      revision: replayed.revision,
      operations,
      operation_hash: createHash("sha256").update(JSON.stringify(operations)).digest("hex")
    });
  });
  replayed.status = "complete";
  assertValidSketchDocument(replayed);
  const hash = createHash("sha256").update(JSON.stringify(replayed)).digest("hex");
  return {
    candidate_id: candidateId,
    name: `${candidateId} · ${archetype.name}`,
    recommendation: archetype.description,
    archetype_id: archetype.id,
    archetype_name: archetype.name,
    selection_score: archetype.selection_score,
    selection_rationale: archetype.selection_rationale,
    selection_policy: clone(LAYOUT_ARCHETYPE_SELECTION_POLICY),
    catalog_provenance: clone(archetype.provenance),
    difference_axes: archetype.difference_axes,
    schematic: clone(archetype.schematic),
    hash,
    seed_document: seedDocument,
    operation_batches: operationBatches,
    document: replayed,
    completion: { candidate_id: candidateId, revision: replayed.revision, status: "complete" }
  };
}

export function validateCandidateSet(candidates) {
  const errors = [];
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 3) errors.push("candidate set must contain 2 or 3 candidates");
  const ids = new Set();
  const archetypeIds = new Set();
  const geometryFingerprints = new Set();
  for (const [index, candidate] of (candidates ?? []).entries()) {
    if (!candidate || typeof candidate !== "object") {
      errors.push(`candidate[${index}] must be an object`);
      continue;
    }
    if (!candidate.candidate_id || ids.has(candidate.candidate_id)) errors.push(`candidate[${index}] has a duplicate or missing candidate_id`);
    ids.add(candidate.candidate_id);
    if (candidate.archetype_id) {
      if (archetypeIds.has(candidate.archetype_id)) errors.push(`candidate[${index}] has a duplicate archetype_id`);
      archetypeIds.add(candidate.archetype_id);
      if (!candidate.schematic || !Array.isArray(candidate.schematic.elements)) errors.push(`${candidate.candidate_id ?? index}: schematic is required for an archetyped candidate`);
    }
    const documentErrors = validateSketchDocument(candidate.document);
    errors.push(...documentErrors.map((error) => `${candidate.candidate_id ?? index}: ${error}`));
    const main = candidate.document?.objects?.find((object) => object.type === "image_placeholder" && object.asset_role === "main_visual") ?? candidate.document?.objects?.find((object) => object.type === "image_placeholder");
    if (main) geometryFingerprints.add([main.x, main.y, main.width, main.height].join(":"));
  }
  if (archetypeIds.size && archetypeIds.size !== (candidates?.length ?? 0)) errors.push("candidate set must keep one distinct archetype per candidate");
  if ((candidates?.length ?? 0) >= 2 && geometryFingerprints.size < 2) errors.push("candidate set lacks a material main-visual geometry difference");
  return { valid: errors.length === 0, errors };
}

export function buildLayoutCandidates(brief, { candidateCount = 3 } = {}) {
  const report = validatePosterBrief(brief);
  if (!report.can_enter_layout) throw new Error(`PosterBrief must be ready before layout: ${report.status}`);
  if (!Number.isInteger(candidateCount) || candidateCount < 2 || candidateCount > 3) throw new Error("candidateCount must be 2 or 3");
  const selection = selectLayoutArchetypes(report.brief, { candidateCount });
  const candidates = selection.selected.map((archetype, index) => buildCandidate(report.brief, String.fromCharCode(65 + index), archetype));
  const validation = validateCandidateSet(candidates);
  if (!validation.valid) throw new Error(`generated candidate set is invalid: ${validation.errors.join("; ")}`);
  return {
    schema_version: SCHEMA_VERSION,
    brief_schema_version: report.brief.schema_version,
    canvas: resolveCanvas(report.brief.canvas),
    candidate_count: candidates.length,
    archetype_catalog_schema_version: selection.schema_version,
    selection_policy: clone(selection.selection_policy ?? LAYOUT_ARCHETYPE_SELECTION_POLICY),
    selection_signals: selection.signals,
    selection: selection.selected.map((candidate) => ({
      archetype_id: candidate.id,
      archetype_name: candidate.name,
      score: candidate.selection_score,
      rationale: candidate.selection_rationale
    })),
    candidates,
    validation,
    image_model_called: false
  };
}

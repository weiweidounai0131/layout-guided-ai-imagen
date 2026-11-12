const SCHEMA_VERSION = "poster-brief/1";

export const POSTER_BRIEF_SCHEMA_VERSION = SCHEMA_VERSION;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nonEmptyText(value) {
  return typeof value === "string" && value.length > 0;
}

function unique(values) {
  return [...new Set(values)];
}

function ratioValue(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return null;
  return Number(match[1]) / Number(match[2]);
}

function issue(path, message, question = null) {
  return { path, message, question };
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isAvailableAttachmentStatus(status) {
  return ["ready", "readable", "described"].includes(status);
}

export function normalizePosterBrief(input) {
  if (!isObject(input)) return { schema_version: SCHEMA_VERSION, canvas: {}, copy: [], main_visual: {}, style: {}, assets: [], references: {}, constraints: {}, attachments: [], conflicts: [] };
  const brief = clone(input);
  brief.schema_version = SCHEMA_VERSION;
  brief.copy = normalizeArray(brief.copy);
  brief.assets = normalizeArray(brief.assets);
  brief.attachments = normalizeArray(brief.attachments);
  brief.conflicts = normalizeArray(brief.conflicts);
  brief.references = isObject(brief.references) ? brief.references : {};
  brief.constraints = isObject(brief.constraints) ? brief.constraints : {};
  return brief;
}

function collectMissing(brief) {
  const missing = [];
  const canvas = brief.canvas;
  const hasDimensions = isObject(canvas) && Number.isFinite(canvas.width) && Number.isFinite(canvas.height) && canvas.width > 0 && canvas.height > 0;
  const hasRatio = isObject(canvas) && nonEmptyText(canvas.aspect_ratio) && ratioValue(canvas.aspect_ratio) !== null;
  if (!hasDimensions && !hasRatio) missing.push(issue("canvas", "需要画布尺寸（width + height）或比例（aspect_ratio）。", "请提供海报尺寸或比例，例如 800×1100 或 8:11。"));

  if (!brief.copy.length) missing.push(issue("copy", "完整文案不能为空。", "请提供需要逐字保留的完整海报文案。"));
  if (!isObject(brief.main_visual) || !nonEmptyText(brief.main_visual.description)) missing.push(issue("main_visual.description", "主视觉描述不能为空。", "请描述海报要表现的主体和场景。"));
  return missing;
}

function collectCopyIssues(brief) {
  const issues = [];
  const ids = new Set();
  for (const [index, item] of brief.copy.entries()) {
    if (!isObject(item)) {
      issues.push(issue(`copy[${index}]`, "文案项必须是对象。"));
      continue;
    }
    if (!nonEmptyText(item.text)) issues.push(issue(`copy[${index}].text`, "文案文本不能为空。", "请补充这条文案的完整原文。"));
    if (nonEmptyText(item.id)) {
      if (ids.has(item.id)) issues.push(issue(`copy[${index}].id`, `文案 ID 重复：${item.id}。`));
      ids.add(item.id);
    }
  }
  return issues;
}

function collectDuplicateAssetConflicts(brief) {
  const conflicts = [];
  const ids = new Set();
  for (const [index, asset] of brief.assets.entries()) {
    if (!isObject(asset) || !nonEmptyText(asset.id)) continue;
    if (ids.has(asset.id)) conflicts.push({ id: `asset-duplicate-${index}`, type: "duplicate_asset_id", fields: [`assets[${index}].id`], severity: "blocking", status: "unresolved", detail: `素材 ID 重复：${asset.id}。` });
    ids.add(asset.id);
  }
  return conflicts;
}

function collectCanvasConflicts(brief) {
  const canvas = brief.canvas;
  if (!isObject(canvas)) return [];
  if (nonEmptyText(canvas.aspect_ratio) && !ratioValue(canvas.aspect_ratio)) return [{
    id: "invalid-canvas-ratio",
    type: "invalid_canvas_ratio",
    fields: ["canvas.aspect_ratio"],
    severity: "blocking",
    status: "unresolved",
    detail: `画布比例格式无效：${canvas.aspect_ratio}。`
  }];
  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || !ratioValue(canvas.aspect_ratio)) return [];
  const expected = ratioValue(canvas.aspect_ratio);
  const actual = canvas.width / canvas.height;
  if (Math.abs(actual - expected) <= 0.01) return [];
  return [{
    id: "canvas-ratio-mismatch",
    type: "canvas_ratio_mismatch",
    fields: ["canvas.width", "canvas.height", "canvas.aspect_ratio"],
    severity: "blocking",
    status: "unresolved",
    detail: `画布尺寸 ${canvas.width}×${canvas.height} 与比例 ${canvas.aspect_ratio} 不一致。`
  }];
}

function collectAttachmentErrors(brief) {
  const errors = [];
  for (const [index, attachment] of brief.attachments.entries()) {
    if (!isObject(attachment)) {
      errors.push({ path: `attachments[${index}]`, status: "failed", error_type: "invalid_attachment_record" });
      continue;
    }
    const required = attachment.required === true;
    const status = attachment.status ?? (attachment.source_ref ? "pending" : "missing");
    if (required && !isAvailableAttachmentStatus(status)) errors.push({ path: `attachments[${index}]`, id: attachment.id ?? null, status, error_type: attachment.error_type ?? (status === "missing" ? "required_attachment_missing" : "required_attachment_unavailable") });
  }
  for (const [index, asset] of brief.assets.entries()) {
    if (!isObject(asset) || asset.required !== true) continue;
    const status = asset.status ?? (asset.source_ref ? "pending" : "missing");
    if (!isAvailableAttachmentStatus(status)) errors.push({ path: `assets[${index}]`, id: asset.id ?? null, status, error_type: asset.error_type ?? (status === "missing" ? "required_asset_missing" : "required_asset_unavailable") });
  }
  return errors;
}

function normalizeExplicitConflicts(brief) {
  return brief.conflicts
    .filter((conflict) => isObject(conflict) && (conflict.status ?? "unresolved") !== "resolved")
    .map((conflict, index) => ({
      id: conflict.id ?? `conflict-${index + 1}`,
      type: conflict.type ?? "user_declared_conflict",
      fields: normalizeArray(conflict.fields).filter(nonEmptyText),
      severity: conflict.severity === "warning" ? "warning" : "blocking",
      status: conflict.status ?? "unresolved",
      detail: conflict.detail ?? "存在尚未解决的需求冲突。"
    }));
}

export function validatePosterBrief(input) {
  const brief = normalizePosterBrief(input);
  const missing = collectMissing(brief);
  const structureIssues = collectCopyIssues(brief);
  const copyMissing = structureIssues.filter((item) => nonEmptyText(item.question));
  const copyConflicts = structureIssues
    .filter((item) => !nonEmptyText(item.question))
    .map((item, index) => ({
      id: `copy-structure-${index + 1}`,
      type: "copy_structure_conflict",
      fields: [item.path],
      severity: "blocking",
      status: "unresolved",
      detail: item.message
    }));
  const conflicts = [
    ...normalizeExplicitConflicts(brief),
    ...copyConflicts,
    ...collectDuplicateAssetConflicts(brief),
    ...collectCanvasConflicts(brief)
  ];
  const attachmentErrors = collectAttachmentErrors(brief);
  const blockingConflict = conflicts.some((conflict) => conflict.severity === "blocking");
  const blockingStructure = copyMissing.length > 0;
  const status = missing.length || blockingStructure
    ? "needs_input"
    : blockingConflict
      ? "conflict"
      : attachmentErrors.length
        ? "attachment_error"
        : "ready";
  const questions = unique([
    ...missing.map((item) => item.question).filter(nonEmptyText),
    ...copyMissing.map((item) => item.question).filter(nonEmptyText)
  ]);
  return {
    schema_version: "poster-brief-report/1",
    status,
    can_enter_layout: status === "ready",
    brief,
    missing,
    questions,
    structure_issues: [...copyMissing, ...copyConflicts],
    conflicts,
    attachment_errors: attachmentErrors
  };
}

export function assertValidPosterBrief(input) {
  const result = validatePosterBrief(input);
  if (!result.can_enter_layout) throw new Error(`PosterBrief is ${result.status}`);
  return result.brief;
}

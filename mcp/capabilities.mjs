const CAPABILITY_STATES = new Set(["supported", "unsupported", "unknown"]);

function normalizeBoolean(value) {
  return value === true ? true : value === false ? false : null;
}

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : null;
  return {
    name,
    can_generate_image: normalizeBoolean(candidate.can_generate_image),
    accepts_image_input: normalizeBoolean(candidate.accepts_image_input),
    max_image_inputs: Number.isInteger(candidate.max_image_inputs) && candidate.max_image_inputs >= 0 ? candidate.max_image_inputs : null,
    evidence: typeof candidate.evidence === "string" ? candidate.evidence.slice(0, 500) : null
  };
}

export function assessImageCapabilities(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      state: "unknown",
      reason: "宿主没有提供可核对的图像工具能力描述。",
      selected_tool: null,
      candidates: []
    };
  }
  const normalized = candidates.map(normalizeCandidate).filter(Boolean);
  const supported = normalized.find((candidate) => candidate.can_generate_image === true && candidate.accepts_image_input === true);
  if (supported) {
    return {
      state: "supported",
      reason: "至少一个宿主工具明确同时支持图像生成和图像输入。",
      selected_tool: supported.name,
      candidates: normalized
    };
  }
  const allKnownAndBlocked = normalized.length > 0 && normalized.every((candidate) => {
    return candidate.can_generate_image === false || candidate.accepts_image_input === false;
  });
  if (allKnownAndBlocked) {
    return {
      state: "unsupported",
      reason: "已知宿主工具没有同时提供图像生成和图像输入能力。",
      selected_tool: null,
      candidates: normalized
    };
  }
  return {
    state: "unknown",
    reason: "能力描述不完整，不能安全判断视觉框架/参考图输入是否可用。",
    selected_tool: null,
    candidates: normalized
  };
}

export function isCapabilityState(value) {
  return CAPABILITY_STATES.has(value);
}

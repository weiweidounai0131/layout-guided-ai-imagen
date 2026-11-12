const Fabric = window.fabric;
const params = new URLSearchParams(window.location.search);
const apiBase = typeof window.__layoutGuidedApiBase === "string"
  ? window.__layoutGuidedApiBase.replace(/\/$/, "")
  : "";
let sessionId = window.__layoutGuidedSessionId || params.get("session") || "demo";

function servicePath(path) {
  return `${apiBase}${path}`;
}

const hostBridge = (() => {
  const enabled = window.parent !== window;
  let nextRequestId = 0;
  const pendingRequests = new Map();
  let state = enabled ? "initializing" : "unsupported";
  const notify = (method, bridgeParams = {}) => {
    if (!enabled) return false;
    window.parent.postMessage({ jsonrpc: "2.0", method, params: bridgeParams }, "*");
    return true;
  };
  const request = (method, bridgeParams = {}) => {
    if (!enabled) return Promise.reject(new Error("MCP Apps host bridge unavailable"));
    const id = ++nextRequestId;
    const promise = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error("MCP Apps host bridge response timed out"));
      }, 3000);
      pendingRequests.set(id, { resolve, reject, timeout });
    });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params: bridgeParams }, "*");
    return promise;
  };
  const initialize = async () => {
    if (!enabled) return null;
    try {
      const result = await request("ui/initialize", {
        appInfo: { name: "layout-guided-ai-imagen-workbench", version: "0.2.11" },
        appCapabilities: {},
        protocolVersion: "2026-01-26"
      });
      state = "connected";
      notify("ui/notifications/initialized", {});
      return result;
    } catch (error) {
      state = "failed";
      throw error;
    }
  };
  return { enabled, pendingRequests, notify, request, initialize, get state() { return state; } };
})();

window.__layoutGuidedHostBridge = hostBridge;

const elements = {
  status: document.querySelector("#status"),
  conversationHelpButton: document.querySelector("#conversation-help-button"),
  sessionId: document.querySelector("#session-id"),
  candidateState: document.querySelector("#candidate-state"),
  revisionState: document.querySelector("#revision-state"),
  saveState: document.querySelector("#save-state"),
  candidateTitle: document.querySelector("#candidate-title"),
  footerTitle: document.querySelector("#footer-title"),
  confirmationState: document.querySelector("#confirmation-state"),
  confirmedSummary: document.querySelector("#confirmed-summary"),
  confirmedReason: document.querySelector("#confirmed-reason"),
  returnEditButton: document.querySelector("#return-edit-button"),
  candidateList: document.querySelector("#candidate-list"),
  candidateCount: document.querySelector("#candidate-count"),
  briefSummary: document.querySelector("#brief-summary"),
  catalogPolicy: document.querySelector("#catalog-policy"),
  streamState: document.querySelector("#stream-state"),
  exportState: document.querySelector("#export-state"),
  listenerState: document.querySelector("#listener-state"),
  annotationCount: document.querySelector("#annotation-count"),
  annotationList: document.querySelector("#annotation-list"),
  annotationInput: document.querySelector("#annotation-input"),
  annotationButton: document.querySelector("#annotation-button"),
  confirmButton: document.querySelector("#confirm-button"),
  restoreButton: document.querySelector("#restore-button"),
  reloadButton: document.querySelector("#reload-button"),
  layoutChangeInput: document.querySelector("#layout-change-input"),
  layoutChangeButton: document.querySelector("#layout-change-button"),
  layoutChangeState: document.querySelector("#layout-change-state"),
  layoutChangeCancelButton: document.querySelector("#layout-change-cancel-button"),
  layoutChangeCopyButton: document.querySelector("#layout-change-copy-button"),
  layoutChangeForm: document.querySelector("#layout-change-form"),
  feedbackModal: document.querySelector("#feedback-modal"),
  feedbackModalClose: document.querySelector("#feedback-modal-close"),
  feedbackModalAction: document.querySelector("#feedback-modal-action"),
  feedbackModalEyebrow: document.querySelector("#feedback-modal-eyebrow"),
  feedbackModalTitle: document.querySelector("#feedback-modal-title"),
  feedbackModalMessage: document.querySelector("#feedback-modal-message"),
  feedbackModalCountdown: document.querySelector("#feedback-modal-countdown"),
  undoButton: document.querySelector("#undo-button"),
  redoButton: document.querySelector("#redo-button"),
  colorInput: document.querySelector("#color-input"),
  canvasElement: document.querySelector("#sketch-canvas")
};

const DEFAULT_STROKE_WIDTH = 3;

const app = {
  session: null,
  candidate: null,
  document: null,
  canvas: null,
  tool: "select",
  loading: false,
  userStreamId: `user-${crypto.randomUUID()}`,
  userBatchSeq: 0,
  lastCursor: 0,
  eventSource: null,
  pollTimer: null,
  pollInFlight: false,
  reconnectTimer: null,
  listenerPollTimer: null,
  listenerPollInFlight: false,
  objectMap: new Map(),
  annotationObjects: [],
  history: [],
  future: [],
  activeAnnotationId: null,
  hostBridge,
  hostToolOutput: null,
  hostBridgeError: null,
  hostBridgeState: hostBridge.state,
  pendingLayoutRequestId: null,
  lastSubmittedLayoutRequest: null,
  selectionGeneration: 0,
  feedback: {
    timer: null,
    interval: null,
    openedAt: 0,
    previousFocus: null,
    seenEvents: new Set()
  },
  readOnly: false,
  exportStatus: { candidateId: null, revision: null, phase: "unexported" },
  canvasResizeObserver: null,
  ui: {
    sessionId: null,
    privateKey: null,
    uiInstanceId: null,
    challenge: null,
    sessionToken: null,
    selectedCandidateId: null,
    selectedRevision: null,
    bootstrapPromise: null
  },
  hostPresentation: {
    requestModal: typeof window.openai?.requestModal === "function",
    requestDisplayMode: typeof window.openai?.requestDisplayMode === "function"
  }
};
// A read-only inspection handle makes browser evidence able to map marker
// coordinates to the product-owned document without relying on screen guessing.
window.__layoutGuidedApp = app;

function hideFeedbackModal() {
  if (app.feedback.timer) window.clearTimeout(app.feedback.timer);
  if (app.feedback.interval) window.clearInterval(app.feedback.interval);
  app.feedback.timer = null;
  app.feedback.interval = null;
  if (elements.feedbackModal) elements.feedbackModal.hidden = true;
  const previousFocus = app.feedback.previousFocus;
  app.feedback.previousFocus = null;
  if (previousFocus && typeof previousFocus.focus === "function" && document.contains(previousFocus)) previousFocus.focus();
}

function showFeedbackModal({ type = "confirmation", eventKey = null, message = null, durationMs = 10_000 } = {}) {
  if (!elements.feedbackModal) return false;
  if (eventKey && app.feedback.seenEvents.has(eventKey)) return false;
  if (eventKey) {
    app.feedback.seenEvents.add(eventKey);
    if (app.feedback.seenEvents.size > 64) app.feedback.seenEvents.delete(app.feedback.seenEvents.values().next().value);
  }
  hideFeedbackModal();
  app.feedback.previousFocus = document.activeElement;
  const isChange = type === "layout_change";
  elements.feedbackModalEyebrow.textContent = isChange ? "已收到修改" : "已收到确认";
  elements.feedbackModalTitle.textContent = isChange ? "已收到修改，正在回到对话继续处理" : "已收到你的确认，请回到对话查看后续生成";
  elements.feedbackModalMessage.textContent = message || (isChange ? "AI 已成功领取并应用这次布局修改。" : "画板已保存当前确认版本。");
  elements.feedbackModal.hidden = false;
  const deadline = Date.now() + Math.max(1000, Number(durationMs) || 10_000);
  app.feedback.openedAt = Date.now();
  const updateCountdown = () => {
    const remaining = Math.max(0, deadline - Date.now());
    elements.feedbackModalCountdown.textContent = `${Math.ceil(remaining / 1000)} 秒后自动关闭`;
    if (remaining <= 0) hideFeedbackModal();
  };
  updateCountdown();
  app.feedback.interval = window.setInterval(updateCountdown, 250);
  app.feedback.timer = window.setTimeout(hideFeedbackModal, Math.max(1000, Number(durationMs) || 10_000) + 50);
  elements.feedbackModalClose?.focus();
  return true;
}

window.__layoutGuidedFeedback = {
  show: showFeedbackModal,
  hide: hideFeedbackModal,
  isVisible: () => Boolean(elements.feedbackModal && !elements.feedbackModal.hidden)
};

elements.feedbackModalClose?.addEventListener("click", hideFeedbackModal);
elements.feedbackModalAction?.addEventListener("click", hideFeedbackModal);
elements.feedbackModal?.querySelector("[data-feedback-dismiss]")?.addEventListener("click", hideFeedbackModal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && elements.feedbackModal && !elements.feedbackModal.hidden) hideFeedbackModal();
});

window.addEventListener("message", (event) => {
  if (!hostBridge.enabled || event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.id !== undefined && hostBridge.pendingRequests.has(message.id)) {
    const pending = hostBridge.pendingRequests.get(message.id);
    hostBridge.pendingRequests.delete(message.id);
    if (pending.timeout) window.clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(message.error.message || "MCP Apps host request failed"));
    else pending.resolve(message.result);
    return;
  }
  if (message.method === "ui/notifications/tool-input") {
    const nextSessionId = message.params?.arguments?.session_id ?? message.params?.session_id;
    if (typeof nextSessionId === "string" && nextSessionId && nextSessionId !== sessionId) {
      sessionId = nextSessionId;
      window.__layoutGuidedSessionId = sessionId;
      app.ui = { sessionId: null, privateKey: null, uiInstanceId: null, challenge: null, sessionToken: null, selectedCandidateId: null, selectedRevision: null, bootstrapPromise: null };
      if (app.canvas) loadSession().catch((error) => setStatus(error.message, "error"));
    }
  }
  if (message.method === "ui/notifications/tool-result") {
    app.hostToolOutput = message.params ?? null;
    const nextSessionId = message.params?.structuredContent?.session_id;
    if (typeof nextSessionId === "string" && nextSessionId && nextSessionId !== sessionId) {
      sessionId = nextSessionId;
      window.__layoutGuidedSessionId = sessionId;
      app.ui = { sessionId: null, privateKey: null, uiInstanceId: null, challenge: null, sessionToken: null, selectedCandidateId: null, selectedRevision: null, bootstrapPromise: null };
      if (app.canvas) loadSession().catch((error) => setStatus(error.message, "error"));
    }
  }
}, { passive: true });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setStatus(message, tone = "neutral") {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function setChip(element, message, tone = "neutral") {
  element.textContent = message;
  element.dataset.tone = tone;
}

async function requestJson(path, options = {}) {
  const response = await fetch(servicePath(path), { cache: "no-store", credentials: "include", ...options });
  const raw = await response.text();
  let value;
  try { value = JSON.parse(raw); } catch { value = { error: raw || response.statusText }; }
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value;
}

function base64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function uiCanonical(action, candidateId, revision, challenge) {
  return JSON.stringify([sessionId, app.ui.uiInstanceId, action, candidateId, Number(revision), challenge]);
}

async function ensureUiSession() {
  if (app.ui.sessionId === sessionId && app.ui.privateKey && app.ui.uiInstanceId && app.ui.challenge) return app.ui;
  if (app.ui.bootstrapPromise) return app.ui.bootstrapPromise;
  app.ui.bootstrapPromise = (async () => {
    if (!window.crypto?.subtle) throw new Error("当前浏览器不支持 UI 确认所需的安全密钥");
    const keyPair = await window.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"]
    );
    const publicKey = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const result = await requestJson(`/api/session/${encodeURIComponent(sessionId)}/ui/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, public_key_jwk: publicKey })
    });
    app.ui = {
      sessionId,
      privateKey: keyPair.privateKey,
      uiInstanceId: result.ui_instance_id,
      challenge: result.challenge,
      sessionToken: result.ui_session_capability || null,
      selectedCandidateId: null,
      selectedRevision: null,
      bootstrapPromise: null
    };
    return app.ui;
  })();
  try { return await app.ui.bootstrapPromise; }
  finally { if (app.ui.bootstrapPromise) app.ui.bootstrapPromise = null; }
}

async function requestUiAction(path, action, candidateId, revision, extra = {}) {
  const ui = await ensureUiSession();
  const challenge = ui.challenge;
  const payload = new TextEncoder().encode(uiCanonical(action, candidateId, revision, challenge));
  const signature = await window.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ui.privateKey, payload);
  const result = await requestJson(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Layout-UI-Gesture": "pointer",
      ...(ui.sessionToken ? { "X-Layout-UI-Session": ui.sessionToken } : {})
    },
    body: JSON.stringify({
      ...extra,
      session_id: sessionId,
      candidate_id: candidateId,
      revision,
      ui_instance_id: ui.uiInstanceId,
      challenge,
      signature: base64Url(signature)
    })
  });
  if (result.next_challenge) app.ui.challenge = result.next_challenge;
  return result;
}

async function callHostTool(name, argumentsValue) {
  let result;
  if (hostBridge.state === "connected") {
    result = await hostBridge.request("tools/call", { name, arguments: argumentsValue });
  } else if (typeof window.openai?.callTool === "function") {
    result = await window.openai.callTool(name, argumentsValue);
  } else {
    return null;
  }
  if (result?.isError) throw new Error(result.error?.message || "宿主工具调用失败");
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text); } catch { return text; }
  }
  return result;
}

function currentCandidate() {
  return app.session?.candidates.find((candidate) => candidate.candidate_id === app.document?.candidate_id) ?? app.candidate;
}

function currentConfirmation() {
  const confirmation = app.session?.confirmed;
  return confirmation?.confirmed_by === "user_ui" ? confirmation : null;
}

function isReadOnlySession() {
  return Boolean(currentConfirmation());
}

function renderExportState(document, confirmation) {
  if (!elements.exportState) return;
  const currentTarget = { candidateId: document?.candidate_id ?? null, revision: document ? Number(document.revision) : null };
  const targetMatches = app.exportStatus?.candidateId === currentTarget.candidateId
    && Number(app.exportStatus?.revision) === currentTarget.revision;
  if (!targetMatches) app.exportStatus = { ...currentTarget, phase: "unexported" };
  const phase = app.exportStatus.phase;
  if (phase === "saved" && confirmation?.candidate_id === currentTarget.candidateId && Number(confirmation.revision) === currentTarget.revision) {
    setChip(elements.exportState, "双 PNG 已保存", "ok");
  } else if (phase === "exporting") {
    setChip(elements.exportState, "正在导出双 PNG…", "neutral");
  } else if (phase === "error") {
    setChip(elements.exportState, "导出失败，未确认", "error");
  } else {
    setChip(elements.exportState, "双 PNG 未导出", "neutral");
  }
}

function updateEditingControlsDisabled(readOnly) {
  const controls = [
    ...document.querySelectorAll("[data-tool], .color-swatch, #annotation-input, #annotation-button, #restore-button, #layout-change-input, #layout-change-button, #undo-button, #redo-button")
  ];
  for (const control of controls) control.disabled = readOnly;
  updateHistoryControls();
  if (elements.returnEditButton) elements.returnEditButton.disabled = !readOnly;
  if (elements.confirmButton) {
    elements.confirmButton.setAttribute("aria-disabled", String(readOnly));
    elements.confirmButton.title = readOnly ? "此版本已确认；返回编辑后才能重新确认" : "确认当前方案并继续";
  }
  if (readOnly && app.canvas) {
    app.canvas.discardActiveObject();
    app.canvas.selection = false;
    app.canvas.isDrawingMode = false;
    app.canvas.renderAll();
  } else if (app.canvas) {
    app.canvas.selection = true;
  }
}

function updateHistoryControls() {
  const hasHistory = app.history.length > 0;
  const hasFuture = app.future.length > 0;
  if (elements.undoButton) elements.undoButton.disabled = app.readOnly || !hasHistory;
  if (elements.redoButton) elements.redoButton.disabled = app.readOnly || !hasFuture;
}

function currentCanvasViewport() {
  return document.querySelector(".canvas-stage-viewport");
}

function fitCanvasToFrame() {
  if (!app.canvas || !app.document) return;
  const frame = document.querySelector(".canvas-frame");
  const viewport = currentCanvasViewport();
  if (!frame || !viewport || !viewport.clientWidth || !viewport.clientHeight) return;
  const logicalWidth = Number(app.document.canvas.width);
  const logicalHeight = Number(app.document.canvas.height);
  if (!(logicalWidth > 0 && logicalHeight > 0)) return;
  const computedStyle = window.getComputedStyle(viewport);
  const availableWidth = Math.max(1, viewport.clientWidth - parseFloat(computedStyle.paddingLeft || "0") - parseFloat(computedStyle.paddingRight || "0"));
  const availableHeight = Math.max(1, viewport.clientHeight - parseFloat(computedStyle.paddingTop || "0") - parseFloat(computedStyle.paddingBottom || "0"));
  const scale = Math.min(1, availableWidth / logicalWidth, availableHeight / logicalHeight);
  const displayWidth = Math.max(1, Math.round(logicalWidth * scale));
  const displayHeight = Math.max(1, Math.round(logicalHeight * scale));
  // Keep Fabric's backstore at the product-owned canvas dimensions. Only its
  // CSS presentation is fitted only; pointer mapping and PNG export retain the
  // same business coordinate system at every viewport.
  app.canvas.setDimensions({ width: displayWidth, height: displayHeight }, { cssOnly: true });
  frame.style.width = `${displayWidth}px`;
  frame.style.height = `${displayHeight}px`;
  frame.dataset.canvasScale = scale.toFixed(4);
  frame.style.setProperty("--canvas-display-width", `${displayWidth}px`);
  frame.style.setProperty("--canvas-display-height", `${displayHeight}px`);
  app.canvas.calcOffset?.();
  app.canvas.requestRenderAll?.();
}

function ensureCanvasResizeObserver() {
  if (app.canvasResizeObserver || typeof ResizeObserver !== "function") return;
  const viewport = currentCanvasViewport();
  if (!viewport) return;
  app.canvasResizeObserver = new ResizeObserver(() => fitCanvasToFrame());
  app.canvasResizeObserver.observe(viewport);
  window.addEventListener("resize", fitCanvasToFrame, { passive: true });
}

const FALLBACK_ARCHETYPE_SCHEMATICS = {
  "center-hero": { viewBox: "0 0 120 160", elements: [{ type: "rect", x: 20, y: 10, width: 80, height: 5, fill: "#263247", rx: 2 }, { type: "circle", cx: 60, cy: 78, radius: 38, fill: "#dce7f6", stroke: "#5f86c9", strokeWidth: 2 }, { type: "rect", x: 30, y: 132, width: 60, height: 5, fill: "#9aa8bb", rx: 2 }] },
  "top-bottom": { viewBox: "0 0 120 160", elements: [{ type: "rect", x: 12, y: 9, width: 96, height: 25, fill: "#edf2f8", stroke: "#7f93ad", strokeWidth: 1, rx: 3 }, { type: "rect", x: 16, y: 43, width: 88, height: 55, fill: "#dce7f6", stroke: "#5f86c9", strokeWidth: 2, rx: 4 }, { type: "rect", x: 22, y: 122, width: 76, height: 15, fill: "#edf2f8", stroke: "#7f93ad", strokeWidth: 1, rx: 3 }] },
  "diagonal-flow": { viewBox: "0 0 120 160", elements: [{ type: "rect", x: 10, y: 10, width: 48, height: 5, fill: "#263247", rx: 2 }, { type: "line", x1: 16, y1: 40, x2: 103, y2: 118, stroke: "#7f93ad", strokeWidth: 2 }, { type: "rect", x: 34, y: 48, width: 62, height: 50, fill: "#dce7f6", stroke: "#5f86c9", strokeWidth: 2, rx: 4 }, { type: "rect", x: 74, y: 112, width: 35, height: 5, fill: "#5f86c9", rx: 2 }] },
  "split-columns": { viewBox: "0 0 120 160", elements: [{ type: "rect", x: 10, y: 12, width: 40, height: 65, fill: "#edf2f8", stroke: "#7f93ad", strokeWidth: 1, rx: 3 }, { type: "rect", x: 62, y: 25, width: 46, height: 73, fill: "#dce7f6", stroke: "#5f86c9", strokeWidth: 2, rx: 4 }, { type: "line", x1: 56, y1: 8, x2: 56, y2: 116, stroke: "#7f93ad", strokeWidth: 1 }] }
};

function fallbackArchetypeSchematic(candidate) {
  const hint = `${candidate?.archetype_id ?? ""} ${candidate?.name ?? ""}`.toLowerCase();
  const key = Object.keys(FALLBACK_ARCHETYPE_SCHEMATICS).find((id) => hint.includes(id) || (id === "center-hero" && /主视觉居中|中心英雄/.test(hint)) || (id === "top-bottom" && /上下分区/.test(hint)) || (id === "diagonal-flow" && /对角|动线/.test(hint)) || (id === "split-columns" && /分栏|图文/.test(hint))) ?? "center-hero";
  return FALLBACK_ARCHETYPE_SCHEMATICS[key];
}

function drawArchetypeThumbnail(candidate, target) {
  const context = target.getContext("2d");
  const schematic = candidate?.schematic?.viewBox === "0 0 120 160" ? candidate.schematic : fallbackArchetypeSchematic(candidate);
  const scale = Math.min(target.width / 120, target.height / 160);
  const offsetX = (target.width - 120 * scale) / 2;
  const offsetY = (target.height - 160 * scale) / 2;
  context.clearRect(0, 0, target.width, target.height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, target.width, target.height);
  context.save();
  context.translate(offsetX, offsetY);
  context.scale(scale, scale);
  for (const element of schematic.elements ?? []) {
    context.save();
    if (typeof element.transform === "string") {
      const match = element.transform.match(/^rotate\(\s*(-?[\d.]+)(?:\s+([\d.]+)\s+([\d.]+))?\s*\)$/);
      if (match) {
        const angle = Number(match[1]) * Math.PI / 180;
        const cx = Number(match[2] ?? 0);
        const cy = Number(match[3] ?? 0);
        context.translate(cx, cy);
        context.rotate(angle);
        context.translate(-cx, -cy);
      }
    }
    context.fillStyle = element.fill || "transparent";
    context.strokeStyle = element.stroke || "transparent";
    context.lineWidth = Math.max(0.75, Number(element.strokeWidth ?? 1));
    if (element.type === "rect") {
      context.beginPath();
      if (element.rx && context.roundRect) context.roundRect(element.x, element.y, element.width, element.height, element.rx);
      else context.rect(element.x, element.y, element.width, element.height);
      if (element.fill && element.fill !== "none") context.fill();
      if (element.stroke && element.stroke !== "none") context.stroke();
    } else if (element.type === "circle") {
      context.beginPath();
      context.arc(element.cx, element.cy, element.radius, 0, Math.PI * 2);
      if (element.fill && element.fill !== "none") context.fill();
      if (element.stroke && element.stroke !== "none") context.stroke();
    } else if (element.type === "line") {
      context.beginPath();
      context.moveTo(element.x1, element.y1);
      context.lineTo(element.x2, element.y2);
      context.stroke();
    }
    context.restore();
  }
  context.restore();
}

function renderCandidateList() {
  elements.candidateList.replaceChildren();
  const candidates = app.session?.candidates ?? [];
  if (elements.candidateCount) elements.candidateCount.textContent = `${candidates.length} 个候选`;
  for (const candidate of candidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `candidate-card${candidate.candidate_id === app.document?.candidate_id ? " active" : ""}${candidate.candidate_id === app.ui.selectedCandidateId && candidate.document.revision === app.ui.selectedRevision ? " selected" : ""}`;
    button.dataset.candidateId = candidate.candidate_id;
    if (candidate.archetype_id) button.dataset.archetypeId = candidate.archetype_id;
    const thumbnail = document.createElement("canvas");
    thumbnail.className = "candidate-thumb";
    thumbnail.dataset.previewKind = "archetype-schematic";
    thumbnail.width = 104;
    thumbnail.height = 140;
    drawArchetypeThumbnail(candidate, thumbnail);
    const text = document.createElement("span");
    text.innerHTML = `<span class="candidate-name"></span><span class="candidate-meta"></span><span class="candidate-rationale"></span>`;
    const displayName = candidate.archetype_name ? `${candidate.candidate_id} · ${candidate.archetype_name}` : candidate.name;
    text.querySelector(".candidate-name").textContent = displayName;
    const confirmed = currentConfirmation();
    const statusLabel = confirmed?.candidate_id === candidate.candidate_id && Number(confirmed.revision) === Number(candidate.document.revision)
      ? `已确认 · ${confirmed.layout_version || `r${confirmed.revision}`}`
      : candidate.status === "generating"
      ? "生成中"
      : candidate.status === "interrupted"
        ? "流中断"
        : candidate.status === "failed"
          ? "生成失败"
          : candidate.modified
            ? "已修改"
            : "初始版本";
    text.querySelector(".candidate-meta").textContent = statusLabel;
    const rationale = candidate.selection_rationale || candidate.recommendation || "旧会话：使用通用版式示意。";
    text.querySelector(".candidate-rationale").textContent = rationale;
    button.title = rationale;
    button.dataset.selectionMethod = candidate.selection_policy?.execution || "legacy";
    button.dataset.evidenceStatus = candidate.selection_policy?.aesthetic_evidence || "unverified";
    button.setAttribute("aria-label", `${displayName}，${statusLabel}，${rationale}`);
    button.append(thumbnail, text);
    button.addEventListener("click", () => selectCandidate(candidate.candidate_id));
    elements.candidateList.append(button);
  }
}

function renderBrief() {
  const brief = app.session?.poster_brief;
  if (!brief) return;
  elements.briefSummary.textContent = `${brief.canvas.width}×${brief.canvas.height} · ${brief.main_visual.description} · 文案 ${brief.copy.length} 条`;
  if (elements.catalogPolicy) {
    const policy = app.session?.candidates?.find((candidate) => candidate.selection_policy)?.selection_policy;
    elements.catalogPolicy.textContent = policy
      ? `版式目录：本地确定性评分（${policy.execution}）· 未调用图像模型 · 真实模型审美选择：${policy.aesthetic_evidence}`
      : "旧会话：版式元数据缺失，使用通用抽象示意。";
  }
}

function fabricObjectFor(object) {
  const style = object.style ?? {};
  const editable = !object.locked && !app.readOnly;
  const common = {
    left: object.x,
    top: object.y,
    originX: "left",
    originY: "top",
    opacity: style.opacity ?? 1,
    selectable: editable,
    evented: editable,
    data: { object_id: object.id, object_type: object.type, locked: Boolean(object.locked) }
  };
  if (object.type === "text") {
    return new Fabric.Textbox(object.text || object.label || "", {
      ...common,
      width: object.width,
      height: object.height,
      fill: style.fill || "#1d1d1f",
      fontSize: style.font_size || 24,
      fontWeight: style.font_weight || 500,
      textAlign: style.text_align || "left",
      lineHeight: style.line_height || 1.15,
      editable
    });
  }
  if (object.type === "ellipse") {
    return new Fabric.Ellipse({
      ...common,
      rx: object.width / 2,
      ry: object.height / 2,
      fill: style.fill || "transparent",
      stroke: style.stroke || "#7d8da3",
      strokeWidth: style.stroke_width || 0
    });
  }
  if (object.type === "freehand_path") {
    const points = object.points ?? [];
    const minX = points.length ? Math.min(...points.map((point) => point.x)) : object.x;
    const minY = points.length ? Math.min(...points.map((point) => point.y)) : object.y;
    const path = points.length > 1
      ? `M ${points.map((point) => `${point.x - minX} ${point.y - minY}`).join(" L ")}`
      : "M 0 0 L 1 1";
    return new Fabric.Path(path, {
      ...common,
      left: minX,
      top: minY,
      fill: "",
      stroke: style.stroke || "#6e8fc9",
      strokeWidth: style.stroke_width || 2,
      selectable: editable,
      evented: editable
    });
  }
  return new Fabric.Rect({
    ...common,
    width: object.width,
    height: object.height,
    fill: style.fill || "transparent",
    stroke: style.stroke || "#7d8da3",
    strokeWidth: style.stroke_width || 0,
    rx: style.radius || 0,
    ry: style.radius || 0
  });
}

const CIRCLED_NUMBERS = ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

function markerSymbol(annotation) {
  const number = Number(String(annotation.label ?? "").replace(/^D/, ""));
  return CIRCLED_NUMBERS[number] ?? annotation.label ?? "标记";
}

function addAnnotationMarker(annotation) {
  const point = annotation.end;
  const active = app.activeAnnotationId === annotation.id;
  const tone = annotation.status === "invalid" ? "#c45c61" : active ? "#17365f" : "#4f78c9";
  const halo = new Fabric.Circle({
    left: point.x,
    top: point.y,
    originX: "center",
    originY: "center",
    radius: active ? 22 : 18,
    fill: active ? "#e8f0ff" : "#ffffff",
    stroke: tone,
    strokeWidth: active ? 2 : 0,
    selectable: false,
    evented: true,
    excludeFromExport: true,
    data: { annotation_id: annotation.id }
  });
  const label = new Fabric.Text(markerSymbol(annotation), {
    left: point.x,
    top: point.y,
    originX: "center",
    originY: "center",
    fontSize: 29,
    fontWeight: 700,
    fill: tone,
    selectable: false,
    evented: true,
    excludeFromExport: true,
    data: { annotation_id: annotation.id }
  });
  for (const visual of [halo, label]) {
    app.canvas.add(visual);
    app.annotationObjects.push(visual);
  }
}

function renderCanvas() {
  if (!app.canvas || !app.document) return;
  app.readOnly = isReadOnlySession();
  app.loading = true;
  app.objectMap.clear();
  app.annotationObjects = [];
  app.canvas.clear();
  app.canvas.backgroundColor = "#ffffff";
  app.canvas.setDimensions({ width: app.document.canvas.width, height: app.document.canvas.height });
  for (const object of [...app.document.objects].sort((left, right) => left.z_index - right.z_index)) {
    const fabricObject = fabricObjectFor(object);
    app.objectMap.set(object.id, fabricObject);
    app.canvas.add(fabricObject);
  }
  for (const annotation of app.document.annotations) addAnnotationMarker(annotation);
  app.canvas.renderAll();
  app.loading = false;
  app.canvas.selection = !app.readOnly;
  ensureCanvasResizeObserver();
  fitCanvasToFrame();
  updateViewState();
}

function focusAnnotation(annotationId) {
  app.activeAnnotationId = annotationId;
  renderAnnotations();
  renderCanvas();
}

function renderAnnotations() {
  elements.annotationList.replaceChildren();
  const annotations = app.document?.annotations ?? [];
  elements.annotationCount.textContent = `${annotations.length} 条`;
  for (const annotation of annotations) {
    const item = document.createElement("button");
    item.type = "button";
    item.dataset.annotationId = annotation.id;
    item.className = `annotation-item${annotation.status === "invalid" ? " invalid" : ""}${app.activeAnnotationId === annotation.id ? " active" : ""}`;
    item.innerHTML = `<span class="annotation-title"><span></span><span></span></span><p></p><span class="annotation-target"></span>`;
    item.querySelector(".annotation-title span:first-child").textContent = markerSymbol(annotation);
    item.querySelector(".annotation-title span:last-child").textContent = annotation.status === "valid" ? "有效标记" : "标记失效";
    item.querySelector("p").textContent = annotation.note;
    const targetObject = annotation.target.kind === "object"
      ? app.document.objects.find((object) => object.id === annotation.target.object_id)
      : null;
    item.querySelector(".annotation-target").textContent = targetObject
      ? `位置对象：${targetObject.label || targetObject.id}${targetObject.asset_description ? `\n素材说明：${targetObject.asset_description}` : ""}`
      : annotation.target.kind === "object"
        ? `位置对象：${annotation.target.object_id}`
        : `目标区域：${annotation.target.region}`;
    item.addEventListener("click", () => {
      app.activeAnnotationId = annotation.id;
      if (annotation.target.kind === "object") {
        const object = app.objectMap.get(annotation.target.object_id);
        if (object) {
          app.canvas.setActiveObject(object);
          app.canvas.renderAll();
        }
      }
      renderAnnotations();
      renderCanvas();
    });
    elements.annotationList.append(item);
  }
}

function updateViewState() {
  const document = app.document;
  if (!document) {
    app.readOnly = false;
    app.exportStatus = { candidateId: null, revision: null, phase: "unexported" };
    elements.sessionId.textContent = sessionId;
    elements.candidateState.textContent = "—";
    elements.revisionState.textContent = "—";
    elements.candidateTitle.textContent = "等待 PosterBrief";
    setChip(elements.streamState, "等待需求", "neutral");
    setChip(elements.listenerState, "AI 监听未连接", "neutral");
    setChip(elements.exportState, "双 PNG 未导出", "neutral");
    elements.confirmButton.disabled = true;
    elements.footerTitle.textContent = "确认这套构图";
    elements.confirmationState.hidden = true;
    elements.returnEditButton.hidden = true;
    updateEditingControlsDisabled(false);
    elements.layoutChangeButton.disabled = true;
    if (elements.layoutChangeForm) elements.layoutChangeForm.hidden = false;
    renderCandidateList();
    renderAnnotations();
    return;
  }
  const candidate = currentCandidate();
  const confirmation = currentConfirmation();
  const readOnly = Boolean(confirmation);
  app.readOnly = readOnly;
  renderExportState(document, confirmation);
  const listener = app.session?.layout_listener;
  const pendingRequest = app.session?.layout_requests?.find((request) => request.status === "pending");
  app.pendingLayoutRequestId = pendingRequest?.request_id ?? null;
  if (elements.listenerState) {
    if (app.hostBridgeState === "connected") {
      setChip(elements.listenerState, "AI 已连接 · MCP Apps bridge", "ok");
    } else if (listener?.status === "active" && listener.transport === "cli_runner") {
      setChip(elements.listenerState, "AI 已连接 · CLI listener", "ok");
    } else if (listener?.status === "active" && listener.transport === "browser_fallback") {
      setChip(elements.listenerState, "AI 已连接 · 等待操作", "ok");
    } else if (listener?.status === "active") {
      setChip(elements.listenerState, "AI 已连接 · 等待操作", "ok");
    } else if (pendingRequest) {
      setChip(elements.listenerState, "AI 监听已断开，请返回对话继续", "error");
    } else if (app.hostBridgeState === "failed") {
      setChip(elements.listenerState, "MCP Apps bridge 不可用 · 使用浏览器降级", "neutral");
    } else {
      setChip(elements.listenerState, "AI 监听未连接", "neutral");
    }
  }
  elements.sessionId.textContent = sessionId;
  elements.candidateState.textContent = document.candidate_id;
  elements.revisionState.textContent = String(document.revision);
  elements.candidateTitle.textContent = `当前方案 · ${document.candidate_id}${candidate?.selection_policy ? " · 本地评分候选" : ""}`;
  const streamStatus = candidate?.status ?? document.status;
  const streamLabel = readOnly
    ? `已确认只读 · 方案 ${confirmation.candidate_id}`
    : streamStatus === "generating" || document.status === "generating"
    ? "生成中"
    : streamStatus === "interrupted"
      ? "流已中断"
      : streamStatus === "failed"
        ? "生成失败"
        : document.status === "confirmed"
          ? "布局已确认"
          : "操作流可用";
  setChip(elements.streamState, streamLabel, ["failed", "interrupted"].includes(streamStatus) ? "error" : readOnly ? "ok" : "neutral");
  if (elements.saveState) {
    if (readOnly && confirmation.layout_version) elements.saveState.textContent = `已确认 · 方案 ${confirmation.candidate_id} · ${confirmation.layout_version}`;
    else if (Number(document.revision) > 0 && candidate?.last_saved_revision === document.revision) elements.saveState.textContent = `已保存 · r${document.revision}`;
    else if (streamStatus === "generating") elements.saveState.textContent = "生成中 · 尚未保存";
    else elements.saveState.textContent = "未保存";
  }
  if (elements.footerTitle) elements.footerTitle.textContent = readOnly ? "布局已确认" : "确认这套构图";
  if (elements.confirmationState) elements.confirmationState.hidden = !readOnly;
  if (elements.confirmedSummary) elements.confirmedSummary.textContent = readOnly
    ? `已确认 · 方案 ${confirmation.candidate_id} · ${confirmation.layout_version || `r${confirmation.revision}`}`
    : "";
  if (elements.confirmedReason) elements.confirmedReason.textContent = readOnly
    ? "此版本已确认，当前只读。需要调整时点击“返回编辑”；产生新版本后需重新选择并确认。"
    : "";
  if (elements.returnEditButton) elements.returnEditButton.hidden = !readOnly;
  if (elements.layoutChangeForm) elements.layoutChangeForm.hidden = readOnly;
  if (elements.confirmButton) elements.confirmButton.disabled = readOnly || ["generating", "interrupted", "failed"].includes(streamStatus) || document.status === "generating";
  const canvasFrame = elements.canvasElement?.closest(".canvas-frame");
  canvasFrame?.setAttribute("aria-readonly", String(readOnly));
  updateEditingControlsDisabled(readOnly);
  if (elements.layoutChangeCancelButton) elements.layoutChangeCancelButton.hidden = !pendingRequest;
  if (elements.layoutChangeCopyButton) elements.layoutChangeCopyButton.hidden = !pendingRequest || app.hostBridgeState === "connected";
  renderCandidateList();
  renderAnnotations();
}

function objectPatchFromFabric(target, previous) {
  const patch = {
    x: Number(target.left || 0),
    y: Number(target.top || 0),
    width: Math.max(1, Number(target.getScaledWidth?.() ?? target.width ?? previous.width)),
    height: Math.max(1, Number(target.getScaledHeight?.() ?? target.height ?? previous.height)),
    style: {
      ...(previous.style ?? {}),
      fill: typeof target.fill === "string" ? target.fill : previous.style?.fill,
      stroke: typeof target.stroke === "string" ? target.stroke : previous.style?.stroke,
      stroke_width: Number(target.strokeWidth ?? previous.style?.stroke_width ?? 0),
      radius: Number(target.rx ?? previous.style?.radius ?? 0),
      font_size: Number(target.fontSize ?? previous.style?.font_size ?? 0),
      font_weight: target.fontWeight ?? previous.style?.font_weight,
      text_align: target.textAlign ?? previous.style?.text_align
    }
  };
  if (previous.type === "text") patch.text = target.text;
  return patch;
}

function inverseForOperations(operations, document) {
  return [...operations].reverse().map((operation) => {
    if (operation.type === "add_object") return { type: "delete_object", object_id: operation.object.id };
    if (operation.type === "delete_object") {
      const object = document.objects.find((item) => item.id === operation.object_id);
      return { type: "add_object", object: clone(object) };
    }
    if (operation.type === "update_object") {
      const object = document.objects.find((item) => item.id === operation.object_id);
      const patch = {};
      for (const key of Object.keys(operation.patch ?? {})) patch[key] = clone(object[key]);
      return { type: "update_object", object_id: operation.object_id, patch };
    }
    if (operation.type === "add_annotation") return { type: "delete_annotation", annotation_id: operation.annotation.id };
    if (operation.type === "delete_annotation") {
      const annotation = document.annotations.find((item) => item.id === operation.annotation_id);
      return { type: "add_annotation", annotation: clone(annotation) };
    }
    if (operation.type === "update_annotation") {
      const annotation = document.annotations.find((item) => item.id === operation.annotation_id);
      const patch = {};
      for (const key of Object.keys(operation.patch ?? {})) patch[key] = clone(annotation[key]);
      return { type: "update_annotation", annotation_id: operation.annotation_id, patch };
    }
    throw new Error(`unsupported local inverse operation: ${operation.type}`);
  });
}

async function sendOperations(operations, { inverse = null, historyMode = "normal" } = {}) {
  if (!app.document || !operations.length) return;
  if (isReadOnlySession()) {
    setStatus("当前确认版本为只读，请先点击“返回编辑”", "error");
    return;
  }
  const baseRevision = app.document.revision;
  const batchSeq = app.userBatchSeq + 1;
  setChip(elements.streamState, "保存操作中…");
  try {
    const result = await requestJson(`/api/session/${encodeURIComponent(sessionId)}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidate_id: app.document.candidate_id,
        stream_id: app.userStreamId,
        batch_seq: batchSeq,
        base_revision: baseRevision,
        operations
      })
    });
    app.userBatchSeq = batchSeq;
    if (historyMode === "normal" && inverse) {
      app.history.push({ forward: clone(operations), inverse: clone(inverse) });
      app.future = [];
    }
    if (historyMode === "undo" && inverse) app.future.push({ forward: clone(inverse), inverse: clone(operations) });
    if (historyMode === "redo" && inverse) app.history.push({ forward: clone(operations), inverse: clone(inverse) });
    app.document = result.document;
    const candidate = currentCandidate();
    if (candidate) candidate.document = result.document;
    elements.saveState.textContent = `已保存 · r${result.revision}`;
    setStatus(result.idempotent ? "重复操作已幂等处理" : "操作已保存", "ok");
    updateHistoryControls();
    renderCanvas();
  } catch (error) {
    setStatus(error.message, "error");
    setChip(elements.streamState, "保存失败", "error");
    await loadSession({ preserveCandidate: true });
  }
}

async function addObject(object) {
  const inverse = [{ type: "delete_object", object_id: object.id }];
  await sendOperations([{ type: "add_object", object }], { inverse });
}

function makeNewObject(type, x, y) {
  const id = `user-${crypto.randomUUID().slice(0, 8)}`;
  const color = elements.colorInput.value;
  const width = type === "text" ? 300 : 230;
  const height = type === "text" ? 60 : 150;
  const base = {
    id,
    type,
    x: clamp(x - width / 2, 5, app.document.canvas.width - width - 5),
    y: clamp(y - height / 2, 5, app.document.canvas.height - height - 5),
    width,
    height,
    z_index: Math.max(1, ...(app.document.objects.map((object) => object.z_index))) + 1,
    style: {
      fill: type === "text" ? "#1d1d1f" : "rgba(79, 120, 201, 0.12)",
      stroke: color,
      stroke_width: DEFAULT_STROKE_WIDTH,
      radius: type === "rounded_rectangle" ? 18 : 0,
      font_size: 24,
      font_weight: 600,
      text_align: "left",
      line_height: 1.15
    },
    locked: false,
    label: null,
    asset_ref: null,
    copy_ref: null,
    text_role: type === "text" ? "user_note" : null,
    summary: null
  };
  if (type === "text") base.text = "新增文字";
  return base;
}

function pathToPoints(pathObject) {
  const offsetX = Number(pathObject.left || 0);
  const offsetY = Number(pathObject.top || 0);
  const points = [];
  for (const command of pathObject.path ?? []) {
    if (!Array.isArray(command)) continue;
    if (["M", "L"].includes(command[0])) points.push({ x: command[1] + offsetX, y: command[2] + offsetY });
    else if (command[0] === "Q") points.push({ x: command[3] + offsetX, y: command[4] + offsetY });
    else if (command[0] === "C") points.push({ x: command[5] + offsetX, y: command[6] + offsetY });
  }
  return points.length > 1 ? points : [{ x: 20, y: 20 }, { x: 40, y: 40 }];
}

function setupCanvasEvents() {
  app.canvas.on("mouse:down", ({ target }) => {
    const annotationId = target?.data?.annotation_id;
    if (!annotationId) return;
    app.activeAnnotationId = annotationId;
    const annotation = app.document?.annotations?.find((item) => item.id === annotationId);
    if (annotation?.target?.kind === "object") {
      const object = app.objectMap.get(annotation.target.object_id);
      if (object) app.canvas.setActiveObject(object);
    }
    renderAnnotations();
    renderCanvas();
  });

  app.canvas.on("object:modified", async ({ target }) => {
    if (app.loading || app.readOnly || !target?.data?.object_id) return;
    const previous = app.document.objects.find((object) => object.id === target.data.object_id);
    if (!previous || previous.locked) return;
    const patch = objectPatchFromFabric(target, previous);
    const operations = [{ type: "update_object", object_id: previous.id, patch }];
    await sendOperations(operations, { inverse: inverseForOperations(operations, app.document) });
  });

  app.canvas.on("path:created", async ({ path }) => {
    if (app.loading || app.readOnly || app.tool !== "freehand") return;
    path.remove();
    const points = pathToPoints(path);
    const object = {
      id: `user-${crypto.randomUUID().slice(0, 8)}`,
      type: "freehand_path",
      x: 0,
      y: 0,
      width: app.document.canvas.width,
      height: app.document.canvas.height,
      z_index: Math.max(1, ...(app.document.objects.map((item) => item.z_index))) + 1,
      style: { fill: "transparent", stroke: elements.colorInput.value, stroke_width: DEFAULT_STROKE_WIDTH, opacity: 1 },
      points,
      label: "用户手绘路径",
      locked: false
    };
    await addObject(object);
  });

  app.canvas.on("mouse:down", async (event) => {
    if (app.loading || app.readOnly || event.target?.data?.annotation_id) return;
    if (app.tool === "eraser" && event.target?.data?.object_id) {
      await removeSelectedObject(event.target);
      setTool("select");
      return;
    }
    if (app.tool === "select" || app.tool === "freehand" || event.target) return;
    const pointer = app.canvas.getScenePoint ? app.canvas.getScenePoint(event.e) : app.canvas.getPointer(event.e);
    await addObject(makeNewObject(app.tool, pointer.x, pointer.y));
    setTool("select");
  });
}

function setTool(tool) {
  if (app.readOnly && tool !== "select") tool = "select";
  app.tool = tool;
  document.querySelectorAll("[data-tool]").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
  if (!app.canvas) return;
  app.canvas.isDrawingMode = tool === "freehand";
  if (app.canvas.freeDrawingBrush) {
    app.canvas.freeDrawingBrush.color = elements.colorInput.value;
    app.canvas.freeDrawingBrush.width = DEFAULT_STROKE_WIDTH;
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function nextAnnotationLabel() {
  const labels = new Set((app.document.annotations ?? []).map((annotation) => annotation.label));
  let number = 1;
  while (labels.has(`D${number}`)) number += 1;
  return `D${number}`;
}

async function addAnnotation() {
  if (isReadOnlySession()) {
    setStatus("当前确认版本为只读，请先点击“返回编辑”", "error");
    return;
  }
  const note = elements.annotationInput.value.trim();
  if (!note) {
    setStatus("请先填写局部细节说明", "error");
    return;
  }
  const selected = app.canvas.getActiveObject();
  const objectId = selected?.data?.object_id;
  const targetObject = objectId ? app.document.objects.find((object) => object.id === objectId) : null;
  const end = targetObject
    ? { x: targetObject.x + targetObject.width * .62, y: targetObject.y + targetObject.height * .28 }
    : { x: app.document.canvas.width * .52, y: app.document.canvas.height * .46 };
  const start = end;
  const annotation = {
    id: `annotation-${crypto.randomUUID().slice(0, 8)}`,
    type: "detail_marker",
    label: nextAnnotationLabel(),
    start,
    end,
    target: targetObject ? { kind: "object", object_id: targetObject.id } : { kind: "region", region: "user_selected_region" },
    note,
    category: "user_detail",
    polarity: "positive",
    render_in_final: false,
    status: "valid",
    invalid_reason: null
  };
  await sendOperations([{ type: "add_annotation", annotation }], { inverse: [{ type: "delete_annotation", annotation_id: annotation.id }] });
  elements.annotationInput.value = "";
}

async function removeSelectedObject(selected = app.canvas.getActiveObject()) {
  if (isReadOnlySession()) {
    setStatus("当前确认版本为只读，请先点击“返回编辑”", "error");
    return;
  }
  const objectId = selected?.data?.object_id;
  if (!objectId) return;
  const object = app.document.objects.find((item) => item.id === objectId);
  if (!object || object.locked) return;
  await sendOperations([{ type: "delete_object", object_id: object.id }], { inverse: [{ type: "add_object", object: clone(object) }] });
}

async function undo() {
  if (isReadOnlySession()) {
    setStatus("当前确认版本为只读，请先点击“返回编辑”", "error");
    return;
  }
  const entry = app.history.pop();
  if (!entry) return;
  await sendOperations(entry.inverse, { inverse: entry.forward, historyMode: "undo" });
}

async function redo() {
  if (isReadOnlySession()) {
    setStatus("当前确认版本为只读，请先点击“返回编辑”", "error");
    return;
  }
  const entry = app.future.pop();
  if (!entry) return;
  await sendOperations(entry.forward, { inverse: entry.inverse, historyMode: "redo" });
}

function detailConstraints() {
  return (app.document.annotations ?? []).map((annotation) => ({
    detail_id: annotation.label ?? annotation.id,
    annotation_id: annotation.id,
    target: clone(annotation.target),
    marker: { symbol: markerSymbol(annotation), point: clone(annotation.end) },
    anchor: clone(annotation.end),
    instruction: annotation.note,
    category: annotation.category ?? "detail",
    polarity: annotation.polarity ?? "positive",
    status: annotation.status ?? "valid",
    must_not_render: annotation.render_in_final === false
  }));
}

function exportPng(includeAnnotations) {
  const dataUri = app.canvas.toDataURL({
    format: "png",
    multiplier: 1,
    filter: (object) => includeAnnotations || !object.data?.annotation_id
  });
  app.canvas.renderAll();
  return dataUri;
}

async function restoreInitialVersion() {
  if (isReadOnlySession()) {
    setStatus("当前确认版本为只读，请先点击“返回编辑”", "error");
    return;
  }
  if (!app.document || !app.candidate?.initial_document) return;
  const initial = clone(app.candidate.initial_document);
  const operations = [
    ...[...(app.document.annotations ?? [])].reverse().map((annotation) => ({ type: "delete_annotation", annotation_id: annotation.id })),
    ...[...(app.document.objects ?? [])].reverse().map((object) => ({ type: "delete_object", object_id: object.id })),
    ...(initial.objects ?? []).map((object) => ({ type: "add_object", object: clone(object) })),
    ...(initial.annotations ?? []).map((annotation) => ({ type: "add_annotation", annotation: clone(annotation) }))
  ];
  if (!operations.length) return;
  const inverse = inverseForOperations(operations, app.document);
  await sendOperations(operations, { inverse });
  app.activeAnnotationId = null;
  setStatus("已恢复该方案的初始版本", "ok");
}

async function sendLayoutChangeToHost({ requestId, request, candidateId, baseRevision }) {
  const text = [
    "请处理一个待确认的海报布局修改请求。",
    `session_id=${sessionId}`,
    `request_id=${requestId}`,
    `candidate_id=${candidateId}`,
    `base_revision=${baseRevision}`,
    `用户修改要求：${request}`,
    "请只返回结构化 SketchDocument operations，并通过 resolve_layout_change 回写；若不能安全完成，请以 failed 状态回调，不要覆盖当前版本。"
  ].join("\n");
  // `window.parent !== window` only means that the page is framed.  A real
  // MCP Apps bridge exists only after ui/initialize succeeds; ordinary
  // browser fallback must never emit ui/message and assume a host turn.
  if (hostBridge.state === "connected") {
    hostBridge.notify("ui/message", {
      role: "user",
      content: [{ type: "text", text }]
    });
    app.hostBridgeState = "connected";
    return "mcp_apps_bridge";
  }
  if (typeof window.openai?.sendFollowUpMessage === "function") {
    await window.openai.sendFollowUpMessage(text);
    return "window_openai_compatibility";
  }
  return null;
}

async function submitLayoutChange() {
  if (isReadOnlySession()) {
    setStatus("当前确认版本为只读，请先点击“返回编辑”", "error");
    return;
  }
  const request = elements.layoutChangeInput?.value.trim() ?? "";
  if (!request || !app.document) {
    setStatus("请先填写自然语言修改要求", "error");
    return;
  }
  elements.layoutChangeButton.disabled = true;
  if (elements.layoutChangeState) {
    elements.layoutChangeState.textContent = "正在提交…";
    elements.layoutChangeState.dataset.tone = "neutral";
  }
  try {
    const callbackInput = {
      session_id: sessionId,
      candidate_id: app.document.candidate_id,
      base_revision: app.document.revision,
      request
    };
    const result = await callHostTool("submit_layout_change", callbackInput) ?? await requestJson(`/api/session/${encodeURIComponent(sessionId)}/layout-change`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(callbackInput)
    });
    const hostRoute = await sendLayoutChangeToHost({
      requestId: result.request_id,
      request,
      candidateId: app.document.candidate_id,
      baseRevision: app.document.revision
    });
    app.pendingLayoutRequestId = result.request_id;
    app.lastSubmittedLayoutRequest = { ...callbackInput, request_id: result.request_id };
    app.session.layout_requests = app.session.layout_requests ?? [];
    if (!app.session.layout_requests.some((item) => item.request_id === result.request_id)) {
      app.session.layout_requests.push({ request_id: result.request_id, candidate_id: callbackInput.candidate_id, base_revision: callbackInput.base_revision, status: "pending", request_length: request.length, claimed: false });
    }
    if (elements.layoutChangeState) elements.layoutChangeState.textContent = hostRoute
      ? `已提交 ${result.request_id} · 已发送 MCP Apps bridge，等待结构化回调`
      : result.listener_available
        ? `已提交 ${result.request_id} · AI 已连接，等待操作`
        : `已提交 ${result.request_id} · AI 监听已断开，请返回对话继续`;
    setStatus(hostRoute || result.listener_available
      ? "修改请求已提交；当前 AI 回合仍在监听，当前版本保持不变"
      : "修改已保存，可恢复；请返回原对话继续，当前版本保持不变", hostRoute || result.listener_available ? "ok" : "error");
    elements.layoutChangeInput.value = "";
    updateViewState();
  } catch (error) {
    if (elements.layoutChangeState) {
      elements.layoutChangeState.textContent = "提交失败，当前版本已保留";
      elements.layoutChangeState.dataset.tone = "error";
    }
    setStatus(error.message, "error");
  } finally {
    elements.layoutChangeButton.disabled = false;
  }
}

function buildFallbackFollowUpText() {
  const pendingId = app.pendingLayoutRequestId;
  const request = app.lastSubmittedLayoutRequest;
  if (!pendingId || !request) return "";
  return [
    "请继续处理 Layout-Guided AI Imagen 的待处理布局修改。",
    `session_id=${request.session_id}`,
    `request_id=${pendingId}`,
    `candidate_id=${request.candidate_id}`,
    `base_revision=${request.base_revision}`,
    `用户修改要求：${request.request}`,
    "请先调用 wait_for_layout_action 或读取该 request，再读取当前 SketchDocument；完成后使用 resolve_layout_change 回写结构化 operations。若不能安全处理，请回写 failed，不要覆盖当前版本。"
  ].join("\n");
}

async function copyLayoutChangeToConversation() {
  const text = buildFallbackFollowUpText();
  if (!text) return;
  try {
    if (typeof window.openai?.sendFollowUpMessage === "function") {
      await window.openai.sendFollowUpMessage(text);
      if (elements.layoutChangeState) elements.layoutChangeState.textContent = "已发送回原对话，等待 AI 监听";
      setStatus("已发送回原对话；请保持当前任务继续监听", "ok");
      return;
    }
    await navigator.clipboard.writeText(text);
    if (elements.layoutChangeState) elements.layoutChangeState.textContent = "已复制请求，请粘贴回原对话继续";
    setStatus("当前浏览器没有宿主桥接，已复制可恢复请求", "ok");
  } catch (error) {
    setStatus(`复制失败：${error.message}`, "error");
  }
}

async function cancelPendingLayoutChange() {
  if (!app.pendingLayoutRequestId) return;
  try {
    const result = await requestJson(`/api/session/${encodeURIComponent(sessionId)}/layout-change/${encodeURIComponent(app.pendingLayoutRequestId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "user_cancelled" })
    });
    if (elements.layoutChangeState) elements.layoutChangeState.textContent = result.status === "cancelled" ? "已取消，当前版本已保留" : `请求状态：${result.status}`;
    setStatus("已取消布局修改，当前版本已保留", "ok");
    app.pendingLayoutRequestId = null;
    updateViewState();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function returnToEdit() {
  const confirmation = currentConfirmation();
  if (!confirmation) {
    setStatus("当前没有可返回编辑的确认版本", "error");
    return;
  }
  const confirmedCandidate = app.session?.candidates?.find((candidate) => candidate.candidate_id === confirmation.candidate_id);
  if (!confirmedCandidate || Number(confirmedCandidate.document.revision) !== Number(confirmation.revision)) {
    setStatus("确认版本已变更，正在重新读取会话", "error");
    await loadSession({ connect: false });
    return;
  }
  elements.returnEditButton.disabled = true;
  try {
    const result = await requestUiAction(`/api/session/${encodeURIComponent(sessionId)}/ui/return-to-edit`, "return_to_edit", confirmation.candidate_id, confirmation.revision);
    app.ui.selectedCandidateId = null;
    app.ui.selectedRevision = null;
    app.selectionGeneration += 1;
    await loadSession({ connect: false });
    setStatus(`已返回编辑：方案 ${result.candidate_id} · 新版本 r${result.revision}；旧确认仍保留，请重新选择并确认`, "ok");
  } catch (error) {
    setStatus(`返回编辑失败：${error.message}`, "error");
  } finally {
    updateViewState();
  }
}

async function confirmLayout() {
  if (!app.document) return;
  if (isReadOnlySession()) {
    setStatus("当前版本已确认；如需调整请先点击“返回编辑”", "error");
    return;
  }
  const candidate = currentCandidate();
  if (["generating", "interrupted", "failed"].includes(candidate?.status) || app.document.status === "generating") {
    setStatus("操作流尚未完成，暂不能确认", "error");
    return;
  }
  if (app.document.annotations.some((annotation) => annotation.status !== "valid")) {
    setStatus("存在失效局部标记，修复后才能确认", "error");
    return;
  }
  if (app.ui.selectedCandidateId !== app.document.candidate_id || app.ui.selectedRevision !== app.document.revision) {
    setStatus("请先点击选择当前候选方案，再确认布局", "error");
    return;
  }
  elements.confirmButton.disabled = true;
  app.exportStatus = { candidateId: app.document.candidate_id, revision: Number(app.document.revision), phase: "exporting" };
  setChip(elements.exportState, "正在导出双 PNG…");
  try {
    const clean = exportPng(false);
    const annotated = exportPng(true);
    const intent = await requestUiAction(`/api/session/${encodeURIComponent(sessionId)}/ui/confirmation-intent`, "issue_confirmation_intent", app.document.candidate_id, app.document.revision);
    const result = await requestJson(`/api/session/${encodeURIComponent(sessionId)}/confirm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(app.ui.sessionToken ? { "X-Layout-UI-Session": app.ui.sessionToken } : {})
      },
      body: JSON.stringify({
        document: clone(app.document),
        clean_png_data_uri: clean,
        annotated_png_data_uri: annotated,
        detail_constraints: detailConstraints(),
        confirmation_intent: intent.confirmation_intent
      })
    });
    app.session.confirmed = result;
    app.exportStatus.phase = "saved";
    setChip(elements.exportState, "双 PNG 已保存", "ok");
    elements.saveState.textContent = `已确认 · ${result.layout_version}`;
    app.document = { ...app.document, status: "confirmed" };
    const confirmedCandidate = app.session.candidates.find((item) => item.candidate_id === app.document.candidate_id);
    if (confirmedCandidate) {
      confirmedCandidate.document = clone(app.document);
      confirmedCandidate.status = "confirmed";
      confirmedCandidate.last_saved_revision = app.document.revision;
    }
    setStatus("布局已确认，确认材料已保存；本阶段未调用生图模型", "ok");
    if (result.confirmed_by === "user_ui" && result.confirmation_id) {
      showFeedbackModal({ eventKey: `confirmation:${result.confirmation_id}` });
    }
    renderCanvas();
    updateViewState();
  } catch (error) {
    app.exportStatus.phase = "error";
    setChip(elements.exportState, "导出失败，未确认", "error");
    setStatus(error.message, "error");
  } finally {
    updateViewState();
  }
}

async function loadSession({ preserveCandidate = false, connect = true } = {}) {
  const selectionGeneration = app.selectionGeneration;
  const previousCandidateId = preserveCandidate ? app.document?.candidate_id : null;
  const snapshot = await requestJson(`/api/session/${encodeURIComponent(sessionId)}`);
  // A late SSE completion/reload from the previously selected candidate must
  // not win a race with an explicit user switch. Generation streams continue
  // in the background, but their stale page refresh is discarded.
  if (preserveCandidate && selectionGeneration !== app.selectionGeneration) return;
  app.session = snapshot;
  const candidateId = previousCandidateId && snapshot.candidates.some((candidate) => candidate.candidate_id === previousCandidateId)
    ? previousCandidateId
    : snapshot.active_candidate_id;
  const candidate = snapshot.candidates.find((item) => item.candidate_id === candidateId) ?? snapshot.candidates[0];
  app.candidate = candidate;
  app.document = candidate ? clone(candidate.document) : null;
  app.lastCursor = snapshot.event_cursor;
  let uiError = null;
  try {
    await ensureUiSession();
    const selected = snapshot.user_selected_candidate;
    if (selected?.ui_instance_id === app.ui.uiInstanceId) {
      app.ui.selectedCandidateId = selected.candidate_id;
      app.ui.selectedRevision = selected.revision;
    }
  } catch (error) {
    uiError = error;
  }
  if (!app.canvas) {
    app.canvas = new Fabric.Canvas(elements.canvasElement, { preserveObjectStacking: true, selection: true });
    app.canvas.freeDrawingBrush = new Fabric.PencilBrush(app.canvas);
    setupCanvasEvents();
  }
  renderBrief();
  renderCanvas();
  updateViewState();
  if (!preserveCandidate) setStatus(uiError ? "V1.1 轻量画板已加载；确认需在受支持的浏览器 UI 中操作" : "V1.1 轻量画板已加载", uiError ? "error" : "ok");
  if (connect && app.document) openEventStream();
  startListenerStatusPolling();
}

async function pollListenerStatus() {
  if (app.listenerPollInFlight || !app.document) return;
  app.listenerPollInFlight = true;
  try {
    const snapshot = await requestJson(`/api/session/${encodeURIComponent(sessionId)}`);
    app.session = snapshot;
    const current = snapshot.candidates.find((candidate) => candidate.candidate_id === app.document?.candidate_id);
    if (current && Number(current.document.revision) !== Number(app.document.revision)) {
      // Committed operations are still applied through the SSE/cursor path;
      // this metadata poll only catches a listener lease or pending request
      // that changed while no canvas event was emitted.
      app.candidate = current;
    }
    updateViewState();
  } catch { /* the regular SSE/poll path reports transport failures */ }
  finally { app.listenerPollInFlight = false; }
}

function startListenerStatusPolling() {
  if (app.listenerPollTimer) return;
  app.listenerPollTimer = window.setInterval(() => void pollListenerStatus(), 1500);
}

async function consumeEvent(payload) {
  if (!payload || !Number.isFinite(payload.cursor)) return;
  app.lastCursor = Math.max(app.lastCursor, payload.cursor);
  if (payload.candidate_id !== app.document?.candidate_id) return;
  if (["sketch_batch", "sketch_complete", "sketch_interrupted", "sketch_failed", "layout_change_applied", "layout_change_failed", "layout_change_cancelled", "layout_confirmed", "layout_returned_to_edit"].includes(payload.event)) {
    await loadSession({ preserveCandidate: true, connect: false });
  }
  if (payload.event === "sketch_batch") {
    elements.streamState.dataset.batchSeq = String(payload.batch_seq);
    setChip(elements.streamState, "收到已提交操作", "ok");
    setStatus(`已提交第 ${payload.batch_seq} 批操作 · revision ${payload.revision}`, "ok");
  }
  if (payload.event === "sketch_complete") setChip(elements.streamState, "生成完成", "ok");
  if (payload.event === "sketch_interrupted") setChip(elements.streamState, "流已中断，等待续传", "error");
  if (payload.event === "sketch_failed") setChip(elements.streamState, "生成失败，已保留最后版本", "error");
  if (payload.event === "layout_change_applied") {
    if (elements.layoutChangeState) {
      elements.layoutChangeState.textContent = `宿主 AI 已应用 · revision ${payload.revision}`;
      elements.layoutChangeState.dataset.tone = "ok";
    }
    setStatus("宿主 AI 修改已应用，已保留无关布局", "ok");
    showFeedbackModal({
      type: "layout_change",
      eventKey: `layout_change:${payload.request_id || payload.cursor}:${payload.revision || ""}`,
      message: `AI 已成功领取并应用这次布局修改，当前版本为 revision ${payload.revision}。`
    });
  }
  if (payload.event === "layout_change_failed") {
    if (elements.layoutChangeState) {
      elements.layoutChangeState.textContent = "宿主 AI 修改失败，当前版本已保留";
      elements.layoutChangeState.dataset.tone = "error";
    }
    setStatus("宿主 AI 修改失败，当前版本已保留", "error");
  }
  if (payload.event === "layout_change_cancelled") {
    app.pendingLayoutRequestId = null;
    if (elements.layoutChangeState) {
      elements.layoutChangeState.textContent = "已取消，当前版本已保留";
      elements.layoutChangeState.dataset.tone = "neutral";
    }
    setStatus("布局修改已取消，当前版本已保留", "ok");
  }
  if (payload.event === "layout_confirmed") {
    if (elements.layoutChangeState) elements.layoutChangeState.textContent = "布局已确认";
    app.pendingLayoutRequestId = null;
  }
  if (payload.event === "layout_returned_to_edit") {
    app.ui.selectedCandidateId = null;
    app.ui.selectedRevision = null;
    setStatus(`已返回编辑 · 新版本 r${payload.revision}；旧确认仍保留，请重新选择并确认`, "ok");
  }
}

async function pollEvents() {
  if (app.pollInFlight || !app.document) return;
  app.pollInFlight = true;
  try {
    const query = new URLSearchParams({ candidate_id: app.document.candidate_id, after: String(app.lastCursor), format: "poll" });
    const result = await requestJson(`/api/session/${encodeURIComponent(sessionId)}/events?${query}`);
    for (const event of result.events ?? []) await consumeEvent(event);
    app.lastCursor = Math.max(app.lastCursor, Number(result.next_cursor) || 0);
    setChip(elements.streamState, (result.events ?? []).length ? "轮询已同步" : "轮询等待操作", "ok");
  } catch {
    setChip(elements.streamState, "轮询恢复失败", "error");
  } finally {
    app.pollInFlight = false;
  }
}

function startPolling() {
  if (app.pollTimer) return;
  app.eventSource?.close();
  app.eventSource = null;
  setChip(elements.streamState, "流中断，轮询恢复中…", "error");
  void pollEvents();
  app.pollTimer = window.setInterval(() => void pollEvents(), 350);
}

function openEventStream() {
  app.eventSource?.close();
  if (app.pollTimer) {
    window.clearInterval(app.pollTimer);
    app.pollTimer = null;
  }
  if (app.reconnectTimer) {
    window.clearTimeout(app.reconnectTimer);
    app.reconnectTimer = null;
  }
  const query = new URLSearchParams({ candidate_id: app.document.candidate_id, after: String(app.lastCursor) });
  app.eventSource = new EventSource(servicePath(`/api/session/${encodeURIComponent(sessionId)}/events?${query}`));
  for (const eventName of ["sketch_batch", "sketch_complete", "sketch_interrupted", "sketch_failed", "layout_change_applied", "layout_change_failed", "layout_change_cancelled", "layout_confirmed", "layout_returned_to_edit"]) {
    app.eventSource.addEventListener(eventName, (event) => {
      consumeEvent({ ...JSON.parse(event.data), event: eventName }).catch(() => startPolling());
    });
  }
  app.eventSource.onerror = () => {
    setChip(elements.streamState, "流连接重试中…", "error");
    if (!app.reconnectTimer) app.reconnectTimer = window.setTimeout(() => startPolling(), 500);
  };
}

async function selectCandidate(candidateId) {
  if (!app.session) return;
  const candidate = app.session.candidates.find((item) => item.candidate_id === candidateId);
  if (!candidate) return;
  try {
    const selected = await requestUiAction(`/api/session/${encodeURIComponent(sessionId)}/ui/select`, "select_candidate", candidate.candidate_id, candidate.document.revision);
    app.ui.selectedCandidateId = selected.candidate_id;
    app.ui.selectedRevision = selected.revision;
  } catch (error) {
    setStatus(`选择方案失败：${error.message}`, "error");
    return;
  }
  if (candidateId === app.document?.candidate_id) {
    renderCandidateList();
    updateViewState();
    setStatus(`已明确选择方案 ${candidateId}`, "ok");
    return;
  }
  app.selectionGeneration += 1;
  app.candidate = candidate;
  app.document = clone(candidate.document);
  app.lastCursor = app.session.event_cursor;
  app.history = [];
  app.future = [];
  app.userStreamId = `user-${crypto.randomUUID()}`;
  app.userBatchSeq = 0;
  renderCanvas();
  updateViewState();
  openEventStream();
  setStatus(`已切换到方案 ${candidateId}`, "ok");
}

document.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
elements.colorInput.addEventListener("input", () => setTool(app.tool));
document.querySelectorAll(".color-swatch").forEach((button) => button.addEventListener("click", () => {
  if (button.classList.contains("rainbow")) {
    elements.colorInput.click();
    return;
  }
  elements.colorInput.value = button.dataset.color;
  document.querySelectorAll(".color-swatch").forEach((swatch) => swatch.classList.toggle("selected", swatch === button));
  setTool(app.tool);
}));
document.querySelectorAll(".color-swatch:not(.rainbow)").forEach((button) => {
  button.style.backgroundColor = button.dataset.color;
});
elements.colorInput.addEventListener("change", () => {
  document.querySelectorAll(".color-swatch").forEach((swatch) => swatch.classList.toggle("selected", swatch.dataset.color === elements.colorInput.value));
});
elements.annotationButton.addEventListener("click", addAnnotation);
elements.confirmButton.addEventListener("click", confirmLayout);
elements.returnEditButton?.addEventListener("click", () => returnToEdit());
elements.layoutChangeCancelButton?.addEventListener("click", () => cancelPendingLayoutChange());
elements.layoutChangeCopyButton?.addEventListener("click", () => copyLayoutChangeToConversation());
elements.restoreButton.addEventListener("click", () => restoreInitialVersion().catch((error) => setStatus(error.message, "error")));
elements.layoutChangeButton.addEventListener("click", submitLayoutChange);
elements.layoutChangeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submitLayoutChange();
});
elements.reloadButton.addEventListener("click", () => loadSession().catch((error) => setStatus(error.message, "error")));
elements.undoButton.addEventListener("click", undo);
elements.redoButton.addEventListener("click", redo);
elements.conversationHelpButton.addEventListener("click", () => {
  // This is a guidance affordance, not a close transport. The current host
  // does not expose a documented panel-dismiss API, and the feedback prompt
  // remains under its own 10-second/explicit close controls.
  setStatus(elements.feedbackModal && !elements.feedbackModal.hidden
    ? "请回到原对话；提示可用“关闭提示”关闭，10 秒后自动关闭"
    : "请回到原对话；画板和确认材料仍保留", "neutral");
});

function isTextEntryTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

document.addEventListener("keydown", (event) => {
  if (isTextEntryTarget(event.target)) return;
  if (event.key === "Delete" || event.key === "Backspace") removeSelectedObject();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
  }
});

if (!Fabric?.Canvas) {
  setStatus("Fabric.js 资源加载失败", "error");
} else {
  void hostBridge.initialize().then(() => {
    app.hostBridgeState = hostBridge.state;
    updateViewState();
  }).catch((error) => {
    app.hostBridgeError = error.message;
    app.hostBridgeState = hostBridge.state;
    updateViewState();
  });
  loadSession().catch((error) => setStatus(error.message, "error"));
}

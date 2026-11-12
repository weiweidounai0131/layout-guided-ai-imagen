import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;

function canonical(sessionId, uiInstanceId, action, candidateId, revision, challenge) {
  return JSON.stringify([sessionId, uiInstanceId, action, candidateId, Number(revision), challenge]);
}

function parseResponseCookie(response) {
  const value = response.headers.get("set-cookie") || "";
  const match = value.match(/(?:^|,?\s*)layout_ui_session_[A-Za-z0-9_-]+=([^;]+)/);
  if (!match) throw new Error("UI bootstrap did not return an HttpOnly session cookie");
  return match[1];
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function readJson(response) {
  const value = await response.json();
  return { response, value };
}

export async function createUiSession(service, sessionId) {
  const keyPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKeyJwk = await subtle.exportKey("jwk", keyPair.publicKey);
  const response = await fetch(`${service.url}/api/session/${sessionId}/ui/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    body: JSON.stringify({ session_id: sessionId, public_key_jwk: publicKeyJwk })
  });
  const { value } = await readJson(response);
  if (!response.ok) throw new Error(value.error || "UI bootstrap failed");
  return { service, sessionId, keyPair, cookie: parseResponseCookie(response), ...value };
}

export async function uiAction(ui, action, candidateId, revision, path, extra = {}) {
  const payload = new TextEncoder().encode(canonical(ui.sessionId, ui.ui_instance_id, action, candidateId, revision, ui.challenge));
  const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ui.keyPair.privateKey, payload);
  const response = await fetch(`${ui.service.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `layout_ui_session_${ui.sessionId}=${ui.cookie}`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "x-layout-ui-gesture": "pointer"
    },
    body: JSON.stringify({
      ...extra,
      session_id: ui.sessionId,
      candidate_id: candidateId,
      revision,
      ui_instance_id: ui.ui_instance_id,
      challenge: ui.challenge,
      signature: base64Url(signature)
    })
  });
  const { value } = await readJson(response);
  if (response.ok && value.next_challenge) ui.challenge = value.next_challenge;
  return { response, value };
}

export async function selectCandidate(ui, candidateId, revision) {
  return uiAction(ui, "select_candidate", candidateId, revision, `/api/session/${ui.sessionId}/ui/select`);
}

export async function issueIntent(ui, candidateId, revision) {
  return uiAction(ui, "issue_confirmation_intent", candidateId, revision, `/api/session/${ui.sessionId}/ui/confirmation-intent`);
}

export async function returnToEdit(ui, candidateId, revision) {
  return uiAction(ui, "return_to_edit", candidateId, revision, `/api/session/${ui.sessionId}/ui/return-to-edit`);
}

export async function confirmWithUi(ui, { document, clean_png_data_uri, annotated_png_data_uri, detail_constraints }) {
  const selected = await selectCandidate(ui, document.candidate_id, document.revision);
  if (!selected.response.ok) return selected;
  const intent = await issueIntent(ui, document.candidate_id, document.revision);
  if (!intent.response.ok) return intent;
  const response = await fetch(`${ui.service.url}/api/session/${ui.sessionId}/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `layout_ui_session_${ui.sessionId}=${ui.cookie}`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty"
    },
    body: JSON.stringify({ document, clean_png_data_uri, annotated_png_data_uri, detail_constraints, confirmation_intent: intent.value.confirmation_intent })
  });
  return readJson(response);
}

# V1.1 canvas-to-session protocol

V1.1 no longer treats a notification or a request queue as the primary drawing loop. The local canvas and MCP tools share the same session API. AI and user changes are committed as structured operation batches and delivered to the canvas through SSE.

## Local HTTP contract

```text
POST /api/session
body: { "session_id"?: string }
result: { "created": boolean, ...session snapshot }

GET /api/session/:session_id/confirmed
result: confirmation metadata and local file availability; no PNG bytes

POST /api/session/:session_id/begin
body: { "candidate_id": string, "stream_id": string }

POST /api/session/:session_id/ops
body: {
  "candidate_id": string,
  "stream_id": string,
  "batch_seq": integer,
  "base_revision": integer,
  "operations": object[]
}

POST /api/session/:session_id/complete
body: { "candidate_id": string, "stream_id": string }

GET /api/session/:session_id/events?candidate_id=A&after=0
result: text/event-stream with integer cursors

PUT /api/session/:session_id/sketch
body: { "document": SketchDocument }

POST /api/session/:session_id/layout-change
body: { "candidate_id"?: string, "base_revision"?: integer, "request": string }
result: pending request ID plus sanitized listener availability; request text is persisted only in a private, short-lived session request record so a waiting model can recover it after a process restart

POST /api/session/:session_id/layout-listener/claim
body: { "listener_id"?: string, "transport": "browser_fallback" | "mcp_apps_bridge" | "cli_runner", "lease_ms"?: integer, "after_cursor"?: integer }
result: a renewable listener lease and opaque token; one active lease is allowed per session

POST /api/session/:session_id/layout-listener/heartbeat
body: { "listener_id": string, "lease_token": string, "cursor"?: integer }
result: renewed lease and pending request summaries

POST /api/session/:session_id/layout-listener/wait
body: { "listener_id": string, "lease_token": string, "after_cursor"?: integer, "timeout_ms"?: integer, "event_types"?: string[] }
result: one finite event (`layout_change`, `confirm`, `cancel`, or `layout_change_result`) or a timeout heartbeat; maximum wait is 30 seconds

POST /api/session/:session_id/layout-listener/release
body: { "listener_id": string, "lease_token": string }
result: released lease; pending requests remain reclaimable

POST /api/session/:session_id/layout-change/:request_id/result
body: { "status": "applied" | "failed", "operations"?: object[], "stream_id"?: string, "error_category"?: string }
result: applied revision or failed status; only an explicit host callback may supply structured operations

POST /api/session/:session_id/layout-change/:request_id/cancel
body: { "reason"?: string }
result: cancelled status; the cancellation is a cursor event that wakes a waiting listener

POST /api/session/:session_id/layout-candidates
body: { "brief": PosterBrief, "candidate_count"?: 2 | 3, "auto_start"?: boolean,
        "batch_delay_ms"?: integer, "include_plans"?: boolean }
result: one session with independent A/B/C seed documents and stored operation streams

POST /api/session/:session_id/generation/interrupt
body: { "candidate_id": string, "stream_id": string }

POST /api/session/:session_id/generation/resume
body: { "candidate_id": string, "stream_id": string, "batch_delay_ms"?: integer }

POST /api/session/:session_id/confirm
body: { "document": SketchDocument, "clean_png_data_uri": string,
        "annotated_png_data_uri": string, "detail_constraints"?: object[],
        "confirmation_intent": string }

POST /api/session/:session_id/ui/bootstrap
body: { "public_key_jwk": P-256 public key }
result: browser-bound UI instance and challenge; the raw session cookie is HttpOnly

POST /api/session/:session_id/ui/select
body: { "candidate_id": string, "revision": integer, "ui_instance_id": string,
        "challenge": string, "signature": base64url string }
result: `user_selected_candidate` record and next challenge; requires browser
Fetch Metadata and an explicit pointer gesture

POST /api/session/:session_id/ui/confirmation-intent
body: { "candidate_id": string, "revision": integer, "ui_instance_id": string,
        "challenge": string, "signature": base64url string }
result: one-time short-lived intent; it is the only input accepted by `/confirm`

POST /api/session/:session_id/ui/return-to-edit
body: { "candidate_id": string, "revision": integer, "ui_instance_id": string,
        "challenge": string, "signature": base64url string }
result: creates the next editable revision for the currently confirmed candidate,
        clears the current confirmation/selection/issued intent, and keeps the
        previous confirmation files plus a local history record. The new revision
        still requires a fresh candidate selection and explicit confirmation.

GET /api/session/:session_id/ui/confirmation-status
result: sanitized confirmation/selection/intent status, never raw tokens

POST /api/session/:session_id/generation/preflight
body: {}
result: `{ "allow": false, "reason": string }` until a persisted `user_ui`
confirmation and all matching exports pass hash/identity checks

The formal `build_generation_request_preview` MCP route accepts only
`session_id`; it loads the persisted confirmation, maps session-relative export
paths to absolute local refs, and exposes the generation request's
`hard_constraints`, `soft_layout_guidance`, and `creative_freedom` layers.
```

The authoritative operation envelope and failure rules live in [operation-protocol.md](../contracts/operation-protocol.md). The UI applies only committed operations; it does not simulate or replay an AI drawing after completion.

## Bundled CLI fallback

When a host injects the workflow Skill but does not expose the plugin MCP tools
to the model turn, the official fallback is the bundled
`scripts/layout-guided-ai-imagen.mjs` runner. It is intentionally a small
HTTP client, not a second MCP implementation and not an instruction to search
the user's plugin cache or write a temporary JSON-RPC client.

```text
node scripts/layout-guided-ai-imagen.mjs prepare --session <id> --brief-file <poster-brief.json> [--candidate-count 3]
node scripts/layout-guided-ai-imagen.mjs prepare --session <id> --demo
node scripts/layout-guided-ai-imagen.mjs start --session <id>
node scripts/layout-guided-ai-imagen.mjs claim --session <id>
node scripts/layout-guided-ai-imagen.mjs wait --state-file <listener_state_file> --timeout-ms 30000
node scripts/layout-guided-ai-imagen.mjs document --session <id> --candidate-id A
node scripts/layout-guided-ai-imagen.mjs heartbeat --state-file <listener_state_file>
node scripts/layout-guided-ai-imagen.mjs resolve --state-file <listener_state_file> --status applied --operations-file <ops.json>
node scripts/layout-guided-ai-imagen.mjs cancel --state-file <listener_state_file> --request-id <id>
node scripts/layout-guided-ai-imagen.mjs release --state-file <listener_state_file>
node scripts/layout-guided-ai-imagen.mjs confirmation-status --session <id>
node scripts/layout-guided-ai-imagen.mjs generation-preflight --session <id>
```

For `wait`, `heartbeat`, `resolve`, `cancel`, and `release`, `--session` and
`--data-root` are optional when `--state-file` points to a runner-created 0600
state file: the runner derives both values from that file. An explicitly
provided session/data-root that conflicts with the state file is rejected. The
lease token remains private and is never printed. A correct token may release
an expired lease, and repeated release is terminal/idempotent; a newer listener
with a different lease still rejects the old token.

`prepare`/`start` writes/uses one mode-0600
`<data-root>/.layout-guided-service.json` discovery record and prints the
service/browser URL and session ID. The runner reuses a healthy service
started by MCP or starts the bundled detached `mcp/service-daemon.mjs`; the
browser therefore reads and writes the same session and event journal. `claim`
writes the opaque lease token to a mode-0600 listener state file and does not
print the token. `wait` is bounded to 30 seconds, returns a structured action
or heartbeat timeout, and stores the cursor for the next call. Only the
claiming listener receives the full request text; status, discovery, and
journals contain request hash/length/status only. A new claim can reclaim a
pending request after the old lease expires or is released. `resolve`,
`cancel`, and `release` are idempotent and preserve the last valid document on
failure. The CLI has no confirmation command and cannot mint a UI session,
signature, or confirmation intent; confirmation must come from an open
workbench click path.

`prepare --brief-file` is the public PosterBrief entry point: it validates the
JSON through the service, seeds A/B/C in the same session, waits for committed
candidate batches, and returns candidate metadata plus the next listener step.
The same validated brief is idempotent; a different brief is rejected without
overwriting candidates. New non-demo sessions are `awaiting_brief`; football
content is only the explicit `--demo` fixture.

## MCP tools

- `create_session` creates a local session without overwriting an existing ID.
- `get_session_status` reads the session snapshot and sanitized pending layout requests.
- `validate_poster_brief` is the pre-layout gate; `build_layout_candidates` consumes only a `ready` brief and returns 2–3 structured candidates plus ordered operation plans.
- `begin_sketch` starts a candidate stream.
- `apply_sketch_ops` commits an atomic batch and returns its revision/cursor.
- `complete_sketch` marks the stream complete.
- `save_sketch_version` persists the candidate's current revision.
- `submit_layout_change` records a pending natural-language change and stores its original text only in the private request record described below; session snapshots and operation journals keep hash/length/status only.
- `claim_layout_listener` / `heartbeat_layout_listener` / `wait_for_layout_action` / `release_layout_listener` implement the browser-fallback active-turn protocol. Each wait is finite, renews a lease on timeout, and returns a durable event cursor for reconnection. The same HTTP contract accepts the bundled CLI's `cli_runner` transport.
- `resolve_layout_change` accepts only an explicit host callback result or a listener-owned structured result; a failed callback leaves the last document and revision intact.
- `cancel_layout_change` marks a pending request cancelled without changing the document.
- `confirm_layout` consumes a one-time intent minted by an explicit browser/MCP
  Apps workbench click. Direct MCP calls, HTTP/curl, CLI, and caller-supplied
  `confirmed_by` values fail closed.
- `get_confirmed_inputs` reads confirmed export metadata and availability.
- `generation_preflight` verifies only the persisted `user_ui` confirmation and
  matching local files; `build_generation_request_preview` uses that same
  persisted record and never accepts a caller-constructed confirmation object.
- The visual framework is broad structure guidance, not a pixel/style replica.
  The generated prompt preserves dimensions, exact copy, explicit keep/avoid,
  and user locks as hard constraints; treats regions, hierarchy, subject share,
  reading path, and whitespace as soft guidance; and leaves typography, title
  packaging, materials, decoration, lighting, and image-wide integration to
  creative freedom unless explicitly locked. “秋季新品发布会” remains verbatim
  but may receive an expressive title treatment instead of copying canvas font
  styling. Plain programmatic text overlay is not the default.
- `get_sketch_document` returns the current product-owned JSON.

The same local session is used by the browser and MCP. A duplicate sequence with the same operation hash is idempotent. A gap, stale revision, or conflicting duplicate is rejected without mutating the document.

## Host callback boundary and transport distinction

The canvas must distinguish a real MCP Apps bridge from an ordinary browser fallback. A framed page is not sufficient: the MCP Apps branch becomes active only after a successful `ui/initialize` response. That branch may use `tools/call` and `ui/message` to route a request through the originating host task. The ordinary browser branch has no such guarantee; it uses the local listener lease and finite `wait_for_layout_action` loop, or shows a recoverable copy/send instruction when no listener is active.

The local protocol proves service-to-canvas delivery and the bounded listener state machine. It does not by itself create a new visible model turn. Desktop MCP Apps task bridging and modal/fullscreen feature detection remain a separate host verification gate. Until a real target-host round trip is recorded, no notification, queue, or browser `postMessage` should be described as a successful task callback.

The private request record is the controlled exception needed for model recovery: it contains the original layout request text under the session's local data root with restrictive permissions, is not copied into `session.json`, `operations.ndjson`, evidence, or status snapshots, and remains available after a service restart while the request is pending. Terminal resolution/cancellation removes that private record. Any host callback must preserve the local session as the recoverable source of truth and must not expose full copy, image Base64, credentials, or unrelated task data in notifications.

---
name: sketch-ai-imagen
description: Use the Sketch AI Imagen workflow to create and inspect a local V1.1 visual-framework canvas with product-owned SketchDocument JSON, committed operation batches, numbered local markers, and atomic dual-PNG confirmation.
metadata:
  short-description: "Open the local visual-framework canvas"
---

# Sketch AI Imagen

Invoke this public workflow Skill as `@sketch-ai-imagen`. The distributed Skill name is
`sketch-ai-imagen`; the plugin bundle, MCP server, session schemas, resource URIs, and
internal product IDs intentionally remain `layout-guided-ai-imagen` for compatibility.

Migration: replace the old public Skill path/name `layout-guided-ai-imagen-workflow` with
`sketch-ai-imagen`. This release exposes one public workflow Skill only; do not install or
advertise a duplicate legacy Skill alongside it.

Use the plugin's local MCP tools to start the V1.1 lightweight canvas and inspect its status. The visual framework controls spatial structure; the user's reference images and complete creative prompt control visual content and style.

## Absolute confirmation and generation gate

**Never auto-select a candidate, auto-confirm a layout, or call any image-generation tool before a real user has seen the candidates and explicitly selected and confirmed one in the workbench UI.** A default `active_candidate_id` (including A), an AI recommendation, a model statement such as “采用 A”, an HTTP/CLI/MCP tool result, or a caller-supplied `confirmed_by` field is not user confirmation. Do not generate a main visual early, do not build a finished poster and confirm it retroactively, and do not treat a preflight or preview as permission to generate. If the workbench did not actually open, or the user did not click a candidate and the confirmation control, stop and report the blocker.

The service accepts confirmation only from a short-lived, candidate/revision-bound intent created by the browser/MCP Apps workbench's explicit click path. `confirm_layout`, HTTP requests, CLI commands, and direct imports of the internal generation builder cannot create that proof. Always `prepare/open → claim/wait` for a live workflow, then wait at the canvas until the user's selection and confirmation are observed. Run `generation_preflight` immediately before any generation preview or host image call; `allow: false` is a hard stop.

## Layout is guidance, not visual replication

The canvas is a broad composition scaffold. Preserve region relationships, information hierarchy, subject proportion, reading path, whitespace, and exact copy by default; allow the image model to choose typography, line breaks, font treatment, title packaging, material, lighting, decoration, and the unified treatment of background, main visual, and copy. Canvas `fontFamily`, `fontSize`, fill, strokes, borders, placeholder colors, and simple text blocks are not hard constraints unless the user explicitly locks them. Do not use a default programmatic plain-text overlay. The formal generation preview must make the distinction explicit as `hard_constraints`, `soft_layout_guidance`, and `creative_freedom`; “秋季新品发布会” is an example of verbatim copy that may receive an expressive title treatment rather than a canvas-style copy.

## Stage 0 behavior

- Call `open_layout_workbench` to obtain the local canvas URL.
- Use one opening route per workbench. When the host exposes `open_in_codex`,
  pass the returned URL to that action first and treat a successful result as
  the workbench already being open. Do not create or inspect a second browser
  tab for the same URL after success. Only an explicit failure, timeout, or
  unavailable `open_in_codex` action may enter the browser fallback, and the
  state should say that the browser fallback was used. Opening the same session
  twice must reuse its URL and listener lease rather than start another page or
  listener.
- Route by the actual tool surface, not by Skill visibility alone. If the
  layout MCP tools are listed and callable in the current host, use them
  directly. If they are not listed/callable, use the bundled runner at
  `scripts/layout-guided-ai-imagen.mjs`; do not search `~/.codex`, hand-write
  JSON-RPC, or create a temporary Node client. Start/reuse the shared service
  with `start --session <id>`, open its emitted `browser_url`, and keep the
  emitted private `listener_state_file` for the listener loop.
- For a new PosterBrief in the bundled-runner route, use the formal public
  command `prepare --session <id> --brief-file <poster-brief.json>
  [--candidate-count 3]`. It validates the brief, rejects missing/conflicting
  input, seeds A/B/C into the same session, waits for committed batches, and
  returns the browser URL plus candidate metadata and the next listener step.
  Re-running with the same brief is idempotent; a different brief must use a
  new session or an explicitly authorized replacement workflow. Do not use
  curl, hand-written JSON-RPC, or imports of internal modules for preparation.
  New non-demo sessions begin as `awaiting_brief`; the football `demo` content
  is available only through the explicit `--demo` fixture.
- Treat the returned UI as two different transports. A real MCP Apps bridge is
  present only after the iframe receives a successful `ui/initialize` response;
  only then may the component use `tools/call` and `ui/message`. A normal local
  browser URL is a fallback and must not assume that `ui/message` reaches the
  originating task.
- Call `create_session` when a new local session is needed; it never overwrites an existing session ID. Call `get_session_status` to reopen or inspect a session.
- Call `get_session_status` to inspect candidates, current revision, local storage, and confirmation state.
- Call `get_sketch_document` to read the product-owned `SketchDocument` for a candidate.
- Use `seed_layout_candidates` with a `ready` `PosterBrief` to place A/B/C seed documents into one session. The service persists separate candidate operation streams and then commits the returned `operation_batches` through `begin_sketch` → `apply_sketch_ops` → `complete_sketch`.
- Use `begin_sketch`, `apply_sketch_ops`, and `complete_sketch` for ordered AI or user operation batches. A committed batch is real canvas state; do not replace it with a post-hoc animation.
- Use `interrupt_sketch` and `resume_sketch` to preserve the last continuous revision and continue a stored operation plan after interruption. The browser uses SSE first and `/events?format=poll` as the cursor-based fallback.
- Treat duplicate batches as idempotent and reject gaps, stale revisions, or conflicting duplicate hashes.
- Use `save_sketch_version` for an explicit candidate save. The local session keeps `initial.sketch.json`, `current.sketch.json`, and `versions/v<revision>.json`.
- Use `submit_layout_change` for a natural-language layout change. The request is queued as a pending record with a request ID, revision, length, and hash; the original text is stored only in the private session request record needed by a waiting model, never in the session snapshot or operation journal, and is removed when the request reaches a terminal state.
- For a browser fallback, after opening the canvas claim a short-lived
  `claim_layout_listener` lease with `transport=browser_fallback` (or run the
  bundled CLI `claim --session <id>`, which uses `transport=cli_runner`), then
  keep the current model turn alive in a loop of bounded (maximum 30 second)
  `wait_for_layout_action` calls (or CLI `wait --state-file <path>`). Renew with
  `heartbeat_layout_listener` (or CLI `heartbeat`) between waits; pass the
  returned cursor into the next wait. On a `layout_change` event, read the
  current `SketchDocument`, produce only structured operations, and call
  `resolve_layout_change` with the listener lease (or CLI `resolve` with an
  operations file). In the CLI route, read the product-owned document with
  `document --session <id> --candidate-id A` before composing operations.
  Continue waiting until the user confirms, cancels, the
  lease is released, or the task genuinely ends. A timeout is a heartbeat, not
  completion, and user inactivity must not be reported as an error.
- In a real MCP Apps bridge, the current host turn may route the submitted
  request through `tools/call` plus `ui/message`; still resolve only explicit
  structured operations. Never emit `ui/message` from an ordinary browser
  fallback.
- Never call `open_layout_workbench` and immediately send a final response
  while a natural-language modification flow is expected. If the host cannot
  keep a reliable active turn, leave the request recoverable and tell the user
  to return to the original conversation; the canvas must say that the AI
  listener is disconnected rather than display a permanent callback wait.
- Use `cancel_layout_change` for a user cancellation. Pending requests survive
  a process restart in a private local request record and can be reclaimed by a
  new listener after the old lease expires or is released; the raw request is
  returned only to the waiting model tool, not to status snapshots or journals.
- Use `release_layout_listener` before ending a fallback listener turn. A
  listener lease is finite and idempotent; no single wait call is allowed to
  block indefinitely.
- The CLI runner is an official low-token fallback, not a second session
  implementation. Its `start`, `claim`, `wait`, `heartbeat`, `resolve`,
  `cancel`, and `release` commands all use the same local service/data root as
  the browser. Its output contains hashes/lengths/status by default; full
  request text is returned only by a successful `wait` to the listener that
  claimed it. After a process interruption, a new CLI `claim` can reclaim a
  pending request once the old lease expires; never report a permanent wait.
- Use the canvas to export a clean visual framework, an annotated framework, and structured detail constraints through the explicit confirmation gate.
- Use `confirm_layout` only when the same candidate revision has a valid SketchDocument, clean PNG, numbered-marker PNG, and non-renderable detail constraints. Repeated confirmation of that candidate revision is idempotent.
- Use `get_confirmed_inputs` to read confirmation metadata and local export availability without returning image bytes.
- Treat numbered markers, labels, notes, placeholder colors, and helper frames as control marks. They must not appear in a final image.
- Use `assess_image_capability` only with explicit host evidence; an unknown capability blocks image generation without affecting layout editing.
- Use `build_generation_request_preview` to inspect the visual-framework plus complete creative-prompt package before any future image dispatch. It does not call an image tool.
- Do not claim candidate generation, atomic confirmation, reference-image generation, image refinement, or cross-computer packaging is complete until each stage has real evidence.
- Do not use Draw.io, Excalidraw, an external canvas site, auto-retry, or automatic image regeneration.
- Do not use Computer Use or mouse simulation to draw or to compensate for a
  failed workbench open; drawing remains structured `SketchDocument` operations
  and an explicit host-open failure is reported or routed through the documented
  browser fallback.

## PosterBrief gate

- Assemble the user's request into `PosterBrief` and call `validate_poster_brief` before entering layout.
- Keep complete copy text verbatim. Do not shorten, rewrite, or silently resolve conflicts between dimensions, versions, assets, or attachments.
- Ask only the questions returned for missing required canvas, copy, or main-visual fields. Style, purpose, and optional references may remain absent until the user supplies them.
- Keep user reference images separate from the visual framework. A supplied layout image may constrain spatial relationships, but it is not automatically a style reference.
- Treat `conflict` and required `attachment_error` results as blockers. A `ready` result is the only result that may proceed to candidate layout generation.
- The local validator checks structure and explicit attachment state; it does not perform natural-language parsing or OCR.

## Stage 3 local candidate assembly

- After a `ready` PosterBrief, call `build_layout_candidates` to produce 2 or 3 selected-archetype `SketchDocument` records.
- Keep candidate IDs, object IDs, copy references, asset references, and marker IDs stable. Every required copy block and major asset must have an explicit position; asset placeholders carry an `asset_description`.
- Compare candidate differences through material hierarchy, main-visual geometry, and reading-path axes. Do not accept three cosmetic variants as distinct candidates.
- Use the returned `seed_document` and ordered `operation_batches` when wiring candidates into a live operation stream. The operation plan is real structured state, not an animation replay.
- The local assembler is deterministic and image-model-free. Do not describe it as ordinary-model generation or as a real AI host stream until that host path has evidence.
- Candidate choice comes from the product-owned `layout-archetypes/1` catalog, not a fixed A/B/C template list. The catalog records stable IDs, fit/avoid signals, composition grammar, slots, difference axes, normalized geometry, abstract schematic elements, and machine-readable provenance. The local selector scores PosterBrief signals deterministically, applies a difference-axis penalty, and returns materially different candidates with `archetype_id`, `archetype_name`, `selection_score`, `selection_rationale`, `difference_axes`, `schematic`, and `catalog_provenance`; it does not call an image model or extra LLM.
- OpenAI's public Images 2.5 article is only a boundary/reference: it describes Sketch as a visual guide and mentions flyers/product photos format templates, but does not publish a complete layout catalog. Do not present our product-owned archetypes as an official exhaustive list. Candidate cards render only the matching schematic (abstract blocks/lines/shapes), never a second full-canvas text or asset preview. Older sessions may omit archetype fields and must use the UI fallback schematic.
- Call `list_layout_archetypes` when a host workflow needs to inspect the full product-owned catalog before discussing a choice. The host may explain a proposed archetype from those signals, but this release has no host-supplied override path or real-model selection evidence; preserve the local selector as the deterministic, testable fallback and do not claim aesthetic selection by an ordinary model.

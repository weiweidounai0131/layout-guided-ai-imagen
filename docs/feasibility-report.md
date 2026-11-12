# Feasibility report — Layout-Guided AI Imagen V1.1

Date: 2026-09-09  
Scope: V1.1 Stage 0 local baseline  
Overall status: **PARTIAL**

The V1.1 baseline replaces the previous Draw.io Embed experiment with a product-owned `SketchDocument` rendered by a bundled Fabric.js canvas. The verified local browser path covers candidate state, structured operation batches, SSE cursor delivery, direct editing, annotation export, atomic dual-PNG confirmation, and local reopen. The local Stage 2/3 path now validates `PosterBrief` input and can assemble deterministic candidate layouts without invoking an image model.

## Verified

- Fabric.js `7.4.0` is pinned and recorded in [NOTICE](../NOTICE).
- Three independent candidates load from the same local session API.
- `SketchDocument` JSON is the persisted source of truth; Fabric private JSON is not persisted.
- Ordered operation batches reject gaps and stale revisions and accept same-hash duplicates idempotently.
- SSE events carry cursors and committed operations; the browser smoke receives a real service event and reloads the latest revision.
- Clean and annotated PNGs are exported from the same document revision. Clean export filters all annotation visuals.
- Invalid annotation anchors prevent confirmation.
- The generation preview carries both visual-framework inputs and the complete creative prompt, while keeping user reference images separate.
- A ready `PosterBrief` can be converted into two or three validated, materially different local layout candidates with replayable operation batches; the builder explicitly does not call an image model.
- Plugin manifest validation, CLI discovery, unit tests, and the real browser smoke pass.

## Not yet verified

- Real Codex Desktop MCP Apps presentation, modal feature detection, and fullscreen fallback.
- A real layout-model response driving operation batches; the current test uses the MCP/local operation contract, not a production model.
- A host image adapter that accepts the visual framework, annotated framework, and user reference images.
- Pure-text-only host blocking through a real host adapter.
- Cross-computer online/ZIP installation, migration, and rollback.

## Evidence

See [Stage 0 V1.1 evidence](evidence/stage-0-v11.md), [Stage 1 evidence](evidence/stage-1.md), and the [browser screenshot](evidence/stage-0-v11-browser.png). The old Draw.io files under `prototype/` and the old `docs/evidence/stage-0.md` are retained as V1.0 historical material and are not V1.1 acceptance evidence.

## Exit decision

Stage 0 remains **PARTIAL**. Stages 1–3 have local implementation evidence, while Desktop host integration, cross-process single-instance behavior, ordinary-model candidate generation, real model streaming, and image dispatch remain explicit later gates.

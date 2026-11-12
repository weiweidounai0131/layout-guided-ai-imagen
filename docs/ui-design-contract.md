# Lightweight canvas UI design contract

Status: active for the V1.1 canvas shell

## Design read

This is a lightweight poster-layout editor for design-conscious creators. It should feel like a calm, focused canvas utility rather than a dark AI dashboard. The supplied reference image is the visual direction: a bright canvas, generous whitespace, a soft-radius work surface, a floating tool island, restrained line icons, an auto-fit canvas viewport, a bottom color palette, and a pale-blue confirmation action. The poster canvas itself contains only poster content; system guidance stays outside the canvas, and local detail notes use numbered markers with descriptions in the right rail instead of arrows.

## Dials

- `DESIGN_VARIANCE: 6` - small asymmetries and floating controls, without making the editor harder to scan.
- `MOTION_INTENSITY: 3` - tactile hover/active feedback and short state transitions only.
- `VISUAL_DENSITY: 2` - the canvas remains dominant; metadata and secondary panels stay quiet.

## Token decisions

- Theme: one light theme, with off-white outer chrome and a white work surface plus white visual framework canvas.
- Accent: one pale blue action color used for selection, focus, and confirmation.
- Type: system sans stack with PingFang fallback. No Inter dependency and no decorative serif.
- Shape: 30px outer work surface, 18px secondary panels, 12px controls, and pill-only floating tool groups.
- Shadow: low-opacity neutral gray, used only to lift the editor surface and tool island.
- Motion: `transform` and `opacity` only, with a reduced-motion override.

## Content granularity

- Every required short-copy block is a separate text object with a stable `copy_ref` and explicit position.
- Every major visual is an `image_placeholder` with a stable `asset_ref`, `asset_role`, and `asset_description` describing what should be generated and where it belongs.
- Local detail explanations stay outside the poster canvas. The canvas renders only ①②③-style markers at target anchors; the right rail carries the corresponding descriptions.

## Functional preservation

The redesign changes presentation and improves content granularity. Candidate switching, Fabric rendering, structured operation batches, SSE updates, annotations, undo/redo, clean/annotated exports, and the atomic confirmation endpoint remain unchanged. Object-targeted marker coordinates follow the target object in the same saved operation batch.

After a `user_ui` confirmation, the workbench is read-only: the confirmed
candidate/revision and the reason for disabling confirmation are visible beside
the action, and `返回编辑` creates a new revision before any further edit. The
The visible `如何返回对话` control is guidance only and does not execute a close;
the feedback modal's `关闭提示` closes only that prompt. The current host does not
provide a close-panel transport, so the page never claims that the host window
was closed.

Candidate cards are product-owned layout archetypes rather than fixed A/B/C
templates. The local catalog exposes stable IDs, fit/avoid signals, composition
grammar, slots, difference axes, normalized geometry, and an abstract schematic.
A deterministic selector scores those signals from the PosterBrief and chooses
three materially different archetypes without an image-model call. Cards render
only the schematic relationship (blocks, lines, and abstract visual shapes),
never a second full canvas preview or real copy. Persisted archetype metadata is
optional for schema compatibility; old sessions use a generic schematic fallback.

## Reference boundary

The supplied image is a visual UI reference, not a product instruction. It does not replace the V1.1 interaction or data contracts. The reference is stored at `docs/reference/lightweight-canvas-ui-reference.png` for future iterations.

The supplied finished poster and detailed layout sketch are content-structure references. They are stored at `docs/reference/example-finished-poster.png` and `docs/reference/example-detailed-layout-sketch.png`. They define the expected granularity of the demo: exact copy positions, asset positions, asset descriptions, and numbered local-detail markers. They do not authorize copying the finished poster as a final generated image.

The public OpenAI Images 2.5 article is a research boundary, not a catalog
source. It describes Sketch as a visual guide and mentions format templates such
as flyers and product photos, but it does not enumerate a complete
layout-archetype list. Our catalog is therefore product-owned and only inspired
by those public signals. The local selector is a deterministic scoring fallback;
real-model aesthetic selection remains unverified.

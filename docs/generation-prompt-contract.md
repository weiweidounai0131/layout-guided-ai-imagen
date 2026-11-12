# V1.1 generation prompt contract

Status: adopted product decision  
Scope: Stage 5/6 generation package and first-image dispatch

## Decision

The confirmed visual framework and the textual creative prompt are complementary inputs in one image-generation request.

- The **visual framework** controls spatial intent: placement, relative scale, information hierarchy, reading path, and whitespace.
- The **annotated visual framework** maps stable D-numbers to local detail constraints; its numbered markers, labels, notes, and helper marks are instructions only.
- The **creative prompt** supplies subject, scene, style, medium, lighting, palette, materials, exact copy, asset roles, and keep/avoid rules.
- A **user reference image** is a separate visual input for a person, product, logo, scene, or style; it is not the visual framework.

### 0.2.4 semantic amendment: structure guidance, not visual replication

The framework is a broad composition scaffold. It does not freeze pixels, canvas
font family, font size, line breaks, fills, strokes, borders, placeholder colors,
or title packaging. By default the request preserves only region relationships,
information hierarchy, subject proportion, reading path, whitespace, and exact
copy semantics. The image model may refine typography, wrapping, title art
direction, materials, decoration, lighting, and the unified treatment of the
background, main visual, and copy. A plain programmatic text overlay is not the
default.

The formal request exposes three layers:

- `hard_constraints`: canvas dimensions/aspect, verbatim copy, explicit
  `must_include`/`must_not_include`, user-locked items, and valid local detail
  instructions.
- `soft_layout_guidance`: broad regions, relative relationships, hierarchy,
  subject share, reading path, and whitespace; natural in-region adjustment is
  allowed.
- `creative_freedom`: font, size, weight, tracking, wrapping, title treatment,
  material, decoration, lighting, color, and image-wide integration.

For example, “秋季新品发布会” remains exact copy but may receive a high-quality
theme-appropriate title treatment. It must not be mechanically forced to copy
the canvas text styling. Only an explicit user lock promotes a normally creative
detail to a hard constraint.

The product must never send only a framework PNG, or pair it with a generic prompt and claim that the poster's visual style is controlled.

## Request assembly

```text
Visual framework role:
  Use the clean visual framework only for spatial structure and composition.
  Preserve relative placement, proportions, hierarchy, reading path, and whitespace.

Annotated framework role:
  Use D1...Dn only to map local regions to structured detail constraints.

Creative brief:
  Subject and scene: <PosterBrief.main_visual and purpose>
  Visual style / medium: <PosterBrief.style.direction>
  Lighting / palette / materials: <PosterBrief.style fields>
  Exact copy, verbatim: <all PosterBrief.copy text>
  Asset roles: <Logo/person/product/QR/style reference mapping>
  Detail constraints: <D1...Dn complete instructions>
  Must keep: <constraints.must_include>
  Must avoid: <constraints.must_not_include plus helper elements>

Rendering exclusion:
  Do not render helper frames, labels, IDs, grid, arrows, numbered markers, UI chrome,
  notes, QR placeholders, or placeholder colors unless explicitly requested
  as creative direction.
```

If the host supports multiple image inputs, pass the clean framework and annotated framework first, then separately labelled user reference images. Do not conflate a style reference image with the visual framework.

If the host supports only one image input, use the annotated framework and repeat the whole spatial structure plus every D-number constraint in text. If required user reference images cannot also be passed, ask the user to choose or stop; never silently discard them.

## Dispatch gate

Before calling the host image tool, verify:

1. `generation_preflight` returns `allow: true` from the local service. A missing,
   legacy, caller-constructed, stale, or tampered confirmation returns
   `allow: false` and is a hard stop.
2. The server-persisted confirmation records `confirmed_by: "user_ui"`, a
   `confirmation_id`, `ui_instance_id`, and the exact `user_selected_candidate`
   candidate/revision. The record was created by consuming a short-lived,
   single-use intent minted by the workbench click path.
3. A confirmed `SketchDocument`, clean framework PNG, annotated framework PNG,
   and matching detail constraints exist for the same session, candidate, and
   revision, and their hashes/dimensions pass server verification.
4. The creative prompt is non-empty and contains the current complete copy and
   visual requirements.
5. The request declares the framework roles and helper-element exclusions.
6. The host explicitly accepts image inputs and image generation, including its usable input count.
7. This is the user's first request or an explicitly user-triggered retry;
   never dispatch automatically after a quality warning or failure.

The public preview path accepts only `session_id` and loads the persisted
confirmation itself. Do not import `mcp/generation-request.mjs` directly or
construct a `confirmed` object in a model/script; the internal builder requires
a server verification context and `confirmed_by: "user_ui"`.

The local implementation is [mcp/generation-request.mjs](../mcp/generation-request.mjs). It creates a dual-conditioned `generation-request/3` preview with the three constraint layers and fails closed when either framework input or the creative brief is incomplete. The public `build_generation_request_preview` route maps persisted session-relative confirmation refs to usable absolute local refs and flattens persisted hashes; callers must not import the internal builder or hand-construct verification data. It does not dispatch an image request.

# PosterBrief contract

Status: `poster-brief/1` adopted for the local validation gate

`PosterBrief` is the structured handoff between the user's poster request and layout candidates. The local validator does not claim to understand arbitrary natural language, perform OCR, or choose between conflicting user inputs. A host model or UI can assemble the object; the validator then decides whether it is safe to enter the layout stage.

## Required inputs

Only these three groups block layout entry:

- `canvas`: positive `width` + `height`, or a valid `aspect_ratio` such as `8:11`.
- `copy`: at least one item with non-empty `text`. Text is preserved verbatim, including intentional whitespace.
- `main_visual.description`: a non-empty description of the subject and scene.

Style, purpose, material descriptions, user reference images, layout references, local detail requirements, and optional assets enrich the brief but do not silently replace missing required inputs.

## Separate image roles

- A user-provided person, product, logo, scene, or style image belongs under `assets` or `references`.
- The confirmed canvas output is the **visual framework**. It controls spatial structure and is not a user reference image.
- A layout reference supplied by the user is kept as `layout_reference`; it does not become a style reference automatically.

## Validation results

`POST /api/poster-brief/validate` and the `validate_poster_brief` MCP tool return a report with:

- `needs_input` and `questions` when required fields are missing;
- `conflict` when explicit unresolved conflicts, duplicate asset IDs, or contradictory dimensions are found;
- `attachment_error` when a required asset/attachment is not ready;
- `ready` only when the brief can enter layout.

The report keeps the normalized brief and the original copy text. Attachment failures are reported separately and do not erase other fields. The full natural-language request is not part of this validation report unless the caller intentionally includes it as a structured field outside the contract.

## Layout archetype selection

After a `ready` brief, the local assembler consults the product-owned
`layout-archetypes/1` catalog. It derives deterministic signals from copy
length/density, main-visual subject, purpose, and style, scores each archetype,
then selects two or three candidates while penalizing overlapping difference
axes. The result records stable `archetype_id`/`archetype_name`, score, selection
rationale, difference axes, schematic, and catalog provenance. The same brief is
idempotent; distinct brief signals may yield distinct combinations. No image
model or extra model call is made by this local fallback.

The read-only `list_layout_archetypes` interface exposes the full catalog to a
host workflow. A host model may inspect the fit/avoid signals, composition
grammar, slots, difference axes, and schematic before explaining a choice, but
this release has no host-supplied archetype override and provides no evidence of
real-model aesthetic selection. `build_layout_candidates` remains the measured
deterministic fallback and returns the selected metadata for auditability.

The catalog provenance is explicit: every entry is `product-owned` by
`layout-guided-ai-imagen`, with the public OpenAI Images 2.5 article recorded as
non-exhaustive inspiration only. The article describes Sketch as a visual guide
and gives flyers/product photos template examples; it does not enumerate a
complete layout-archetype list. The left candidate cards therefore show our
abstract schematics, not an implied official taxonomy or a second full-canvas
preview.
Archetype fields are optional in persisted session records so older sessions
remain readable.

The catalog also exposes a `selection_policy`: this release uses
`deterministic_scoring` in the `local_fallback`, with no model call and
`aesthetic_evidence: "unverified"`. A host may inspect and explain the catalog
signals, but the local score is not evidence of real-model aesthetic selection.

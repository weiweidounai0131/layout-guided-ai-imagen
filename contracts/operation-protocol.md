# V1.1 sketch operation protocol

This is the product-owned protocol for AI and user changes. Fabric.js is only a renderer; its private JSON is never the persisted source of truth.

## Envelope

Every committed batch uses:

```json
{
  "session_id": "demo",
  "candidate_id": "A",
  "stream_id": "ai-layout-A",
  "batch_seq": 1,
  "base_revision": 0,
  "operations": [
    { "type": "add_object", "object": {} }
  ]
}
```

`batch_seq` is monotonic within one `stream_id`. `base_revision` must equal the candidate's current revision. A successful batch increments the revision exactly once, regardless of how many operations it contains.

## Supported operations

- `add_object` with a complete stable object ID.
- `update_object` with `object_id` and a partial patch.
- `delete_object` with `object_id`.
- `add_annotation` with a complete stable annotation ID and `render_in_final=false`.
- `update_annotation` with `annotation_id` and a partial patch.
- `delete_annotation` with `annotation_id`.

All operations are validated and applied atomically. A failed operation leaves the previous document unchanged.

## Ordering, retry, and interruption

- A duplicate `(stream_id, batch_seq)` with the same operation hash is idempotent and returns the already committed revision.
- A duplicate sequence with a different operation hash is rejected.
- A sequence gap, stale `base_revision`, or out-of-order batch is rejected without changing the document.
- The last continuously valid revision remains available after interruption.
- The local append-only journal assigns an integer `cursor` to each committed batch.
- The canvas prefers SSE with `after=<cursor>` recovery and may poll the same journal when SSE is unavailable.
- Candidate seeding materializes the same committed events in each candidate's local `operations.ndjson` alongside the session journal; the per-candidate stream remains isolated while the session cursor remains globally monotonic.

## Annotation rules

The current annotation presentation is a numbered marker, not an arrow. A marker stores a stable D-number, an anchor point in `end`, a target object or region, and a note that is shown in the UI's right-side detail panel. `start` is retained for V1.1 backward compatibility with older arrow annotations and is not rendered by the current UI. An object-targeted marker follows the target object's saved geometry when that object is moved or resized. Deleting its target marks the annotation `invalid` and blocks confirmation. Clean exports omit all annotations; annotated exports render only the numbered markers.

## User and AI concurrency

User edits use the same envelope and revision checks as AI edits. A stale AI batch is rejected rather than silently overwriting a newer user revision. The host may retry from the latest document by starting a new stream.

Once a candidate/revision is confirmed, its current document is read-only. Begin,
operation-batch, save, and natural-language layout-change writes reject that
confirmed revision until the workbench's signed `return-to-edit` action creates
the next revision. That action preserves the confirmed version and its files,
clears the current confirmation/selection/intent, and requires a fresh
selection plus confirmation; it never triggers image generation.

## Human confirmation proof

`active_candidate_id` is a rendering default, not a user choice. The workbench
creates a browser-bound UI session with an HttpOnly cookie and a non-exportable
P-256 key. A real candidate-card click signs a short-lived challenge and writes
`user_selected_candidate` with `candidate_id`, `revision`, `ui_instance_id`,
and `selected_at`. A separate real confirmation click signs the next challenge
and mints a short-lived, one-time confirmation intent for that exact candidate
and revision.

The `/confirm` endpoint consumes that intent atomically. It ignores or rejects
caller-provided `confirmed_by` values, and rejects calls without the browser UI
cookie, Fetch Metadata, gesture header, and matching intent. Intent replay,
expiry, candidate/revision changes, or a different UI instance fail closed.
CLI and direct MCP tools can inspect status or run generation preflight, but
cannot mint this proof. `generation_preflight` must return `allow: true` from a
persisted `confirmed_by: "user_ui"` record before a generation preview/package
or host image call is permitted.

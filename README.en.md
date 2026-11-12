# Sketch AI Imagen

**Control composition before you generate.** A model-agnostic Codex plugin that lets you lock down a poster's spatial structure on a local, editable canvas — then hand that structure to any image model that accepts image input.

Most AI image tools give you one dial: the prompt. Layout, hierarchy, and where the subject sits are left to chance, and you re-roll until something lands. Sketch AI Imagen splits the problem in two. You decide the *structure* on a canvas you can actually see and edit; the image model decides the *craft* — typography, materials, lighting, art direction.

```
PosterBrief → candidates A/B/C → you edit on canvas → you confirm → visual framework + creative prompt → image model
```

---

## Why this exists

Prompting alone cannot reliably control composition. Describing "title top-left, product center at 60% height, whitespace on the right" in prose is imprecise, and the model reinterprets it every run.

So this plugin makes layout an explicit, inspectable, editable artifact:

- **You see the structure before spending a generation.** Candidates render as real editable documents, not thumbnails.
- **You edit it directly.** Move, resize, relabel, annotate. Every change is a structured, versioned operation — not a chat message hoping for the best.
- **Nothing generates until you click confirm.** The confirmation gate is enforced in the service, not just requested in a prompt.
- **The model still gets creative freedom.** The canvas is guidance, not a stencil.

## Core concepts

### Layout is guidance, not replication

The confirmed canvas is a **broad composition scaffold**. By default it constrains region relationships, information hierarchy, subject proportion, reading path, whitespace, and verbatim copy — and nothing else.

Canvas font family, font size, fills, strokes, borders, and placeholder colors are *not* hard constraints unless you explicitly lock them. A generation request is assembled in three explicit layers:

| Layer | Meaning |
|---|---|
| `hard_constraints` | Canvas dimensions/aspect, verbatim copy, explicit `must_include` / `must_not_include`, user-locked items |
| `soft_layout_guidance` | Regions, relative relationships, hierarchy, subject share, reading path, whitespace |
| `creative_freedom` | Font, size, weight, tracking, wrapping, title treatment, material, decoration, lighting, color, integration |

So exact copy like `秋季新品发布会` stays verbatim while still receiving a properly art-directed title treatment — instead of being mechanically stamped in canvas styling.

### The confirmation gate

**No image is generated before a real user selects and confirms a candidate in the workbench UI.**

This is enforced structurally, not by convention. A default `active_candidate_id` (including `A`), an AI recommendation, an HTTP or CLI call, and a caller-supplied `confirmed_by` field are all rejected. The service accepts confirmation only from a short-lived intent bound to the exact candidate revision and created by the workbench's explicit click path. `generation_preflight` runs immediately before any generation and `allow: false` is a hard stop.

### Candidates come from a real catalog

Candidate choice is driven by the product-owned `layout-archetypes/1` catalog — 12 archetypes with stable IDs, fit/avoid signals, composition grammar, slots, difference axes, and normalized geometry:

`center-hero` · `bold-type` · `split-columns` · `top-bottom` · `title-led` · `module-grid` · `framed-scene` · `diagonal-flow` · `full-bleed` · `minimal-space` · `information-stack` · `editorial-grid`

A deterministic local selector scores your brief, applies a difference-axis penalty, and returns **materially different** candidates — not three cosmetic variants. It calls no image model and no extra LLM, which makes it testable and reproducible.

### Atomic dual-PNG confirmation

Confirming a candidate produces three artifacts together, atomically:

1. a **clean visual framework** — what the image model sees,
2. an **annotated framework** — numbered `D`-markers mapped to detail constraints,
3. **structured detail constraints** — machine-readable, non-renderable.

The numbered markers, labels, notes, and helper frames are *control marks*. They are instructions only, and are guaranteed never to appear in a final image.

## Installation

### From a local marketplace

The plugin root is this repository — `.codex-plugin/plugin.json` sits at the top level. Place it in a local marketplace and register it:

```sh
mkdir -p /path/to/marketplace/plugins
cp -R /path/to/layout-guided-ai-imagen /path/to/marketplace/plugins/layout-guided-ai-imagen
mkdir -p /path/to/marketplace/.agents/plugins
```

Write `/path/to/marketplace/.agents/plugins/marketplace.json`:

```json
{
  "name": "sketch-ai-imagen-local",
  "interface": { "displayName": "Sketch AI Imagen" },
  "plugins": [
    {
      "name": "layout-guided-ai-imagen",
      "source": { "source": "local", "path": "./plugins/layout-guided-ai-imagen" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

Then install and restart Codex:

```sh
codex plugin marketplace add /path/to/marketplace
codex plugin add layout-guided-ai-imagen@sketch-ai-imagen-local
codex plugin list --json
```

Requires **Node.js >= 18**. Install dependencies with `npm ci` if you want to run the full test suite; the canvas itself needs no network access — `web/vendor/fabric.js` ships in the repository.

## Usage

Invoke the public workflow Skill as `@sketch-ai-imagen`.

If the plugin's MCP tools are listed and callable in your host, use them directly. If they are not, use the bundled runner — it talks to the same local service and data root:

```sh
# Start or reuse the shared local service for a session
node scripts/layout-guided-ai-imagen.mjs start --session <id>

# Validate a PosterBrief and seed candidates A/B/C into that session
node scripts/layout-guided-ai-imagen.mjs prepare --session <id> --brief-file brief.json

# Inspect state
node scripts/layout-guided-ai-imagen.mjs status --session <id>
node scripts/layout-guided-ai-imagen.mjs document --session <id> --candidate-id A
node scripts/layout-guided-ai-imagen.mjs confirmation-status --session <id>
node scripts/layout-guided-ai-imagen.mjs generation-preflight --session <id>
```

`prepare` is idempotent for the same brief. A different brief never overwrites an existing session — start a new session instead. New non-demo sessions begin empty; the bundled football fixture is available only via `--demo`.

### The listener loop

After opening the canvas, claim a short-lived listener lease and keep the turn alive with bounded waits, so natural-language layout edits from the canvas actually reach the model:

```sh
node scripts/layout-guided-ai-imagen.mjs claim --session <id>
node scripts/layout-guided-ai-imagen.mjs wait --state-file <path> --timeout-ms 30000
node scripts/layout-guided-ai-imagen.mjs heartbeat --state-file <path>
node scripts/layout-guided-ai-imagen.mjs resolve --state-file <path> --status applied --operations-file ops.json
node scripts/layout-guided-ai-imagen.mjs release --state-file <path>
```

A timeout is a heartbeat, not completion. Leases are finite and idempotent; after a process interruption a new listener can reclaim a pending request once the old lease expires. The browser uses SSE first with a cursor-based `/events?format=poll` fallback.

## Architecture

```
.codex-plugin/plugin.json   Plugin manifest (name, version, Skill path, MCP wiring)
.mcp.json                   MCP server declaration (stdio → mcp/server.mjs)
mcp/                        Local service: 26 MCP tools, HTTP + SSE, session store
  server.mjs                Service, routing, confirmation gate, MCP Apps resource
  sketch-document.mjs       Product-owned SketchDocument + operation protocol
  layout-archetypes.mjs     layout-archetypes/1 catalog (12 archetypes)
  layout-candidates.mjs     Deterministic selector + difference-axis penalty
  poster-brief.mjs          PosterBrief validation (fails closed)
  generation-request.mjs    Three-layer generation request assembly
  capabilities.mjs          Host image-capability assessment
web/                        Lightweight Fabric.js canvas (offline vendored)
contracts/                  JSON Schemas + operation protocol
scripts/                    CLI runner (official low-token fallback)
skills/sketch-ai-imagen/    The public workflow Skill
docs/                       Contracts, design specs, license matrix, evidence
tests/                      53 unit tests + browser and host smoke tests
```

**The operation protocol** is the spine. AI and user edits are ordered batches committed through `begin_sketch` → `apply_sketch_ops` → `complete_sketch`. Duplicate batches are idempotent; gaps, stale revisions, and conflicting duplicate hashes are rejected. A committed batch is real canvas state — never a post-hoc animation.

**Storage** is local and inspectable. Each session keeps `initial.sketch.json`, `current.sketch.json`, and `versions/v<revision>.json` under a local data root (default: `$TMPDIR/layout-guided-ai-imagen-v11`).

### Naming, deliberately

| Surface | Name |
|---|---|
| Public workflow Skill | `sketch-ai-imagen` (invoke as `@sketch-ai-imagen`) |
| Plugin bundle / marketplace ID | `layout-guided-ai-imagen` |
| MCP server, resource URIs, session schemas | `layout-guided-ai-imagen` |

The bundle, MCP, and session IDs keep the original name so existing installations and sessions keep working. The public Skill was renamed to `sketch-ai-imagen`; the old `layout-guided-ai-imagen-workflow` name is retired and must not be installed alongside it. This release exposes **one** public workflow Skill.

## Development

```sh
npm ci                     # install dependencies
npm test                   # 53 unit tests
npm run test:browser       # browser smoke (needs Playwright)
npm run test:browser:stage4
npm run test:cli-discovery
npm run test:host:mcp-apps
```

## Honest limitations

This project distinguishes what is verified from what is not, and does not claim capabilities it cannot demonstrate:

- **Real Codex Desktop iframe embedding, live host model callbacks, and actual image generation are not verified here.** Local protocol smoke tests do not extrapolate to those paths.
- The host image capability check is evidence-based. An `unknown` capability **blocks generation** without affecting layout editing.
- The archetype catalog is **product-owned**, not an official exhaustive OpenAI layout list. OpenAI's public Images 2.5 article describes Sketch as a visual guide but publishes no complete catalog — it is treated here as a boundary reference only.
- The local assembler is deterministic and image-model-free. It is not described as ordinary-model generation.
- The PosterBrief validator checks structure and explicit attachment state. It performs no natural-language parsing or OCR.
- Full `npm test`, browser smoke, and the dev toolchain require a network-connected environment for `npm ci` and Playwright. They are not prerequisites for running the offline plugin core.

## License

[MIT](LICENSE). Bundles [Fabric.js](https://fabricjs.com) 7.4.0 (MIT) — see [NOTICE](NOTICE). Third-party boundary recorded in [docs/license-matrix.md](docs/license-matrix.md).

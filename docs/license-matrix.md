# V1.1 license and reuse matrix

This matrix records the dependency boundary for the V1.1 lightweight canvas. It does not grant permission to copy unrelated third-party source code.

| Material | Observed authority | V1.1 decision |
|---|---|---|
| Fabric.js `7.4.0` | The installed package declares `MIT` in `node_modules/fabric/package.json` and ships its license in `node_modules/fabric/LICENSE`. | Bundle the browser distribution, retain the MIT notice, and keep the version pinned in `package.json`. |
| Demo layout elements | Product-owned objects and colors defined in `mcp/sketch-document.mjs`; not copied from an external design project. | Keep them as replaceable `SketchDocument` fixtures. They are examples of spatial structure, not final visual assets. |
| Toolbar glyphs and annotation markers | Toolbar controls use native text glyphs; numbered markers use Fabric.js circles and text primitives. | No third-party icon pack or external illustration asset is bundled. |
| Product-owned `SketchDocument` | Local contract at `contracts/sketch-document.schema.json`. | Persist this schema, not Fabric's private serialization. |
| Product-owned operation protocol | Local contract at `contracts/operation-protocol.md`. | Use atomic ordered batches with revision checks, idempotent duplicates, and SSE/cursor recovery. |
| Draw.io / Excalidraw / other full editors | V1.1 product boundary explicitly excludes them. | Do not package, load, or depend on them. Previous Draw.io evidence is historical only. |

## Offline package obligations

- Include the pinned Fabric browser bundle, `NOTICE`, the schema, and the operation contract.
- Do not include development caches, user sessions, generated test data, credentials, or machine-specific absolute paths.
- Recheck package contents whenever the Fabric version changes.

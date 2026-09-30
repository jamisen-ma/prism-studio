# Staged PSD interchange

Research checkpoint: September 19, 2026. The broader import/round-trip proposal below remains future work. Subsequent codec evaluation led to an independent, strict export-only writer; see [current PSD export scope](PSD_EXPORT.md) and [codec findings](PSD_CODEC_EVALUATION.md). No general PSD parser is a production dependency.

## Evidence and implementation choice

PSD stores document resources, layer records/channels and a separate merged image. A file may omit its compatibility composite. Layer rectangles and masks have their own bounds, and the format records group/blending information. A merged preview alone therefore cannot establish editable import fidelity. [Adobe format specification](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)

`ag-psd` is a candidate MIT-licensed JavaScript codec. Its current repository manifest identifies version 31.0.2 with `base64-js` and `pako` runtime dependencies. The application must evaluate a pinned published version, rather than rely on an unversioned branch. [Project manifest](https://github.com/Agamnentzar/ag-psd/blob/master/package.json)

The codec recommends raw/image-data access to avoid canvas alpha conversion, structural validation before bitmap decoding, serialized work and a separate thread/process for synchronous decoding. It does not render updated layer or merged imagery for the caller. Its README lists several mode/feature limitations. [Maintainer usage and limitations](https://github.com/Agamnentzar/ag-psd/blob/master/README.md)

Source review exposes a documentation mismatch: the current reader accepts header versions 1 and 2 and contains code paths beyond the README's stated format limits. Deferred layer decoders also have distinct allocation paths. Prism must base each advertised feature and memory guarantee on tests against the pinned artifact, not infer support from one README paragraph or a header parser. [Reader implementation](https://github.com/Agamnentzar/ag-psd/blob/master/src/psdReader.ts)

## Proposed first contract

Start with an explicitly declared 8-bit RGB PSD subset. Preserve raster layers, their names/order, supported blend modes, opacity, visibility, native-compatible pass-through groups, and raster masks. Apply existing native canvas, node-count, metadata and scratch bounds before publishing a document. Reject PSB and other working modes in this first contract even if the chosen codec can parse them.

Use a worker with a bounded input, deadline and explicit decoded-pixel budget. Validate canvas, every layer rectangle, every mask rectangle and nested depth before decoding. Never interpret embedded data as a URL or open linked file paths. Evaluate an independent preflight of section lengths and allocation claims; parser options alone do not prove every path is bounded. Keep the companion responsive while decoding.

Store the exact original PSD separately from normalized per-layer PNG assets. The existing native `sourceAsset` denotes a decodable image and must not silently become a PSD blob. A new document-level original-container reference needs a versioned portable-project design, or explicit independent archival storage and reporting. Finish that decision before implementing import publication.

Inspect unsupported records before conversion. Default import must reject unsupported visual features with a structured compatibility report. A separately explicit raster-fallback mode could retain supplied layer bitmaps while identifying lost text/vector/effect/filter editability; it must not silently pretend those records were preserved. Saved merged imagery, when present, is an independent comparison target, not a replacement for the layer graph.

Exports must generate a fresh merged preview from Prism. Prefer strict supported-subset export first. Rasterized-layer export can be a separately named option, but adjustment layers and contextual protection make arbitrary per-layer flattening nontrivial: do not bake one isolated layer and assume the composite stays equal. Keep `.prism` as the lossless native editable format.

## Acceptance before UI exposure

- Fixtures from an independent producer, plus an independent decoder for exported PSDs; exact channel/alpha checks for simple raster documents and explicit tolerances for cross-engine blending.
- Nonzero/negative layer origins, source bounds larger than the canvas, soft masks, hidden layers, Unicode names, empty groups, group opacity and clipping/unsupported-feature reports.
- Original PSD bytes retained; failed imports leave all existing projects/assets unchanged; successful import receives a new document ID and fresh history.
- Every malformed/oversized structure fails before excessive allocation or document publication. Worker timeout/cancellation cleans temporary state and leaves the HTTP service responsive.
- Browser and MCP share the same compatibility report and explicit options. Round-trip reports distinguish retained editable properties, rendered fallbacks and rejected features.
- Portable export/reopen retains the new original-container reference safely, or clearly documents a deliberate archival boundary.

Implementation sequence: isolated codec evaluation and independent fixtures → accepted subset/format-reference contract → bounded worker and atomic native publication → authenticated HTTP/MCP → compatibility UI → independent review. Do not add `.psd` to the ordinary raster import whitelist as a shortcut.

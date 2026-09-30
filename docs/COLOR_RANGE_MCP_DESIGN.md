# Color Range command and MCP integration

Status: design only, September 19, 2026. The photographic default and exact arithmetic are approved; native resource and interface designs are being finalized. No command is registered yet. Root owns the shared command envelopes, status forwarding, MCP descriptions/image response, schema tests and official SDK acceptance. See [evaluation](COLOR_RANGE_EVALUATION.md) and [independent review](COLOR_RANGE_REVIEW.md).

## Commands

`get_color_range_preview` is a native read with `documentId`, optional positive `expectedRevision`, required `colors`, optional `tolerance`, `falloff`, `invert` and `maxEdge`. Defaults are32,32,false and700 respectively. `maxEdge` is an integer32..2400. There is no selection mode or layer ID on this read.

`load_color_range_selection` is a native mutation with `documentId`, required positive `expectedRevision`, the same color/range/invert settings and optional `mode` defaulting to `replace`. Modes are replace/add/subtract/intersect. There is no preview size or layer ID. It participates in atomic transactions only with a positive outer revision; transaction steps cannot supply another document or revision. The final output is an ordinary exact active mask, and Save Selection is a separate explicit operation.

`colors` is a standard dense array of one to eight distinct exact seven-character RGB hex strings. Canonical output is lowercase and retains authored order. Duplicate colors after case normalization refuse. Tolerance and falloff are finite integers0..255; booleans and numbers are never coerced. Unknown fields refuse. No schema transform is needed: keep the Zod grammar representable as MCP JSON Schema, then canonicalize through the strict shared settings normalizer after parsing.

The old Magic Wand and `select_color` contracts are unchanged. The new read and load refuse on the optional Adobe bridge, including inside transactions. They do not enter the recipe grammar or introduce another serialized mask format. Registration will raise native discovery from103 to105 commands; the28 global and32 source effect kinds remain unchanged.

## Strict ownership before asynchronous work

Both read and load must capture their complete arguments before joining the native queue. A read queued behind another edit must not later use a caller-mutated colors array. Public HTTP validation alone is insufficient because direct native callers also exist.

The proposed exported `checkColorRangeCommandArguments(command,args)` performs a descriptor-based preflight before Zod or any legacy native snapshot. It returns whether the request contains a new range command, allowing native `execute` to reuse the ordinary validated owned snapshot. Direct range envelopes use plain or null-prototype objects and own enumerable data fields only. The nested colors array is inspected before any element is read. No getters, symbol/hidden fields, holes or custom prototypes are accepted.

Transaction traversal must inspect the operations property, array indices and operation command/args through own data descriptors. Reject accessors without invoking them. For each new range step, validate its complete settings before outer `z.record` parsing or object spread can erase the original property shape. Preserve existing validation and revision injection for the other transaction steps. Do not add a second unsafe command-detection traversal in native code.

The shared preflight is called first by `validateCommand` for HTTP/MCP/TX and by native `execute` before its existing specialized snapshot paths. Native dispatch still checks the current project revision before rendering. Queue capture fixes caller ownership; it does not promise that an omitted preview revision is the one originally visible to a user.

## Discovery and response

Proposed discovery is `colorRangePolicy:'sampled-rgb-chebyshev-alpha-v1'`, a typed `colorRangeLimits` object and independent `colorRangePreviewLimits`. The isolated measurement supports maxComparisons192000000 and comparisonBatch65536, with a private256-byte membership lookup and280-byte total typed setup reserve. Preview requires the matching policy, valid typed color/preview limits and its advertised read command. Load requires the matching color policy/limits, dense-mask policy/limits and its advertised mutation command. Preview can remain available when dense authoring is withheld; both operations still enforce the complete graph and mask resource checks natively. Color Range does not require the unrelated channel-selection policy.

The preview response carries `documentId`, `revision`, canonical `colors`, `tolerance`, `falloff`, `invert`, `maxEdge`, source/output dimensions, `coveragePolicy`, `sampling:'nearest-pixel-center'`, `mimeType:'image/png'` and encoded data. It measures the freshly rendered visible composite and displays opaque grayscale coverage before active-selection combination. Nearest sampled pixels can omit fine detail. PNG output is bounded to8MiB. Preview writes no asset, history entry or selection and does not use the ordinary cached document preview.

The MCP handler splits encoded PNG data into an image content block and the remaining metadata into text/structured content, as the existing channel/mask previews do. Mark preview read-only/idempotent and exclude it from mutation receipt tracking. Load returns the usual updated document and uses the existing stable request ID receipt path. A caller that loses the response must inspect state before another load; a new ID is not an automatic retry mechanism.

MCP help describes nearest encoded-RGB Chebyshev membership, inclusive full tolerance, linear falloff, separate membership/alpha half-up rounding and final inversion. It explicitly states that transparent pixels become fully selected after inversion. Multiple swatches union by nearest distance; they do not add coverage. The active selection and selected layer do not restrict measurement. Add uses maximum coverage; Subtract/Intersect require an existing selection and retain continuous left coverage until the final byte. Empty output remains an explicit empty mask.

Selection authoring preserves original image bytes and does not lift later protection. No provider, image generator or segmentation model is called. The native arithmetic is not a claim of semantic object detection, perceptual color matching or Adobe pixel equivalence.

## Root acceptance

Schema checks cover defaults and all modes, strict bounds and exact hex length, duplicate/case behavior, owned array copies, direct/TX accessors with zero getter calls, required positive mutation/outer revisions, native-only refusal, read/mutation categories, recipe exclusion and JSON Schema discovery. Native owner and reviewer cover queued preview/load mutation independently.

Official SDK workflows use an isolated companion and real stdio client with forbidden provider/key/segmentation callbacks. They verify:

- All literal ramp/alpha/inversion discriminators and independent full masks; preview image block, canonical metadata, size sampling, read-only state and authored-order behavior.
- Photographic hard/soft/multi-swatch coverage, use as an editing mask, unchanged originals, filters/Fill/styles in the measured composite, Save Selection, Undo and editable project/restart retention.
- Continuous geometric-left combinations, no-selection early refusals, exact dense output beyond the run-length ceiling, stable-ID replay and late transaction/publication rollback with unchanged old shared assets.
- The existing default-Codex hard-mask path with an injected returned image: generated content remains locally clipped outside protected original people regardless of Color Range selection. No real generation is needed to test that boundary.

Use bounded first-byte diagnostics for large exact comparisons. Test-owned processes and temporary companions must close. Full integrated regression and the relevant real-browser workflows follow implementation; design approval is not completion evidence.

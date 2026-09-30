# Native Color Range selections

Status: **implementation approved; acceptance pending**, September 19, 2026. Root and independent review approved the arithmetic,32/32 defaults, photographs and isolated timing. Production integration is the remaining task; no next feature is included. See [evaluation](COLOR_RANGE_EVALUATION.md), [independent review](COLOR_RANGE_REVIEW.md) and [MCP contract](COLOR_RANGE_MCP_DESIGN.md).

## Frozen scope and arithmetic

Produce a soft selection from one to eight authored RGB8 swatches against the fresh final visible composite. Keep Magic Wand/`select_color`, its hard RGBA matching and contiguous flood behavior unchanged. No tonal, perceptual, hue-only, localized-cluster, layer-source, semantic-detection or new live eyedropper mode is introduced. Existing image/selection/mask formats and consumers remain unchanged.

Adobe documents sampled colors, adjustable fuzzy boundaries, partial grayscale coverage and inversion; it does not publish the numeric distance/alpha algorithm. This is a native encoded-RGB policy, not Adobe pixel parity. [Adobe Color Range](https://helpx.adobe.com/photoshop/desktop/make-selections/freehand-selections/select-a-color-range-in-photoshop.html).

For each RGB8/A8 pixel, let `D` be the minimum over authored swatches of `max(abs(R-r),abs(G-g),abs(B-b))`. With integer tolerance T and falloff F:

```text
if D <= T: K = 255
else if F == 0 or D >= T+F: K = 0
else: K = floor((2*255*(T+F-D) + F) / (2*F))
M = floor((2*K*A + 255) / 510)
if invert: M = 255-M
```

The plateau is inclusive; F0 is a hard D≤T threshold. Each T and F may be0..255, so T+F may reach510. Do not truncate the tail at255: T200/F100/D255 gives115. T255 gives composite alpha before inversion. Multiple colors union by nearest distance, never additive membership. Membership rounds to a byte before multiplication by alpha; T0/F4/D1/A2 gives K191 then M1, whereas fusion would give2. Alpha0 gives0 independently of hidden RGB; final inversion selects transparent pixels at255. A matching RGB with alpha128 produces128.

All shifted integer numerators are below2^17 and denominators at most510. Nonintegral quotients are at least1/510 from an integer boundary versus binary64 error below2^-44; integral boundaries are exactly representable. `Math.floor` therefore gives exact half-up integer results without BigInt. The independent oracle checked all16,777,216 T/F/D triples and65,536 membership/alpha pairs. Production uses one private256-byte membership LUT plus at most24 RGB sample bytes; no scalar-vs-LUT option is public.

## Shared contract and exact API

Architecture owns `shared/color-range.mjs` and `.d.mts` with these exports:

```js
COLOR_RANGE_POLICY = 'sampled-rgb-chebyshev-alpha-v1';
COLOR_RANGE_LIMITS = {
  maxColors: 8, maxTolerance: 255, maxFalloff: 255,
  maxComparisons: 192_000_000, comparisonBatch: 65_536
};
COLOR_RANGE_PREVIEW_LIMITS = {
  minEdge: 32, maxEdge: 2400, defaultMaxEdge: 700,
  maxBytes: 8_388_608, maxWorkingBytes: 268_435_456
};
normalizeColorRangeSettings(value);
// Owned { colors: string[], tolerance: number, falloff: number, invert: boolean }
```

Freeze constants. The strict normalizer accepts ONLY colors/tolerance/falloff/invert, with a plain or null-prototype object and known own enumerable data properties. `colors` is required: an ordinary dense array of1..8 exact seven-character `#rrggbb` strings. Accept upper/lowercase, canonicalize lowercase, reject duplicates after normalization, preserve authored display order. No extra/symbol/hidden fields, custom prototypes, holes, accessors or coercion. Omission defaults T32/F32/invertfalse; explicitly supplied undefined is invalid. T/F are integers0..255; canonicalize scalar -0 to0. Copy the array before any await/queue. Errors use `INVALID_ARGUMENT`; command validation maps them to its established `INVALID_ARGUMENTS` family.

Root owns these strict command envelopes:

```js
get_color_range_preview({
  documentId, expectedRevision, // optional positive read revision
  colors, tolerance: 32, falloff: 32, invert: false,
  maxEdge: 700 // integer32..2400
});
load_color_range_selection({
  documentId, expectedRevision, // positive required
  colors, tolerance: 32, falloff: 32, invert: false,
  mode: 'replace' // replace | add | subtract | intersect
});
```

No layer ID, coordinate sample, additional mask, live recipe, preview mode on Load or selection mode on Preview. Native-only; the optional Adobe bridge refuses both, including transaction steps. Load joins the existing at-most30-step transaction grammar with a positive outer revision and current document injected per step. Preview is read-only and excluded from transactions. Registration changes command count103→105; effect kinds remain28 global/32 source.

Preview response:

```js
{
  documentId, revision, sourceWidth, sourceHeight, width, height,
  colors, tolerance, falloff, invert, maxEdge,
  coveragePolicy: 'sampled-rgb-chebyshev-alpha-v1',
  sampling: 'nearest-pixel-center', mimeType: 'image/png', data
}
```

Echo owned canonical settings and authored order. PNG is opaque grayscale. Use existing half-up preview dimensions and nearest pixel-center sample coordinates from full rendered RGBA; do not resize/blur membership or measure a reduced browser image. Preview shows new candidate coverage **before** combining with active selection. It writes no mask asset/history/cache. Load returns the ordinary updated document and exact persisted selection descriptor.

Capabilities are `colorRangePolicy`, `colorRangeLimits`, `colorRangePreviewLimits`. Preview requires connected Native, exact Color Range policy, valid typed own limits, its command and preview limits. Load additionally requires the existing exact dense-mask policy/typed limits and its command because it can author alpha8. Preview does not depend on dense authoring capability or unrelated channel policy. Server graph/mask checks remain mandatory for both. Honor lower valid advertised ceilings; retain invalid/out-of-limit local drafts with a reason. Full canonical capability keys/epochs are part of UI read ownership.

## Safe ownership before parsing and queueing

Root exports `checkColorRangeCommandArguments(command,args)` from `shared/commands.mjs`. It returns whether a request contains either new command and performs descriptor-only preflight. Native execute invokes it FIRST, before old Photo/Dense checks or command-detection paths; its Boolean enables `validateCommand` owned snapshot for BOTH Preview and Load. Native direct dispatch also invokes it first. Shared `validateCommand` invokes it before Zod for HTTP/MCP and transactions. Native must not invent a second scanner.

Direct new command envelopes require plain/null-prototype own enumerable data fields. The scanner safely extracts the four settings fields and calls the strict normalizer. For transactions it checks the operations property, standard dense array indices, operation command and args through own data descriptors before outer `z.record` parsing or spreads. Structural accessors reject without invocation; unknown fields/values still receive ordinary schema validation. Strict settings semantics apply only to the new commands; no generic migration of unrelated parameter families. Both new reads and mutations capture their colors array and other arguments at call time, including while another queued operation runs.

Queue dispatch checks the document revision before pixels; an omitted read revision means the dispatched current revision, not a promise of call-time image state. The UI always supplies its captured revision. Render, response and image-decode installation retain document/revision/settings/capability/request/epoch ownership; selecting another layer does not retarget a document-scoped range. Mutation ambiguity must survive panel teardown and be shared with other active-selection producers: a pending/unconfirmed channel load must not permit a competing Color Range load, or vice versa. Reuse the existing document-owned selection-load state or an explicitly shared narrow controller. No automatic replay or durable receipt claim.

Manual hex/color controls and **Add foreground color** are the complete first authoring path. Existing Eyedropper may set foreground first, but `sample_color` has no server expectedRevision/result identity and turns alpha0 into black. Do not change it or claim atomic current-revision sampling. Copying an authored foreground black is valid. No new in-panel click sampler is included.

## Native helper and operation sequence

Architecture owns `server/color-range.mjs` with bounded proposed exports:

- `compileColorRange(settings)`: validates/copies settings and returns a private `(R,G,B,A)=>M` RGB8 callback; typed tables never escape.
- `colorRangeComparisonWork(pixelCount,colorCount)`: metadata-only safe integer multiplication and the192M limit.
- `materializeColorRangeSelection(graph,args,render,resolveAlpha8)`: snapshots settings, extracts only candidate bytes from a private awaited helper, then uses existing `combineMaskAlpha`; only final alpha escapes.
- `renderColorRangePreview(graph,args,render)`: snapshots settings, samples in a private awaited helper, then encodes bounded grayscale; only response gray/metadata escapes extraction.

`compileColorRange` can be tested independently. Integration must call it **after await render** inside the private extraction/sampling helper; returned renderer pixels, matcher closure and typed tables must not escape to combination or publication. Shared normalized immutable strings/numbers are bounded metadata, not an additional canvas plane. Input RGBA remains unmodified. Validate rendered byte length against the declared canvas before scanning.

Both commands validate graph, dimensions, settings, comparison work and operation phases before any RGB or mask-asset read. Force `validateDenseMaskOperation` even if the original graph has no Dense/LUT/Distort marker. Also force the runtime `withMaskPreparationBudget` in dispatch for both commands and in mutate for Load, so nested render/combination shares the admitted operation counter. Each transaction step gets its own operation scope; nested renders cannot reset it. Existing runtime mask accounting stays separate from sample comparisons.

The fresh composite includes existing visibility, filters/effect masks, Fill, additional masks, outside effects, clipping, groups, adjustments and protected/generated composition. Active selection does not gate measurement. Selection authoring does not remove later protection restrictions. No alternate renderer/source selector is added.

Before rendering, Subtract/Intersect require active selection or refuse `NO_SELECTION`. Replace/Add with no selection use candidate directly. Existing combination uses continuous left coverage, candidate/255 right coverage, max/Add, left×(1−right)/Subtract or left×right/Intersect, then existing byte rounding. Preserve the geometric1/6 intersect69 result11; never prequantize left to43. Empty output stays explicit empty RLE, not null/unrestricted selection.

Load calls `publishMaskAlpha` only after the materializer returns final alpha. Use the existing outer `withRepairAssets` for direct and transaction dispatch and pass `context.validateCommit`. All candidate graph/typed alias/known-hash/history/JSON validation and owned-file rollback apply unchanged. A late transaction or real persistence failure removes newly created links while preserving shared prior assets, graph, cursor and history. Do not publish from a nested helper retaining source RGBA or intermediate candidate/coverage callbacks.

## Resource phases and scheduling

Let Q be full canvas pixels, P preview pixels, C authored colors, and Bactive the existing prepared-selection backing/feather reservation. Apply the existing forced Dense joint graph estimate for both commands; its root/ancestor/clipping/global/source/decoration/callback bounds remain intact. This does not promise every24MP graph fits or total RSS/codec bounds.

| Phase | Named live requirement |
| --- | --- |
| Render | Existing forced joint graph estimate; matcher not compiled yet |
| Load extraction | `5Q + 280` |
| Combine | `2Q + Bactive`, active callback omitted for Replace/no selection |
| Adaptive publish/dedup | `3Q + 64` |
| Preview sampling | `4Q + P + 280` |
| Preview encode/base64 | Existing channel envelope `5P + E + 5*4*ceil(E/3)`, E=8MiB |

Validate the maximum of graph and applicable sequential phases; do not add them all as if co-live. Existing render mask-preparation work plus one active-selection preparation for a non-Replace combine remains within384M. Exact stored RLE→alpha8 switch remains200000 nonzero runs. Keep256 unique/3GiB retained dense refs,16MiB metadata and193-asset/256MiB portable bounds. No new asset class, mask consumer/cache, history format, recipe transfer or garbage collection is introduced.

Separately charge Q×C comparisons for Load, P×C for Preview, bounded by192000000. Charge all C even if early exact matches, alpha0 or T255 could simplify a pixel; production need not add such shortcuts. This is a per-operation matcher bound, not a whole-render/transaction CPU limit. Both commands still render and admit full Q. Loop batching uses `floor(65536/C)` pixels, yielding after each complete batch: at most65536 comparisons and, at C8,8192 pixels. A final partial batch is smaller. Existing combination/storage scans retain their existing≤65536-pixel cadence. No await is required for the bounded256-entry table setup.

The isolated quiet-window [measurement](../test-results/color-range-evaluation/architecture-benchmark.json) used warm repetitions on Node22.14.0/darwin arm64 with diverse RGB and alpha0/1/2/128/254/255. At24MP, scalar/LUT medians were272.03/277.16ms for one swatch and507.74/491.71ms for eight; eight-swatch lookup max492.96ms and5ms-heartbeat max5.15ms. Wide/tall1MP cases were consistent. Both paths matched exact hashes; results had31/53 distinct coverage values. An initial synthetic pattern lacked useful color diversity and was replaced before retained measurement. The LUT choice provides bounded fixed membership evaluation; it is not universally faster. These measurements exclude render, combination, publication and codecs; actual registered production loops and an admitted complete load still need measurement after functional tests in a quiet window.

## Acceptance and ownership

Root owns shared command scanner/schemas, status forwarding, MCP image/help, official SDK and full regression. Architecture owns shared constants/strict normalizer/declaration, native matcher/extraction/preview/registration/resource integration and owner tests. UI owns the document-scoped swatch/preview/load flow and browser checks. Independent review owns exact oracle, native/client audits and final resource/source review. Advertise only when both paths are callable and old semantics remain intact.

Required evidence:

1. Strict pure settings and exact reference: literals, plateau/tail boundaries, two roundings, alpha/hidden RGB, duplicate/case/order, T+F>255, frozen/null-prototype inputs, getter0, output ownership. Promote only bounded meaningful tests; exhaustive development evidence already exists.
2. Real native Preview/Load equality on small literals and photo/high-texture fixtures, maxEdge sampling/metadata/PNG size, input/source immutability, one/ eight swatches, retained Fill/styles/filters and no provider calls.
3. All four combinations, continuous geometric-left and byte/dense masks, explicit empty output, no-selection and metadata resource/work refusal before reads. Count lower cap boundaries via pure resource seams without allocating huge planes.
4. Execute/direct-dispatch/enclosing-TX getter refusal and queued Preview/Load call-time ownership. Force runtime budget even on legacy-only graph; respect per-step/nested scope.
5. Exact dense fallback beyond200000 runs, Save Selection, mask/adjustment/source-mask use, paint/canvas compatibility, Undo/redo, portable/restart, stable request replay, real commit error and late transaction cleanup with deduplicated shared assets.
6. UI independent preview/load/dense capability gates, manual/foreground samples, exact raw drafts, invalid duplicate/empty list, no-selection modes, document-revision/draft/capability late-result rejection, shared pending/unconfirmed selection ownership, keyboard/focus/layout and truthful grayscale preview.

The original photograph and all input assets remain unchanged. Approved default32/32 has useful smooth orange coverage but can match similarly colored backgrounds and near-black regions for dark-blue samples; show this honestly. Completion requires focused tests, independent review, complete regression and browser acceptance. Finish Color Range, then stop without initiating another feature.

## Manual-testing stopping point

Production shared/native Color Range implementation is callable. At the user's requested stopping point, root reports all97 schema tests and all3 official SDK workflows passed, including photographic masked adjustment/Fill/source-filter/style use, portable restart, rollback and synthetic generation hard clipping. Architecture's last focused run passed6 of7 owner tests. The remaining assertion incorrectly compared the normalized working PNG with the imported original PNG; it now compares the working asset with its own pre-operation bytes. This test-only correction has **not been rerun**, and no production failure was identified by that assertion.

Architecture owns no running test or benchmark process. Production performance measurement and final combined regression remain unperformed; the measurements above are explicitly isolated prototype evidence. UI/build and independent audit completion are recorded by their respective owners/root. Stop here for manual testing; do not treat the incomplete acceptance checks as completed.

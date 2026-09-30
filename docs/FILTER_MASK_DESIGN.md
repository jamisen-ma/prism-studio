# Editable source filter-stack mask

Native backend implemented and verified, 2026-09-19. Root accepted the enabled toggle, native density LUT, exact-copy capture with its separate CPU limit, yielding bitmap preparation and complete-source pre-read admission after independent review. The focused owner/audit/schema/SDK checks pass24/24; the combined run with adjacent backend suites passes65/65. Whole-suite and browser release evidence is maintained by those owners. Independent findings belong in `FILTER_MASK_REVIEW.md`.

One source-coordinate mask controls how much of the **finished filter stack** replaces the original working RGB. It does not hide the layer. Black restores the pre-stack working RGB, white keeps the stack result, and gray interpolates between them. Source alpha, source-cutout alpha, the later additional layer mask, geometry and document compositing remain separate.

Adobe documents a shared mask for all Smart Filters, selection-based creation, painting, density/feather/inversion and mask-only display in [Applying Smart Filters](https://helpx.adobe.com/photoshop/using/applying-smart-filters.html#mask_smart_filters). This is a workflow reference. The coordinates, alpha8 weighting and bounded native implementation below are Prism's explicit policy, not Photoshop file-format or pixel equivalence.

## Proposed first slice

Include a shared mask for a nonempty raster filter stack, explicit reveal-all/hide-all, active-selection capture through provably exact integer-copy geometry, source-coordinate rectangle/ellipse/bitmap authoring, editable feather/invert/density/enabled, and read-only raw/effective grayscale inspection in the retained source frame. Existing filter edits, source geometry, native history/bundles and explicit source Bake continue to work.

Do not include per-entry masks, mask position/unlinking, filter-mask painting, morphology, filter-mask-to-selection loading or mask-aware recipes yet. Arbitrary affine and resize inversion is not approximated. A mask can still be authored directly in source coordinates on a transformed layer, or created before transforming it. These exclusions keep the first feature useful without borrowing the canvas-anchored additional-mask semantics.

Source polygons are not a first-slice descriptor type. A polygon active selection remains usable because capture materializes its current coverage into a bounded source bitmap. This avoids introducing a potentially 256-edge per-source-pixel polygon workload into every filter render.

Proposed native mutations, each with document/layer identity and positive captured `expectedRevision`, plus the existing optional-revision read-only preview:

```js
set_layer_filter_mask({
  documentId, expectedRevision, layerId,
  source: 'selection' | 'all' | 'none' | 'mask',
  mask?: SourceMaskDescriptor // required only for source:'mask'
})
modify_layer_filter_mask({
  documentId, expectedRevision, layerId,
  feather?: number, // finite 0..100 source pixels
  invert?: boolean,
  density?: number, // any finite Number in 0..1
  enabled?: boolean
})
clear_layer_filter_mask({documentId, expectedRevision, layerId})
get_mask_preview({
  documentId, expectedRevision, layerId,
  source: 'filter-mask', maskMode?: 'raw' | 'effective', maxEdge?: number
})
```

Set replaces the previous mask and resets density to1 and enabled totrue. Selection/all/none start at feather0 and invertfalse. A direct descriptor retains its explicitly authored feather/invert, defaulting to0/false. All creates a full-source rectangle; none creates an explicit empty source bitmap, not null. `source:'mask'` requires an explicit rectangle, ellipse or bitmap shape. Rectangle/ellipse x/y are nonnegative integers, width/height positive integers, and their complete bounds must fit the immutable current working-source frame. Bitmap dimensions must equal the source dimensions; optional authored x/y must be exactly0 and normalize to stored x:0/y:0. No positioned wrapper, clip, density, enabled, source asset, arbitrary key or nested mask is accepted in the coverage descriptor. Public mask input is copied and strictly normalized before queueing.

Modify requires at least one supported property, preserves omitted properties and validates before assignment. Disabling the mask preserves its density, descriptor and feather/inversion while revealing the complete filtered result; re-enabling restores the retained settings. Density0 also restores the full result but is not a substitute for the enabled toggle. Neither bypass disables the filters. Clear removes only the mask and reveals the full stack. Missing layer, missing stack and missing mask give `NOT_FOUND`, `NO_FILTERS` and `NO_FILTER_MASK` respectively. Selection capture without a selection gives `NO_SELECTION`; an explicit empty selection succeeds with an empty mask. Unsupported capture geometry gives `FILTER_MASK_CAPTURE_GEOMETRY`, before any mask allocation or image access. Ordinary metadata/run/work limits retain `LIMIT_EXCEEDED`.

The three mutations participate in transactions, preserve request-id/session dedupe and create one undo step at the outer commit. A transaction can add a filter then set its mask on the same layer. Positive revision is required on standalone commands and on the enclosing transaction; step validation should follow the already released Bake revision-injection convention. Commands operate on private staged metadata, never write image assets, and must validate the candidate graph before a subsequent pixel operation can execute.

Proposed capabilities:

```js
layerFilterMaskPolicy: 'source-stack-alpha8-v1'
layerFilterMaskCoordinates: 'source'
layerFilterMaskSources: ['selection', 'all', 'none', 'mask']
layerFilterMaskShapes: ['rectangle', 'ellipse', 'bitmap']
layerFilterMaskProperties: ['feather', 'invert', 'density', 'enabled']
layerFilterMaskCaptureGeometry: 'integer-copy-v1'
maskPreviewSources: [...existingSources, 'filter-mask']
limits.maxFilterMaskWorkingBytes: 268435456
limits.maxFilterMaskCaptureWork: 384000000
```

The command and exact policy gate are both required for authoring. Source filter kind/blend gates continue independently. A capability disappearance cannot silently clear an existing mask or convert it to a layer-coverage mask. Read-only display may still show retained metadata; unsupported mutations remain disabled.

## Persistence, public projection and stack lifecycle

An optional `layer.filterMask` persisted by itself would be unsafe: older native graph readers ignore unknown layer fields and would display unmasked filters. Use a strict alternate `layer.filters` shape only when a mask exists:

```js
filters: {
  version: 1,
  entries: [ /* the existing 1–8 strict filter records */ ],
  mask: {
    sourceWidth: layer.width,
    sourceHeight: layer.height,
    coverage: { /* strict source Mask descriptor */ },
    density: 1,
    enabled: true
  }
}
```

Existing arrays and omitted filters retain their exact stored representation and behavior. Older readers reject this non-array at their existing `normalizeLayerFilters` boundary, including disabled or density0 masked stacks. Wrapper keys, version and nested mask keys are strict; enabled is a required Boolean in persisted wrappers. Source dimensions must equal the layer's working source and obey8192-axis/24MP limits. Validate the entire mask even if every filter or the mask is disabled or density is zero. Additional-mask positioned wrappers and arbitrary source frames are forbidden. Empty wrappers are invalid.

New readers use a common pure stack accessor and a separate strict normalizer everywhere internal filters are inspected. The low-level existing array evaluator can stay unchanged behind a new whole-stack evaluator. Do not pretend the wrapper has `.length`, and never catch an unsupported wrapper by returning an empty stack.

The document response projection remains `layer.filters: FilterEntry[]` and adds a **read-only** `layer.filterMask` containing sourceWidth/sourceHeight, coverage, density and enabled. This keeps existing public filter-list consumers readable. It is an explicit presentation projection; project files, history and `.prism` bundles retain the strict wrapper. Projection fields must never be accepted as persisted graph metadata. Reject a top-level persisted `filterMask` field, whether alone or paired with a wrapper. Never feed a public projection into bundle export or graph persistence.

Lifecycle rules are uniform, including hidden, disabled, all-white and density0 masks:

| Action | Result |
| --- | --- |
| Add/update/reorder filter | Preserve the one mask and its source frame |
| Delete a filter while others remain | Preserve the mask |
| Delete the final filter | Remove the mask atomically and store the existing empty array form |
| Clear filters | Remove all entries and the mask atomically |
| Clear filter mask | Restore the exact entries as a legacy array; full filtered appearance returns |
| Bake an active stack | Bake the masked source RGB, then clear both stack and mask |
| Bake an entirely inactive stack | Clear both metadata-only, without asset reads/writes |
| Duplicate/history/reopen/bundle | Independent deep copies of entries and source mask |

No mask may outlive the last filter. The UI must state that deleting the final filter, Clear filters and Bake consume the shared mask. It should label the mask separately from the ordinary additional layer mask.

Current edit recipes have no source-coordinate masks. Capturing filter steps from a masked stack must refuse with a concise explanation, even for white/density0/inactive masks, rather than silently dropping scope. Definition-only manual recipe save/import stays unchanged. Applying or validating an existing filter-only recipe against a masked layer appends the steps normally while preserving its mask and running full resource/protection checks. This slice does not expand the recipe allowlist or copy a mask between differently sized documents.

## Coordinates and exact selection capture

The persisted mask always belongs to `layer.width × layer.height`, before all geometry. Applying crop, canvas bounds, resize/resample or arbitrary affine transforms later does not rewrite the mask: masked RGB goes through the same existing geometry as source RGB. Additional masks stay in their separate document-coordinate frame. No inverse map is needed to keep an existing source mask working.

Capturing the current document selection is allowed only if **every** retained transform is one of:

1. Integer crop.
2. Integer canvas translation/padding.
3. The renderer's exact affine copy branch: scaleX=scaleY=1, rotation=0, no flips, integer x/y, unchanged dimensions.

Reject resize/resample even when a particular requested size happens to match, and reject all other affine transforms. A scale followed by its inverse is still a resampled source history, not an exact frame. This rule is deliberately structural and inspectable by both client and native.

Compile a source-to-current offset `(dx,dy)` and a surviving source rectangle, initially the full source. For a crop subtract its origin; for canvas/affine copy add the translation. After **each** stage intersect the surviving rectangle with the preimage of that stage's output bounds. Empty intersections remain empty. This is O(transform count), bounded by the existing500 records, and requires no image buffers.

For each source integer pixel `(x,y)` surviving every clip, sample the current selection at `(x+dx,y+dy)` using its existing pixel-center coverage. Otherwise sample zero. The active selection's own inversion, feather and persisted document clip are evaluated before capture. Bitmap selections use the new yielding, byte-equivalent bitmap preparation helper too; they must not enter the legacy synchronous feather constructor. Geometric selection clips remain after source inversion, exactly as today. Quantize once to alpha8, encode bounded RLE, and save it as a source bitmap with feather0/invertfalse/density1/enabledtrue. Thus capture intentionally bakes the current selection's soft coverage; future feather/invert edits operate on that captured bitmap, not on the old selection descriptor.

Selection outside the source or in newly padded transparent canvas cannot create source pixels and contributes nothing. Source content discarded by an intermediate crop remains masked off even if a later canvas expansion restores the same dimensions. Example: width4 source cropped to middle pixels1–2, then padded byx1 back to width4, captures `[0,255,255,0]` from a full current selection, not four white pixels. Layer opacity/visibility, own/ancestor coverage masks, clipping, styles, cutout alpha and source RGB do not participate in capture. A selected source location may be transparent; its mask value remains valid if alpha is changed after an explicit Bake/Clear workflow.

Source geometry introduced after capture can move or resample the **masked RGB**, including edge interpolation with neighboring source pixels. This is source-stage localization, not a promise that a fixed document-space selection boundary survives later scaling unchanged.

Canvas filter-mask painting could later use exactly this copy-map predicate and map brush points/radii into source pixels while intersecting the surviving rectangle. It would need explicit behavior for preexisting feather/inversion, active selection/protected context, pressure and complexity limits. Reusing the current document `mask_brush` would instead edit an additional mask and silently change frames. Defer painting rather than adding a second canvas tool target without that contract. Users can create/edit a selection and recapture it, or author a source descriptor, in this slice.

## Numerical policy and alpha invariants

Let `O` be pre-stack working RGBA after combining separate source-cutout alpha once. Evaluate the existing ordered filter stack completely to obtain `F`, including each candidate's quantization, blend mode and opacity. The shared mask never gates a blur neighborhood, histogram, noise counter, per-entry input or effective source alpha. This distinction matters: a blur near a black mask region still samples the same full source as an unmasked stack.

Evaluate source mask coverage only after the existing filter evaluator returns. Geometry uses the existing mask coverage formula; bitmap feather uses the same alpha8 chamfer arithmetic as existing bitmap masks. Apply the descriptor's inversion, then form the raw mask byte:

```text
M = clamp(Math.round(255 * rawCoverage), 0, 255)
```

Density retains the exact authored finite Number in[0,1]. Compile at most one256-byte lookup table after filtering, using the **existing native bitmap-density expression**:

```text
density 0: E[M] = 255
density 1: E[M] = M
otherwise: E[M] = clamp(Math.round(255 - density * (255 - M)), 0, 255)
```

This is a declared binary64 floating density stage, not exact-real multiplication, an IEEE-rational reinterpretation, or continuous geometric additional-mask parity. For black raw coverage, stored density0.1 gives230 under this expression; exact arithmetic on its binary64 rational would give229. Neighboring0.09999999999999999 and0.10000000000000002 both give230 here. Density0.49999999999999994 and0.5 give128, while0.5000000000000001 gives127. Pin these values and all256 raw bytes. Do not add an epsilon, round the authored density, or change existing layer-mask arithmetic.

For each positive-alpha source pixel and each RGB byte:

```text
n = O * (255 - E) + F * E
outputRGB = floor((2*n + 255) / 510)
outputAlpha = O.alpha
```

All terms are small exact integers: `0<=n<=65025`, doubled numerator at most130305. Noninteger division results are at least1/510 from an integer, many orders above binary64 rounding error. This is exact half-up RGB interpolation after the mask's explicit alpha8 stages. E0 returns O byte-for-byte; E255 returns F. Fully transparent source pixels keep O's original hidden RGB and alpha unchanged. No separate output frame is needed: mix into the already-owned filtered buffer. Never mutate the caller's original input.

The raw/effective mask preview reports exactly M/E used by this mix, sampled in the source frame. It must not include source/cutout alpha, layer/ancestor masks, visibility, opacity or geometry. Disabled or density0 effective inspection is solid white, while raw inspection still shows the retained mask. `get_layer_preview` source/cutout views retain their existing meanings; `load_layer_selection source:'content'` remains unfiltered alpha and cannot change because of this RGB-only mask.

If there are no active entries, skip mask evaluation and return O without mutating it or claiming an owned output. Disabled or density0 masks bypass sampling and return F after ordinary filter evaluation. Do not infer inactive/protected status from an all-black/all-white mask or from computationally identity candidates: existing structural filter guards remain authoritative. The first slice does not skip full filter evaluation merely because sampled mask coverage would be black.

## Resource phases and yielding

Let S be source pixels, N document pixels, L the largest retained geometry frame, R the maximum sequential spatial-filter ring, T the existing shared noise-table reserve, and C the mask preparation peak. For source rectangle/ellipse C=0; unfeathered bitmap C=S; feathered bitmap C=5S (alpha8 plus Float32 distance). Keep this conservative preparation peak through the mask mix even if the distance array becomes unreachable earlier. Fractional density adds a256-byte LUT; density1 may use M directly, and disabled/density0 masks bypass C/LUT completely. Validate all descriptors regardless of bypass.

Construct coverage in a separate awaited post-stack helper; only its finished RGBA returns. Consequently the mask callback/LUT do not coexist with a Gaussian ring, and no mask callback survives into later geometry or another leaf. No persistent/global mask cache is introduced.

Renderer additional scratch becomes:

```text
max(8*L, 8*S + R, 4*S + C + LUT) + N
```

Add existing retained group/clipping surfaces, positioned additional-mask callback reserves and the shared T after the graph peak exactly as today. This is the established named **additional** renderer-buffer envelope, not total memory including the base renderer or native codec caches. A masked direct evaluator also admits its complete source phase before allocating: `max(12*S+R, 8*S+C+LUT)+T <= 256 MiB`.

Apply that complete-source predicate in graph validation for every leaf whose mask will actually evaluate (active entries, mask enabled, density>0), including hidden leaves, using the graph-wide T even if Gaussian noise belongs to a different layer. This second named gate prevents a metadata-accepted masked stack from failing the evaluator's own gate only after source decoding. In particular a24MP scalar source with an enabled rectangle mask fails the conservative12S phase before reads; the absolute no-ring ceiling is22,369,621 source pixels before other limits. Feathered bitmaps may be smaller still. Legacy unmasked, disabled-mask and density0 calls retain their existing admission/bytes. Both predicates and limits must be visible in error copy/documentation; neither is a total RSS claim.

Bake keeps its existing encoded-input/decode/filter/encode/publication ledger and adds a separately compared mask phase:

```text
Ew + Ea + (hasAlpha ? 13*S : 8*S) + C + LUT + T
```

The13S term retains working4S, effective4S, filtered4S and alphaS. Without separate alpha the original and effective buffers alias. Compare this phase against the existing `(hasAlpha?17:12)*S + R +64KiB` filter phase rather than adding C and R. Check actual encoded source sizes plus these estimates before source byte reads or decoding. The mask helper must complete before restoring working alpha/returning the final surface for encode; later Bake phases do not retain C or LUT. The existing full mutate-through-commit new-asset rollback scope remains unchanged.

Selection capture uses source alpha8 output S plus the current selection callback Cselection (0 for geometric, N for bitmap,5N if feathered), with a256MiB operation ceiling. Its RLE metadata is bounded separately by600,000 scalars/200,000 runs and the existing16MiB project/history limit. Build the entire candidate before assignment; run/serialization/persistence failures leave selection, stack, assets, graph/history and caches unchanged. Direct source-mask authoring is metadata-only and allocates no pixel plane or LUT.

Capture has a distinct384million weighted-visit ceiling, checked from metadata **before** coverage construction or source alpha8 allocation. Let V be the area of the exact surviving source rectangle (zero for an empty intersection), H its sampled row count, and P the selection polygon vertex count, or0 otherwise:

```text
captureWork = S + 8*V
            + (polygon ? 2*P*V + H*P*(2+ceil(log2(P))) : 0)
            + (bitmap ? (feather>0 ? 8*N : N) : 0)
```

S charges the source RLE traversal;8V charges sampling/quantization. Polygon work additionally reserves per-pixel crossing/distance checks and each row's crossings/filter/sort construction, even for a very thin surviving source rectangle. Bitmap preparation covers the full current selection frame, even when only a small part is sampled. Invalid/huge stored feathers and all bitmap metadata still validate before this estimate. A24MP/256-edge polygon cannot trigger billions of checks: it rejects this separate capture gate before allocation. This command-work limit is distinct from the retained stack's384million render-work admission, and both must pass.

Read-only inspection adapts the existing mask preview estimator to **source**, not canvas, dimensions: `C + LUT + 5*P + 8MiB + 5*B`, with P the bounded sampled plane and B its existing worst-case base64-length reserve. It uses default edge700, cap2400, exact ratio dimensions and center-nearest sampling. It needs no RGB decoder, asset read, render cache or project write. The response carries `source:'filter-mask'`, `coordinates:'source'`, layerId, documentId, revision, sourceWidth/sourceHeight, returned dimensions and raw/effective mode.

Propose a conservative additional8*S work charge whenever there are active filters, the mask is enabled and density>0, including white/black masks; inactive stacks/disabled masks/density0 add zero. This joins the existing384million document-wide work budget, including hidden layers. It is separate from each entry's candidate/blend work and must be checked on mask enabled/density/feather/source changes, ordinary filter edits, recipe staging and every relevant transaction step before later raster work. Setup is bounded by one256-entry LUT, not by per-pixel BigInt.

New mask decode, feather passes, RLE encoding and RGB mixing should yield at most every65,536 visited pixels/cells; source run decoding also yields by visited count rather than relying on run endpoints coinciding with a coordinate multiple. Capture yields by weighted work: include polygon row-setup cost and pixel cost8+2P, yielding before a next row/pixel would exceed65,536. A256-vertex polygon thus samples at most126 pixels per batch, fewer when charging row setup; never allow65,536 such pixels between yields. Implement byte-equivalent async bitmap feather preparation for both source masks and bitmap selection capture. The legacy synchronous `maskCoverage(bitmap)` showed a34ms gap at only1MP in the probe, so merely calling it inside an async outer loop would not meet this new scheduling intent. Keep all existing legacy consumers unchanged. Typed allocation, legacy geometry and OS scheduling are not hard deadlines; geometric selection coverage retains the existing formulas and bounded row metadata.

## Consumer audit and validation requirements

All internal consumers must use the same stack accessor: native active/protection/resource checks; array mutation and commit candidates; source/cutout refinement, paint/fill, retouch and placement guards; renderer/contextual restoration; Bake planning/estimation/materialization; PSD preflight; source previews and alpha-selection bypass; recipes; duplication and public document projection. Native source guards must still block every nonempty stack, even with disabled entries or an all-black mask. This avoids making a wrapper accidentally appear editable through `.filters?.length`.

Client public arrays stay stable, but mask presence needs a separate check in recipe capture, lifecycle explanations and capability gates. Existing `canEditCutoutAlpha`, source placement and paint guards can continue to check projected array length; test that masked arrays are never omitted from projection. Internal bundle validation rejects invalid wrappers/source frames/unsupported descriptors before image metadata or filesystem work. The wrapper remains in bundles and histories; public projection must not contaminate either.

Strict PSD export continues to reject any nonempty filter stack, including a masked disabled stack, before rendering. It must not silently convert the source-filter mask into a PSD additional layer mask. Explicit Bake or Clear remains the route to the existing PSD subset. Flat PNG/JPEG/WebP/TIFF render the mask through the common source pipeline.

Mask edits require an unprotected raster target just like stack edits, including for an inactive stack. Existing lower protected-context RGB restoration occurs after masked source geometry and remains unconditional wherever the original protected footprint requires it. Generated-role hard exclusions and clipping/group rules remain unchanged. Source mask changes cannot enable brushing over protected pixels or strip provenance. Active Bake retains its conservative earlier-protected-content rejection; the mask's current colors do not weaken that guard.

## Probe evidence and acceptance gate

`test-results/filter-mask-evaluation/probe.mjs` is design-only and uses no asset/model publication. It compares the compiled capture rectangle with actual `renderLayerGeometry` byte-copy/crop output using independently encoded source-pixel identities. All160 seeded exact-copy programs pass, including intermediate clipping; five resize/noncopy-affine fixtures refuse. The RGB-mix oracle passes331,072 BigInt cases. The explored exact-IEEE density LUT passes14,080 independent repeated-doubling comparisons, while the selected native density LUT separately pins14,080 byte-expression cases and the explicit counterexamples above. The async bitmap-feather prototype matches7,474 legacy coverage samples across80 random masks exactly.

Three-run prototype medians, Node22.14.0 on Darwin arm64 / Apple M5 Max, include mask construction and RGB mixing but exclude filter evaluation, source decoding and document rendering:

| Source | Mask | Median |
| --- | --- | ---: |
|1024² |Rectangle, feather0 |11.8ms |
|1024² |Ellipse, feather20 |27.7ms |
|1024² |Bitmap, feather0 |18.9ms |
|1024² |Bitmap, feather20 |37.9ms |
|8192×128 |Bitmap, feather20 |41.2ms |
|6000×4000 |Bitmap, feather0 |328.6ms |

The largest observed5ms heartbeat gap is9.12ms after switching bitmap preparation to yielding passes. These timings support an8*S proposal without promising real-time latency. Production acceptance must repeat meaningful cases through the integrated masked evaluator/Bake after source and schema approval.

The separate adversarial polygon probe is `capture-probe.mjs` / `capture-report.json`. A256-edge crossing-heavy polygon with persisted feather1,000,000 at1024×716 costs383,821,824 declared capture visits including row sorting; it samples in1.31s with a5.47ms maximum observed heartbeat gap. The65,536 weighted-visit yielding rule covers row setup and at most126 such pixel samples between yields. A512×240 case costs64,634,880 visits and takes249ms;256×128 takes71ms. These deliberately expensive masks are bounded before sampling, irrespective of their eventual quantized coverage being empty.

Required independent acceptance includes all-byte density/mix endpoints and neighboring decimal ties; multi-entry order and blend before whole-mask application; blur neighborhood independence; all alpha values/hidden-RGB perturbation; exact geometry capture with irreversible intermediate clips; raw/effective source previews without source files; graph/Bake phase boundaries where each old phase fits but the new mask phase fails; hidden/disabled malformed wrappers before reads; old-array byte/serialization regression; public projection versus portable wrapper; last-delete/Clear/inactive-Bake lifecycle; filter-only recipe append and masked-capture refusal; original protected/generated/group/clipping context; exact source Bake and original/cutout-alpha retention; one-step transactions, stale revision, retry/undo/reopen/portable and real persistence/asset rollback.

## Production implementation and measurements

`server/filter-mask.mjs` implements strict internal wrapper/descriptor access, exact native density-table compilation, byte RGB interpolation, yielding bitmap feather preparation, exact-copy selection mapping, capture CPU/buffer admission and bounded RLE. Rendering/resources integrate through `server/layer-filters.mjs`; native mutation, public projection and source-edit guards through `server/native.mjs`; source-only inspection through `server/mask-preview.mjs`; and the separately compared mask phase through `server/filter-bake.mjs`. No additional image asset role or persisted public-projection field was introduced.

The owner suite `tests/filter-mask.test.mjs` passes8/8. It covers strict descriptors and bypass records, arbitrary density boundary examples, all27 source filter kinds under a final mask, full-stack versus per-entry application, alpha/hidden RGB, bitmap-feather equivalence and sparse-run yielding, exact capture/intermediate clipping, polygon and RLE refusal, complete-source/Bake phase admission, queued-argument snapshots, metadata persistence rollback, public/internal lifecycle and odd-dimension source preview. Independent `tests/filter-mask-audit.test.mjs` passes10/10, including original protected/generated context, full source-edit guards, source inspection with inaccessible RGB, masked-source and combined group/chain/positioned/other-leaf-noise boundaries before reads, scoped recipes, hostile bundles and real mixed Bake/paint/late-failure rollback.

Root's four schema and two official MCP workflows pass. The combined65-case run additionally includes legacy layer-filter/Bake/mask-preview/High Pass suites, protecting the existing unmasked paths. Review findings fixed before handoff were a null wrapper mask accepted through truthiness checks, explicit null feather inheriting a legacy default, early RLE length admission before a key-array scan, and ensuring the new capture encoder yields per65,536 pixels rather than inheriting the old selection encoder's32-row schedule. These do not change the approved valid-record policy.

Actual evaluator measurements are in `test-results/filter-mask-evaluation/production-probe.mjs` and `production-report.json`, Node22.14.0 / Darwin arm64 / Apple M5 Max, three-run medians. Each render workload runs a real brightness filter followed by the shared mask, including stack output allocation and opacity loops; decode, whole-document rendering and PNG encoding are excluded.

| Workload | Median | Largest observed5ms heartbeat gap |
| --- | ---: | ---: |
|1MP rectangle, density0.1 |57.6ms |8.61ms |
|1MP ellipse, feather20 |68.0ms |6.40ms |
|1MP bitmap, feather0 |59.1ms |8.18ms |
|1MP bitmap, feather20 |84.1ms |7.28ms |
|8192×128 /128×8192 bitmap, feather20 |82.7 /87.8ms |10.87 /5.83ms |
|20MP bitmap, feather20 |1494.2ms |12.79ms |
|24MP disabled mask /density0 mask |864.5 /860.8ms |15.78 /12.39ms |
|383,821,824-work polygon selection capture |1256.2ms |5.56ms |
|4MP inverted bitmap selection capture, feather20 |157.7ms |5.63ms |

The disabled/density0 workloads measure the existing unmasked brightness path at24MP; they construct no filter-mask pixel callback or LUT. A4MP feather100 capture initially exercised the expected200,000-run metadata refusal; the successful capture benchmark uses feather20. Work/buffer admission does not guarantee that a later RLE or total project/history serialization will fit. All refusals preserve the prior state. These measurements support the retained8*S and separate capture policies without hard timing or process-RSS guarantees. Production timing was complete before the parent began the whole backend suite.

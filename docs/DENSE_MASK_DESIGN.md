# Framed alpha8 masks and composite-channel selection

Status: **implementation and acceptance complete; final native regression1177/1177 and88 browser workflows pass**, 2026-09-19. This develops [DENSE_MASK_ARCHITECTURE.md](DENSE_MASK_ARCHITECTURE.md), [DENSE_MASK_SEAMS.md](DENSE_MASK_SEAMS.md) and the measured photographic failure in [CHANNEL_WORKFLOW_EVALUATION.md](CHANNEL_WORKFLOW_EVALUATION.md). Independent review is tracked in [DENSE_MASK_REVIEW.md](DENSE_MASK_REVIEW.md). The implementation adds the declared native representation and two commands; legacy-only admission and pure legacy coverage helpers remain unchanged.

## Complete first slice

Add one explicitly tagged, immutable, framed raw alpha8 mask asset, plus asynchronous prepared coverage in every existing mask consumer. The first new producer loads the exact continuous Red, Green, Blue, encoded luma or Alpha coverage of the current document composite into the active selection. A separate read-only channel preview displays that same prospective coverage as opaque grayscale. Save/load/combine selections, additional masks, filter-stack masks, paint/fill, morphology, canvas changes, inspection, PSD compatibility checks, Undo, restart and portable projects must all understand the representation before the producer is advertised.

The practical result is exact ordinary512² and1MP photographic channel selections, which currently exceed the200000-run RLE ceiling. Raw storage does not change samples, quantize coverage further, reduce resolution or raise that ceiling. Existing RLE/geometric records and pixels stay unchanged by reading them. There is no generic mask library, alpha file upload, PNG decoder, RGB channel painting, channel calculations, cache service or garbage collector in this slice.

Adobe describes color channels as grayscale information and alpha channels as stored selections; its Calculations workflow is broader than this first composite-channel loader. These references establish the workflow, not native byte equivalence: [channel basics](https://helpx.adobe.com/photoshop/using/channel-basics.html), [channel calculations](https://helpx.adobe.com/photoshop/using/channel-calculations.html). The private raw frame below is a native format, not a PSD alpha-channel interchange specification.

## Frame, descriptor and compatibility

Use a fixed32-byte header and row-major unsigned alpha bytes. All integers are unsigned32-bit **big endian**. The payload is coverage, with no ICC, transfer function, premultiplication or grayscale color interpretation.

| Byte offset | Length | Required value |
| --- | ---: | --- |
|0|8|ASCII `PRISMA8` followed by NUL|
|8|4|Version1|
|12|4|Width|
|16|4|Height|
|20|4|Payload length, exactly width×height|
|24|4|Flags0|
|28|4|Reserved0|
|32|N|Exactly N alpha8 bytes, no trailer|

Width/height are integers1..8192 and N≤24000000. Total length B is exactly N+32. SHA256 covers the entire frame. Thus the same flat six bytes framed2×3 and3×2 have different hashes; a descriptor cannot reinterpret a shared blob's dimensions. Reject wrong magic/version/flags/reserved/dimensions/length/digest before sampling. Do not invoke an image decoder.

Canonical descriptor:

```js
{
  shape: 'alpha8',
  asset: 'lowercase 64-character SHA256',
  bytes: 32 + width * height,
  width, height,
  x: 0, y: 0,
  feather: 0,
  invert: false
}
```

Required input fields are shape/asset/bytes/width/height. Optional x/y accept only literal numeric zero and normalize to zero. Feather/invert default only when omitted or undefined; explicit null rejects. Authored feather is finite0..100; persisted feather can be0..1000000, preserving the existing resize-scaled mask contract; negative zero canonicalizes to zero. Invert must be Boolean. Require plain or null-prototype objects with own enumerable data properties; reject extra fields, symbols, accessors, arrays and custom prototypes before reading values. No `runs`, `clip`, density, path, URL, filename or nested asset metadata. The positioned wrapper retains its existing source-frame translation/domain; it is the only place for a retained clipping domain. Direct source filter-mask descriptors permit alpha8 with exact working-source dimensions. Geometric-only command inputs stay geometric; this does not silently widen every public mask schema.

Metadata normalization is synchronous and performs no reads. Slot validation requires exact canvas dimensions for active/saved selections and ordinary layer masks, exact retained source dimensions for positioned masks, and exact working-source dimensions for filter masks. Existing protection, source-edit, nonempty-stack, recipe and capture-geometry guards remain effective. Density0, disabled filter masks, hidden layers and inactive entries still validate metadata and participate in ownership/transfer/history quotas.

Old readers reject `shape:'alpha8'`. Do not disguise it as `shape:'bitmap'` with optional missing runs. The synchronous `maskCoverage` function must **explicitly refuse unprepared alpha8**, including when reached recursively through a wrapper; its current unknown-shape fallback must never turn an asset into an accidental rectangle. Tests must exercise that direct-function boundary without relying on graph validation.

## Owned asynchronous preparation and exact legacy treatment

Proposed server seams are `prepareMaskCoverage(mask, resolveOwnedAlpha8)`, `prepareRawLayerMaskCoverage(layer, resolver)`, and `prepareLayerMaskCoverage(layer, resolver)`. They normalize/snapshot all metadata before the first await and return a private synchronous callback. Legacy-only callers may retain their existing synchronous helpers; new consumers await one explicit preparation interface, never a sometimes-promise `maskCoverage`.

The resolver opens only the hash through the existing same-file nonblocking/no-follow regular-file reader, bounds and checks its exact declared length, hashes verified bytes, verifies frame metadata, and returns a **new private Buffer**. The callback retains that entire B-byte backing, not merely a supposedly free payload view. There is no shared decoded cache or table on a graph/public object. Metadata reuse resolves and verifies an existing compatible project asset before publishing the new reference. New alpha8 payloads supplied through native direct-JS calls, including transaction steps, receive a narrow own-data precheck before a Zod/transaction snapshot can invoke accessors; this is not a new guarantee for every legacy shape.

Without feather, sample the payload directly. With feather, modify only the private read buffer's payload after complete verification; the immutable file is untouched. Allocate one Float32Array of4N bytes and execute the existing bitmap inward chamfer in exactly the same order: zero alpha gives distance0, nonzero border gives0.5, interior starts at feather+2; forward and backward axial/diagonal minima use1 and Math.SQRT2 with Float32 storage after each assignment; final alpha is `Math.round(alpha * Math.min(1, distance / feather))`. This is byte-equivalent to native bitmap feather, not an exact Euclidean distance claim. A separate awaited feather helper returns before the coverage callback is constructed, so it does not retain the distance array. If a future resolver shares buffers, an extra N-byte copy is mandatory and must be charged; that is not this ownership contract.

Prepare serially. Each byte read/hash, feather pass, extraction, sample/materialization and encoder scan yields after at most65536 visited pixels/bytes; count actual visits, not absolute sparse indexes. No `Promise.all` of feather constructors. File-open/read awaits do not justify a later24MP synchronous feather constructor. The isolated prototype validates arithmetic and ownership but uses synchronous SHA/frame copying for its small functional fixtures; production must implement the declared yielding read/hash/copy seams and measure them.

Sampling floors x/y and returns zero outside the source frame before inversion. Feather then invert: inverted out-of-source coverage is1. A positioned mask samples `u=x-offsetX,v=y-offsetY`; its domain is tested in **source coordinates at u+0.5,v+0.5**, after inversion, and forces outside-domain coverage0. Copy the domain and offset before awaiting, so callers cannot move a returned callback by changing their input object.

Additional-layer density retains its current byte-mask expression: recover `b=Math.round(255*rawCoverage)`, then `(255-density*(255-b))/255`. This value may be fractional in byte units; do not add a new byte quantization. Density0 returns full coverage after metadata validation, without reading. The source filter mask retains its distinct256-byte density LUT `Math.round(255-density*(255-b))`, explicit0/1 endpoints, disabled bypass and exact whole-stack RGB blend. The new shape does not reconcile or silently change those different established contracts. PSD continues rejecting effective mask coverage that cannot be represented exactly in a byte.

## Producer API and exact pixels

Two native-only commands are proposed; existing command count100 becomes102 only when implementation is released.

```js
load_channel_selection({
  documentId, expectedRevision, // positive, required
  channel: 'luma',             // red | green | blue | luma | alpha
  mode: 'replace',             // replace | add | subtract | intersect
  invert: false
})

get_channel_preview({
  documentId,
  expectedRevision,            // optional positive read revision
  channel: 'luma', invert: false,
  maxEdge: 700                 // integer32..2400
})
```

The mutation supports existing transaction ownership with a positive enclosing revision injected into each step, one commit/Undo and same-session request dedupe. No layer/source selector is included. New preview is read-only, queued with the document, and never populates a mask/image asset or preview cache. Read responses carry documentId/revision and sourceWidth/sourceHeight plus `channel`, `invert`, `coveragePolicy:'composite-byte-alpha-v1'`, `sampling:'nearest-pixel-center'`, maxEdge, width/height and the ordinary encoded PNG result fields. The mutation returns the ordinary updated document, whose selection descriptor is the exact persisted representation. UI pins preview revision and drops late document/revision/draft results. No automatic retry across an ambiguous mutation result.

Render the fresh final composite, including visible source filters, masks, adjustments, groups/clipping, generated/protected composition and outside styles. The active selection does not restrict the source measurement. It participates only in combination afterward. Never sample a reduced browser preview or invoke the existing layer-alpha loader (which intentionally excludes parts of the composite).

For each RGB8/A8 pixel, let `round255(n)=floor((2*n+255)/510)`:

* Red/Green/Blue: `M=round255(component*A)`.
* Encoded luma: first `Y=floor((2*(2126R+7152G+722B)+10000)/20000)`, then `M=round255(Y*A)`.
* Alpha: `M=A` directly.
* Inversion, when requested: `M=255-M` **last**.

All intermediates are exact small integers; no BigInt or floating tie ambiguity is needed. This is encoded Rec.709 luma, not linear-light luminance or perceptual lightness. Luma intentionally rounds twice: `[14,1,122,128]` gives7; a fused formula gives6 and is not the policy. `[64,64,64,128]` yields32 or inverted223; inverting intensity before alpha would give96. Fully transparent pixels yield0 normally and255 inverted regardless of hidden RGB. Display these exact M bytes as opaque grayscale. Preview uses established half-up dimensions and nearest pixel-center sampling directly from final RGBA, without a full extra Q mask plane.

The full-resolution mutation materializer returns only Q coverage bytes from a separate awaited helper; its4Q rendered composite is released before combinations. Preserve existing combination arithmetic and order: left is prepared active coverage, right is new byte/255; Add uses max, Subtract left*(1-right), Intersect left*right, then current half-up byte quantization. Never prequantize a geometric left callback: rectangle1×1 with feather3 gives left1/6; intersecting loaded69 yields11 in the existing order, whereas rounding left to43 first gives12. Subtract/Intersect without an active selection refuse before rendering. Replace/Add without selection use the candidate. Do not replace explicit all-zero coverage with null, which means unrestricted selection.

## Exact adaptive storage and every producer

Use an asynchronous count-only scan before allocating a run array. If the exact number of nonzero constant runs is≤200000, call the existing canonical RLE encoder with identical output fields. Otherwise encode the exact plane as the new raw frame. Empty results remain explicit empty RLE. Do not change an old stored RLE simply by reading it, pick a threshold according to file compression, or increase graph/history JSON limits. A valid small-run result may still hit the existing16MiB project metadata limit; this storage rule does not bypass it.

Route native editing byte-plane producers through one operation-owned adaptive publisher: channel/layer selection, saved selection combinations, subject-segmentation selection, selection/mask painting, morphology, color selection, filter-mask selection capture, positioned-mask rasterization and canvas crop/resize/pad. Internal flood/color tests can keep a private byte callback instead of publishing a throwaway asset. Source cutout alpha remains its existing image asset type; consuming dense selection for refinement does not change that asset's semantics. The PSD import worker retains its separately declared200000-run import subset in this first slice; it does not publish new raw assets or claim wider mask import support. PSD export/inspection must consume native dense masks completely under its existing representability/subset restrictions.

Adaptive publication retains outputQ and the new framed Buffer B=Q+32. The existing `storeAsset` deduplication branch also reads an existing matching B while incoming B remains live, so reserve **Q+2B=3Q+64**, not2Q+32. Its bounded reader allocates exactly B; there is no extra EOF plane. A separate combine/materialize helper must return only the final output before publication, preventing previous source byte planes/callbacks from escaping into this phase. A future streaming dedup verifier could reduce this bound but is not assumed here.

Crop of feathered bitmap/raw coverage bakes feather before clipping so a new crop edge does not invent an old feather boundary. Resize retains nearest pixel-center alpha policy and scales feather as before. Canvas expansion bakes existing effective feather/invert/domain then pads0, so an inverted old selection does not select the new canvas. Positioned transforms retain their existing frame/domain behavior; source filter masks retain their source frame. Process masks one at a time and retain only staged descriptors between them. An output that now fits RLE may be RLE even if its input was alpha8, with identical coverage.

Canvas changes have one explicit staging exception: source and destination operation buffers/work and a conservative final graph projection are admitted before source reads. Potential adaptive byte outputs reserve their full new N+32 frames. Masks are then transformed and linked serially under one operation-owned rollback scope; provisional metadata can temporarily combine old and new canvas dimensions. Each actual new hash passes typed retained-history and JSON quotas before linking. The final dimension-consistent graph passes complete graph/resource validation before commit or the next transaction step. Any later failure removes only newly owned links and retains old/shared assets. This avoids retaining all output frames at once.

## Typed asset ownership, history and portable projects

Extend the existing common typed asset walker, currently `lookup-assets.mjs:projectAssetUses`, rather than adding a parallel partial list. Enumerate active selection, every saved selection, ordinary and positioned layer-mask sources, and source filter-mask coverage, across every retained history graph. Include invisible/disabled/zero-density references. Uses of one hash must agree on frame version/dimensions/bytes; feather/invert/density/position may differ because they are not file content. Accumulate all uses and reject raster/sourceAlpha/PSD/LUT/alpha8 type aliases; never overwrite an earlier type in a Map.

Before reading known references, validate their metadata and aggregate unique references in the prospective history **after redo truncation, append and the existing100-state cap**. A newly computed result's unique hash is not knowable before source pixels: first admit the operation's memory/work and existing known references, compute its exact candidate frame/hash, then finalize prospective unique-history admission **before storing that frame or publishing graph/history**. Do not reject a deduplicating result merely by assuming it adds another unique asset. Apply identical final history admission on restart; startup must not refuse history that a normal commit was allowed to write. Proposed new quota is256 unique alpha8 assets and3GiB=3221225472 retained framed bytes, independent of the existing LUT128/64MiB quota. Use safe Number sums, never signed32-bit coercion. Compatible shared hashes count once across selections, masks and history.

| Distinct maximum24MP masks | Framed bytes |3GiB result|
| ---: | ---: | --- |
|100|2400003200|Fits100 successive independent states|
|116|2784003712|Fits100 changes plus16 retained originals/saved selections|
|134|3216004288|Fits|
|135|3240004320|Refuses before publication|

The independent count guard rejects257 tiny distinct masks even if bytes are small. Conversely100 states each introducing two distinct24MP masks would exceed the byte quota; do not silently discard Undo to accept it. These are storage bounds, not simultaneous allocations. Restart verifies unique frames serially in chunks, with at most one B buffer (≤24000032 bytes); do not retain callbacks or let a separate64MiB verification budget reject an admitted3GiB history. A large history can take substantial I/O time to verify; there is no startup latency promise.

Current bundle limits remain193 assets,256MiB total and16MiB manifest; bundles transfer the current graph's referenced masks, not the entire Undo history. Ten maximum masks use240000320 bytes and may fit with a small image; eleven alone exceed256MiB. A project that fits local retained history can therefore legitimately exceed portable export limits. Keep exact typed frame validation/digests during bundle import/export; malformed metadata at the bundle boundary becomes `INVALID_PROJECT_BUNDLE`, with limit cases retaining `LIMIT_EXCEEDED`.

Retained quota is **not a total disk quota**. Existing successful old blobs can remain after history eviction; no GC or cross-project quota is added. Deduplication and rollback preserve old/shared assets. Every command newly capable of raw publication enters the operation-local created-asset scope, including old commands and transactions. Failures after a later canvas transform, Bake, brush or project save delete only newly owned unpublished files. Validate each intermediate transaction graph/quotas before pixel-dependent work; a final deletion cannot excuse an oversized intermediate state. Hash/verify reused direct descriptors before commit, and snapshot their metadata before queueing.

## Named buffer and preparation admission

The new limit is256MiB=268435456 **named binary buffers**, not RSS. Encoded original image inputs where the old renderer does not retain declared byte lengths, native codec/V8 allocator internals, JS metadata and caches remain outside this ledger and under their existing independent bounds. Do not claim that a metadata-only graph scan measures total process memory. Existing direct Bake/layer-selection/PSD paths keep their stronger actual encoded-size checks too.

Use Q=canvas pixels, N=mask source pixels, S=content source pixels, H=canvas height, B=N+32 for raw storage; for a legacy bitmap, B=N. Define `F(mask)=4N` for feather>0, otherwise0; `K(mask)=B+F(mask)`. Do not add another N merely because the callback uses a view. All current/retained sources use their actual N, which can exceed Q after crop/positioning.

Whenever a graph has an evaluating dense additional/source-filter mask, and **unconditionally for channel preview/load**, use a new joint preread gate:

```
Egraph = 6Q + R + C + T + max(D, G, V) + U <= 268435456
```

* 6Q reserves root RGBA and base/context footprints. R is the global maximum retained ancestor5Q/group plus clipping surfaces, using existing tree/clipping accounting, including another original-context branch. C=`2*sum(B of all additional bitmap/alpha8 masks with density>0)+max(F)`; include legacy ordinary and positioned sources, not only dense ones. Source filter masks belong in D, not C. The two sets bound simultaneous outer/original-context callbacks; prepare their constructors serially. T is shared Gaussian-noise table once. U is the existing global banked-Curves1280-byte reserve once.
* D is the maximum across **all content leaves**, including legacy/protected siblings. Reuse the alias-aware phases of `estimateDistortLeafBytes`: max of decode(4S or9S with separate alpha), filter12S+sequentialCache, source mask8S+K+optional densityLUT256, and geometry/original-context replay; add retained procedural4S for gradients or1MiB SVG for text/shape/path. For this new gate, extend sequentialCache to `max(existing source cache, active median size>1 ?3264:0, active single Curves or Levels ?256:0, active nonnormal blend ?8:0)`. Those legacy source histograms/LUTs and blend IEEE view were not declared in the old Distort helper and cannot disappear from the new complete named phase;1-pixel examples are not covered merely by12S. Banked Curves already has its1280-byte source-cache reserve. Single Smooth's8-byte exponent setup ends before its256-byte LUT allocation. Raw header32 joins source-mask K. Filter candidate, source-mask constructor and geometry are sequential maxima, not summed. Old filter/Distort/Color Lookup work and memory gates still apply independently.
* G covers global adjustment incremental buffers while its input/root remain in the base: scalar output4Q (plus256 for a legacy/smooth single Curves or Levels LUT); median/mosaic or legacy blur/sharpen changed+output8Q, with median histogram3264; Color Lookup `max(parser P,4Q+table+axes512)`. Curves banks U already covers their bounded compiler. Masks are in C, not counted twice in G. Include active kinds conservatively without relying on pixel content or a later hidden branch.
* V covers named outside-style buffers: source4Q+alphaQ+occupiedQ+effect output4Q, plus up to three largest padded blur planes; hence10Q+3Pmax when a nonzero-opacity effect blur≥0.3 exists, or10Q without one. Pmax=(W+2padding)*(H+2padding), padding=`ceil(sigma*sqrt(-2*log(.01)))+1`, under existing32MP cap. The third plane conservatively covers the previous shadow result while a differently blurred glow is awaited. An outline without effects costs11Q+20H+8; with an already retained effect result it costs15Q+20H+8. The20H+8 counts Int32 vertices and two Float64 column/boundary arrays, including width1 tall frames. Use the maximum effect/outline phase, not their sum. Opacity0 effects do not allocate. Pixel-empty fast paths are not assumed by admission.

The expanded G/V rows apply only to the new dense/channel gate; legacy-only admission and pixels stay unchanged. This closes the known weakness of merely borrowing the older Distort ledger, which explicitly excluded global-spatial/style buffers. Cross-branch protected inspection is why D/R/C range over the full relevant graph. Layer-specific preview/materialization that additionally retains a copied4Q visible layer must add that caller-owned surface outside Egraph. Direct function evaluators must enforce their own equivalent phase predicate when called without a whole graph; a callback is not permission to bypass resource validation.

Preparation work is separately bounded at384 million declared weighted visits, with byte-mask read/expansion costing N and feathered preparation costing8N **per invocation**. Include ordinary RLE and new alpha8 masks once the operation opts into this gate. Shared hashes do not reduce repeated preparations because there is no cache. Let W(mask)=N or8N, with absent/density0 additional masks and bypassed source-filter masks costing0. `Wbase(graph)` sums each additional mask plus each evaluating source-filter mask; counting hidden/zero-opacity nodes too is an acceptable conservative ordinary-render bound. This suffices for the ordinary final composite used by the two channel operations, which does not invoke a separate original-context render.

For contextual inspection define `P(context,before)` as the sum over preceding protected content of its own additional mask, evaluating source-filter mask, and **every ancestor additional mask once for that protected content**. Metadata may conservatively count invisible protected nodes, but must not deduplicate repeated ancestor/hash uses. Contextual `renderGraph` adds P for each visited clipping base and each ordinary contextual content node (active filters, generated provenance, effects or outline). It also includes Wbase of the inspected graph. A metadata walker may conservatively use every inspected content ID instead of only contextual ones. `protectedPixels` alone costs the corresponding P; visible-layer helpers add their source/own/ancestor callbacks; PSD adds its exact-mask pass then ordinary render. Each mutation adds all planned preparations from its sequential render/materialize/combine scopes, even though their memory peaks are maxima.

Admission is operation-specific before reads, with a private AsyncLocalStorage execution counter as an invariant check rather than late routine refusal. Nested consumers share the same counter; each separately admitted transaction mutation starts its own scope. PSD and generation snapshot scopes include their sequential preparations outside the renderer. A saved graph must pass ordinary render preparation; a more expensive contextual preview may separately refuse without making the graph invalid. Channel load adds W(active selection) only for a real combination; preview never samples active selection. Two simultaneous callback sets are **not** two total evaluations. History verification is governed by its separate3GiB unique-byte bound. This is a mask-preparation budget, not a claim to cap all legacy rendering CPU. Existing polygon selection/capture work guards remain; raw storage does not waive256-edge costs.

## Operation phases and lifetime requirements

Every row is joined with caller-retained buffers before allocation/read. Separate helpers are a required lifetime boundary, not an assumption that a block-scoped variable will be collected immediately. An operation's bound is the maximum of sequential phases. Each predicate must be mirrored before the first corresponding source read.

| Operation | Additional named phase / ownership requirement |
| --- | --- |
|One raw callback|B unfeathered; B+4N while feathering; only B survives|
|Source filter mask|`8S+K+LUT` versus candidate`12S+cache`; before geometry, enabled/density0 skip evaluation but validate all metadata|
|Bake|Retain existing actual encoded E and separate-alpha terms: candidate`E+(alpha?17:12)S+cache+64KiB+T`; mask`E+(alpha?13:8)S+K+LUT+T`; preserve existing encoding/publication maximum and all source buffers|
|Channel load|max(Egraph,5Q extraction,2Q+K(active) combination,3Q+64 frame/dedup publication). The extracted Q and combination Q coexist; active coverage is prepared after RGB helper returns|
|Channel preview|max(Egraph,4Q+P sampling,5P+8MiB+5×base64Cap transfer). RGB dies before encoding; no full Q coverage plane; P is bounded preview pixels|
|Mask preview|K(selected)+optional source densityLUT256+5P+8MiB+5×base64Cap, preserving conservative current transfer formula; read only the selected alpha asset, never RGB/unrelated assets|
|Saved selection combine|FirstK(left); then B(left)+K(right); then B(left)+B(right)+Q result; publication3Q+64 later. Legacy geometric callbacks stay continuous until final quantization. Replace can share a descriptor without reads|
|Load layer mask|K(source)+Q materialization, then2Q+K(active), then3Q+64 publication; content-alpha loading keeps its existing encoded/source/geometry ledger and unchanged content policy|
|Filter-mask capture|Existing exact integer-copy geometry eligibility and polygon work, now K(selection)+S output; raw publication3S+64 later; no resample/Distort capture relaxation|
|Morphology|K(input)+Q materialization, release callback, then callerQ+kernel3Q+4maxAxis; publication3Q+64 later. Bake feather/invert/domain once, keep density separate|
|Paint selection/additional mask|K(start)+initialRGBA4Q+stroke output4Q+applied Uint16≤2Q; alpha extraction later≤9Q; publication3Q+64 in a separate scope. Replace need not read old coverage|
|Paint pixels/Clone/Heal|Add target4Q to sample-render Egraph. During selection preparation retain target4Q+distinct sample4Q; while protected original renders also retain prepared selection B. Stroke phase target4Q+distinct sample4Q+protectedQ+output4Q+applied≤2Q+K(selection); current-layer sample aliases target and is not charged twice. Retain existing encoded-output publication allowance separately|
|Fill|Existing order keeps selection B during flood-render Egraph, then B+RGBA4Q+selectedQ+seenQ+queue4Q. Return only private floodQ; next target render keeps B+floodQ, and protection rendering keeps B+floodQ+target4Q. Fill phase B+floodQ+target4Q+protectedQ+output4Q. Count selection constructor K separately; byte-plane flood replaces internal throwaway RLE without changing arithmetic|
|Refine cutout / generation snapshot|Refine holds alphaQ+K(selection), then existing alpha-image encode/store phase. Snapshot renders/encodes composite first, then prepares protection and selection while retaining encoded image; add its actual byte length to the latter named phases before those allocations. No provider call is part of this storage work|
|Crop/resize/pad/rasterize position|K(current source)+new outputQ, then3Q+64 publication; process masks serially. No all-mask decoded map and no changed density/inversion order|
|PSD inspect/export|Preserve writer's existing bound; before pixels additionally max(retainedMaskPlanes+K(current)+current Q, retainedMaskPlanes+Egraph, retainedMaskPlanes+composite4Q+previous collectedRGBA+next leaf decode/geometry). Density representability still tested exactly; source filters retain current PSD restrictions|
|Restart/import/export|One verified B at a time after unique quota/type admission, plus existing current bundle container/transfer limit; no feather or renderer needed just to validate raw storage|

For paint/fill/source refinement, a dense active selection is a real dependency even if it is not referenced by the rendered graph; force the operation preflight and include its K. A source-only filter-mask asset likewise activates the joint graph gate. Additional callbacks include masks on groups, clipping bases and cross-branch original protection. The standalone frame/helper tests do not establish these native integration lifetimes; maintained owner/independent tests must do so before release.

## Capabilities, modules and integration ownership

Proposed exact capability fields:

```js
denseMaskPolicy: 'framed-raw-alpha8-v1'
denseMaskLimits: {
  headerBytes: 32, maxDimension: 8192, maxPixels: 24000000,
  maxWorkingBytes: 268435456, maxPrepareWork: 384000000,
  maxHistoryAssets: 256, maxHistoryBytes: 3221225472,
  yieldVisits: 65536
}
channelSelectionPolicy: 'composite-byte-alpha-v1'
channelSelectionChannels: ['red', 'green', 'blue', 'luma', 'alpha']
channelPreviewLimits: {
  maxEdge: 2400, defaultMaxEdge: 700, maxBytes: 8388608,
  maxWorkingBytes: 268435456, yieldVisits: 65536
}
```

These are proposals pending the CPU/resource review and root freeze. Shared exports are `DENSE_MASK_POLICY`, `DENSE_MASK_LIMITS`, `normalizeDenseMaskDescriptor`, `CHANNEL_SELECTION_POLICY`, `CHANNEL_SELECTION_CHANNELS` and `CHANNEL_PREVIEW_LIMITS`; root owns the environment-neutral shared module and declarations. The new channel preview has its own limits, never inferred from mask-preview capabilities. No separate format-mode option or cache promise. Existing mask shape/capture capabilities add alpha8 only where the corresponding public descriptor is accepted and verified. Mask inspection help changes from “no asset reader” to “only selected alpha asset, no RGB/source image reads.” The optional Photoshop bridge refuses both new commands and the alpha8 shape. UI gates on native+exact policies/full channel list/limits and command availability; unsupported contexts cannot author the new representation. It should still permit inert portable metadata inspection where current UI already does so.

Expected implementation map:

* Shared module for policy/limits and strict alpha8 metadata normalizer with declaration file; root owns schema/status/MCP. Server owns framed reader/writer/prepared-coverage and operation estimates. Private prepared callbacks expose no mutable planes.
* `masks.mjs`, `layer-mask.mjs`, `filter-mask.mjs`: new normalization/explicit sync refusal/async preparation/density/storage estimates; no old pixel changes.
* `native.mjs`: async ancestor/render/protection/adjustment scopes, new queued commands and transaction gates, new-asset rollback for every adaptive producer, startup/precommit verification. `applyAdjustment` preserves its finalized yield/pixel seam apart from awaiting prepared coverage at the declared phase.
* `saved-selections.mjs`, `layer-selection.mjs`, `raster-ops.mjs`, morphology, canvas and mask-preview modules: byte materialization/output seams, exact adaptive publication, operation-level phase gates. `psd-native.mjs`: serial exact coverage plus retained mask/collection phases.
* Common typed walker/native/project-bundle: all mask slots and history/type/byte admission, no dependency masquerading as raster. Existing recipes still exclude masks; masked filter capture refuses, and recipe execution merely preserves an existing mask as before. Dense references never silently enter a standalone recipe body.

## Prototype evidence and release gate

`test-results/dense-mask-evaluation/architecture-prototype.mjs` is isolated: frame/descriptor validation, owned raw preparation with yielding byte-equivalent feather, positioned density, channel extraction and metadata-only quota arithmetic. `architecture-probe.mjs` compares existing legacy helpers directly; `architecture-report.json` records14 malformed/header/digest checks,15 strict descriptor checks,109 feather cases,394924 exact sampled comparisons and40 position/density cases. The512² feather fixture executes16 deliberate yields across its four passes. All five channels roundtrip byte-for-byte at512² and1024². This is functional evidence, not integrated production performance or a native acceptance claim.

`architecture-resource-probe.mjs` / `architecture-resource-report.json` pins named arithmetic without large allocations: plain24MP final-composite240000000 bytes;4096² feathered raw additional mask268435520 (64 bytes above cap because two headers); source-only16MP feathered scalar stack304000032;24MP deduplicating raw publication72000064; and width1×8192 outline253960 bytes. It also demonstrates repeated ancestor preparation: eight protected children sharing one feathered1MP ancestor, inspected through six contextual callers, costs402653184 visits and must refuse even though each individual preparation fits. These are planning fixtures, not substitutes for native no-I/O tests of the integrated estimators.

Original public photo SHA256 is `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. Original512² luma still has205876 nonzero runs and now fits a262176-byte frame. The declared1024² resample has732853 luma runs and fits1048608 bytes. Luma outputs are `architecture-photo-512-luma.png` and `architecture-photo-1024-luma.png`; matching `.alpha8` files and report hashes preserve the exact storage fixtures. The earlier208343/204368/210469 RGB run counts are unchanged. Alpha is constant and would remain small RLE under the actual adaptive publisher.

Independent backend design review now clears the cumulative preparation-invocation bound, joined global/style/source auxiliary/caller phases, frame/channel arithmetic, quota and final-plane publication scope. Its own probe verifies475136 BigInt channel bytes,200 literal outputs,28490 legacy coverage samples, strict frame/descriptor cases and action-specific work boundaries; see [DENSE_MASK_REVIEW.md](DENSE_MASK_REVIEW.md). Root's isolated, unregistered shared metadata contract has four passing strict tests. Root released implementation and registration after independent design clearance. Native consumers and transport are now callable.

Production must then pass maintained frame/grammar/ownership, every direct consumer, bitmap equivalence, mixed raw/RLE, real photographic channel outputs, positive revision/preview races, protection/generated clipping, inactive malformed portable metadata, restart/quota/typed aliases, current bundle limits and actual late persistence/transaction cleanup. Benchmarks must use production helpers at admitted dimensions with wide/tall/feather and repeated preparation, in a coordinated quiet window. No integrated acceptance or performance claim follows from these isolated passing probes.


## Production integration checkpoint

Native owner tests in `tests/dense-mask-native.test.mjs` cover exact 512-square adaptive publication, immutable source coverage through paint/morphology, generation protection and cutout refinement, PSD representability/export, continuous geometric combination, positioned materialization, legacy feather equivalence and fresh optimized photographic Invert. Seven tests pass; independent native audit has fourteen tests, with independent client and existing morphology checks owned by the reviewer. The combined owner/audit/legacy scalar-and-yield sweep passed26 tests in2.106 seconds. Root's actual MCP SDK four workflows pass in3.228 seconds, including the photo, 1MP transaction/publication failure and saved generation-mask handoff. The complete native/schema/SDK suite passes1176/1176 in23.133 seconds. Initial focused browser acceptance passes8/8; adjacent browser and production timing evidence follow after their coordinated runs. The full suite caught a canvas projection omission: projected guides now receive the exact same geometry transform as the committed guides before resource validation; existing guide/resampling suites pin the correction.

The photographic SDK acceptance exposed an optimization-sensitive failure in the existing nested per-pixel Invert map/switch closure: one normal process left part of the image unchanged, while an independent no-opt run and isolated numerical/coverage probes passed. The implementation now compiles the same three scalar Invert expressions directly, following the earlier Shadows/Highlights treatment; arithmetic order and clamping are unchanged. This is not a claim to have identified a specific V8 compiler defect. Pre-change source is preserved in `test-results/dense-mask-evaluation/architecture-color-before-invert.mjs`, and the isolated probe is `architecture-invert-probe.mjs`. A maintained worker checks every photographic byte under six strengths, masked/unmasked opacity and protected pixels in two fresh ordinary optimized processes. The SDK photograph and focused browser both pass afterward.


## Actual production measurements

Quiet Node v22.14.0 run; three sequential samples per case, full/browser workers idle. See `test-results/dense-mask-evaluation/architecture-production-benchmark.mjs`, `.json` and `.log`. These use the actual native command/resolver/preparation paths, not the design prototype. Times include native publication and same-file dedup checks for repeated loads.

| Production operation | Median ms | Largest 5 ms heartbeat gap, ms |
| --- | ---: | ---: |
|channel-load-512x512|22.14|10.39|
|prepared-feather-512x512|6.93|6.46|
|channel-preview-512x512|11.99|11.73|
|channel-load-1024x1024|40.05|18.44|
|prepared-feather-1024x1024|24.30|5.36|
|channel-preview-1024x1024|32.22|18.97|
|raw-feather-8192x128|27.38|5.58|
|raw-feather-128x8192|24.86|5.43|
|raw-feather-6000x4000|571.81|5.46|
|native-channel-load-24MP|546.58|319.56|

The 24MP raw feather preparation stays cooperative (largest measured gap5.46 ms). The complete24MP channel load has a319.56 ms gap: the new preparation/sampling yields do not make the existing full renderer and codec path wholly nonblocking. This is an explicit measured limit, not an unqualified responsiveness claim; no scheduling or pixel algorithm change was introduced to the existing compositor.

The source photograph SHA-256 is `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. Production512² exact luma frame is262176 bytes, payload SHA-256 `7ff937f6c4db9f45c11002efcb80d310a32c2cca0240b744c9ee6651ad881286`; resized1024² frame is1048608 bytes, payload SHA-256 `64b27190b8a4cf8256098e9bd5c3bc1990d09239d18753d391e0e0cffd67be52`. Ordinary photographs remain exact byte coverage instead of exceeding the RLE ceiling. The full suite is1176/1176; focused browser8/8 is complete and adjacent browser acceptance is owned by the UI agent.

### Subsequent legacy sparse-style resource correction

Review of the next Layer Fill design found that an accepted legacy `effects:{shadow:{}}` renders default opacity/blur, but the dense decoration estimator previously inspected missing fields directly and charged no style planes. `denseDecorationBytes` now uses the same effective style normalization as the renderer. A4000² raster with a raw alpha8 mask and default sparse shadow is correctly estimated at337,256,176 bytes and refused before image/mask/file I/O, rather than the incorrect192,000,064 bytes. Explicit, absent, empty and zero-opacity style controls remain covered. Pixel arithmetic and scheduling are unchanged, so the prior production timing is not repeated. The existing owner/effects12 and expanded independent native15 tests pass. Root's final complete regression passes1177/1177 in22.7971235 seconds:37 new maintained checks over the Photo Filter1140 baseline, including15 independent native audits. Final browser acceptance is8 focused plus80 adjacent,88 total, with build acceptance recorded by the UI owner.

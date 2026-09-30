# Independent review: editable four-corner Distort

Status: **implemented native backend independently audited; client source cleared; owner browser acceptance passed**. The design/prototype findings below informed the approved contract. This reviewer owns tests and review documents, not production geometry changes.

## Recommendation and scope

A fixed-frame, editable four-corner **Distort** stage is a useful bounded next slice. It belongs after source-alpha combination and the complete source filter stack, in the existing sequential geometry list. It needs neither a new raster asset nor a mesh/warp engine. Adobe describes Distort as independent corner/edge movement and Perspective as symmetric opposite-corner movement; this proposal implements the former interaction with a projective mapping, not Photoshop's algorithm or a full Warp/Liquify feature. [Adobe transformation options](https://helpx.adobe.com/photoshop/desktop/crop-resize-transform/transform-manipulate-reshape/transformation-options-in-adobe-photoshop.html)

The proposed persisted record is a strict new type:

```js
{ type: 'distort', width, height, corners: [TL, TR, BR, BL] }
// Each corner is a strict { x, y } object.
```

`width` and `height` must equal the immediately preceding stage's frame. The four points map the outer source pixel edges `(0,0)`, `(W,0)`, `(W,H)`, `(0,H)` into that same output frame. Samples are taken at destination pixel centers. Moving corners beyond the frame clips the result; it does not enlarge the canvas. An independently movable quadrilateral permits projective foreshortening without promising a camera model.

The proposed `add_layer_distort`, `update_layer_distort` and `delete_layer_distort` commands require a positive expected revision, including the enclosing revision of a containing transaction. Update/delete use `transformIndex`, the full transform-array index; they must verify that the indexed record is actually a Distort stage. Add/update accept the four corners and derive the fixed frame from the preceding geometry, rather than trusting an independently supplied output size. Every Distort may be edited or removed, including middle records. Fixed dimensions make this safe for later stage dimensions. The UI must show the selected historical input frame. Raw historical corners are not valid canvas handles after later geometry: numeric editing can cover every stage while handles initially cover only an appended/trailing stage.

All six existing content types can use the same renderer: raster, solid, text, shape, path and gradient. Groups and adjustments have no equivalent source frame. No transform recipe extension, multi-layer transform, automatic rasterization or cross-document coordinate binding is part of this slice.

## Sampling and numerical admission

The prototype conditions the quad in normalized destination coordinates around its bounding-box center. Its current proposed bounds are finite authored coordinates within ±16384, span at least 0.25 pixel, strictly clockwise convex turns of at least `2^-20` after normalization, infinity-norm matrix condition at most `1e6`, and positive forward projective denominator with max/min at most 64 over the expanded source rectangle.

The expanded rectangle must be `[-0.5/W, 1+0.5/W] × [-0.5/H, 1+0.5/H]`. This is exactly the support needed when the inverse source index is `W*u-0.5`, `H*v-0.5` and bilinear interpolation has transparent outside taps. Testing only the unit-square corners can admit a projective pole in the interpolation fringe. A linear denominator's extrema on this rectangle occur at its four corners, so those four tests suffice. Concave, crossed, mirrored, collapsed and extremely thin quads are rejected. These are explicit stability limits, not a proof of exact-real projective arithmetic.

Evaluate each pixel directly from the compiled inverse matrix; do not accumulate scanline coordinates. Reject nonfinite/nonpositive inverse denominators before division/indexing. Zero outside neighbors contribute no alpha or RGB. The new prototype accumulates `weight * alphaByte`, accumulates RGB multiplied by that weight, divides RGB by the accumulated alpha and rounds the accumulated byte alpha. That exact operation order must be declared. Existing affine divides alpha by 255 inside its accumulation; algebraic equivalence does not promise identical floating half-tie bytes.

Identity and exact integer translations must be recognized from authored corners before matrix arithmetic and copy all four source bytes. This preserves alpha 1 and hidden RGB exactly. General resampling excludes hidden RGB from visible interpolation. A tiny nonzero interpolated alpha may round to zero while retaining computed RGB, matching the existing general resampling convention; it is not a hidden-RGB preservation claim. Do not hard-clip samples to the destination quad before bilinear support evaluation.

The current test-only comparison supports these choices:

- Six independent exact-rational fixtures cover identity, integer/fractional translation, trapezoid, skew and off-canvas corners with alpha 0/1/128/255. All six match the current prototype exactly.
- Across 306 fixtures, 305 images match the BigInt rational sampler exactly. One alpha half tie yields 127 in the floating prototype and 128 mathematically. Maximum source-coordinate error in this set is `8.810729923425242e-13`; this is fixture evidence, not a universal error bound.
- 304 hidden-RGB perturbation comparisons preserve the general interpolation result.
- Eight malformed/geometrically unsafe cases reject, including a pole in the expanded bilinear fringe for a 1×1 source.

Evidence: `test-results/perspective-review/reference.mjs`, `probe.mjs`, `report.json`, `prototype-review.mjs` and `prototype-report.json`. The reference independently constructs integer homogeneous matrices from exact dyadic corner coordinates and uses rational inverse mapping, transparent bilinear taps and alpha-weighted half-up output. No runtime sampler is its oracle.

## Pipeline, masks and protection

Source-alpha assets are combined before source filters and their whole-stack mask. Distort then transforms the effective RGBA once. Its source-space filter mask remains attached to source coordinates; additional layer masks, positioned layer masks, active/saved selections and guides stay in document coordinates. A per-layer Distort must not silently transform any of those document objects.

Selection capture into a source filter mask must reject any Distort record, even an identity-equivalent one. The current capture planner already rejects unknown/new geometry. Source preview with filters disabled still includes geometry and source alpha. Content-alpha selection, protected-pixel rendering, original-RGB restoration beneath protected content, generated hard exclusion and isolated/clipping composition must all run the same new geometry branch. A missing renderer branch is dangerous: the current generic fallback treats unhandled geometry as a resize after graph validation.

Authoring, updating or removing a Distort on a currently protected target should reject. Do not reject an otherwise valid persisted protected layer merely for containing an earlier Distort: a user can transform a layer and subsequently protect its current appearance. Existing proportional resize/affine protection rules remain unchanged. Hidden lower protected content and nested clipping/group contexts remain part of the existing original-source restoration and generated-exclusion footprint; this feature must not introduce a shortcut around those paths.

Filter Bake remains source-space RGB materialization and preserves the geometry record, source alpha, original source asset and additional masks. Its exact appearance guarantee should carry over because the pre-geometry effective pixels are unchanged. Source editing commands that materialize geometry keep their current semantics and guards. In particular, do not invent a generic raster-layer Rasterize command: the current rasterize-layer operation applies to procedural content, not existing raster layers.

## Resource contract required before implementation

One new stage allocates one output RGBA frame; integer copies still need that output unless the implementation explicitly aliases identity. No full coordinate map or per-pixel object array is necessary. General sampling should yield in bounded pixel batches, with a separately measured work weight and a cumulative new-Distort-stage work cap. The existing 500-record geometry limit alone is not a CPU admission bound. Hidden layers and middle stages must count. Do not claim this new-stage cap bounds arbitrary legacy transform lists or all render passes.

Independent prototype timing in `test-results/perspective-review/benchmark.json` measured about 36 ms for a warm 1024² general stage, 34 ms for 8192×128, 0.8 ms for a 1024² integer copy and 926 ms for one 24 MP general stage. The largest observed 5 ms heartbeat gap was 7.72 ms. These are local test-only measurements, not deadlines. General sampling yields at at most 16,384 output pixels; the copy path yields by at most 65,536 source pixels. The final agreed work rule is uniform `16 * stageArea` for **every** Distort record, including exact identity/integer copies, under a 384M cumulative new-stage cap. This conservatively replaces the review's earlier proposed cheaper copy weight. Hidden stages count. A 24 MP stage fits the work cap alone; the combined memory predicate is stricter and may reject it.

The final agreed admission is a stronger combined named-buffer envelope whenever the graph contains any Distort. **Every content leaf participates**, including legacy-only siblings, because a source inspection can render a protected sibling from the original graph while the inspected branch's surfaces remain live. Legacy-only graphs keep their existing admission behavior.

```text
6N + Rmax + C + T + max(Dleaf) <= 256 MiB
```

`6N` counts the root RGBA composite plus base and original-context protection footprints. `Rmax` is the global maximum ancestor/group and clipping retention, using the existing surface predicates and conservative clipping reserve. It must be global rather than just each leaf's ancestry because original-context protection can render a leaf from a different branch. It must not include another leaf's sequential source-filter candidate/cache.

`C` counts **all** effective additional bitmap mask sources, ordinary and positioned, under the established conservative `2 * sum(sourceAlphaBytes) + max(featherDistanceBytes)` callback reserve; density-zero masks still validate but do not allocate effective callbacks. The current legacy estimator's zero-unless-positioned behavior cannot be reused unchanged here. `T` is the one persistent Gaussian Noise table, added after the maximum across all leaves. `Dleaf` is that leaf's maximum decoded source/filter/geometry phase, defined below. Do not add a separate contextual footprint inside `Dleaf`; it is already in `6N`.

The existing graph scratch/work checks still apply. The new bound is one combined preflight, not two independently passing 256 MiB predicates. It describes these named content-processing buffers and concurrent surfaces, not encoded Sharp inputs, native codecs, font caches, global-adjustment/style internals, JavaScript metadata or RSS. Metadata-only commands must not start opening assets to estimate anonymous encoded inputs.

For source pixels `S`, final canvas pixels `N`, previous stage pixels `P` and next pixels `Q`, the current native lifetimes require these alias-aware geometry bounds:

| Phase | First transform (previous aliases source) | Later transform |
| --- | ---: | ---: |
| Unfiltered source | `4S + 4Q` | `4S + 4P + 4Q` |
| Active filtered source | `8S + 4Q` | `8S + 4P + 4Q` |
| Original-source restoration while filtered final frame remains live | `8S + 4N + 4Q` | `8S + 4N + 4P + 4Q` |

Use the possible restoration phase for structurally active filters so admission does not depend on rendered footprint bytes. Take the maximum of geometry, decoding/alpha combination (`9S` with separate alpha; otherwise `4S`), ordinary active-filter candidate (`12S + largest spatial cache`), and deferred stack-mask preparation/mixing (`8S + coverage + density LUT`). The sequential filter ring and deferred mask callback do not overlap. Add a retained procedural input reserve of `4S` for gradient source RGBA, or 1 MiB for text/shape/path SVG, to that leaf's maximum. Solid creation has no additional authored input Buffer. The SVG allowance conservatively covers the existing 2000-character text, 256-node path and 200-vertex star limits; native font/codec internals remain outside this ledger. Add the one shared noise table only outside `max(Dleaf)`. Original source bytes remain live after a crop.

Independent decoded-phase examples: one unfiltered 24 MP stage needs 192,000,000 bytes; two equal stages can retain 288,000,000 bytes. Possible filtered restoration at 16 MP needs 256,000,000 bytes. Those are **leaf phases**, not complete admission: root, ancestor, callback and shared reserves must still be added.

The final combined formula gives exact useful preread boundaries with no extra masks/groups/cache: one unfiltered stage at 8192×2340 costs 268,369,920 bytes and fits; 8192×2341 costs 268,484,608 and rejects. One active-filtered stage with possible original restoration at 4096×2978 costs 268,353,536 and fits; 4096×2979 costs 268,443,648 and rejects. Both refusals still fit the work cap. A retained 24 MP source cropped to 512² then distorted needs 98,097,152 decoded bytes plus 1,572,864 root/context bytes, or 99,670,016 bytes before further reserves. These arithmetic checks are maintained in the independent design-only probe/report.

Layer-alpha selection and PSD use their own broader phases, including encoded inputs or retained export planes. Update every stage-size consumer and preserve those budgets. A fixed-size Distort can use the preceding size, but a generic unknown-type fallback must not become the intended validation policy. Existing Bake does not execute geometry, so its source-only memory formula should not gain an unrelated destination frame charge.

Each add/update/delete candidate must pass full metadata validation before assignment. For transactions, validate after every staged mutation while either the prior or resulting graph contains a Distort stage, so a temporary work/memory activation cannot bypass admission via a later deletion. Publication failure must leave history, assets and the former geometry unchanged. No pixel writes are needed for this first slice.

## Portability and acceptance gates

A new strict transform type gives old readers a fail-closed path. The current native reader rejects the proposed record with `Invalid geometry transform`; the independent probe verifies that behavior. Reject surplus fields, holes, accessors, symbols, nonplain corner objects, nonfinite coordinates and mismatched historical frame dimensions before any asset read. Portable import must validate the complete graph first. Public projection should retain the record unchanged; no migration should rewrite legacy affine/resize descriptors.

PSD can rasterize the transformed output under its existing geometry warning, while the native project and portable bundle retain the editable stage. Rendering should not modify source assets. The production acceptance suite should include exact integer copies, fractional/fringe cases, middle update/remove, source-alpha and whole-stack masks, protected/generated isolated clipping, all six content types, default legacy pixel regressions, pre-I/O work/memory boundaries, malformed portable metadata and actual persistence/late-transaction failure. UI acceptance needs stale/away-and-back/capability/preview ownership checks and must never auto-apply a corner drag.

The frozen capability policy is `layerDistortPolicy:'fixed-frame-projective-bilinear-v1'`, coordinates `layerDistortCoordinates:'stage-pixel-edges'`, and the six content types above. Limits are `maxDistortCorner:16384`, `maxDistortWork:384000000` and `maxDistortWorkingBytes:268435456`. The work rule, combined memory scope and `transformIndex` API are implemented. The reviewed arithmetic and phase lifetimes have no remaining native blocker.

## Maintained native audit

`node --test tests/distort-audit.test.mjs` passes 10/10. The maintained mathematical sampler lives in `tests/fixtures/distort/exact-reference.mjs`, independently constructs exact homogeneous matrices and does not import the runtime geometry helper as its oracle.

- Six stable complete RGBA fixtures match the exact-rational oracle, including non-affine trapezoid/off-frame quads, fractional translation, alpha 0/1/128/255 and hidden colors. Integer copies preserve all four bytes; general hidden-color perturbations do not affect output. A wide sampling call yields before completing.
- Strict records reject malformed frames, surplus fields, crossed/mirrored/thin quads, nonfinite coordinates, accessor corners and sparse arrays. Malformed portable metadata rejects before asset decoding/publication. The portable encoder itself also rejects nonfinite JSON; that case uses its JSON-null representation to exercise the import path.
- Independent source-alpha combination, Invert opacity and an inverted whole-stack bitmap mask at density 0.1 match pre-geometry pixels. Native filtered/unfiltered geometry paths match independent copies. Source Bake restores raw working alpha, retains the separate alpha/source assets and Distort, and preserves exact rendered appearance.
- A middle stage updates/removes by full index while later crop/Distort records remain byte-identical. Masks, density, selections and guides retain their documented frames. A transformed-then-protected graph remains valid, while all three mutations reject on that protected target.
- Exact 14N and 22N admission boundaries reject before source/model/render/asset calls. A hidden protected legacy sibling's retained original/previous/next frames participate when a small new stage opts the graph into stronger admission; an intermediate add-then-delete transaction cannot conceal its resource refusal.
- A near-limit graph combines two isolated ancestors, clipping, two Distort stages, 15 ordinary bitmap callbacks including feather, and another leaf's persistent Gaussian table. The independently calculated peak is 268,432,896 bytes. Activating another mask rejects before pixels, including when a later stage deletion would reduce the final estimate. The explicit estimate confirms callbacks are forced without any positioned wrapper and the table is added once after the maximum.
- Gradient's retained 4S input and text/shape/path's 1 MiB SVG reserves trigger the expected metadata-only acceptance/refusal boundaries. All six content types also render through actual non-affine projective geometry and exact integer-copy updates. General procedural comparisons allow only the declared one-byte floating half-boundary difference from the mathematical fixture.
- An already-protected Distort changes the protected footprint correctly. Filtered transformed RGB restores its independently transformed original at that footprint; generated members inside an isolated clipping group contribute no protected pixels, including in isolated member previews. An additional positioned mask stays in document coordinates.
- Two PSD cases pass the normal graph gate at 268,418,304 bytes but reach 268,451,072 bytes during export: one retains completed mask planes, the other retains earlier exported layer RGBA while rendering a large legacy source. Both refuse before source/render calls; swapping collection order gives the independently predicted smaller phase. The ordinary PSD writer estimate alone would admit them.
- Real `ENOTDIR` metadata persistence failure and a late transaction failure after actual Distort→Bake→paint leave graph, history/project files and original assets unchanged. Instrumentation confirms both pixel writes occurred before the final missing-layer failure; transaction ownership removes their new assets.

The production strict normalizer, direct inverse sampler, alias-aware leaf estimator, combined graph gate, forced callback scope and PSD preparation phases were also source-reviewed. The owner reports its eight tests plus a 175-test adjacent sweep passing and production sampling timings consistent with the prototype. Root subsequently reports the full backend suite at 957/957 and doctor at 99 checks. Those reported runs are separate evidence from the ten independently executed tests above.

## Client source review

The source review confirms full-index/historical numeric targeting, explicit Apply, a stable own-result acknowledgement before metadata publication, guarded preview installation and a separate stale-conflict refresh guard. All three independent findings are corrected and re-reviewed: handle drags use the captured pointer delta relative to exact saved strings, entry checks current canvas/pan gesture ownership, and capability admission checks finite positive bounded integer corner/work/buffer limits. An unmoved off-center handle click preserves the authored corner instead of shifting it.

The root-reported stale-row issue is also corrected: stale historical rows disable; explicit Reload current geometry rebuilds the list and returns to a new draft if the transform list changed, requiring a fresh saved-stage choice. Pointer ownership, view-change cancellation, capability withdrawal and own acknowledgement retain the intended epoch guards.

Read-only closing, reopening and saved-stage inspection remain available while a request is pending. These actions replace the ownership epoch, so the old response cannot install into the replacement editor. All field edits, mutation actions, New, Reset and Revert remain disabled while busy; this intentional inspection behavior is not a mutation exception. The owner's additional overshoot fix keeps captured handles mounted during a drag beyond the authored range, then retains an invalid numeric draft with Apply disabled instead of clamping or submitting it. That source change is also reviewed.

No client source blocker remains. The UI owner reports eight focused plus 51 adjacent browser workflows and the build passing, with evidence in `test-results/distort-browser-report.json` and `docs/DISTORT_UI_DESIGN.md`. The focused cases cover delayed close/reopen, off-center and all-four zoom-scaled handles, out-of-range drag release, active brush capture, view change at pointerup, capability withdrawal and external middle-stage deletion. These browser runs are owner evidence rather than independently rerun browser tests.

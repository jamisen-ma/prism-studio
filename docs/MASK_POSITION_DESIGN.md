# Independent additional-mask positioning

Implemented native contract, 2026-09-19. Root approved the persisted shape, geometry policy and public names. Owner tests, independent audits and the official MCP/schema checks pass; browser acceptance is being completed separately. This incorporates the actual native geometry paths and the parallel [feasibility review](MASK_POSITION_FEASIBILITY.md).

The recommended first slice is **mask-only integer positioning with a retained source frame**. Support exact crop and canvas-bounds changes, keep paint/morphology available through their existing explicit canvas-materialization behavior, and provide a separate **Rasterize mask position** action. Only image resampling requires that action first. Do not introduce linked image/mask transforms, rotation, scale, source-cutout positioning or a general mask transform stack.

Adobe documents independent layer/mask movement after unlinking. This establishes the workflow, not the numerical behavior below: Prism's sampling, density, extent and conversion policies are explicit native contracts. [Adobe: unlink layers and masks](https://helpx.adobe.com/photoshop/desktop/create-masks/layer-masks/unlink-layers-and-masks.html). Adobe also uses “apply layer mask” for permanently removing hidden image areas; our action must be labeled **Rasterize mask position**, because it changes only an additional mask and never removes image pixels. [Adobe: apply or delete layer masks](https://helpx.adobe.com/photoshop/desktop/create-masks/layer-masks/apply-or-delete-layer-masks.html).

## Why a retained frame is necessary

An offset applied to `maskCoverage` preserves the existing geometric feather, bitmap feather boundary, inversion and source clip. Rewriting RLE on every move would discard pixels outside the canvas; moving back could not recover them. Rewriting geometric coordinates can also change floating-point subtraction at fractional edges.

Today bitmap masks match the canvas. `transformMask` resamples/crops those bytes; `resizeCanvasMask` additionally zeros new padding after inversion. Neither helper can consume a retained off-canvas frame unchanged. Meanwhile rendering, group masks, clipping chains, styles, adjustments and protection already share `layerMaskCoverage`; raw mask preview, selection loading, paint and morphology do not. Both kinds of consumer must use the same positioned raw evaluator.

## Persisted representation and compatibility

Prefer a **persisted-only additional-mask wrapper**, not bare `layer.maskOffset`:

```js
layer.mask = {
  shape: 'positioned',
  sourceWidth: 1200,
  sourceHeight: 900,
  x: 35,
  y: -12,
  source: /* one complete legacy geometric or bitmap mask */,
  // Optional, introduced only by an explicit canvas-bounds change:
  domain: { x: 0, y: 0, width: 1200, height: 900 }
};
// Existing layer.maskDensity remains separate.
```

The coordinates of `source`, its own `clip`, and optional `domain` belong to the retained mask frame. They are unrelated to raster `width`, `height`, `transforms`, `sourceAsset` or `alphaAsset`. `x/y` translate that frame into document coordinates. There is exactly one wrapper and one legacy source; no nested wrappers or transform list.

Validate exact wrapper/domain keys, plain JSON, finite bounded integers, source dimensions and the complete legacy source even when density is zero or the layer is hidden. Source axes remain 1–8192 and source area at most 24 MP. A bitmap source must match `sourceWidth/sourceHeight`, not the current canvas. Geometric source validation uses its retained frame with existing persisted coordinate limits. RLE retains the 600,000-scalar limit. Active/saved selections and public raw mask descriptors reject this shape and reject misplaced positioning/density fields; the wrapper is only authored through the positioning command or validated persisted projects.

Proposed authored `x/y` range is ±16,384 document pixels. Geometry-generated persisted offsets/domain edges may reach ±1,000,000, matching existing persisted geometric limits; reject a bounds operation that would exceed that limit before mutation. A caller may always reset to zero or choose an in-range authored position. Coincident and entirely off-canvas masks are valid.

Old native and portable readers already reject an unknown mask shape. They currently ignore unknown layer fields, so bare `maskOffset` would silently render the wrong image unless accompanied by broader native-project and bundle version changes. The wrapper supplies a local fail-closed boundary. Do not migrate every existing mask into a wrapper on load. Legacy graphs keep their descriptor, evaluator and geometry behavior.

At position zero, unwrap only when the wrapper has no added domain and its source frame equals the current canvas; restore the exact source descriptor. A cropped frame with different dimensions or a bounds-derived domain must retain the wrapper even at zero. Old readers may still reject native history containing prior positioned states; that is preferable to silent misrendering.

## Authoritative coverage order

Add `rawLayerMaskCoverage(layer)` and have `layerMaskCoverage(layer)` apply density to it. Generic `maskCoverage` remains restricted to legacy masks and selections.

```text
S(u,v) = legacy maskCoverage(source)(u,v)
u = documentPixelX - offsetX
v = documentPixelY - offsetY
R(x,y) = domain exists and (u+0.5,v+0.5) is outside domain ? 0 : S(u,v)
E(x,y) = existing layer density calculation applied to R(x,y)
```

Thus the order is source shape/bitmap → source feather → source inversion → source persisted clip → translated wrapper domain → layer density. The legacy evaluator itself owns half-pixel geometric centers. Do not add another center shift in the wrapper.

Initial positioning adds **no domain or canvas clip**. Keep existing exterior behavior: uninverted bitmap coverage outside its stored extent is zero; inverted bitmap coverage there is one. An unclipped inverted geometric source similarly covers outside its shape. This avoids inventing a different mask background merely because it moved. Existing source clips still override inversion and move with the source.

Density zero bypasses callback allocation and returns one over the whole canvas, including outside the positioned domain. It still requires full graph validation. Density one returns raw coverage. Interior density keeps the existing byte-domain correction; inspect the **underlying source type** when recovering inherently alpha8 bitmap coverage. Geometric coverage remains continuous. No source alpha, own opacity, ancestor mask or protected footprint is folded into this additional-mask function.

Position-only movement changes two integers and performs no sampling/allocation, pixel/asset write or descriptor rewrite. Returning to the same offsets supplies exactly the same coordinates to the same raw source and therefore returns the same coverage, including fractional feather and off-canvas content.

## Public commands and capabilities

Proposed commands, both ordinary native mutations and transaction-compatible:

```text
set_layer_mask_position {
  documentId, expectedRevision?, layerId,
  x: integer[-16384,16384], y: integer[-16384,16384]
}
apply_layer_mask_position {documentId, expectedRevision?, layerId}
```

Both return the normal `{document}` envelope. `set` requires an existing additional mask (`NO_MASK` otherwise), creates a retained wrapper only for a nonzero initial position, and sets absolute offsets rather than accumulating deltas. Zero means the source frame's origin, not the position immediately before a crop. Setting zero on an ordinary mask is an accepted no-op under existing mutation/history policy.

`apply` requires a positioned wrapper; otherwise return `MASK_NOT_POSITIONED`. UI and tool descriptions label it **Rasterize mask position**. Its source pixels, cutout alpha and layer density never change. No operation is Adobe-style “apply mask to image.”

Proposed capabilities:

```js
layerMaskPositioning: 'independent-translation'
layerMaskPositionUnits: 'document-pixels'
layerMaskPositionOperations: ['set', 'rasterize']
limits.maxLayerMaskPosition: 16384
limits.maxLayerMaskSourcePixels: 24_000_000
```

Support every native layer that can own an additional mask: content, adjustment and group. Missing layer, malformed wrapper, misplaced fields and unsupported nested/source wrappers fail early. Protected layers and groups with protected descendants may position/refine their masks, following the current permission to edit masks; this does not authorize source RGB edits or weaken subsequent write protection.

## Geometry without silent alpha8 conversion

The following policy avoids blanket crop/expand/paint/morph rejection while keeping the first representation small.

| Operation | Positioned-mask behavior |
| --- | --- |
| Image move/scale/rotate/flip | Mask stays anchored in document coordinates, exactly as current additional masks do. No linkage is inferred. |
| Crop document | Retain source/frame/domain; set `x' = x - cropX`, `y' = y - cropY`. No resampling, new feather edge or new domain. Visible coverage satisfies `Rnew(i,j) = Rold(i+cropX,j+cropY)` exactly. Off-canvas source remains available to later mask positioning. |
| Resize canvas / expand / shrink | Translate offset by the existing integer anchor delta. Intersect the domain with mapped old and new canvas rectangles, as detailed below. This keeps existing zero-new-padding semantics without alpha8 conversion. |
| Resize image (`resize_document`) | Reject if **any** layer has a positioned wrapper, including hidden/density-zero masks. Return `MASK_POSITION_REQUIRES_RASTERIZE` naming affected layers, before any graph/asset changes. Rasterize those masks first, then use existing resampling. A truly dimension-identical resize may retain the normal no-op behavior. |
| Paint additional mask | Materialize positioned **raw** current-canvas coverage as the brush's starting mask; `replace` starts empty as it does today. Apply the explicit brush operation, store a normal canvas bitmap and clear the wrapper. Preserve density. |
| Morph additional mask | Sample positioned raw coverage once, run existing morphology, store a normal canvas bitmap and clear the wrapper. Preserve density. |
| Feather/invert/density edit | Feather/invert modify the retained source descriptor; density modifies only the layer. Keep offsets/domain/frame. Feather units are current document pixels because v1 has translation only. |
| Replace/remove mask, mask from selection, adjustment mask replacement | Replace the entire positioned mask and reset density using existing replacement rules. No old offset survives. |

Legacy masks continue through their current geometry helpers byte-for-byte. Only positioned wrappers use the new branches. Cropping a retained bitmap can leave a much larger source than the current canvas, which is why every validator and memory estimator must use source dimensions explicitly.

For `resize_canvas`, let old offset be `(ox,oy)` and anchor delta `(dx,dy)`. New offset is `(nx,ny)=(ox+dx,oy+dy)`. Define source-coordinate rectangles:

```text
A = [-ox, -oy, oldCanvasWidth, oldCanvasHeight]
B = [-nx, -ny, newCanvasWidth, newCanvasHeight]
newDomain = intersection(previousDomain or unbounded, A, B)
```

Represent empty intersection canonically with zero width/height; all coordinates and comparisons are integers. Return the original descriptor for a dimension/anchor no-op. Source feather/inversion/clip are not edited. On overlap pixels, coverage matches the old canvas translated by `(dx,dy)`; new padding is raw zero, even for inverted sources. Density applies afterward, so density zero remains fully revealing.

This canvas-bounds operation **can discard retained off-canvas coverage for later moves**, exactly because zero-padding is the established bounds policy. Example: selected source pixel 0 positioned at document x=4 on a width-4 canvas is off canvas; expanding to width 8 does not reveal it, and the domain excludes it until Undo. Position-only movement is lossless; canvas extent changes are not promised to preserve hidden mask support. Crop retains source coverage, whereas canvas-bounds changes impose the established hard extent. These differing policies must be stated, not hidden behind a generic “nondestructive” label.

Image resize is deferred because offset×scale is usually fractional, geometric feather scales continuously, and bitmap feather is computed on a resampled discrete region. Rounding an integer offset silently shifts coverage; resampling the current canvas silently loses off-canvas support. Supporting all cases faithfully would require a declared source-to-document mapping, interpolation and feather-unit model. That is a larger milestone, not an innocuous extension of two integer offsets.

## Explicit canvas materialization and its precision

`apply_layer_mask_position` samples `Q(R)=clamp(round(255*R),0,255)` at current canvas pixel indices, encodes a normal bitmap, and publishes only after all RLE/graph/history checks pass. Set feather zero and inversion false; raw source effects have been evaluated once. Preserve `layer.maskDensity` unchanged. No RGB/alphaAsset asset is read or written.

The action discards source-frame samples outside the current canvas and continuous geometric coverage between byte values. The mathematical raw-coverage error is at most `0.5/255` per sampled pixel (apart from floating-point roundoff); after density it is at most `density * 0.5/255`. This is a coverage bound, **not** a blanket one-byte bound on arbitrary unpremultiplied composited RGB. Displayed raw mask-preview bytes remain the same under the same Q255 sampler. Do not promise bit-identical composite pixels after converting fractional geometric masks, or rely on altered inversion arithmetic having identical half-tie behavior downstream.

Bitmap coverage is already alpha8 after feathering; materialization retains its quantized visible raw values. Off-canvas loss and resetting editable feather/inversion still matter. Undo restores the whole retained descriptor, offsets and domain.

Paint/morph are already explicit canvas-rasterizing mask edits in the current product. Extend their starting callback to positioned raw coverage and disclose **“Painting or reshaping rasterizes the positioned mask to the canvas; off-canvas coverage is discarded.”** Do not demand a redundant separate apply click. They must stage the complete replacement and retain the old wrapper on failure. `paint_mask mode:'replace'` intentionally ignores the old mask, while preserving density as before. Exports and reads must never perform this mutation.

## Consumer, lifecycle and protection obligations

Use central helpers for validation, raw callback, effective callback, source-type inspection and source buffer cost. Never teach generic selections to accept the wrapper merely to avoid call-site changes.

- Rendering, groups, clipping chains, adjustments, outlines/effects, ancestor contexts, `protectedPixels` and generated/filter exclusions inherit positioned effective coverage through `layerMaskCoverage`. Decoration casting remains before ancestor mask clipping; position does not change that ordering.
- Raw/effective `get_mask_preview` and `load_layer_selection` use the positioned raw/effective helper. Their output coordinates and dimensions remain the **current document**, not the retained frame. Existing content-alpha selection and `get_layer_preview view:'mask'` (source cutout alpha) remain independent.
- Morphology and mask painting use positioned raw coverage. `modify_layer_mask` edits source feather/invert, not nonexistent wrapper fields. Active/saved selection painting, morphology and geometry remain unchanged.
- Duplicate/subtree duplicate deep-copy the wrapper. Reparent/reorder keep its document coordinates. Rasterization reconstructs a layer but must carry its mask wrapper and density unchanged. Extraction likewise preserves the additional mask. Paint/fill of image pixels keep the existing positioned mask untouched.
- `place_layer` already bakes the source layer's own effective coverage into a new copy's alpha. Positioned masks follow that rule; the original remains editable, the placed copy does not receive the old wrapper or apply density twice. Existing nonneutral-ancestor/filter/clipping restrictions remain.
- Undo/reopen and `.prism` preserve the full wrapper and source descriptor. Validate malformed source/frame/domain before image access. No new pixel asset, bundle asset role, source attachment or native project-version bump is required.
- PSD export samples effective coverage through the shared helper and keeps its exact-alpha8 gate. Warn that the exported mask is a current-canvas materialization and omits independent position/off-canvas source/editable feather. PSD export never clears the native wrapper. Existing PSD import and archived source remain unchanged.
- Source RGB, working raster/source hashes, source transparency and cutout `alphaAsset` never change from positioning or rasterizing an additional mask. Additional-mask replacement is not source-cutout repair.

After a protected layer/group mask moves, current protected footprints must immediately reflect newly visible pixels, including alpha one, density-expanded coverage and styled pixels. Newly exposed protected pixels remain excluded from subsequent AI output, filter RGB replacement, paint/fill and retouch writes. Generation capture retains its old snapshot rules; current installation/render protection must also use the newly positioned geometry. Mask editing permission is intentionally distinct from permission to recolor the protected subject.

## Bounds and resource accounting

The wrapper has fixed depth and bounded metadata; repeated moves never grow a transform list or resample/grow RLE. Normal private graph and Undo snapshots still copy metadata. Coverage uses two integer subtractions and an optional rectangle check per sample. A geometric callback allocates no full mask plane. For retained bitmap area `S`, callback construction reserves `S` bytes or `5S` with feather; density-zero effective reads reserve zero callback bytes but still validate the source.

For a graph containing any positioned mask, define `B` as the sum of source bitmap areas of **all** effective additional masks, including coexisting legacy masks and hidden layers, excluding density-zero callbacks. Let `D` be the largest `4S` feather construction plane. Reserve `2B + D`: renderer ancestor callbacks can coexist with a second callback set in original-context protection; constructors are synchronous, so one feather distance plane suffices. Add this reserve to the existing maximum group/clipping/filter retained scratch and enforce their shared 256 MiB named-buffer ceiling before commit or rendering. Empty groups and root leaves participate in the peak. Legacy graphs without positioned masks retain their previous admission. This is not total renderer or process RSS.

Update mask preview's existing `C + 5P + E + 5B` ledger to use retained `S`, not current document area `N`, for `C`. Update layer selection's source-type/storage helper and layer-mask validation similarly. Sampling remains current-canvas or preview-plane only. This also applies after a large bitmap is cropped to a tiny canvas.

Rasterizing position uses callback storage `C` plus one output alpha plane `N`, with the existing 256 MiB explicit-binary-buffer ceiling, row yields (32 rows), 600,000 RLE scalars and 16 MiB project/history cap. RLE arrays/JSON are metadata rather than binary-buffer accounting; enforce both limits before publication. Density is not sampled into this output. Positioned painting preflights `C + 10N` (two RGBA surfaces and up to `2N` brush coverage; the later alpha-extraction phase is `9N`); replace mode needs no old callback. Positioned morphology reserves `C + 4N + 4*max(width,height)` for its input and three owned byte planes plus deque. Both add no redundant starting bitmap/RGBA conversion. These are explicit buffer bounds, not total-process RSS guarantees; existing feather initialization and legacy brush loops retain their current synchronous limits.

Positioned PSD preparation uses the maximum of its existing writer snapshots/output phase, completed current-canvas mask planes plus the largest source callback, and completed mask planes plus combined render scratch/callbacks plus the live composite/protection pair `5N` and peak original/previous/next source RGBA geometry. A separate phase accounts already-collected exported layer RGBA while later source geometry renders. The source geometry reserve includes `9S` for separate-alpha combination when applicable. Inspect/export reject excess preparation before constructing a callback. These named raw buffers do not include source codec caches or promise total RSS.

Position setters validate their candidate graph before assignment. Transactions with positioned masks before or after a step validate the complete staged graph after that step, before any later operation can render, segment or publish an asset. Extraction preflights the additional copied mask before reading source pixels or invoking segmentation. Commit remains queued, revision-checked and atomic. The two new commands perform no source/asset writes. Transactions containing a later failure restore masks, offsets, history, revision and preview cache under existing transaction rules; unrelated asset-producing operations retain their established asset-cleanup policy.

## Acceptance before advertising

1. Legacy fixtures across every mask shape, inversion, density, group mode, clipping and protection produce identical pixels and serialized descriptors without new wrappers.
2. Position out/back repeatedly on x/y, negative and beyond-canvas offsets; compare full retained descriptor/RLE and every raw/effective sample. Include inverted exterior, original clips and bitmap feather at its original boundary.
3. Fractional geometric feathers and all 256 bitmap values under forward/inverted density 0/.25/.5/.75/1 agree between render, raw/effective preview and selection loading. Source-cutout preview and content-alpha selection ignore positioning.
4. Crop fixtures prove exact integer-coordinate identity and retained intrinsic bitmap dimensions. All nine canvas anchors prove overlap identity, zero new padding, source-domain clipping, empty intersections and the explicit lost-offcanvas example. No geometry path samples to alpha8.
5. Resize guard covers hidden, density-zero and zero-offset retained wrappers, rejects before writes, and allows the documented rasterize→resize path. Legacy resizing is unchanged.
6. Apply/paint add/subtract/replace/morph produce independently sampled raw canvas bitmaps, preserve density, clear position, and restore full source/frame after Undo. Include zero stroke opacity, fractional geometric quantization, empty mask and RLE overflow rollback.
7. Content/adjustment/pass-through/isolated group/clipping-base/member masks and outside styles share effective coverage. Move masks on protected subjects, then verify subsequent generation/filters/retouch/fill preserve newly visible source pixels and upper generated preview context.
8. Duplicate/extract/rasterize preserve masks; placement bakes once; replacement/removal resets. Source bytes and alphaAsset remain exact through undo/reopen/.prism. Malformed/nested wrappers, source dimensions, misplaced metadata and over-budget retained frames fail before assets are processed; old mask validators reject the new shape.
9. Read-only preview/selection resource estimators account a 24 MP retained source after a tiny crop, including density-zero fast paths. Metadata-only positioning does no renderer/model/asset I/O. Disk/stale/transaction failures retain state and caches.
10. Independently decoded supported PSD masks equal exported effective coverage; fractional coverage still rejects and reports omitted positioning/off-canvas data.

The recommended tradeoff is one new retained mask descriptor, two commands, exact translation/crop/bounds arithmetic and explicit canvas-baked refinement. It avoids a full affine mask engine and keeps existing editing available; only image resampling requires the user to choose the declared conversion first.

A read-only local probe compared 32,940 samples for the proposed crop and all nine canvas-anchor/domain equations against direct legacy coverage. Fractional geometric feather, bitmap feather, inversion, clips and negative/off-canvas offsets matched exactly. This proves the coordinate identities on those fixtures, not implementation or lifecycle correctness; the production acceptance checks above remain required.

Native evidence: `tests/mask-position.test.mjs` covers exact movement, domain geometry, source-sized resource accounting, metadata-only persistence/portable state, raw/effective previews and selections, materialization and rollback. Independent coverage is in `tests/mask-position-audit.test.mjs`, including newly revealed protected pixels and pre-allocation PSD/transaction boundary cases. Root's `tests/mask-position-schema.test.mjs` and `tests/mask-position-mcp.test.mjs` cover the public schema and actual SDK workflow.

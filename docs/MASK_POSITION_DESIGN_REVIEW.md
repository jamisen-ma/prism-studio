# Independent review: additional-mask positioning

Design and independent native audit, 2026-09-19. This reviews [the implementation contract](MASK_POSITION_DESIGN.md), [feasibility](MASK_POSITION_FEASIBILITY.md), [the UI proposal](MASK_POSITION_UI_DESIGN.md), and the native consumers. The independent helper/native audit passes **10/10**; browser behavior remains separately verified by its owner. This reviewer has changed no production files.

The retained `shape: 'positioned'` wrapper is appropriate. Integer positioning and crop can preserve continuous coverage without resampling. Canvas-bounds changes intentionally impose a different, clipping policy. The important issue found during review was a resource-accounting bypass after crop; root accepted a combined mask-callback and existing render-scratch guard, described below. With that correction, there is no unresolved representation or geometry blocker.

Adobe's documentation establishes that an unlinked mask can move independently of its layer. It does not establish Prism's numerical, bounds or retained-source semantics. [Adobe: unlink layers and masks](https://helpx.adobe.com/photoshop/desktop/create-masks/layer-masks/unlink-layers-and-masks.html). The native conversion must be called **Rasterize mask position**, since Adobe's separate Apply Layer Mask workflow changes the treatment of hidden image areas. Our conversion must never change image RGB or source-cutout alpha. [Adobe: apply or delete layer masks](https://helpx.adobe.com/photoshop/desktop/create-masks/layer-masks/apply-or-delete-layer-masks.html).

## Representation and validation

The wrapper provides an existing compatibility barrier: old `normalizeMask` rejects the unknown shape. A bare optional offset field would be ignored by old native readers and silently change the image. Do not broaden generic selection validation just to accept the new layer-owned descriptor.

The source is exactly one legacy descriptor, with its own retained dimensions; its geometry, inversion, feather and original clip stay intact. Active/saved selections, public replacement masks and source `alphaAsset` never accept the wrapper. Validate the wrapper and domain's exact keys, plain data, integer bounds, source area/axes/RLE and nested ownership even for hidden layers, empty domains and density zero. Reject nested positioned sources and misplaced positioning/density fields. Native graph validation must precede bundle asset reads, so `.prism` cannot defer malformed-mask rejection until rendering.

Zero offset alone does not imply a legacy mask. Unwrapping requires both the current canvas dimensions and no domain. Keep a zero-offset wrapper after crop or domain clipping; history containing a positioned state may remain unreadable by old versions even after the current state unwraps. That is fail-closed compatibility, not backward file compatibility.

The public authored range and persisted geometry range are distinct. A valid geometry-produced position beyond ±16,384 must remain visible in the UI without automatic clamping. Domain endpoints as well as origins and extents must stay within the declared persisted bounds. Validate arithmetic before assigning candidate geometry, including canonical empty intersections.

## Coverage and geometry conclusions

For integer document coordinates, let `u=x-offsetX`, `v=y-offsetY`. Evaluate the unchanged legacy source at `(u,v)`, then its source-space wrapper domain, then separate layer density. The source evaluator already owns the half-pixel center; the wrapper must not add another half pixel. Inversion precedes both original source clipping and the new domain; it must not turn an excluded domain back on. Density zero intentionally reveals the whole canvas without changing source transparency or AI protection.

Detect bitmap storage through the underlying source. Its existing byte-unit density correction must remain in use after positioning; geometric coverage must not acquire a preliminary alpha8 quantization. The inverted bitmap exterior remains one until an explicit domain excludes it. An initially empty inverted bitmap moved wholly off canvas distinguishes this policy from a finite plane with an implicitly black exterior.

The crop identity follows directly from integer arithmetic:

```text
offset' = offset - cropOrigin
newRaw(i,j) = oldRaw(i+cropX,j+cropY)
```

The retained descriptor and domain do not change, so this does not invent bitmap-feather edges. Image geometry changes still leave the additional mask anchored in document coordinates; positioning is not linkage.

For a canvas anchor translation `delta`, retain the source and set `offset'=offset+delta`. Intersect the previous domain with the old canvas mapped by `-offset` and the new canvas mapped by `-offset'`. Old overlap is exact; newly padded raw coverage is zero. A four-pixel canvas with source pixel zero positioned at x=4 is a decisive loss fixture: expanding to eight pixels must not reveal it, and moving back cannot recover it until the bounds edit is undone. Crop retains off-canvas support; canvas resizing can discard its eligibility through the domain. The UI must not call both operations lossless.

Guard image resampling based on wrapper presence, including hidden, density-zero and zero-offset wrappers. Do not rasterize as an invisible prerequisite. An exact dimension no-op may preserve the wrapper if the native no-op path is explicit.

Rasterizing position intentionally samples current-canvas raw coverage once to alpha8, removes editable source feather/inversion and off-canvas support, and retains density. Its coverage error bound is not a bound on composited unpremultiplied RGB. Paint and morphology may perform the same declared conversion as part of their requested edit; Replace ignores old coverage, while zero-opacity Add still follows the explicit materialization policy. Neither export nor a read-only preview may trigger conversion.

## Resource correction accepted during review

Retained source dimensions can be much larger than the current canvas. Existing [ancestorContext](../server/native.mjs) holds an array of callbacks, and isolated layer previews can call original-context `protectedPixels` while renderer ancestor callbacks are still alive. Eight feathered 24 MP mask sources on a tiny cropped canvas can retain 192 MB of alpha plus a 96 MB construction distance plane. A canvas-only group estimate misses this.

The approved conservative correction applies only when the graph contains a positioned wrapper, preserving admission of graphs with exclusively legacy masks:

```text
B = sum intrinsic bitmap source areas of effective layer masks
D = maximum 4 * intrinsic source area among feathered effective bitmap masks
callbackReserve = 2*B + D
callbackReserve + existing peak group/clipping/filter scratch <= 256 MiB
```

Count hidden masks. Effective density-zero callbacks allocate no source plane but their complete descriptors still validate; raw preview, raw selection and mask editing must count the source regardless of density. Include legacy masks in `B` when a positioned graph is admitted, since both types can coexist. Two copies conservatively cover renderer plus original-context protection callbacks; one construction transient is sufficient because callback initialization is synchronous. This is a conservative named-buffer envelope, not measured peak RSS, a codec bound, or a promise about immediate garbage collection.

The owner initially proposed a separate callback envelope. Root subsequently accepted combining it with group/filter/clipping scratch; this later decision is authoritative. Check the helper's root-leaf, empty-group, all-hidden and no-filter branches so no early return skips the reserve. Arithmetic must use validated safe JavaScript numbers, not bitwise 32-bit accumulation. Metadata-only Set Position performs these estimates without constructing a pixel callback.

Additional operation phases require their own source-sized counts:

| Operation | Required accounting |
| --- | --- |
| Mask inspection | Existing `C+5P+E+5B64` ledger; `C` comes from retained source area, not graph area. `B64` here is the encoded base64 length, unrelated to callback sum `B` above. |
| Load mask selection | Source callback `C` plus current-canvas alpha, followed by the existing active-selection combination phase. Source and active selection cannot both be treated as canvas-sized legacy descriptors. |
| Rasterize position | Source callback `C` plus one current-canvas alpha plane, row yields and bounded RLE encoding. |
| Paint additional mask | Account callback `C` plus `10N`: `4N` input, `4N` painted output and up to `2N` Uint16 dab coverage coexist; the later alpha extraction phase is smaller. Replace can skip old coverage construction. |
| Morph additional mask | Account callback/materialized alpha, then the existing three owned morphology planes and axis deque. A helper boundary can release callback references before morphology; otherwise conservatively include `C+4N+deque`. |
| PSD preparation | Check exact-mask construction with previously retained canvas mask planes plus the current callback/output. Also count all completed mask planes plus callback/scratch reserve, the live `5N` composite/protection pair and peak original/previous/next source RGBA frames during `renderGraph`. Separately count retained exported layer frames during later source rendering. Preserve the existing writer snapshot/output ledger and use the maximum relevant preparation/writer phase. |

Single-mask callback cost is `S` or `5S` with feather. Raw density-zero reads do not get an effective-coverage bypass. Source dimensions, RLE scalar limits and the 16 MiB history-inclusive project cap remain independent checks. Existing synchronous bitmap feathering and brush loops are not made cancellable by adding these estimates.

## Consumer map and invariants

| Current seam | Required treatment |
| --- | --- |
| `native.validateGraph`, bundle validator callback | Separate additional-mask validation from generic selection validation; reject malformed wrappers before assets. |
| `layerMaskCoverage` | Delegate to authoritative raw additional-mask evaluator, then density. This reaches groups, adjustments, clipping, decorations, protected footprints and generated/filter exclusions. |
| `mask-preview.mjs`, `layer-selection.mjs` | Raw and effective layer modes accept the wrapper; ordinary active selections remain legacy. Output dimensions remain current canvas dimensions. |
| `morphology-commands.mjs`, `paintSelection` internal starting-coverage seam | Use positioned raw coverage once; publish a legacy canvas bitmap only after all limits succeed. Preserve density. Do not pass the wrapper to generic `maskCoverage`. |
| `modify_layer_mask` | Modify retained source feather/invert, never add those fields to the wrapper. |
| Native crop/canvas/image-resize loops | Dispatch wrappers through exact metadata geometry; leave legacy masks and saved/active selections on their existing paths. Image resize rejects before layer transforms are appended. |
| Rasterize/extract/duplicate/reparent | Preserve wrapper and density. Rasterization currently reconstructs the layer, so explicit metadata retention must be tested. |
| Placement | Existing own effective coverage becomes placed-copy source alpha once. Do not copy the wrapper/density onto that baked alpha. Preserve source document state. |
| `psd-native.mjs` and PSD report | Effective translated coverage still passes the exact alpha8 gate; warn about omitted source frame/position and keep native metadata unchanged. |
| UI mask summary/refinement | Read underlying source shape/feather/invert, display wrapper position separately. Keep source-cutout alpha tools and selection overlays separate. |

Protection is an additional invariant, not an exception to mask editing. Moving a protected layer's or ancestor group's additional mask may change visibility under the existing permission model. Newly visible alpha-one source and styled pixels must immediately enter the protected footprint used by subsequent fill/retouch, filters and generated output. A mask's density/domain must never weaken the final hard exclusion protecting other people. Content-alpha selection and raw source-cutout previews ignore this additional mask as before.

## Required independent acceptance fixtures

1. Legacy graph/source-byte equality, plus old normalizer rejection of a positioned shape. Malformed nested source/domain, invalid retained dimensions and misplaced fields fail under asset-I/O spies, including density zero.
2. All 256 bitmap values, inversion, density 0/.25/.5/.75/1, original bitmap feather edges, fractional ellipse/polygon and internal clip. Move away/back repeatedly; compare raw and effective samples and retained descriptor identity.
3. Independent crop-coordinate identity and every canvas anchor, repeated crop/expand, empty domain, negative offsets and the explicit off-canvas-loss fixture. No hidden alpha8 conversion.
4. Current-canvas preview and loaded selection byte oracles; source alpha and content selection remain unchanged. Apply/paint/morph quantize raw only and retain density, with Undo restoring the complete source frame.
5. Protected subjects in masked pass-through/isolated groups; clipping base/member masks; outside styles; generated layer preview using original lower protection. Move the mask before subsequent fill/filter/generation operations and verify newly revealed pixels remain exact.
6. Independent admission oracle for cropped large retained sources, combined group/filter/clipping scratch, density-zero effective versus raw reads, and PSD retained mask-plane phases. Check rejection before callbacks/asset reads/publication.
7. Duplicate/rasterize/extract/placement, stale revision, real persistence failure, failed outer transaction, reopen and `.prism` byte-exact source preservation. PSD independently decoded masks retain effective alpha8 and reject fractional coverage.
8. UI source unwrapping, faithfully displayed large persisted offsets, zero-offset wrapper conversion, partial capabilities, saved preview invalidation, and delayed mutation responses across document/target switches. Numeric drafts must not trigger writes; Scale requires an explicit later user submission after mask conversion.

## Verified implementation audit

All **10 tests** in [mask-position-audit.test.mjs](../tests/mask-position-audit.test.mjs) pass against the helper/native implementation. They cover alpha8 density/exterior arithmetic, independent bitmap feather boundaries, reversible fractional geometry, crop/all anchors, combined resource admission, native preview/render/selection bytes, newly exposed own/ancestor protected pixels, and malformed portable validation before assets. Protected tests exercise saved generation masks and current installation exclusion, a subsequent mask movement in generated-layer inspection, fill destinations and filtered RGB restoration without providers.

The PSD near-boundary fixture also passes after the preparation ledger correction: a 512×512 document with six retained 6000×3700 unfeathered bitmap masks passes the old callback-only estimate but fails when live composite/protection/source frames are counted. Inspection and export now refuse before any large callback allocation or rendering.

An independent raw PSD channel reader confirms that supported translated/inverted/domain-clipped mask pixels are exported exactly. Fractional half-byte density refuses export instead of silently rounding, while density zero passes with valid retained metadata.

The transaction issue found during review is fixed. A transaction previously could create an over-budget positioned intermediate graph and then reach a later rasterization before final commit validation. The final regression covers initial positioning, density activation, increased feather and canvas growth. All four now refuse before source rendering or asset writes, preserving the project file, revision/history, asset directory and preview-cache state. The setter validates its candidate, and the transaction loop validates after a step when either its prior or resulting graph contains a positioned wrapper.

Verification command: `node --test tests/mask-position-audit.test.mjs` — **10 passed, 0 failed**. The tests use small real pixels or allocation-guarded metadata fixtures; no image provider, segmentation model or credentials are accessed. No remaining correctness blocker was found in this bounded audit. Browser evidence remains owned by the UI specialist.

## Independent UI source review

The new `MaskPosition` component correctly separates a positioned wrapper from its source shape, accepts integer values without clamping drafts, preserves geometry-produced offsets beyond the authored range, and offers Rasterize for a retained wrapper at zero offset. Numeric-equivalent drafts such as `04` versus saved `4` no longer block rasterization. Position, feather and density editors use revision/context keys; mask actions capture the displayed target and revision. Set-only, rasterize-only and read-only positioning controls have separate capability checks.

Resize review navigation stores the user's dimensions and mode, focuses the selected mask, and returns to an explicit Resize submission after conversion. Hidden and density-zero masks still appear as blockers. No effect or completion handler automatically resubmits the resize. Canvas-bounds loss and mask paint/morph conversion disclosures match the native contract; source-cutout brushes remain separate.

Two additional source findings were sent to the UI owner:

1. `ResizePanel` initially submitted through the generic runner without a document-scoped result guard. A delayed resize success could update an old document after the active context changed. The source fix now guards document/backend/revision before and after the awaited preview without making a whole-document resize depend on selected-layer identity. The owner's adversarial delayed-success checks pass for both a changed selected layer and navigation to another document with a newly opened dialog.
2. `LayerMaskProperties` initially exposed Feather/Invert whenever `modify_layer_mask` existed, even with an explicit partial property list advertising only density. The source fix gates those individual properties when a list exists and retains legacy behavior only when that capability field is absent.

Both fixes were independently confirmed in source. The owner reported eight real-browser workflows passing and added passing checks for density-only/legacy-absent property capabilities and delayed resize results. Same-document revision conflicts also refresh current metadata. No separate duplicate browser suite was created by this reviewer.

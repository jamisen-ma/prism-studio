# Additional mask positioning: feasibility review

Design review, 2026-09-19. No production files were changed and no new implementation is claimed. This report complements the native owner's `MASK_POSITION_DESIGN.md`; the implementation contract should resolve the representation choices below before work begins.

**Recommendation:** deliver absolute integer **mask-only positioning**, with retained source coverage, exact crop translation, and an explicit **Apply position to canvas** operation before image resampling. Defer linked content movement. Painting and morphology remain deliberate current-canvas materializations, with off-canvas loss disclosed. Canvas bounds changes retain the existing padding-clip policy and must disclose its retained-coverage consequences. The native owner is specifying this coordinated scope; the implementation contract must pin the open exterior/domain choice below.

Adobe documents linked layer/mask movement and independent movement after unlinking. The initial Prism increment would cover independent positioning only, with its own stated limits. [Adobe layer/mask linking](https://helpx.adobe.com/photoshop/desktop/create-masks/layer-masks/unlink-layers-and-masks.html).

## What the current code actually assumes

| Area | Current invariant and implication |
| --- | --- |
| [masks.mjs](../server/masks.mjs) | Geometric masks retain editable coordinates, continuous feather, inversion and an optional persisted clip. The clip zeros coverage **after inversion**. Bitmap masks have intrinsic dimensions and RLE data; their feather is evaluated into an alpha8 plane. They cannot carry a geometric `clip`. |
| [layer-mask.mjs](../server/layer-mask.mjs) | Density belongs to the layer. Effective coverage is `1 - density * (1 - rawCoverage)`, with exact zero/one branches and bitmap byte-domain rounding. Density zero reveals everything allowed by source alpha and other independent restrictions, including outside a mask clip. |
| [native.mjs](../server/native.mjs), `validateGraph` | Every additional bitmap mask currently matches the document dimensions. Active/saved selections have the same canvas-size invariant. `transform_layer` moves the image but leaves the additional mask anchored to the document. |
| Native geometry | `crop_document`/`resize_document` call `transformMask`; `resize_canvas` calls `resizeCanvasMask` for each additional mask. Bitmap paths allocate new canvas-sized coverage; canvas expansion zeros new padding, including inverted masks. These helpers cannot implement retained off-canvas mask movement as-is. |
| Native rendering | Content, clipping chains, group composition, adjustments, styles, ancestor masks and protected footprints already obtain effective coverage from `layerMaskCoverage`. This is the main integration advantage. |
| Raw readers | [Layer selection](../server/layer-selection.mjs) and [mask preview](../server/mask-preview.mjs) call `maskCoverage(layer.mask)` directly for raw mode. Updating effective rendering alone would leave both tools showing the wrong position. |
| Raw writers | [Morphology](../server/morphology-commands.mjs) and [mask painting](../server/raster-ops.mjs) materialize only the current canvas. They would lose retained off-canvas coverage if allowed to consume a positioned mask implicitly. |
| Separate cutout alpha | `alphaAsset` is combined with source alpha before image geometry. Additional masks apply later, in document coordinates. Moving an additional mask must never rewrite, reinterpret or move `alphaAsset`. |
| Portable/native versions | [Bundle validation](../server/project-bundle.mjs) allowlists graph fields but not every layer field. Native graph validation also ignores unknown layer metadata. An old reader could silently ignore a new `layer.maskOffset`; an explicit compatibility barrier is therefore necessary. |

## Coordinate and coverage contract

Keep one original mask descriptor and evaluate it at translated sample coordinates. Do not rewrite its RLE, points, feather, inversion or clip when changing position.

```text
S(u, v) = existing raw maskCoverage(originalDescriptor)(u, v)
R(x, y) = S(x - offsetX, y - offsetY)
E(x, y) = density == 0 ? 1
        : density == 1 ? R(x, y)
        : existing density calculation applied to R(x, y)
```

Inputs are integer document pixel indices; the existing geometric evaluator adds the half-pixel center itself. Offset is in document pixels and affects only the additional mask. The local mask plane is not the raster image's source coordinate system. Ordinary image transforms leave this plane stationary until a separately implemented linkage policy says otherwise.

Important consequences:

- Moving away and back returns the identical source descriptor and sample inputs. There is no accumulated sampling, feathering or quantization error.
- Internal geometric clips move with their mask, since they are evaluated in the same local plane. Do not add a fresh document-bound clip on every move.
- The existing out-of-bounds evaluator returns zero outside an un-inverted bitmap and one outside an inverted bitmap. An unclipped inverted geometric mask likewise covers outside its shape. A preexisting internal clip overrides inversion. **Decision to pin:** preserve these exterior rules, or make a positioned mask a finite source-canvas plane whose exterior is zero even after inversion. The latter is a valid new scoped behavior but must be explicit; identity on the original canvas does not test it. Test a moved, inverted, completely empty mask to distinguish the choices.
- Bitmap feather remains computed on the retained bitmap, including its original boundaries. Moving it across the current canvas must not create a new feathered edge.
- Density is applied last and never stored in the mask source. Detect whether the **underlying source** is bitmap when preserving the existing half-up alpha8 density logic.
- Selection/source-alpha fields never acquire mask-position metadata. Content-alpha selection remains independent of the additional mask; raw/effective additional-mask selection samples the translated result.

For the first command, use a strict absolute `set_layer_mask_position {documentId, expectedRevision, layerId, x, y}` with integer `x/y` in `[-16384,16384]`. This covers more than an entire maximum-size canvas in either direction without unbounded coordinates. Missing mask rejects. One command produces one undo step and no asset writes. UI labels should say “Mask position, px” and “Reset position”; reset moves the retained source to its original origin rather than deleting the mask. All additional-mask-owning layer types can share the evaluator, but group/adjustment tests are mandatory before advertising them.

## Representation and older-reader compatibility

Two representations are reasonable; neither should be merged accidentally with selections:

| Choice | Benefit | Necessary extra work |
| --- | --- | --- |
| Layer-owned `maskOffset:{x,y}` with a new `rawLayerMaskCoverage(layer)` | Minimal change to the existing legacy mask descriptor and density helper; identity can omit the field. | Add a real native-project and portable compatibility barrier. Current readers otherwise ignore this unknown field and render the wrong image. Native project v2 plus portable manifest v2, with readers accepting v1/v2, is explicit but broadens the milestone. A new graph flag alone protects old portable readers, not current old native loaders that ignore unknown graph fields. |
| Persisted-only `mask:{shape:'positioned', source:LegacyMask, sourceWidth, sourceHeight, x, y, clip?}` | Retains the source once and naturally fails in old mask validators because the shape is unknown. No whole-file version migration is required merely for rejection. Source dimensions allow exact crop without changing the retained bitmap. | Additional-layer validation explicitly permits this shape; generic selection validation rejects it. Permit exactly one wrapper, never recursive wrappers. Refine controls/preview estimates inspect its source. A layer-owned raw-coverage helper handles it; do not casually extend every generic mask operation. The optional wrapper clip uses source-plane coordinates and zeros coverage after source feather/inversion/internal clip but before density. |

**Prefer the positioned wrapper; the native owner independently favors it**, because it gives old readers an existing fail-closed boundary. At zero offset, a source still compatible with the current legacy canvas and with no effective additional wrapper clip can unwrap to the unchanged descriptor. Do not drop an operative wrapper clip during canonicalization. Old native readers still reject a file if retained history contains positioned states, which is safer than misrendering it. Current-state portable export can use the legacy form only when every current mask is truly legacy-compatible. This is representation compatibility, not a promise that older Prism releases understand all other newly added features.

Validate exact wrapper keys, integer bounded offsets, one legacy source, ownership and source size/RLE limits at command, graph and bundle boundaries. Reject density or position hidden inside raw sources/clips. If a future crop retains a bitmap whose dimensions differ from the canvas, zero offset alone is no longer sufficient to unwrap it.

## Explicit Apply position operation

Offer a separate `apply_layer_mask_position {documentId, expectedRevision, layerId}` action; never call it as a hidden prerequisite of resizing or export. It samples **raw translated coverage on the current canvas** into alpha8, then stores a normal canvas-sized bitmap with feather zero and inversion false, retaining the layer's separate density. It clears positioning metadata. Painting and morphology are separately requested coverage-writing operations and may perform their own clearly disclosed current-canvas materialization, as described below.

The interface and MCP description must state the consequence: this discards off-canvas mask coverage and converts continuous feathered geometry to 8-bit coverage. That can change a rendered channel by a byte at fractional edges. Undo restores the original retained source and position exactly. Original image assets and cutout alpha never change. Rename it “Apply to canvas” rather than suggesting lossless reset.

Preflight the sampling buffers and metadata budget, yield long loops, enforce the existing 600,000-entry RLE limit, and publish only after all checks pass. Density must not be baked a second time. Independent checks must include all 256 bitmap alphas under inversion/density and fractional geometric edge cases.

An optional analytical geometric application can translate points/rectangle coordinates/internal clips without alpha8 conversion. However, adding an integer to arbitrary floating coordinates can change subtraction rounding: do not advertise bit-exact application until half-tie and large/fractional-coordinate tests establish its declared guarantee. Offset sampling itself avoids this issue.

## Behavior of every affected operation

| Operation | Small first delivery | Larger retained-frame extension |
| --- | --- | --- |
| Set/reset mask position | Metadata only; retain all source coverage. | Same. |
| Density, feather, inversion | Edit density on layer; edit feather/inversion on the retained source. Preserve position. | Same; feather units must be revisited if source-to-document scale is added. |
| Layer move/scale/rotate/flip | Keep additional mask stationary. Do not add link semantics yet. | Linked integer translation may update mask position and content in one transaction; other affine transforms require their own contract. |
| Crop document | For positioned masks, retain source/source dimensions and subtract crop origin from the offset. Update validators/resource estimates for intrinsic bitmap dimensions that differ from the new canvas. No new feather edge, clip or source cropping. Existing unpositioned masks retain legacy behavior. | More general mask transforms can build on this retained frame. |
| Resize image | Require explicit Apply first. Preserve current resampling behavior afterward. | Scaling creates fractional offsets and changes feather/source sampling. It needs an explicit source-to-document mapping and resampler policy; integer offsets alone are insufficient. |
| Resize canvas / expand | Add the anchor delta to position, then intersect an optional source-plane domain clip with mapped old/new canvas bounds to retain the existing zero-new-padding rule. This can discard recoverable off-canvas coverage semantically; disclose the loss and retain undo. Source bytes remain stored, but the clip still changes what future moves can reveal. | A separate nondestructive reveal-retained mode would need a different domain policy. Repeated clip intersection is not a lossless source-frame transform. |
| Paint/morph additional mask | Deliberately materialize translated **raw** current-canvas coverage once; apply the requested paint/morph operation; replace with a legacy bitmap and clear position. Preserve separate density. UI/MCP explain that off-canvas coverage is dropped and feather/inversion become pixels. Source-alpha brushes remain separate. | Fully retained source-plane painting/morphology needs mapped brush coordinates, explicit operation bounds and growth rules. It is not implied by this first feature. |
| Replace/remove mask, mask from selection, explicit adjustment-mask replacement | Replace the complete mask and clear position, just as replacement currently resets density. No hidden merge of old offset with a new mask. | Same. |
| Duplicate/reparent/reorder | Deep-copy or retain the positioned descriptor; preserve current structural/protection rules. Masks remain in document coordinates. | Same. |
| Rasterize text/shape/path/gradient | Carry the additional positioned mask and density explicitly, without baking them into rendered content. Current rasterization reconstructs a layer and therefore needs a metadata-copy change. | Same. |
| Proportional placement | Existing placement deliberately incorporates own effective coverage into new source alpha. Permit only with a clear placement notice that this copy contains current visible mask coverage, not retained off-canvas positioning; source document remains editable. Do not attach the old offset to the baked copy. Existing filter/ancestor/clipping restrictions still apply. | Transferring an editable positioned mask would be a separate, more complex placement mode. |
| Additional-mask preview / load selection | Sample translated raw/effective coverage. Selection loading is an intentional canvas-sized alpha8 copy; it leaves the positioned source unchanged. | Estimate coverage memory from retained bitmap dimensions rather than current canvas area. |
| `.prism`, undo/reopen | Retain complete source descriptor and position, no pixel assets added. Validate the compatibility barrier above. | Same, including independent source dimensions. |
| PSD export | The strict writer already uses `layerMaskCoverage` to validate/materialize effective alpha8. Add a report warning that position, editable feather and off-canvas coverage are omitted from this exported copy. Fractional coverage still rejects; do not relax the exact mask gate. Native project stays intact. | Retaining positioned PSD mask rectangles/parameters is a separate export-format extension. |
| PSD import | Leave the current normalized canvas-sized mask and original archive policy unchanged; no implicit positioning feature is inferred from the inert PSD archive. | Broader PSD mask import fidelity is separate work. |

For the first release, resampling guards should test for the retained positioned representation, not merely `x !== 0 || y !== 0`: retained source-frame masks can have zero offset but non-canvas dimensions or an operative wrapper clip. The explicit Apply action avoids a dead-end while keeping irreversible normalization visible and undoable. Full linked transforms should come later.

Concrete canvas-clip regression: on a four-pixel-wide canvas, a selected source pixel at `x=0` shifted by `+4` is off-canvas but retained. Expanding to width eight while intersecting the old-canvas domain excludes that source pixel from the new wrapper clip. Moving back no longer restores it without undoing the bounds edit. The source RLE staying intact does not make that operation coverage-lossless. This is acceptable only as the explicitly documented existing canvas-clip policy, not as an accidental side effect.

## Consumer audit and protection obligations

Create one authoritative raw additional-mask evaluator and have `layerMaskCoverage` apply density to it. Audit both direct raw calls and reconstructed layer records:

- Native `ancestorContext`, `visibleLayerPixels`, group/chain rendering, `applyAdjustment`, `layerDecoration`, `protectedPixels` and `markProtected` must agree on the moved edge.
- `mask-preview.mjs` raw/effective modes and `layer-selection.mjs` raw/effective sources need the same translation. Content transparency/source-alpha inspection must remain unchanged.
- Mask creation/replacement, `modify_layer_mask`, mask painting, morphology, geometry loops and rasterization must explicitly preserve, replace or reject positioning; no unknown-field carry-through is sufficient.
- [PSD exact-mask sampling](../server/psd-native.mjs) should inherit translation from the central evaluator, with the existing precision rejection. PSD preflight adds a specific loss warning.
- Generation snapshot protection, current compositing exclusions, filter restoration and retouch/fill write coverage use native protected footprints. After a mask moves, newly revealed protected source pixels must be protected immediately, while newly hidden pixels cease occupying that visible footprint. A saved generation snapshot still uses its captured constraints; current dynamic exclusion continues to apply at rendering.
- Mask positioning should follow existing mask-refinement protection policy: protected layers may change their own visibility through mask edits without changing source RGB. Do not confuse that permission with permission to repaint those newly visible pixels. Group mask movement must recompute ancestor coverage for every protected descendant.

No new “protected mask pixels” array or duplicate RGB snapshot is needed. Successful metadata publication already invalidates composite preview caches; raw preview reads are fresh. Concurrent API/UI changes must still be rejected by revision, and delayed preview results must not follow a different selected layer.

## Resource and migration cost

Translation and exact crop add constant metadata per positioned mask and a pair of subtractions per coverage sample. They do not require a new canvas buffer, copied RLE, new asset or a growing transform list. Existing bitmap evaluation already allocates one byte per source pixel, plus a four-byte distance plane for feathering; preserve these bounds and underlying source-type detection. Geometric row caches retain their existing limits. Validate wrapper source dimensions independently, and keep its optional clip finite and in source coordinates.

Applying position, painting and morphology need bounded canvas-sized sampling and RLE output. Exact source-frame crop retains the original bitmap size even after a drastic crop: [mask preview's estimate](../server/mask-preview.mjs) currently uses graph area and must change before this feature ships. [Layer selection's bitmap-storage helper](../server/layer-selection.mjs) already uses intrinsic mask dimensions but needs to inspect the wrapper. Keep source axes at 8192, source area at 24 MP, wrapper depth at one, RLE entries at 600,000, document history/metadata at existing limits, and rejected edits atomic. None of these estimates is a total-process RSS guarantee.

Apply/paint/morph preflight must also count the retained source coverage plane and optional feather distance plane **in addition to** current-canvas work buffers. Cropping a 24 MP feathered source to a tiny document does not make source-mask evaluation cheap. Check combined budgets before calling the coverage constructor, not after it has allocated those planes. The existing RLE and 16 MiB history-inclusive metadata checks remain separate constraints.

Legacy documents with no positioned masks must keep the identical coverage evaluator path and serialization. Do not insert zero-offset wrappers everywhere on load. Ordinary masks and active/saved selections keep existing canvas geometry behavior until the user opts into positioning.

## Acceptance fixtures

1. **Legacy identity:** current documents spanning geometry/bitmap masks, density, groups, clipping and generated protection produce exact pre-change RGBA and byte-identical source assets, including reopen and portable transfer.
2. **Retained movement:** translate by each axis beyond the visible canvas and back repeatedly. Raw descriptor/RLE/source hashes remain unchanged; returned coverage equals the original at every pixel. Include hidden and fully masked layers.
3. **Coverage arithmetic:** rectangle/ellipse/polygon with fractional feather and clips; bitmap all 256 alphas; inversion; density 0, 1 and fractional half-ties. Moving does not add feather boundaries or quantize geometry.
4. **Read consistency:** raw/effective mask preview, additional-mask selection and native visible alpha agree under their declared sampling/quantization rules. Content selection and cutout-source inspection ignore the additional mask position.
5. **Compositing/protection:** content, adjustment, isolated/pass-through group masks, clipping base/member, outside styles and a protected cutout below generated content. Verify current footprints after mask movement and exact excluded pixels during subsequent paint/filter/generation installation.
6. **Lifecycle:** duplicate/subtree duplicate, reparent, rasterize and explicit placement retain or bake exactly the documented state; no double application of mask/opacity/density. Replacement clears position.
7. **Geometry, writes and Apply:** exact crop retains source coverage; canvas changes follow the declared source-domain policy; image resize rejects until explicit Apply. Painting/morphology disclose and perform current-canvas replacement with retained density. Undo restores the complete retained source and position. RLE overflow/disk failure/stale revision preserve graph, history and assets.
8. **Compatibility:** malformed/nested wrappers and misplaced offset fields reject; old-reader fixtures reject positioned masks rather than silently ignoring them. `.prism` roundtrip preserves retained state; PSD warns about omitted positioning and independently decoded supported output matches effective visible alpha8.
9. **UI/MCP:** numeric x/y/reset and explicit Apply use the same command/revision semantics; edits form one undo step; a cancelled or stale edit does not publish. No new drag/link UI is required for this first useful milestone.

The implementation choice is therefore between a small retained-position feature with explicit normalization, and a broader source-frame geometry project. The first is useful on its own. Linked content translation should wait until ownership, geometry guards and retained coverage have passed these cross-consumer checks.

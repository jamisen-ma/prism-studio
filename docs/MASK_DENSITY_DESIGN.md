# Additional layer-mask density

Status: implemented and verified. Native owner checks pass 11/11, the independent density audit passes 9/9, and the MCP/schema checks pass. The backend implements layer-owned density, raw-mask editing and geometry, protected rendering, editable-project validation, and exact effective-mask PSD export. Browser controls and transport integration are owned by their respective workstreams.

## Reference and scope

Adobe exposes Density separately from Feather for vector masks; lowering mask density reveals more of what the mask conceals. The archived Photoshop reference also describes density as the opacity of the mask rather than the opacity of the layer. [Adobe vector mask properties](https://helpx.adobe.com/photoshop/using/masking-layers-vector-masks.html), [Adobe Photoshop reference, “Adjust mask opacity,” page 179](https://helpx.adobe.com/pdf/cs6/photoshop_reference.pdf). Sources checked 2026-09-19. These references support the control concept, not a claim of Photoshop-exact feathering or undocumented operation ordering.

The implemented scope is **layer-only density for the existing additional document-space `layer.mask`**, supported on content, group and adjustment nodes. Generic masks, active selections, saved selections, source `alphaAsset`, source filters, generation snapshot masks and style presets do not acquire density.

Existing `maskCoverage(mask)` is shared by all those different operations. Adding density to it globally would accidentally change selection painting, generation hard clipping, saved-selection combination and bitmap geometry baking. It would also be silently lost by current normalization/bitmap constructors unless many unrelated paths were changed. A layer-owned scalar and explicit layer-mask coverage helper keep those meanings distinct.

## Public API and metadata

Extend the existing command rather than adding another:

```js
modify_layer_mask({
  documentId, expectedRevision,
  layerId,
  density, // optional finite 0..1; UI displays 0..100 percent
  feather, // existing optional setting, unchanged
  invert   // existing optional setting, unchanged
})
```

Require an existing additional mask, otherwise `NO_MASK`. Preserve the existing acceptance of an empty `modify_layer_mask` for compatibility; do not add an unrelated minimum-field restriction. Current feather/invert limits and semantics remain unchanged, and the density field itself never creates a mask. Validation and persistence are the usual atomic one-undo edit, with no image asset writes.

Persist optional **`layer.maskDensity`**, not `layer.mask.density`. Omission means 1. Commands may omit the field when reset to 1; imported explicit 1 can remain accepted as equivalent. If present it must be a finite number from 0 through 1 and `layer.mask` must exist. Reject stale density without a mask even if its value is 1. Public clients display `layer.maskDensity ?? 1`; do not materialize defaults on every layer or history graph.

Do not accept `density` or misplaced `maskDensity` inside a mask descriptor. Explicitly reject those misplaced fields in every mask-input and normalization/import validation path rather than silently dropping or preserving an ignored setting. Active/saved selections have no density, and new layer masks copied from them start at density 1.

Capability: `layerMaskProperties: ['feather', 'invert', 'density']`. Existing `modify_layer_mask` capability remains the command gate. No document format version or new asset reference is required; `.prism` preserves the scalar through native graph validation.

## Exact coverage and operation order

Keep the existing base mask implementation unchanged. Let `M(x,y)` be its final coverage: raw geometric/bitmap coverage, existing inward feather, existing inversion, then the internal geometric `clip` restriction. Bitmaps may already contain baked clipping/feather/inversion through previous edits. Let `d = layer.maskDensity ?? 1`.

```text
additionalMaskCoverage(x,y) = 1 - d * (1 - M(x,y))
```

Use exact endpoint branches: no mask or `d === 0` returns 1; `d === 1` returns the existing mask coverage callback unchanged. This retains byte-for-byte legacy behavior at the default density, avoids unnecessary bitmap/feather allocation at density zero, and prevents needless endpoint floating error. Intermediate values are evaluated as floating coverage and rounded only at the established composition/baking stage.

Consequences are intentional:

- Full-white mask coverage remains 1 at every density. Black mask coverage becomes `1-d`, so lowering density reveals previously concealed pixels instead of making already-visible pixels more transparent.
- Feather occurs before inversion and density. Density does not feather the surrounding image or multiply source alpha independently.
- **Density is applied after the mask's internal crop/canvas clip.** Density zero disables the whole additional mask, including that clip, across the current canvas. With `d=0.5`, a location outside the old clip has coverage 0.5. Applying the clip again afterward would break the promised “zero disables this mask” behavior.
- Disabling an additional mask cannot reconstruct source alpha zero, undo an earlier destructive crop, or recover generated pixels removed by installation's hard clip. Source/working geometry and alpha remain earlier constraints.
- Layer opacity is separate and applies once at its existing stage. Group mask density controls the whole group result, including outside styles; it must not be multiplied into child effect caster alpha.
- Generation selection/protection hard exclusions apply **after** this layer coverage or are already in working source alpha. Never soften a protected/generated exclusion with the density formula.

Alternative considered: keep internal canvas clipping as an absolute barrier after density. That would preserve the mask's old support region but make density zero visually different from removing its mask, and introduce different semantics for geometric versus already-baked bitmap clips. The recommended version chooses the consistent full-mask disabling behavior and documents the newly revealed canvas regions explicitly.

## A single explicit layer coverage helper

`server/layer-mask.mjs` exports `layerMaskCoverage(layer)`, `validateLayerMaskDensity(layer)` and `LAYER_MASK_PROPERTIES`. The coverage helper validates/reads density, obtains raw `maskCoverage(layer.mask)`, and applies the formula. `maskCoverage` remains the raw/general-purpose primitive. Native graph validation still validates the complete raw descriptor at density zero; the rendering fast path does not let disabled malformed masks enter a project. Only render and inspection usages representing an additional **layer** mask use the new helper:

| Existing path | Required behavior |
| --- | --- |
| `renderGraph` ordinary content | Use effective own layer coverage for source and outside style casting; generated lower-protection gating remains outside it. |
| Group `renderGraph` / `mixGroup` | Use group effective coverage at the existing group stage, with staged premultiplied rounding unchanged. |
| Clipping base/member assembly and previews | Use effective own base/member masks; keep base alpha/mask/opacity once and independent Dissolve decisions. Upper contributions remain zero at inherited protected pixels. |
| `applyAdjustment` | Use effective adjustment mask with its current opacity and protected-footprint skip. The active selection is not changed. |
| `visibleLayerPixels` / `ancestorContext` | Use effective own and ancestor masks, applying each ancestor at its existing rounded stage. Source-oriented subject selection includes its additional mask/density but still excludes raster filters and clipping. |
| `protectedPixels` / `markProtected` | Cast own styles using effective own mask, then intersect with effective ancestor masks. Preserve the existing nonzero-coverage protection convention, even where tiny final alpha later rounds to zero. |
| `get_layer_preview` | Layer/group/chain contributions show effective density and updated visible bounds; original and source-alpha views remain unchanged. Existing `view:'mask'` is specifically **source cutout alpha**, so do not repurpose it as the new additional-mask view. |
| Strict PSD `exactMask` | Materialize effective layer coverage, not the raw mask. See precision restriction below. |

Do **not** replace `maskCoverage(graph.selection)`, saved-mask combination, raw paint/morphology inputs, canvas-mask transforms or captured generation-mask sampling with this helper. Automated broad replacement would be unsafe.

## Editing, copying and geometry policy

Density stays an editable scalar beside the underlying mask, with these exact rules:

| Operation | Density outcome |
| --- | --- |
| `modify_layer_mask` feather/invert | Preserve density; changing density preserves raw shape/runs/feather/invert/clip exactly. |
| `set_layer_mask` with a new mask, `mask_from_selection`, `update_adjustment` with an explicit new mask | Replace the descriptor and reset density to default 1. These are full replacement operations, matching replacement of feather/invert settings. |
| Remove mask through `set_layer_mask` or `update_adjustment` | Clear both mask and density. Later masks cannot inherit an orphaned setting. |
| `paint_mask` on an existing mask, including brush mode `replace` | Paint its raw-mask effective coverage (existing feather/inversion/clipping may bake), then retain density. Do not bake density into the replacement bitmap and then apply it again. At density zero the brush can edit the stored mask without changing the displayed image until density is raised. Brush replacement is distinct from replacing the complete descriptor with `set_layer_mask`. |
| `morph_layer_mask` | Morph raw-mask effective coverage at full mask strength, preserving density separately. Update the operation description so “effective current alpha” explicitly means before density. Selection morphology remains unchanged. |
| Crop/image resize/canvas resize | Transform the raw descriptor exactly once through existing mask helpers and preserve the scalar. Bitmap transforms may bake raw feather/invert as they already do, never density. Outside old clip/baked zero areas follows the coverage formula. |
| Duplicate layer or whole subtree | Clone density with the mask; changes to either copy remain independent. |
| Rasterize content | Explicitly copy density alongside `mask`, parent, clipping link and styles. Existing rasterization deliberately leaves the additional mask editable. |
| `extract_subject` | Existing clone semantics retain mask/density; source alpha extraction remains independent. Subject cutout refinement changes `alphaAsset` only and never density. |
| `place_layer` | Existing visible-source sampling bakes own effective mask coverage into placed working/source alpha. The new placed layer has no additional mask or density. Existing restrictions on nonneutral ancestor masks remain. |
| Source paint/fill | Keep the additional mask/density separate, as source writes currently retain the layer's mask. Source alpha baking must not also bake the additional mask. |
| Active/saved selections | No density field. Copying a selection onto a layer resets density to 1; saving or combining selections cannot capture it accidentally. A future “selection from layer mask” would need an explicit raw/effective choice and is out of scope. |
| Outside style library | Save/apply still touches only outline/effects; density must neither be captured nor cleared. |

Existing arrangement, group ungrouping, placement, scratch and snapping eligibility checks may remain conservative when a mask object exists, even at density zero. Do not silently reinterpret a stored mask as absent to bypass restrictions. In particular, keep `groupNeedsSurface` based on the presence of a mask, so raising density later cannot activate a graph that was accepted only because its budget omitted the group surface. Density itself adds no full-frame scratch allocation.

## Protection and generation boundaries

Changing additional-mask density is mask refinement, already allowed for protected content; it does not permit direct RGB edits, stretched transforms, changed protected opacity or clipped protected participants. It can reveal more of a protected layer's existing source pixels and therefore enlarge the protected footprint. Every later adjustment, filter, generated overlay, outline/shadow exclusion and generation snapshot must use that new footprint.

For selected AI edits, `snapshotForGeneration` still reads the unchanged active selection and constructs its hard provider/local mask using captured protected coverage. Applying a retained result still checks current protected coverage. Lowering a protected mask's density while a job waits changes the revision; automatic application becomes stale, and explicit retained application clips against the enlarged current footprint. Raising density later does not recover generated pixels already removed from a working asset.

Generated content itself can have an additional mask with density. Its dynamic lower-protection exclusion must remain multiplicative **after** density; formula-wrapping the combined mask/protection coverage would reveal forbidden pixels when density decreases. Protected group masks likewise use final group coverage without altering the local child effect caster; this preserves the audited ancestor-shadow behavior.

Isolated generated-layer previews also derive lower protected coverage from the original document, including when the generated layer has no filter stack. Both its source and outside styles honor that coverage. Ordinary styled-layer previews use the same original-context destination exclusion for decoration, while ordinary source RGB remains independently inspectable rather than being clipped by unrelated lower content. Original/source-alpha preview modes are unchanged.

## PSD and editable project handling

Density adds no new `.prism` asset. Validate paired mask/scalar and finite bounds before import image processing or publication; retain current layer IDs, masks, source bytes and current-state-only history policy.

The strict PSD writer currently stores one alpha8 mask channel and does not serialize a distinct editable density property. Use effective density coverage in `server/psd-native.mjs:exactMask`, accepting only coverage whose `coverage * 255` is within the existing `1e-9` byte tolerance. Emit an explicit warning that density/feather/invert are represented by exported mask pixels; native metadata remains unchanged. Do not silently round unsupported coverage.

Examples: density 0 gives full coverage and can be represented; density 0.5 over a black mask gives 127.5 and must reject with `MASK_NOT_REPRESENTABLE`. Some fractions such as 128/255 can be exact for binary masks, but arbitrary partially gray masks may still fail. The test must inspect every effective pixel, not approve solely from the scalar. Existing unsupported layer/group/filter/clipping/transparent-composite checks remain in force. No PSD density-record writer or untrusted PSD parser is added.

## Ownership and acceptance

The backend owner changed the layer coverage helper, native read/render/protection/geometry/copy paths, morphology wrapper policy, PSD effective-mask materialization, and graph validation/tests together. Root owns shared command schema/MCP/capability forwarding; the UI owner adds a density percent slider beside feather/invert with an explanation that source cutout alpha is separate. The independent protection/geometry audit covers these paths separately.

Acceptance must include:

1. Density 1 is byte-exact legacy behavior; density 0 equals removing only the additional mask. Test raw coverages 0/1/128/255, geometric fractional feathers, inversion and maskless errors.
2. All nine canvas anchors, crop/resize and expansion for geometric and bitmap masks: preserve scalar once, retain raw transformations, and explicitly test density zero/half outside old support and clips.
3. Content, adjustment, nested pass-through/isolated groups, own effects and clipping base/member previews agree with independently calculated staged coverage. No double attenuation or caster/ancestor mask reorder.
4. Painting/morphology at nondefault density edits raw coverage without baking density. Mask replacement/removal resets the scalar; duplicate/rasterize/extract/source edits preserve it where specified. Saved selections and source alpha remain byte-identical.
5. Protected alpha-one/soft edges and outside styles expand their footprint correctly; generated backgrounds below remain visible; higher generated overlays and retained jobs cannot cross current protected coverage after density changes.
6. Density metadata, stale revisions, no-mask requests, invalid bundles, transactions and real persistence failures leave graph/history/cache/files unchanged on rejection. Pure density changes must never call source asset writers.
7. PSD effective-mask byte exactness is independently decoded, with half-density fractional rejection and clear property-baking warning. `.prism`, undo/reopen and original source/mask previews preserve authored metadata/assets.
8. Native capabilities and MCP advertise only the layer-owned control; frontend percent conversion is finite and bounded, old backends remain unchanged, and resetting/reopening does not create a density property on an unmasked layer.

Generic selection density, source-alpha density, mask disable flags and a new additional-mask preview view remain out of scope; each needs its own explicit read/edit contract.

## Alpha8 numerical correction during mask-preview verification

The shared helper now evaluates interior density in byte units, `(255-d*(255-byteCoverage))/255`, to avoid floating cancellation moving exact half-byte values below the half-up rounding boundary. Here `byteCoverage=255*M`; for bitmap masks only, recover the exact inherent alpha8 byte with `round(255*M)` after stored feather/inversion/canvas clipping. Geometric coverage is not quantized early. Density0 and density1 fast paths are unchanged. This fixes both forward and inverted bitmap ramps across rendering, loading selections and mask inspection; it is not a new density policy or persisted metadata migration. Quarter/half/three-quarter ramps and independent source-alpha composition are pinned in `tests/mask-preview.test.mjs`.

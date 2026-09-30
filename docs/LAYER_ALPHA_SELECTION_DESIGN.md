# Load a selection from layer transparency or an additional mask

Status: native backend implemented and owner/MCP checks passing, 2026-09-19. Independent audit and browser verification run separately. This document specifies the native behavior; it does not claim Photoshop-exact parity.

## Useful first scope

Add a deterministic operation to turn a layer's transformed pixel transparency, or its separate additional mask, into an editable selection. This supports selecting text/shape silhouettes, reusing a cutout edge, masking another layer from existing transparency, or loading a stored mask without running subject segmentation or image generation.

Adobe documents separate layer-thumbnail and mask-thumbnail selection workflows with replace/add/subtract/intersect modifiers. Its UXP `Selection.load` describes pixel transparency when the source is a layer. Those references motivate the control, but do not establish our density, group, style or clipping arithmetic. The contract below is explicitly native. [Adobe layer and mask selection boundaries](https://helpx.adobe.com/photoshop/using/load-selections-layer-mask-boundaries.html), [Adobe UXP Selection.load](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/selection#load).

Recommend **source-oriented content alpha**, not a selectable claim about the displayed composite contribution. Do not add a visible-contribution mode until group blending, occlusion, clipping assembly and decoration semantics have a separate precise contract.

## Command

```js
load_layer_selection({
  documentId,
  expectedRevision?,
  layerId,
  source: 'content' | 'layer-mask',       // default 'content'
  maskMode?: 'raw' | 'effective',         // default 'effective', mask source only
  mode: 'replace' | 'add' | 'subtract' | 'intersect', // default 'replace'
  invert?: boolean                      // default false
})
```

`maskMode` supplied with `source:'content'` rejects rather than being silently ignored. Resolve the source and validate enums/booleans before rendering or touching the active selection. A missing layer gives `NOT_FOUND`; inappropriate content targets give `INVALID_TARGET`; missing own additional mask gives `NO_MASK`. Subtract/intersect without an active selection gives the existing `NO_SELECTION` before any source decode.

The command returns the standard `{document}` mutation result and participates in `apply_transaction`. One successful call is one undo step; a whole instruction using a transaction remains one step. Expected revisions, persistence and rollback follow existing native mutation rules. Capabilities must advertise it without requiring `segmentSubject` or an AI configuration.

Capabilities:

```js
layerSelectionSources: ['content', 'layer-mask']
layerSelectionMaskModes: ['raw', 'effective']
layerSelectionContentTypes: ['raster', 'solid', 'text', 'shape', 'path', 'gradient']
limits.maxLayerSelectionWorkingBytes: 268435456
```

The existing `commands` array remains the dispatch gate. Reuse the existing canvas, bitmap-run and project-metadata limits rather than inventing a new file format or asset role.

## Content alpha precisely

Supported source types are raster, solid, text, shape, path and gradient. Groups and adjustment nodes have no individual content source and reject. A group can still supply its own additional mask through the separate mask source.

For a content source, sample the alpha byte from `await renderLayer(layer,{filters:false})` at current document dimensions. This includes:

- The **working raster asset**, including edits already committed to it. Do not use `sourceAsset`, the original-file preview, or a provider's uninstalled output.
- Any separate source cutout `alphaAsset`, combined once with the working asset's alpha by the existing renderer.
- Existing layer geometry in its established order: crop, image resize, canvas placement, affine sampling and clipping.
- The alpha produced by editable text/vector/gradient rendering, including antialiased edges and any authored gradient-stop opacity.

It deliberately excludes own additional mask/density, layer opacity, blend mode/Dissolve, visibility, outside outline/shadow/glow, parent opacity/masks/visibility/group compositing, clipping-chain base coverage and upper-member assembly, sibling occlusion, and dynamic lower-protected-footprint exclusions. It also bypasses the RGB-only editable filter stack; those filters cannot change alpha, and evaluating them adds needless work.

Hidden layers and layers inside hidden/faded/masked/isolated groups remain valid content sources. Layer opacity zero does not make the loaded content selection empty. A masked-out solid can yield the full transformed solid area. A clipping member yields its own transformed source alpha, not the base-clipped contribution. A clipping base yields its own source alpha, not the assembled chain's colors/styles. Those are source-selection semantics, not an inaccurate composite preview.

Protected and generated layers remain eligible for this read of source alpha. A generated layer can select stored pixels currently hidden by dynamic protection, but this cannot bypass the hard protections applied by subsequent edits/generation. Pixels already removed from generated working alpha at installation remain absent. Original subjects retain their RGB/source/alpha assets unchanged. Loading a selection alone does not alter any layer's protection, mask, geometry or provenance.

The operation inherits existing geometry limits: pixels clipped at an earlier canvas stage cannot reappear through a later layer move, even if an immutable source PNG still contains them. It does not rescale a source preview thumbnail or use its downsampled visible bounds.

## Additional-mask source precisely

Any node type with an existing own `layer.mask` is eligible, including groups and adjustments. The additional mask lives in document coordinates and is independent of source content dimensions or affine transforms. A missing mask rejects; it must not be mistaken for a full-white mask.

Let `M(x,y) = maskCoverage(layer.mask)(x,y)`. Here **raw** means the current mask's shape or bitmap after its stored feather, inversion and internal clip have been evaluated once, but **before** the separate layer density. It does not mean unprocessed RLE bytes. Let `d=layer.maskDensity??1`.

| Mask mode | Loaded coverage before byte conversion |
| --- | --- |
| `raw` | `M(x,y)` |
| `effective` (default) | `layerMaskCoverage(layer)(x,y) = 1-d*(1-M(x,y))` |

Neither mode multiplies own opacity, source/cutout alpha, ancestor masks/opacity, layer visibility, clipping-chain membership, styles or protected-footprint exclusion. Density zero makes an effective mask selection full-canvas, including outside an earlier internal mask clip; raw mode still samples the stored concealed region. Density one makes both modes identical.

Do not overload existing `get_layer_preview({view:'mask'})`, which inspects source cutout alpha. Loading an additional mask is a separate explicit source choice. Active/saved selections acquire only the materialized byte coverage, with no `density` or `maskDensity` field and no alias to the layer's descriptor.

## Quantization, inversion and combination

Materialize the source into document-size alpha8 before optional inversion. For content, use the renderer's alpha byte directly. For mask coverage `c`, use `Q(c)=clamp(round(255*c),0,255)`. Then, if the command requests inversion, replace the materialized byte `q` with **`255-q`**. This complements the whole current canvas, including outside an old internal clip; do not implement it by toggling the original descriptor's `invert` flag.

This rounding order is intentional: at coverage 0.5, normal mask materialization is 128 and command inversion is 127. It is not `round(255*(1-0.5))`, which would produce 128 again. Stored mask inversion still executes as part of `M` before density and quantization; the command's independent invert occurs afterward.

Create a canonical bitmap mask with `feather:0`, `invert:false`, no clip and no density, then apply the existing saved-selection combination policy. If `a` is existing active-selection effective coverage and `b` is the loaded alpha8 divided by 255:

```text
replace: loaded bitmap copy
add:     Q(max(a,b))
subtract:Q(a*(1-b))
intersect:Q(a*b)
```

Add without an active selection behaves like replace. Subtract/intersect without an active selection reject. An existing empty bitmap is still a real active selection and can participate; an all-zero result remains `{shape:'bitmap',runs:[],...}`, not `null`. An empty result therefore restricts later selected edits to nothing instead of accidentally clearing the selection and editing the whole canvas.

Do not multiply two alpha bytes and round midway, threshold soft edges to opaque, apply density twice, or take `get_preview` pixels as selection alpha. Active feather/inversion/clipping is baked once by combination just as existing named-selection loading does. The source layer and saved-selection library remain unchanged.

## Implementation seam and resource checks

`server/layer-selection.mjs` implements source lookup/validation, sampling, quantization, inversion and bounded RLE staging. Native dispatch validates the graph, supplies `renderLayer` and encoded-asset size checks, and publishes the returned selection only after the helper completes. `combineSelectionAlpha` is an asynchronous equivalent of the named-selection arithmetic. Thirty seeded soft-mask fixtures across all four modes compare it byte-for-byte with `combineSelections`, including feathering, inversion and internal clipping. `encodeSelectionAlpha` is the reusable bounded async bitmap builder.

Do not use `visibleLayerPixels`, `layerPreview` or `renderGraph`: they include unwanted own/ancestor opacity, style, clipping and/or protection context. Do not render an entire group only to recover one leaf's source alpha. Validate the graph and source eligibility before reading assets; catch source decode/read failures and return a bounded `INVALID_IMAGE` error rather than leaking asset paths or decoder stacks.

Stage the complete candidate and combined bitmap before assigning `graph.selection`. Construct each mask-coverage callback once. Sample pixels and encode runs with bounded row yields (for example every 32 rows), honoring the existing 600,000 scalar run cap while constructing output, not after building an arbitrarily large JS array. Existing bitmapMask currently has a synchronous scan; either add a reusable bounded async builder or explicitly limit/yield this operation's scan.

Memory needs an operation preflight, not reliance on the document's group/filter scratch check. Those persistent graph checks do not include newly materialized selection alpha. The implementation separates source materialization and combination into function phases, returns only source alpha, and accounts the maximum live phase. The RGBA source and source-mask callback have no references in the combination phase; no assumption of immediate garbage collection is made:

- Content phase: source/geometry RGBA frames at their actual largest dimensions, separate source-alpha decode/combination if present, and one canvas alpha result. Geometry can retain the original source, current transformed frame and next output; count them conservatively. Do not assume four bytes per final canvas pixel is the entire render cost.
- Mask-source phase: one canvas alpha result plus the mask callback's storage. Bitmap masks need an alpha buffer; feathered bitmaps also allocate a four-byte-per-pixel distance field. Geometric masks use no full-frame callback storage.
- Combination phase: loaded bitmap coverage, active-selection coverage, and result alpha. A feathered active bitmap can add its own five bytes per pixel. If the implementation retains the materialization buffer during combination, count it as an additional live buffer rather than assuming it disappeared.
- Metadata: canonical runs still obey their per-mask cap and the complete project/history 16 MiB limit. Rejected complexity or persistence leaves the previous selection/history/cache untouched.

`estimateLayerSelectionBytes` reports `{sourceBytes,maskBytes,combinationBytes,estimatedWorkingBytes,maxWorkingBytes}`. Let `S` be source pixels and `N` be current canvas pixels. Source frame storage starts at `4S`, or `9S` when combining a separate alpha asset; every geometry transition additionally considers `4S + 4P + 4Q` for retained original, previous and next frames. The source phase adds `N` for extracted alpha and actual encoded working/alpha file lengths. Gradient input adds another `4S`; generated text/vector SVG inputs reserve 1 MiB under their existing metadata bounds. The mask phase is `N` plus bitmap callback storage (`N`, or `5N` with feather); effective density zero bypasses that callback. A combination retains loaded alpha `N`, active callback storage and result `N`, using loaded bytes directly instead of allocating another bitmap callback. Replace/add-without-active has no active callback. The maximum of those phases must fit 256 MiB before rendering/sampling; otherwise `LIMIT_EXCEEDED` rejects before mutation.

This is an explicit binary-buffer ledger, not total RSS or a limit on codec caches, JS objects and polygon row caches. Metadata remains bounded independently by mask run limits and the project cap. Encoded source sizes are statted before the existing renderer reopens them; this relies on the engine's immutable internal assets and is not a descriptor-bound defense against another process growing those files concurrently. No global renderer/file-I/O refactor is included.

Source sampling, combination and run encoding yield every 32 rows. Existing `maskCoverage` bitmap-feather initialization still performs synchronous full-frame passes, and existing affine geometry still performs synchronous pixel loops within the engine's existing transform bounds. This feature does not claim fully asynchronous source rendering or a whole-process memory guarantee.

No source asset write, segmentation callback, generation job, credential lookup or provider call is needed. The native queue already serializes the selection edit with image edits and revision checks. A transaction can load alpha, save it under a name, invert/reshape it and create an adjustment using one undo step; no separate selection archive type is added.

## UI and MCP boundary

Expose “Load transparency selection” for content layers and “Load layer mask selection” for any additional mask. Label the mask density choice “Include density” versus “Raw mask coverage”; a brief explanation should distinguish raw feather/inversion evaluation from source cutout alpha. Offer existing replace/add/subtract/intersect choices and optional invert without forcing a model to run.

Command/Ctrl-click gestures may map to these commands when thumbnails exist, but can follow the explicit actions. Do not intercept layer-row selection or Move gestures ambiguously to imitate a shortcut. Disabled controls should explain group/adjustment content rejection and missing additional masks. Allow content actions despite hidden layers, filters, protected status and isolated ancestors, because this operation has no composite-appearance mutation.

MCP descriptions must say that content is transformed working alpha before additional masks/opacity/styles/ancestor/clipping context, and that mask mode controls density only. Avoid calling it “visible pixels” or subject selection. SDK calls can combine the operation in transactions and inspect/save the resulting active selection with existing APIs.

## Verification

1. Patterned RGBA with alpha 0/1/128/255, a separate soft alphaAsset, working edits and integer/affine/crop/canvas geometry: selection equals the actual transformed source alpha byte for byte; original RGB/assets remain exact.
2. All six content types, including antialiased text/paths and gradient opacity. Content from hidden, opacity-zero, masked/styled/filtered/protected nodes inside nonneutral groups remains source-oriented. Group/adjustment content rejects before decoding.
3. Clipping base/member and generated-over-protected fixtures distinguish source alpha from displayed contribution; actual subsequent edits still respect protection and hard-installed alpha. No model callback is invoked.
4. Raw/effective additional masks on content/groups/adjustments, geometric feather/inversion/internal clip, bitmap masks, density 0/0.5/1 and outside old support. At 0.5 explicitly assert normal128 → command-inverted127 and full-canvas complement outside clip.
5. All four combination modes against an independent byte/coverage oracle, including active feathered/inverted selection, no selection, empty active/result bitmaps and add-as-replace. Saved selections remain unchanged and copied results have no density or aliases.
6. Missing source/mask, corrupt assets, stale revisions, invalid options, complexity/working-memory limits, transactions and disk failures leave graph/revision/history/cache/source files unchanged. Mask-only loading must read no raster asset.
7. Undo/reopen/current-state `.prism` preserve the resulting bitmap; later mask/source edits do not mutate that saved result. Source selection itself writes no image asset and does not alter a retained PSD archive or import receipt.
8. Real SDK and browser actions validate every pixel, not just marching-ant bounds, and demonstrate that an empty selection blocks selected editing rather than enabling a full-canvas edit. Existing saved-selection, density, cutout, protection and clipping tests remain green.

Owner checks: `node --test tests/layer-selection.test.mjs` passes 10 tests covering the contracts above; the official SDK workflow in `tests/layer-selection-mcp.test.mjs` passes. Independent audit and browser coverage are maintained by their respective owners. Visible-contribution selection, group raster alpha, PSD channel import and new mask preview modes remain separate scopes.

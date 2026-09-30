# Filter effect masks

Native, MCP and browser checks verify this feature, including exact pixel mixing, source protection, Bake and portable projects. See [verification status](IMPLEMENTATION_STATUS.md).

A **Filter effect mask** controls where the complete filter stack changes colors. Black keeps the working colors from before the stack, white reveals its finished result, and gray mixes the two. The layer remains visible and retains its transparency. The ordinary layer mask separately controls which parts of the layer are visible.

Create an effect mask in **Layers → Layer filters** after adding at least one filter. Choose **Reveal all**, **Hide all effects**, **Current selection**, or a rectangle/ellipse in source coordinates. Creation is explicit; adding a filter does not automatically capture a selection. Every later filter appended to the same stack also uses this one mask.

## Editing coverage

**Use effect mask** temporarily enables or disables the saved mask. Turning it off shows the complete filter result while retaining coverage and settings. **Density** weakens the mask's attenuation: 100% uses its full coverage, while 0% shows the complete filter result. Density is not filter strength. Use the individual filter's opacity to fade that filter instead.

**Feather** softens coverage inward over 0–100 source pixels. **Invert coverage** swaps the retained inside/outside coverage. Apply settings explicitly; replacement choices and numeric drafts do not modify the document while typing. Replacing coverage resets Use effect mask on and Density to 100%; selection capture also stores its current soft coverage once and resets Feather/Invert to their defaults.

**Inspect effect coverage** shows saved raw or effective coverage in the retained source frame. Raw includes feather and inversion; effective additionally includes Density and Use effect mask. Disabled or zero-density effective coverage is white, while raw remains inspectable. The preview contains no image colors, source alpha, later layer mask, layer opacity or geometry.

## Source coordinates and selections

Filters and their effect mask run before the layer's geometry. Source dimensions can therefore differ from the current canvas. Existing effect masks follow subsequent layer transforms and image resampling as part of the filtered source RGB. They do not stay anchored to a fixed rectangle on the canvas.

**Current selection** captures a snapshot only when every retained geometry operation is an exact integer crop, canvas translation or unscaled/unrotated integer translation. It refuses resize/resample, flips, rotation and fractional transforms instead of approximating an inverse. Direct source shapes remain available, or create the mask before applying those transforms.

Capture retains only source pixels that survived every intermediate clip. Cropping away the outer columns and later padding the canvas does not recover them. Selection coverage outside the surviving source contributes nothing. Capture ignores image transparency, layer visibility, opacity, layer/group masks and clipping relationships; it records the selection's coverage alone. An explicitly empty selection creates a black effect mask. A missing selection is an error.

Users can draw or paint a selection with existing tools, then capture it. Direct effect-mask painting, effect-mask morphology and loading an effect mask as a selection are outside this first implementation.

## Filters, Bake and recipes

The mask blends the completed stack with its original input once. It does not restrict individual filter entries or remove neighbors from a blur. Filter order, per-entry blending and opacity still run on the full source before this final mix. Every alpha byte and RGB at zero effective source alpha remain exact.

Adding, changing, reordering or deleting entries preserves the one mask while entries remain. Deleting the final entry or **Clear filters** removes it. **Remove effect mask** removes only the mask and reveals every unchanged filter. **Bake filters** stores the current masked treatment in working RGB and clears both filters and effect mask, retaining the archived original, source/cutout alpha, additional layer masks and geometry. These actions undo.

Black, disabled, zero-density and visually unchanged masks do not relax protection or source-edit rules. Protected targets reject mask edits. Nonempty stacks still require explicit Bake/Clear before eligible source painting or alpha repair. Active Bake retains the earlier-protected-content restriction.

Current recipes do not store source-mask coverage. Capturing Filters from a masked stack refuses explicitly, including disabled or white masks. Uncheck Filters to intentionally capture other eligible settings. Applying an existing filter-only recipe to a supported masked target appends its filters under that target's retained mask; validation and application preserve the scope.

Native portable projects retain the editable mask. Older readers reject the new persisted stack representation. The current strict PSD export subset still requires filters to be baked or cleared; it does not convert an effect mask into a transparency mask.

## MCP

Require native `layerFilterMaskPolicy:'source-stack-alpha8-v1'`, `layerFilterMaskCoordinates:'source'`, the applicable command and its advertised source/shape/property. Selection capture additionally requires `layerFilterMaskCaptureGeometry:'integer-copy-v1'`. Each mutation requires a positive captured revision, including the outer revision when used in a transaction.

```js
prism_set_layer_filter_mask({
  backend: 'native', documentId, expectedRevision, layerId,
  source: 'selection'
})

prism_modify_layer_filter_mask({
  backend: 'native', documentId, expectedRevision, layerId,
  enabled: true, density: 0.75, feather: 8
})

prism_get_mask_preview({
  backend: 'native', documentId, expectedRevision, layerId,
  source: 'filter-mask', maskMode: 'effective', maxEdge: 700
})
```

Set accepts `source:'selection'|'all'|'none'|'mask'`. Only `mask` takes a strict descriptor: an explicit rectangle/ellipse with integer source bounds, or a source-sized bitmap with sorted nonoverlapping `[start,length,alphaByte,...]` runs. Alpha is 1–255; omitted regions are zero. Bitmap x/y may only be zero, and dimensions must match the working source. Public descriptors exclude polygons, positioned wrappers, clipping metadata, density and nested masks.

Modify preserves omitted fields and exact stored Density. Clear uses `prism_clear_layer_filter_mask`. Public documents expose the ordinary `filters` array and separate read-only `filterMask` metadata. Persisted graphs use a strict versioned wrapper; never reconstruct a project bundle from the public projection.

## Precision and processing limits

Raw source coverage is rounded once to an alpha8 byte. Density uses the existing native bitmap byte expression, `round(255-density*(255-rawByte))`, with explicit endpoint behavior. Stored density is not rounded to percent increments. This is a defined floating stage: raw black at density 0.1 becomes 230, at 0.5 becomes 128, and at 0.5000000000000001 becomes 127. It does not claim exact-real density or continuous geometric layer-mask equivalence.

The final original/filtered RGB interpolation uses exact integer half-up arithmetic with that effective byte. The grayscale inspector displays these same raw/effective weights. No extra alpha multiplication or generated pixels enter this operation.

An enabled positive-density mask over active filters adds eight weighted visits per source pixel to the shared 384-million filter-work budget, including hidden layers and white/black masks. Disabled masks, density zero and entirely inactive stacks skip mask evaluation while retaining metadata validation. Spatial caches and mask preparation occupy separate phases; feathered bitmap preparation and an optional 256-byte density table are included in the renderer and Bake limits. Additional full-source admission can reject large masked sources even when their unmasked stack fits.

Selection capture separately accounts source traversal, sampled area, polygon edges/row setup and bitmap feather preparation under a 384-million-work ceiling and 256 MiB named-buffer bound. RLE is limited to 200,000 runs and the existing project/history metadata ceiling. Newly introduced bitmap preparation and capture loops yield in bounded batches. Refusals retain saved state and do not reduce feather, change geometry or replace coverage automatically.

The [native design](FILTER_MASK_DESIGN.md) contains exact phase formulas and measured scope. See also the [independent review](FILTER_MASK_REVIEW.md), [UI acceptance plan](FILTER_MASK_UI_DESIGN.md) and [Adobe workflow research](FILTER_MASK_RESEARCH.md).

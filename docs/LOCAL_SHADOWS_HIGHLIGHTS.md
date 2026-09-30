# Local Shadows / Highlights

Verified through native, independent, schema and official MCP checks, 79 focused/adjacent browser workflows and a production build. The latest full regression passes 933 tests, including the [legacy scalar rendering correction](SCALAR_TONE_RENDERING_REVIEW.md) found during acceptance. See [implementation status](IMPLEMENTATION_STATUS.md).

**Local Shadows / Highlights** adjusts colors according to nearby brightness. Add it in **Layers → Layer filters** on an unprotected raster layer. It is a separate source filter; the existing Shadows and Highlights adjustment controls retain their previous pointwise behavior.

## Controls

| Setting | Meaning | Range / default |
| --- | --- | --- |
| Shadows Amount | Lift intermediate channel values where the local neighborhood is dark. | 0–100%; default 25% |
| Highlights Amount | Lower intermediate channel values where the local neighborhood is bright. | 0–100%; default 0% |
| Shadows Tonal width | Broaden the dark-tone support toward brighter neighborhoods. | 1–100%; default 50% |
| Highlights Tonal width | Broaden the bright-tone support toward darker neighborhoods. | 1–100%; default 50% |
| Sigma | Size of the Gaussian brightness neighborhood in source pixels. | 0–50; default 3 |

Amounts and widths accept exact 0.01% increments. Sigma retains any finite value in its range, including very small positive values. Zero sigma uses each pixel's own encoded-RGB tone; it can still change colors. Changing an Amount to zero retains that side's Tonal width for later use.

Changes stay in the local draft until Apply. Reset restores the five defaults without changing filter opacity or blending. These defaults produce a visible shadow lift. Set both Amounts to zero for an unchanged candidate; with Normal blending this leaves colors unchanged. Other blend modes can still change the result, even with an identity candidate.

Amount controls the tonal curve before rounding. Filter opacity fades the finished candidate, and the filter's blend mode acts before that opacity. These controls are not interchangeable.

## What the neighborhood means

The filter computes a brightness byte from encoded sRGB, then an alpha-weighted Gaussian local mean. Its tone map has 256 levels. A gray pixel in a dark surround can receive a different correction from the same gray in a bright surround. A dark pixel surrounded by enough light can receive no shadow lift. Sigma controls that neighborhood; it does not isolate a subject or follow an edge.

Black and white channel endpoints remain unchanged by the candidate. It cannot recover clipped highlights, fully black channels or absent detail. The nonlinear RGB treatment can alter hue and saturation, and large or strong corrections can produce halos. This is Prism's defined native algorithm, not a claim of Adobe pixel equivalence or linear-light color processing.

Every source alpha byte and RGB beneath zero effective source alpha remain intact. Transparent neighbors do not inject hidden colors into the mean. The full source participates before geometry, including source pixels outside a visible crop. Sizes therefore scale with the layer. A [filter effect mask](FILTER_EFFECT_MASKS.md) mixes the completed stack afterward; it does not cut the input neighborhood down to its white region. The additional layer mask separately controls visibility.

## Editing and reuse

Parameters, order, enabled state, blending and opacity remain editable through Undo, duplication, saved recipes and portable projects. Existing target protection, lower protected-content restoration and generated-layer exclusions remain authoritative. A zero-Amount or disabled stack still needs explicit Bake/Clear before eligible source painting, alpha repair or extraction.

[Bake filters](FILTER_BAKING.md) includes the current local treatment and effect-mask scope, then removes the stack and effect mask. It retains the archived original, source/cutout alpha, later layer masks and geometry. For admitted graphs, the current appearance remains exact. Active baking above earlier protected content still refuses.

Recipes save complete effective settings from the persisted entry. Applying a supported recipe appends under a target's retained effect mask. Capturing Filters from a masked stack still refuses rather than losing that coverage. Older readers reject the unknown filter kind; use a compatible native project reader or an explicit supported export.

## MCP

Require the advertised source kind, `layerFilterCoordinates:'source'`, and independent `layerFilterLocalTonePolicy:'alpha-weighted-local-tone-v1'`.

```js
prism_add_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId,
  kind: 'shadows_highlights', value: 0,
  parameters: {
    shadows: 25, highlights: 15,
    shadowWidth: 50, highlightWidth: 50, sigma: 3
  }
})
```

Use the returned filter ID with `prism_update_layer_filter`. Partial parameters preserve omitted effective settings, including explicit zero amounts and exact sigma. The scalar value must remain zero. This kind is not accepted by global adjustment commands or adjustment recipe slots. Blend and whole-stack mask support require their separate policies.

## Processing limits and precision

Under the shared 384-million weighted source-pixel work budget, a computing entry costs 16 visits per pixel at sigma zero, or `2*(2*ceil(3*sigma)+1)+20` at positive sigma. Both Amounts zero costs one; disabled or zero-opacity entries cost zero. Each active nonnormal blend adds 40, and an evaluated whole-stack mask adds its separate cost.

An otherwise unfiltered Normal entry at default sigma 3 admits at most 6,620,689 source pixels before other memory/context limits. Sigma 50 admits at most 617,363. Computing sigma zero can fit the existing 24 MP ceiling when the rest of the graph and operation fit. The editor refuses excess work or memory without silently lowering sigma or changing the source dimensions.

The implementation uses a bounded two-channel row cache, one prepared source row and a 2 KiB response table. Sequential filter caches share their maximum; mask preparation and Bake encoding occupy separate phases. Table setup is bounded to 512 entries and yields every 64. These are named-buffer and workload bounds, not total process-memory or latency guarantees.

Integer input tone, exact alpha-weighted Gaussian sums, exact table setup and one rational half-up RGB rounding define the three stages. Existing per-entry blending/opacity and final stack masking follow them. See [numeric and resource design](LOCAL_SHADOWS_HIGHLIGHTS_DESIGN.md), [independent review](LOCAL_SHADOWS_HIGHLIGHTS_REVIEW.md) and [UI contract](LOCAL_SHADOWS_HIGHLIGHTS_UI_DESIGN.md).

# Color Balance and Black & White

These editable controls work on native 8-bit sRGB images through adjustment layers, raster filters and reusable recipes. Original image files and source alpha stay unchanged. The controls follow familiar photographic workflows; their documented pixel math is Prism's own, not a claim to reproduce Photoshop's color engine.

## Color Balance

Choose **Shadows**, **Midtones** or **Highlights**, then adjust Cyan–Red, Magenta–Green and Yellow–Blue. Positive values add red, green or blue; negative values shift toward the opposing color. Every control accepts −100 to 100 in 0.01 increments. Switching tonal ranges retains the other rows. Reset changes the draft until you apply it.

**Preserve luminosity** starts on. It preserves the input pixel's encoded-sRGB brightness before byte rounding, reducing color intensity when necessary to stay inside the available RGB range. Black and white remain unchanged in this mode. This is encoded-sRGB luma, not perceptual or linear-light luminance. Turning it off permits brightness changes and channel clipping.

The native algorithm blends the three rows with triangular weights derived from the original pixel's Rec.709 encoded luma. It evaluates the complete shift before rounding. With preservation enabled, it fits the desired chroma around the original luma using a common scale factor. Exact integer arithmetic and a bounded rational fallback resolve half-byte rounding consistently. The [design](TONAL_COLOR_DESIGN.md) records the formulas and [independent review](TONAL_COLOR_REVIEW.md) explains their precision bounds.

## Black & White

The Reds, Yellows, Greens, Cyans, Blues and Magentas controls determine how those input hues convert to gray. Each accepts −200 to 300 in 0.01 increments. Defaults are 40, 60, 40, 60, 20, 80 respectively. Nearby hues interpolate between adjacent controls; neutral pixels retain their gray value. Negative or large positive values can clip to black or white.

Enable **Tint** to color the converted gray. Choose a six-digit RGB color and strength from 0 to 100. The default is a warm `#b98952` at 100. Turning Tint off retains its color and strength. Tint preserves the converted gray's encoded brightness before rounding, fitting color intensity inside the RGB range. Black and white remain neutral; a gray tint or zero strength has no effect.

This is separate from the existing simple Grayscale and Desaturate controls. It does not change their behavior.

## Scope and protection

An adjustment layer affects the composite below it. Creation captures the active selection as its mask; subsequent parameter updates retain that mask. Layer opacity controls strength. Existing isolated-group rules determine the adjustment's scope, and protected lower pixels remain unchanged.

A raster filter affects one unprotected raster source before geometry. Its order, enabled state and opacity remain editable. Active selections do not limit filters. Source alpha and RGB beneath zero alpha are retained, as are original files. The layer mask controls final visibility; lower protected coverage still excludes source-filter changes in the composite. Source previews remain unfiltered.

Protected targets reject filter edits. Resolve a nonempty filter stack before eligible painting, filling, extraction, placement or source-alpha repair. [Bake filters](FILTER_BAKING.md) keeps the saved treatment as working pixels; Clear removes it. Baking retains archived originals, separate alpha and current rendered appearance, subject to its protected-context and resource guards. These controls introduce no per-filter mask or implicit baking.

## MCP examples

Both kinds require `value:0`; their parameter object performs the operation.

```js
prism_add_adjustment({
  backend: 'native', documentId, expectedRevision,
  kind: 'color_balance', value: 0,
  parameters: {
    shadows: [-4, 0, 5],
    midtones: [6.25, 1, -3],
    highlights: [3, 0, -2],
    preserveLuminosity: true
  }
})

prism_add_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId,
  kind: 'black_white', value: 0,
  parameters: {
    reds: 50, yellows: 65, greens: 45,
    cyans: 55, blues: 25, magentas: 70,
    tint: true, tintColor: '#b98952', tintAmount: 30
  }
})
```

Update using `prism_update_adjustment` with the existing layer ID, or `prism_update_layer_filter` with the layer and filter IDs. A supplied Color Balance row replaces all three values in that row; omitted rows and switches stay unchanged. Black & White updates merge individual fields. Empty update parameters retain the current settings. Unsupported fields, extra decimal precision, invalid colors and nonzero scalar values reject atomically.

Creation without parameters fills complete defaults. Saved recipes also fill complete defaults when defined, independently of their eventual targets. Replaying an adjustment recipe therefore replaces the target's parameters with the recipe's complete settings. Filter steps append new entries. Disabled tint settings and disabled filter entries remain saved.

## Limits and persistence

Native discovery exposes 24 adjustment kinds and 26 raster-filter kinds, including the subsequently added [source Gaussian/RGB sharpen controls](SOURCE_SPATIAL_FILTERS.md), [Unsharp Mask](UNSHARP_MASK.md) and [Add Noise](ADD_NOISE.md). Filters retain the limits of eight entries per raster and 64 per document, including disabled entries. Active filters share a 384-million weighted source-pixel work budget. Under Normal filter blending: Color Balance costs 40 per pixel with luminosity preservation or 10 without, and Black & White costs 7. An active non-Normal [filter blend](FILTER_BLENDING.md) adds 40 visits per source pixel. One preserved Color Balance filter in Normal mode therefore permits at most 9.6 million source pixels before other active filters consume any of that budget. Transforming a large source to display smaller does not reduce its filtering cost. Enabling a filter, raising its opacity from zero or enabling luminosity preservation revalidates the complete graph.

Global adjustment layers follow the existing canvas limits; the filter work budget applies to source stacks. Both Color Balance execution paths yield at intervals of at most 65,536 pixels and 32 rows. These are responsiveness and admission policies, not a guarantee of total latency, cancellation or process memory. Existing group, clipping and mask scratch limits still apply.

Undo, autosave/reopening and editable `.prism` projects retain all settings. Older readers reject unknown adjustment kinds. Strict PSD export rejects these adjustment layers and filter stacks rather than silently flattening them. Flattened image exports contain the visible result. The optional Photoshop bridge does not implement these native kinds.

See [verification status](IMPLEMENTATION_STATUS.md), [shared UI design](TONAL_COLOR_UI_DESIGN.md) and [reusable recipes](EDIT_RECIPES.md).

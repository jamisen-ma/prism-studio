# Blend individual filters

Implemented and verified through native commands, MCP and the browser. See [verification status](IMPLEMENTATION_STATUS.md) for test evidence and limits.

**Layers → Layer filters → Filter blend** controls how one filter combines with the image entering that step. It is separate from the containing layer's blend mode. Choose a mode and **Apply filter changes** to save it; changing the dropdown alone edits only the local draft.

For example, Luminosity can use a sharpening result's luminance contribution, Color can use a grade's color contribution, and Multiply or Screen can darken or lighten the combination. These are native encoded-RGB operations, with their own defined precision; they are not perceptual color-management or Adobe algorithm equivalence claims.

## Order and opacity

Each saved entry runs in this order:

1. Read the source RGB left by earlier filters.
2. Calculate the filter's ordinary full-strength byte result.
3. Blend that result with its input RGB using **Filter blend**.
4. Fade the blended result using **Filter opacity**, then round to final RGB bytes.

The blend result is not rounded before opacity. This matters at fractional opacity: intermediate rounding can change a final byte. Normal keeps the existing filter behavior exactly. Source alpha stays unchanged; layer geometry, additional masks, mask density, layer opacity, layer blending and group composition keep their later roles.

Zero Amount or sigma means the filter adds no noise, blur or sharpening. A non-Normal blend can still change the image by blending its unchanged candidate with itself. For a source RGB value of 128, self-Multiply produces 64, Screen produces 192 and Difference produces 0 at full filter opacity. Unsharp Threshold gates the sharpening candidate before blending; it does not protect that channel from a later non-Normal blend. Disable an entry or set its opacity to zero to bypass both stages.

The saved stack label shows a non-Normal mode beside opacity. Parameter resets retain the separate blend and opacity settings. **New pattern** changes only a noise seed draft. Recipe capture uses saved settings, including the saved blend mode, rather than unapplied drafts.

## Available modes and protection

All 27 source-filter kinds share these 26 modes:

| Family | Modes |
| --- | --- |
| Default | Normal |
| Darkening | Darken, Multiply, Color Burn, Linear Burn, Darker Color |
| Lightening | Lighten, Screen, Color Dodge, Linear Dodge, Lighter Color |
| Contrast | Overlay, Soft Light, Hard Light, Vivid Light, Linear Light, Pin Light, Hard Mix |
| Comparison | Difference, Exclusion, Subtract, Divide |
| Color components | Hue, Saturation, Color, Luminosity |

Dissolve remains a whole-layer coverage operation and is not available inside an RGB-only filter. Fully transparent source RGB and every alpha byte stay exact. Positive alpha does not apply a second blend-opacity factor. Neighborhood filters retain their existing alpha-weighted candidate calculation.

Protected targets reject filter editing, and existing lower-protected-content and generated-region exclusions still apply. The active selection does not restrict source filters. Any nonempty filter stack must be explicitly baked or cleared before eligible source painting or extraction; a zero-strength candidate is not an exemption.

**Bake filters** includes the saved blend result, preserving the admitted composite, archived original, working alpha, separate cutout alpha, masks and geometry while clearing editable entries. **Clear filters** removes their effect. Both retain the existing Undo and protected-context rules. See [filter baking](FILTER_BAKING.md).

## MCP and compatibility

For non-Normal modes require `layerFilterBlendPolicy:'candidate-rgb-v1'`, source coordinates, the individual kind and mode in `layerFilterBlendModes`, and the applicable command. Specialized source filters retain their own kind policies as well. Global adjustment commands do not gain this field.

```js
prism_add_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId,
  kind: 'unsharp_mask', value: 0,
  parameters: { amount: 100, sigma: 1, threshold: 3 },
  blendMode: 'luminosity', opacity: 0.75
})

prism_update_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId, filterId,
  blendMode: 'normal'
})
```

Omitting a mode on creation means Normal. Omitting it on update preserves the current mode; explicitly setting Normal clears the saved non-Normal field. Native authoring and recipe save omit Normal canonically. Valid externally authored records with explicit Normal can remain stored until ordinary filter editing; reading a project alone does not migrate it.

Legacy Normal operations omit the field and retain their previous capability requirements. A companion without a saved non-Normal mode's exact advertised support keeps it readable, blocks its editor and stack reordering, and retains explicit Delete plus independently advertised Bake/Clear. A withdrawn draft stays intact until the user chooses a supported alternative. Recipe definitions can be captured/imported without execution; Validate/Apply require support for every saved step, including disabled entries.

Undo, recipes, portable transfer and reopening retain saved modes. Older readers reject new non-Normal fields rather than silently rendering Normal. Existing canonical Normal records keep their earlier compatibility.

## Precision and workload

Twenty non-Normal modes use exact byte ratios and exact rounding at the authored binary64 opacity. Common dyadic opacities use bounded integer Number arithmetic; other values have an exact fallback near half-byte boundaries. Darker/Lighter Color compare whole RGB sums and retain the input on a tie. Soft Light and Hue/Saturation/Color/Luminosity use the defined native floating formulas; those five modes do not promise exact-real rounding. Their color-component luma is `0.3R + 0.59G + 0.11B`, distinct from the tonal adjustment luma.

Every enabled, positive-opacity non-Normal entry adds 40 weighted source-pixel visits to its filter's existing cost. Normal adds zero; disabled or zero-opacity entries cost zero. The document shares a 384-million visit limit, including hidden layers. Thus an unchanged candidate with a non-Normal blend costs 41 visits per source pixel, computing Add Noise costs 48, and Color Balance with luminosity preservation costs 80. Other active filters and memory/dimension limits can lower the admitted source size. Reducing display size does not reduce source work.

The blend loop yields in bounded batches of at most 16,384 source pixels, including transparent pixels, without another full-image plane. Candidate construction keeps each filter's existing limits. Runtime scheduling and memory accounting are not whole-process latency or RSS guarantees. A refused mode/opacity change retains the saved project and submitted draft without automatically lowering settings.

See [native algorithm and measurements](FILTER_BLEND_DESIGN.md), [independent review](FILTER_BLEND_REVIEW.md) and [browser acceptance](FILTER_BLEND_UI_DESIGN.md).

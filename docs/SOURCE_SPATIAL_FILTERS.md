# Source Gaussian Blur and RGB Sharpen

**Layers → Layer filters** includes **Gaussian Blur** and **Sharpen (RGB)**. They stay editable, can be reordered with color filters, and can be saved in recipes. Original files remain unchanged. These source filters preserve transparency: they change interior colors without expanding or softening the cutout silhouette.

| Control | Range | Meaning |
| --- | --- | --- |
| Gaussian Blur: Sigma, source px | 0–50 | Size of the alpha-weighted Gaussian neighborhood. |
| Sharpen (RGB): Sigma, source px | 0–10 | Size of the Gaussian neighborhood used for a fixed-strength RGB unsharp result. |

Higher sigma affects a wider neighborhood. Sizes are measured before layer geometry, so an enlarged layer displays a larger effect. Zero produces an unchanged filter candidate. In Normal mode this leaves pixels unchanged; a non-Normal filter blend can still change RGB. Very small positive values can also produce an unchanged candidate after kernel quantization; their authored numbers remain saved exactly. The number field accepts finite fractional values without forcing the slider's step size.

Sharpen uses fixed unsharp amount 1 and threshold 0. **Filter opacity** fades its rounded result afterward in Normal mode. An optional [filter blend](FILTER_BLENDING.md) runs before opacity; both are separate from sharpening strength. Choose the distinct [Unsharp Mask filter](UNSHARP_MASK.md) for independent Amount, sigma and Threshold settings. Neither feature implements Smart Sharpen or claims Adobe numerical parity. Adobe's [Unsharp Mask controls](https://helpx.adobe.com/photoshop/desktop/effects-filters/smart-filters/sharpen-images-with-unsharp-mask.html) are the broader workflow reference.

## Transparency, order and masks

Each visible neighbor contributes in proportion to its alpha. Fully transparent neighbors contribute no color, so hidden RGB cannot bleed into visible pixels. All input alpha bytes remain exact, and RGB at zero input alpha remains exact. Constant colors remain constant even at alpha 1 or 128.

Working-image alpha and a separate cutout alpha are combined before source filters. The stack runs first to last, then layer geometry is applied. Selection, additional layer masks, density, opacity and group/clipping composition keep their existing later behavior. An additional mask hides the result; it does not restrict the filter's sampling neighborhood.

These controls are separate from the existing global Blur and Sharpen adjustment layers, whose saved behavior is unchanged. In particular the source sharpen uses an RGB residual; the existing parameterized global sharpen uses the installed Sharp LAB path. Never substitute one scope for the other when replaying an edit.

Protected target layers reject filter edits, and lower protected content retains the existing display exclusions. An enabled, positive-opacity entry still belongs to the active stack when its sigma is zero or its output happens to be identical. It must be disabled before protecting the target, or explicitly baked/cleared before eligible pixel editing. Changing a radius never unprotects or reshapes a subject.

## Bake, recipes and history

**Apply filter changes** saves the current draft. Bake and recipe capture use saved settings, excluding unapplied drafts. **Bake filters** fixes the saved treatment into working RGB and removes entries while preserving the current composite, archived original, separate alpha, masks and transforms. **Clear filters** removes the treatment instead. Both are undoable. Baking retains its protected-context and additional memory limits; see [Bake filters](FILTER_BAKING.md).

A recipe stores kind, sigma, enabled state, opacity and any non-Normal blend in order. Validation checks the target's existing stack and cumulative resource use without rendering or changing assets. Each intentional application appends its filter steps; one Undo restores the previous stack. `.prism` projects retain editable entries and recipes. Older readers that lack these source kinds reject them rather than silently ignoring them.

## MCP

Require native `layerFilterCoordinates:'source'`, the individual kind in `layerFilterKinds`, and `layerFilterSpatialPolicy:'alpha-weighted-gaussian-rgb-v1'`.

```js
prism_add_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId,
  kind: 'blur', value: 1.5, enabled: true, opacity: 0.75
})
```

Use `kind:'sharpen'` with a sigma from 0 to 10 for RGB sharpen. Omit `parameters`; these source operations do not accept Amount, Threshold, a mask or additional color settings. `update_layer_filter` changes the saved entry by its filter ID. Ordinary revision checks, transaction rollback, Undo and retry rules apply.

## Work and memory limits

Source size and sigma both affect admission. The following costs and ceilings describe Normal blending. For a positive active entry, `r=ceil(3*sigma)`, `K=2*r+1`, and its work charge is `sourcePixels*(2*K+8)`. The whole document shares 384 million weighted source-pixel visits with its other filters, including hidden layers. Active zero-sigma entries cost one visit per pixel; disabled and opacity-zero entries cost none.

| One positive spatial filter | Maximum source pixels from work alone |
| --- | ---: |
| Sigma 1 | 17,454,545 |
| Sigma 3 | 8,347,826 |
| Sigma 10 | 2,953,846 |
| Blur sigma 50 | 629,508 |

Every active non-Normal blend adds 40 weighted visits per source pixel, including a zero-sigma candidate. Other filter entries and the existing dimension, group, mask and memory limits can reduce these ceilings. Displaying a large source at a smaller size does not lower source-filter work. Refusal preserves the saved project; Prism does not secretly reduce sigma or use another algorithm.

The implementation uses a rolling cache of integer horizontal sums, with an explicit maximum based on source width and neighborhood height. That cache contributes to the shared 256 MiB rendering scratch limit and the separate 256 MiB bake working-buffer limit. These are named-buffer limits, not guarantees about total process memory. Tap loops yield within every 65,536 weighted samples; this is not a hard response-time guarantee or a cancellable filter job.

The exact native definition is a symmetric, three-sigma-truncated Gaussian with integer coefficients summing to 65,536, edge replication and alpha normalization. RGB sharpen rounds `2*original - normalizedGaussian` once, after clamping. The stack then applies the selected filter blend and opacity; Normal retains the original interpolation. This preserves exact alpha and deterministic integer rounding without claiming a continuous Gaussian or another editor's pixels. See [algorithm and resource design](SPATIAL_LAYER_FILTERS_DESIGN.md), [independent arithmetic proof](SPATIAL_FILTER_REVIEW.md) and [verification status](IMPLEMENTATION_STATUS.md).

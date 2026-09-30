# Unsharp Mask

**Layers → Layer filters → Unsharp Mask** sharpens image detail with three editable controls. Its settings remain separate from the fixed-strength **Sharpen (RGB)** filter and the global **Sharpen** adjustment. It preserves the archived original and all source transparency.

| Control | Range | Default | Effect |
| --- | --- | --- | --- |
| Amount, % | 0–500 in 0.01% increments | 100 | Scales the difference between each original RGB channel and its Gaussian neighborhood. |
| Sigma, source px | 0–50, including finite fractional values | 1 | Sets the size of that neighborhood before layer transforms. |
| Threshold, per RGB channel | Integer 0–255 | 0 | Changes a channel only when its unrounded difference is strictly greater than this value. |

A larger Amount increases contrast around detail. A larger sigma affects a wider neighborhood. Raising Threshold leaves smaller differences alone in the sharpening candidate. Equality with Threshold retains the input channel in that candidate, and channels can cross the threshold independently, so hue preservation is not guaranteed. The control is Gaussian sigma; it does not claim numerical equivalence to another editor's radius or threshold algorithm.

**Filter opacity** fades the finished result afterward. An optional [filter blend](FILTER_BLENDING.md) runs between the rounded sharpening candidate and opacity; even channels below Threshold can change in this later blend. Amount and opacity can therefore produce different pixels. **Reset Unsharp Mask** restores the three default controls in the local draft, retaining filter blend and opacity. **Apply filter changes** saves the draft; unapplied settings are excluded from Bake and recipe capture.

Expand **How Unsharp Mask works** for threshold, source-pixel and limit details. The main controls remain compact at narrow inspector widths.

The number fields retain valid authored values exactly. Blank, nonfinite, out-of-range, fractional-threshold and finer-than-0.01%-amount drafts cannot be applied. The sigma slider is a convenience; it does not quantize a valid typed sigma. Amount 0, sigma 0 and Threshold 255 produce an unchanged sharpening candidate. In Normal mode they leave pixels unchanged; a non-Normal blend can still change RGB. Very small positive sigma may also yield an unchanged candidate after kernel quantization.

## Transparency, masks and order

The filter uses the existing [source Gaussian neighborhood](SOURCE_SPATIAL_FILTERS.md): edge replication, alpha-weighted neighbors and exact retained alpha. Fully transparent neighbors contribute no hidden color. Pixels with zero effective source alpha keep their hidden RGB unchanged. The filter sharpens interior colors without changing the cutout silhouette.

Working-image alpha and separate cutout alpha combine before the source stack. Filters run in saved order before geometry. Additional layer masks, mask density, layer opacity, groups and clipping retain their later compositing behavior; those masks do not scope the sampling neighborhood. Resizing a layer changes the displayed effect size while retaining the source-pixel setting.

Protected targets reject filter edits. Enabled positive-opacity identities retain the existing active-filter guards, including protection and Bake checks. Any nonempty stack must be explicitly baked or cleared before eligible source painting or extraction. The name Unsharp Mask does not create an editable per-filter mask.

## MCP, recipes and portable projects

Require a matching native document, `layerFilterCoordinates:'source'`, the individual `unsharp_mask` kind, the relevant command, and `layerFilterUnsharpPolicy:'rgb-residual-threshold-v1'`. This marker defines the complete Unsharp policy independently of the older source-blur marker. Source discovery contains 27 kinds; global adjustment discovery remains 24.

```js
prism_add_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId,
  kind: 'unsharp_mask', value: 0,
  parameters: { amount: 125, sigma: 1.2, threshold: 5 },
  enabled: true, opacity: 1
})

prism_update_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId, filterId,
  parameters: { threshold: 8 }
})
```

`value` must be zero. Omitted or empty creation parameters resolve to Amount 100, sigma 1 and Threshold 0. Updates merge supplied fields with the current effective settings. Unknown or wrong-family fields reject. Global adjustment commands and global recipe slots do not accept this source-only kind or its parameters.

Saved recipes materialize complete defaults, retain filter order, enabled state, opacity and any non-Normal blend, and bind explicit raster targets. Validation checks the prospective stack without image reads or mutations; application is one undoable edit. Each intentional application appends its steps. Definition capture/import can remain available when execution support is absent; Validate/Apply require the correct policy. Retry follows existing session deduplication and revision rules.

Portable `.prism` projects retain editable settings and recipes. Older readers that do not recognize this filter kind reject the project before reading image assets. Saved entries remain visible as read-only when the current companion lacks their editing policy; independent Bake/Clear capabilities retain their own rules.

## Bake and limits

Explicit **Bake filters** preserves the current admitted composite, stores filtered working RGB, and clears the stack while retaining original files, source alpha, separate cutout alpha, masks and geometry. RGB hidden by effective source alpha stays ungraded if later revealed. **Clear filters** removes the treatment. Both undo independently; active baking above earlier protected content remains unavailable. See [baking scope and resources](FILTER_BAKING.md).

Under Normal blending, all active nonidentity Unsharp entries use the same work weight, including fractional Amount settings. Let `r=ceil(3*sigma)`, `K=2*r+1` and `S=sourcePixels`. The charge is `S*(2*K+40)` against the shared 384-million source-filter budget. Hidden active layers count. Amount 0, sigma 0 or Threshold 255 costs `S` with no Gaussian cache; disabled or opacity-zero entries cost zero. Leaving an identity can exceed the limit and reject without changing the project.

| One nonidentity Unsharp filter | Maximum source pixels from work alone |
| --- | ---: |
| Sigma 1 | 7,111,111 |
| Sigma 3 | 4,923,076 |
| Sigma 10 | 2,370,370 |
| Sigma 50 | 598,130 |

An active non-Normal blend adds 40 weighted visits per source pixel, even for an unchanged candidate. Other entries and existing dimension, group, mask and memory limits can lower these ceilings. Displaying a source smaller does not lower source-filter work. Prism preserves the requested settings on refusal rather than automatically reducing their quality.

The Gaussian rolling cache contributes to the shared render scratch and separate Bake working-buffer limits. Sequential entries share a maximum-cache reservation; they do not retain multiple blurred image planes. These are accounted-buffer bounds, not a total-process-memory guarantee. Existing periodic yields remain, without a hard response deadline or cancellable filter job.

The native candidate scales the exact, unrounded RGB residual, clamps once and rounds half up once. Safe rational cases use proved exact integer arithmetic; near-half results for other amounts are recomputed with BigInt. No epsilon is added to image colors. Amount 100 and Threshold 0 exactly match fixed source Sharpen at the same supported sigma. See [native definition and measured performance](UNSHARP_MASK_DESIGN.md), [independent proof and audit](UNSHARP_REVIEW.md), and [browser acceptance](UNSHARP_UI_DESIGN.md).

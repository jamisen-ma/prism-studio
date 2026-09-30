# Editable High Pass

Implemented and verified through native commands, MCP and 63 browser workflows. See [verification status](IMPLEMENTATION_STATUS.md).

**Layers → Layer filters → High Pass** builds an editable gray-centered detail map from source RGB. The default is sigma 1 source pixel, Normal blending and 100% filter opacity. Choose **Overlay** or **Soft Light** explicitly to combine the detail with the current image. Increase sigma to include broader detail; reduce filter opacity to fade the blended result.

Sigma accepts any finite value from 0 through 50, including tiny positive values. It is measured before layer geometry, so resizing the layer also resizes its visible detail scale. This is the native Gaussian sigma, not a promise of matching another editor's radius or pixels. High Pass has no Amount or Threshold controls; use [Unsharp Mask](UNSHARP_MASK.md) for those.

**Sigma 0 produces gray 128 at every visible source pixel. It does not bypass High Pass.** In Normal mode this displays a gray map. With Overlay or Soft Light, gray 128 leaves every input byte unchanged after rounding at every filter opacity. Other blend modes have different neutral values and behavior. Disabling the entry or setting filter opacity to zero bypasses it.

## Pixels and composition

The filter computes `128 + current RGB − alpha-weighted Gaussian mean`, then clamps and rounds once to a byte. It does not round the mean before subtraction. This distinction matters at half-byte boundaries: an opaque pair 80/144 at sigma 0.3977 produces 126/131. Source edges repeat, and invisible neighbors do not contribute hidden colors.

All alpha bytes and RGB at zero effective source alpha remain exact. Separate cutout alpha combines with working alpha before filtering. The complete rounded candidate enters optional [filter blending](FILTER_BLENDING.md), then filter opacity. Later masks, density, geometry, group composition and clipping retain their existing behavior. Active selections do not scope a source filter. Filter order matters because each entry reads the preceding result.

Protected targets reject filter edits. Enabled positive-opacity entries remain structurally active even when a gray candidate blends back to unchanged pixels. Existing protection and source-edit guards remain in effect. Any nonempty stack must be explicitly baked or cleared before eligible source painting, extraction or source-alpha repair.

## MCP and recipes

Require native source coordinates, the individual `high_pass` kind, the applicable command, and `layerFilterHighPassPolicy:'alpha-weighted-residual-128-v1'`. This marker is independent of the Gaussian Blur, Unsharp and Add Noise markers. Nonnormal blending additionally requires the blend policy and chosen mode. Source discovery contains 27 kinds; global adjustments remain 24.

```js
prism_add_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId,
  kind: 'high_pass', value: 1,
  blendMode: 'overlay', opacity: 0.625
})

prism_update_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId, filterId,
  value: 2.5
})
```

`value` is sigma. Do not supply `parameters`, including an empty object. Updates preserve omitted settings, including blend and opacity. Invalid scalar values or parameter objects reject even on disabled entries. High Pass is unavailable through global adjustment commands or adjustment recipe slots.

Saved recipes preserve exact scalar values, enabled state, opacity and nonnormal blend choices. Capture uses saved settings, excluding unapplied drafts. Validation checks the prospective stack without image reads or writes; application is one Undo with ordinary revision and session retry rules. Portable projects preserve the editable stack, and older readers reject the unknown kind. A companion without the exact policy keeps saved entries readable while refusing unsupported editing and execution.

## Bake and processing limits

**Bake filters** retains the admitted current composite while storing the finished source RGB and clearing the stack. Archived originals, working alpha, separate cutout alpha, geometry and later masks remain intact. **Clear filters** removes the treatment instead. Both undo; active baking above earlier protected content remains unavailable. See [Bake filters](FILTER_BAKING.md).

For an enabled entry at positive opacity, sigma zero costs one weighted visit per source pixel and needs no Gaussian ring. Positive sigma costs `2*(2*ceil(3*sigma)+1)+8` visits and the same bounded alpha-weighted ring as source Blur. Every nonnormal mode adds 40 visits. Disabled or zero-opacity entries cost zero. Hidden active layers count toward the shared 384-million-visit budget. Tiny positive sigma retains its positive-radius cost even if its quantized candidate is gray.

For example, one sigma-1 entry costs 22 visits per pixel in Normal or 62 in Overlay. Before other limits, those permit 17,454,545 or 6,193,548 source pixels respectively. At sigma 50, the corresponding ceilings are 629,508 or 590,769 pixels. Document dimensions, other filters, groups and mask memory can reduce these ceilings. Preview display size does not reduce source work, and a refusal never silently lowers sigma.

The implementation uses one candidate and the existing rolling Gaussian cache, without a full blurred image plane or generation/model calls. Measured integrated evaluation on Apple M5 Max/Node 22 takes about 53ms for 1MP sigma-1 Normal, 916ms for sigma 50 at 768², and 247ms for 24MP sigma-zero Normal. These exclude file decode, full composition and encoding and are not deadlines or process-memory guarantees.

See the [native arithmetic and resource design](HIGH_PASS_DESIGN.md), [independent review](HIGH_PASS_REVIEW.md) and [browser acceptance plan](HIGH_PASS_UI_DESIGN.md).

# Repeatable Add Noise

Implemented and verified through native commands, MCP and the browser. See [verification status](IMPLEMENTATION_STATUS.md) for the test evidence and limits.

**Layers → Layer filters → Add Noise** adds editable texture to source RGB while preserving transparency and the archived original. A saved seed makes its samples repeat through previews, exports, Undo/Redo, recipes and reopening.

| Control | Range | Default |
| --- | --- | --- |
| Amount, % | 0–400 in 0.01% increments | 5 |
| Distribution | Uniform or Gaussian | Uniform |
| Monochromatic | Shared RGB noise or separate channel samples | On |
| Pattern seed | Integer 0–4,294,967,295 | 1 |

**New pattern** changes only the local seed draft. **Apply filter changes** saves it and updates the image. Opening a panel, changing preview size or exporting never chooses another seed. **Reset Add Noise** restores the four defaults locally while retaining filter blend and opacity. Invalid Amount/seed drafts cannot be applied. Seed zero and the maximum unsigned value remain valid saved choices.

Uniform spreads its samples evenly across a bounded range. Gaussian concentrates samples near zero with fixed bounded tails. At the same Amount they have different spreads: Uniform approaches a maximum RGB offset of `255*Amount/100`, while Gaussian uses approximately that quantity as one standard deviation. For example, Amount 1% means offsets inside approximately ±2.55 with Uniform, versus a standard deviation near 2.55 with Gaussian.

Monochromatic shares the same pre-clamp offset across RGB. It does not convert the image to grayscale, and channel clipping can still change hue. The native Gaussian is a defined finite distribution of 4096 quantiles, with tails bounded at about ±3.668335 standard deviations. Neither mode claims film simulation or Adobe numerical equivalence.

**Filter opacity** fades the finished result after the rounded/clipped noise candidate and optional [filter blend](FILTER_BLENDING.md). It is separate from Amount, which scales noise before clamping. Amount 0 adds no noise; Normal leaves pixels unchanged, while a non-Normal blend can still change RGB. Very small positive amounts can also produce an unchanged noise candidate. A different seed does not promise different displayed pixels when the result is invisible, clipped or an identity. Expand **How Add Noise works** for these details without filling the main inspector with help text.

## Source coordinates, transparency and protection

Noise belongs to source pixels before layer geometry. Moving, cropping or resizing the layer transforms its sampled result. The same source width, coordinates, settings and seed generate the same samples even with different document/layer/filter IDs. Reordering filters can change their combined RGB result, while each noise entry retains its own sampled field.

All alpha bytes stay exact, and RGB at zero effective source alpha stays unchanged. Invisible pixels do not consume a random sequence or shift later samples. Separate cutout alpha combines with working alpha before filtering. Additional masks, mask density/position, layer opacity, group composition and clipping keep their later behavior. The active selection does not restrict this source filter.

Protected targets reject filter edits, and existing protection/generated exclusions remain in effect. An enabled positive-opacity Amount 0 entry remains structurally active. Any nonempty stack, including disabled entries, must be explicitly baked or cleared before eligible source painting or extraction; existing PSD-export restrictions remain.

## MCP and reusable recipes

Require native `layerFilterCoordinates:'source'`, the individual `add_noise` kind, the applicable command, and `layerFilterNoisePolicy:'seeded-rgb-discrete-v1'`. The noise marker is independent of the source-blur and Unsharp markers. Source discovery contains 27 kinds; global adjustment discovery stays 24.

```js
prism_add_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId,
  kind: 'add_noise', value: 0,
  parameters: {
    amount: 2.5, distribution: 'gaussian',
    monochromatic: true, seed: 12345
  },
  opacity: 1
})

prism_update_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId, filterId,
  parameters: { seed: 0 }
})
```

The scalar `value` must be zero. Missing creation parameters use the complete defaults above; partial updates retain current effective fields. Omitted seed never means randomize. Unknown fields and invalid values reject even on disabled or zero-amount entries. Global adjustment commands and adjustment recipe slots do not accept this source-only family.

Recipe capture stores saved settings, including the seed, enabled state, opacity and any non-Normal blend. It excludes unapplied New pattern drafts. Sparse definitions acquire complete defaults on save, independently of their future targets. The same recipe produces the same noise field on equal sources with different IDs; a repeated intentional application appends another entry under normal recipe rules. Validation checks the prospective stack without image reads or writes, and application is one Undo. Existing revision and session retry rules apply.

Portable `.prism` projects preserve live filters and seeds. Older readers reject the unknown kind rather than ignoring it. A companion lacking the exact noise policy leaves saved entries readable; editing/executing them requires support. Definition capture/import and independently advertised Bake/Clear retain their own rules.

## Bake, workload and memory

**Bake filters** stores the saved treatment as working RGB and clears the editable entries, preserving the current admitted composite, archived original, source alpha, separate cutout alpha, masks and geometry. Previously source-alpha-hidden RGB stays ungraded if later revealed. Bake fixes the noise into pixels; subsequent edits do not invoke that removed filter. **Clear filters** removes its treatment. Both undo; active baking above earlier protected content remains unavailable. See [Bake filters](FILTER_BAKING.md).

With Normal blending, every enabled positive-opacity noise entry with Amount > 0 costs eight weighted visits per source pixel, in all distribution/color modes. Amount 0 costs one visit with no sampling/candidate computation; disabled or opacity-zero entries cost zero. Hidden active layers still count. The document shares 384 million visits with its other source filters: two 24 MP noise entries exhaust that work budget before other filters. A non-Normal blend adds 40 visits per source pixel, making computing noise cost 48 and Amount 0 cost 41. Dimension, memory, group and mask limits can lower the actual ceiling. Displaying a source smaller does not reduce its source workload.

Computing Gaussian noise also reserves one shared 4096-byte table. It is charged once alongside the maximum retained rendering phase, including other layers and positioned-mask callbacks, and once in each Bake working phase. It is not multiplied by filter count or confused with a blur's rolling cache. Metadata checks do not initialize it. The table may remain resident after use; this accounting is an operation reservation, not a promise about whole-process memory.

The evaluator copies one candidate and samples by integer source coordinates, yielding at most every 65,536 source pixels. No random image plane, per-pixel state array, runtime inverse CDF, network call or model is used. Refusals preserve saved settings and assets without changing Amount, distribution or seed automatically.

The deterministic mapping, exact one-round additive byte arithmetic and certified table are pinned by the policy. The maintained verifier runs with `python3 scripts/certify-noise-table.py --verify`; the application does not need Python for noise rendering. See [algorithm, resource ledger and measurements](NOISE_FILTER_DESIGN.md), [independent certification and audit](NOISE_FILTER_REVIEW.md), and [browser verification](NOISE_FILTER_UI_DESIGN.md).

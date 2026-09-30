# Tonal color independent review

Reviewed 2026-09-19. The declared mathematics, standalone `server/tonal-color.mjs` helper and native integration pass independent review. The native integration audit has eight passing tests. MCP/browser checks remain separately owned; this document distinguishes their status from the independent evidence below.

The source contract is [TONAL_COLOR_DESIGN.md](TONAL_COLOR_DESIGN.md). Adobe's [Color Balance documentation](https://helpx.adobe.com/ca/photoshop/using/applying-color-balance-adjustment.html) describes tonal-range controls, opposing colors and a preservation option. Its [Black & White documentation](https://helpx.adobe.com/photoshop/desktop/adjust-color/color-effects-techniques/convert-a-color-image-to-black-and-white.html) describes hue-dependent gray controls and optional tint. These support the control vocabulary. They do not establish numerical equivalence with Prism's encoded-sRGB algorithms.

## Arithmetic findings

Color Balance must cancel the leading 255 before the weighted desired-luma calculation. The resulting desired integer numerator stays between −25.5 billion and 51 billion; centered chroma stays within the conservative absolute bound 765 trillion. Every integer used before gamut-factor division therefore remains below `2^53`. The unsimplified expression is suitable for a BigInt reference, but carrying it into Number weighted-luma calculations would lose this guarantee.

The unpreserved and in-gamut branches divide one exact integer numerator and round once. Their rational distances from half-byte boundaries are at least `1e-8` and `1e-12`, respectively. Both exceed byte-range division error. All-zero effective shifts must return the input directly, retaining exact identity rather than subjecting it to an unnecessary neutral/chroma reconstruction.

For compressed chroma, selecting the minimum of rounded positive candidate ratios is safe for the proposed error bound: correctly rounded division is monotone, so the minimum is a rounded exact minimum even when two constraints have equal floating representations. Three multiplicative roundings, target-luma division and final addition contribute less than `6*255u`, where `u=2^-53`. The decision guard is `128*255u`, more than 21 times that bound. The subtraction used to measure distance from a half-byte does not consume this margin. Active factors are normal finite numbers, and fitted chroma is bounded by 255, so neither underflow nor unconstrained large fitted values undermine the argument.

The guard must recompute the complete pixel and its minimum constraint with exact integers. It must never add a color epsilon or reuse a potentially ambiguous floating constraint index. The implementation follows that rule. Its exact products are bounded by the RGB/control ranges and use fixed-size BigInt arithmetic with no data-dependent search or persistent cache.

A deliberately constructed example demonstrates why the fallback is necessary:

```text
Input RGB: [1,89,1]
Every tone row, percent: [100,-100,100]
Preserve luminosity: true
Exact output: [225,0,225]
Ordinary double estimate: [224.49999999999997, ~0, 224.49999999999997]
Ordinary rounded output without fallback: [224,0,224]
```

The family `[r,89,r]` for `r=0..31` gives exact outputs `[r+224,0,r+224]`. It exercises an authored image where every pixel takes the fallback, rather than relying on rare random ties.

Black & White's hue sectors agree with a separate reference using the six possible channel orderings instead of the production maximum-channel hue formula. Equal maxima reach the appropriate anchor; equal channels bypass hue division; both sides of the magenta/red boundary agree. Negative and greater-than-100% mix coefficients clamp only after the integer gray numerator is complete.

Tint fits full chroma around the converted gray before applying strength. The canceled tint formulation needs no BigInt: constraint cross-products and output numerators are safe Number integers, with the latter below the conservative `1.4e13` bound. The smallest possible rational output spacing remains larger than byte-range division error. Off, zero strength and neutral tint are exact bypasses; black and white remain neutral. Preservation concerns the converted gray's encoded luma, not the original color's luma.

## Reproducible evidence

The independent experiments live in `test-results/tonal-color-review/` and make no provider, image-generation or native mutation calls:

| Evidence | Checked result |
| --- | --- |
| `reference.mjs` / `report.json` | 220,032 Color Balance and 227,680 B&W/tint cases; no mismatches outside the guard. Three deliberately constructed cases expose incorrect ordinary floating rounding and correctly request fallback. |
| `production-check.mjs` / `production-report.json` | Actual helper matches the independent references for 262,176 Color Balance and 282,624 B&W/tint cases, including 32 authored ties and systematic hue/gray boundaries. |
| Normalization and ownership checks | 24 assertions cover ranges, precision, malformed/sparse rows, null/unknown fields, accessors/symbol keys, independent arrays/compiled closures and lowercase retained tint. |

The Color Balance oracle retains the original unsimplified 255 factor and exact rational desired denominator in BigInt. The tint oracle likewise retains an uncanceled rational factor. Neither calls the production arithmetic. This gives a different implementation of the declared mathematics rather than testing the helper against itself.

Measured standalone helper timings in this environment were approximately 227 ms for 1 MP common Color Balance,506 ms for 1 MP repeated exact ties, and 62 ms for 1 MP B&W with tint. These are a single local helper experiment, not end-to-end render latency or a throughput guarantee. The prototype's less optimized unsimplified fallback took 848 ms on the same repeated-tie workload.

Final filter admission uses weights 40 for luminosity-preserving Color Balance, 10 without preservation, and 7 for Black & White, within the existing 384-million weighted source-pixel budget. One active preserved Color Balance filter therefore admits at most 9.6 MP, with less room when other active filters exist. Defaults, hidden sources and partial preservation-flag updates use the same admission checks. Disabled or zero-opacity entries consume no work budget but retain their metadata/count limits.

Both Color Balance loops now yield after at most 65,536 pixels, also capped at 32 rows. The owner's actual 8192×128 repeated-tie benchmark in `test-results/tonal-color/native-benchmark.json` observes 493–506 ms processing time and 62–75 ms maximum heartbeat gaps, with 15 timer ticks. These observations include the real global/filter loops but exclude decoding/composition/file I/O and are not hard wall-time or total-memory guarantees. Independent tests verify yielding in both paths, with preservation on and off, and the row/chunk bound for every supported width.

## Parameter and pipeline review

The declared defaults, sparse persistence and partial updates fit the existing seams:

- Creation normalizes absent or empty parameters to a complete independent object. Supplied balance rows replace whole rows; omitted rows remain when the existing update path merges before normalization. B&W field updates retain off-state tint color and strength.
- Recipe normalization calls `normalizeParameters` without target-state merging. Once both kinds are admitted to schemas and dispatch, saved definitions receive complete canonical parameters and replay independently of a target's prior settings. Fixed adjustment-kind slots remain necessary.
- `PARAMETERIZED_ADJUSTMENTS` must include both kinds so `value:0` works. `COLOR_MAPPING_KINDS` must also include both so global adjustments preserve invisible RGB and use the existing yielding path. Adding just the transform dispatcher would leave real integration defects.
- Raster filters already preserve alpha and hidden RGB and restore original-context protected RGB. New kinds should reuse that pipeline, not acquire separate mask/protection logic. Work weights must be explicit.
- Public schemas, capability lists, optional-backend rejection, UI kind/default tables and recipe schemas need consistent kind membership. Unsupported stored kinds remain unsupported; they must not fall through to scalar controls.

The [UI proposal](TONAL_COLOR_UI_DESIGN.md) has no design blocker. Incomplete numeric strings remain drafts, inactive tone-row errors block submission, Tint-off values stay editable, and equivalent numeric spellings do not create artificial edits. Add/update and histogram capabilities are independent. Context checks must include the active filter identity before selecting a returned entry; recipe reconciliation remains unchanged.

## Verified native integration

`node --test tests/tonal-color-audit.test.mjs` passes **8 tests, 0 failures**. Distinct fixtures cover:

1. Real color-dispatch calls against independent rational outputs, including the constructed half-byte family, seeded parameters and hue/tint boundaries.
2. Global and source-filter evaluation with alpha 0/1/128/255, hidden RGB, filter order/bypass/partial opacity, additional bitmap-mask density and a protected destination. Input buffers remain unchanged.
3. Native creation capturing selection for an adjustment, source-wide filters ignoring selection, partial row/flag/tint merges, complete defaults and rendering a sparse persisted definition without rewriting it. Asset bytes do not change.
4. A protected subject and outline below an isolated group containing a clipping chain. Both new kinds preserve the original footprint, contextual source-filter previews restore original RGB, generated-member previews exclude protected coverage, and raw source inspection remains unfiltered.
5. Canonical recipes on three unrelated documents, compared with equivalent explicit commands. Defaults replace previous target-specific settings, masks/density survive, validation/apply avoid render/model/asset seams, source bytes remain exact, and one Undo restores the entire application.
6. Hidden 9.6 MP sources at the exact preserved-filter work boundary; cumulative addition, preservation-flag changes, enable changes and a two-step recipe refuse before pixel access and preserve the published graph. No real large image allocation is needed for these metadata tests.
7. Stale revisions and an actual ENOTDIR persistence failure preserve parameters, source assets, project/history files and cached-preview accounting.
8. An 8192-wide every-pixel-fallback image yields through both native loops, with and without preservation, while every output byte matches the independent reference.

No correctness defect was found in this native integration audit. The prior Mixer audit's expected discovery counts were updated to 24 adjustments and 22 source filters.

## Separately owned integration acceptance

Root owns the official SDK/restart/portable/capability checks; the UI owner covers browser creation/edit/filter/recipe, delayed responses, capability partitions and photographic inspection. These complement the independent native cases. PSD keeps its existing strict refusal of adjustment layers and nonempty filter stacks. Public claims should cite actual completed checks rather than treating a helper benchmark or screenshot as verification of every path.

## UI lifecycle source review

The shared tonal draft parser checks all three tone rows, including the inactive tabs. It preserves incomplete numeric text, rejects extra precision, retains off-state tint settings and deep-copies effective sparse defaults. Local resets do not dispatch commands. Filter Apply captures document/layer/filter/capability identity, while protected targets and unsupported kinds remain disabled.

Four source findings were sent to the UI owner for correction and focused browser evidence:

1. App's initial submission guard normalizes an empty selected-layer string to `undefined`, but its new completion guards initially compared the raw string. Creation without a selected layer could succeed server-side and then discard its result before installation. Both guards need consistent normalization and must distinguish a newly created first layer from an unrelated selection change during preview loading.
2. The workbench initially captured only document/revision/layer. A capability-driven remount could leave a delayed response eligible to install. Its local identity must remain valid through its own accepted revision transition: putting a naive alive flag inside the revision-keyed editor would instead reject every normal post-preview completion.
3. Filter-enable checkboxes initially omitted the captured context used by the Apply path. Their delayed `update_layer_filter` result therefore bypassed the new color-edit completion guard. Toggle submissions need equivalent context checks.
4. A valid persisted uppercase tint color was left uppercase by effective-default merging, while draft parsing canonicalized it to lowercase. An untouched editor could therefore appear dirty. Normalize the effective comparison value without writing the project.

All four corrections were independently rechecked in source. The workbench keeps local identity in its stable outer wrapper, excluding revision while retaining the active kind through its own accepted update. App normalizes absent selection consistently and permits its intentional first-layer installation. Filter toggles use the same captured identity as Apply, and effective tint colors canonicalize without a write.

The UI owner's final eight-workflow browser run passes, with evidence in `test-results/tonal-color-browser-report.json`. It includes empty-document first-layer selection, sparse uppercase canonical dirty state, delayed filter Apply and enable-toggle identity, document navigation before the response and during preview loading, and a pending capability response that removes addition support while a committed creation waits. Late results do not install or select stale content. There was one deliberately triggered revision conflict and no unexpected browser errors or provider/key calls. Adjacent Mixer4, filters4, recipes5 and mask-position8 browser workflows also pass. No UI blocker remains from this bounded source review.

The UI owner's subsequent mock optional-backend check found a transient PS-to-native switch that mounted the old document with the new capabilities and requested an unsupported histogram. The corrected mount gates require `doc.backend === backend` for the workbench, editable adjustment and filter panels; workbench capability checks also require a matching backend ID. These gates were independently rechecked in source. The final mock round-trip, build, eight tonal workflows and four filter workflows pass. This used a mock backend, not an installed Photoshop host.

No RAW, high-depth, perceptual colorimetry or Adobe pixel-parity claim follows from these checks.

# Independent Layer Fill fixtures

`reference.mjs` and its literal vectors were authored for this repository from the declared native content-opacity policy. They import no production/prototype code or third-party implementation and use no external assets.

Exports:

- `layerFillPixelReference(options)` returns one native-order RGBA tuple. Options supply `backdrop`, `body`, optional already-generated `decoration`, overall `opacity`, `fillOpacity`, body `maskCoverage`, final `decorationCoverage`, `blendMode`, and `pixelIndex`.
- `layerFillReference(backdropRGBA, bodyRGBA, options)` returns a new Buffer. Decoration is another RGBA buffer; coverage may be a scalar or one value per pixel. Inputs are not changed.
- `fillMaskCoverage(raw, options)` applies the existing in-bounds inversion/density policy to a raw post-feather sample. It preserves continuous geometry and recovers alpha8 before nonunit density when `byteMask:true`.
- `fillDissolveThreshold(index)` implements the existing unsigned spatial threshold independently with BigInt, rather than importing the runtime's signed `Math.imul` helper.
- `layerFillExactPixelComparison(options)` uses reduced BigInt fractions as a separate mathematical comparison. It is not an exact-real rounding promise for the native binary64 compositor.
- `LAYER_FILL_GOLDENS`, `LAYER_FILL_COVERAGE_GOLDENS`, and `LAYER_FILL_REFERENCE_MODES` provide literal cases and the supported reference subset.

The reference subset covers Normal, Multiply, Screen, Difference, Overlay and Dissolve. These use the existing source-over blend convention: blend normalized RGB, combine source-over contributions, then round the completed pixel. Fill changes only the body's incoming opacity to `O*F`; decoration uses `O`. Fill 1 retains the old incoming-opacity path. This is a native contract, not Photoshop special-Fill blending parity.

Decoration must already include its original, unfilled silhouette and additional mask. `decorationCoverage` represents the final protection/exclusion only: applying the body mask again would be incorrect. This fixture does not implement outline generation, Gaussian blur, geometry, source filters, group rounding, footprint generation or mask feathering. Actual native tests must independently assert those stages and resource admission.

The exact-fraction comparison is useful for algebra and chosen literal cases. Near half ties, different binary64 evaluation order can disagree with exact real arithmetic; actual accepted bytes follow `layerFillPixelReference`. The continuous one-sixth coverage case intentionally retains the declared binary64 result. An output with rounded alpha zero may retain calculated RGB, while an exactly zero source amount skips the write and preserves the backdrop's hidden RGB.

At creation these are fixture files only. They register no tests, commands, capabilities or runtime behavior. Production integration requires the separate native design release.

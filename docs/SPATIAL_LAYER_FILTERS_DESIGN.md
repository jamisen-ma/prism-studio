# Gaussian blur and RGB sharpen in source filter stacks

Status: implemented native backend, 2026-09-19. Root approved the contract and independent production review found no blocker. The owner8, independent10, schema2 and official MCP1 cases pass, and a combined66-test run including prior filter/bake/recipe suites passes. Full regression and client acceptance remain coordinated by root.

## Useful bounded scope

Admit `blur` and `sharpen` through existing editable raster-filter commands. This brings source-filter discovery from 22 to 24 kinds without adding a command. Preserve the existing global adjustment-layer implementations and previously saved global pixels. The source filters receive a separately declared alpha-weighted RGB algorithm; they are not the existing raw-RGBA global Sharp operations.

| Source-filter kind | Value | Meaning |
| --- | --- | --- |
| `blur` | finite 0–50 | Gaussian sigma in source pixels; zero is exact bypass. |
| `sharpen` | finite 0–10 | Gaussian sigma for native RGB unsharp at fixed amount 1 and threshold 0; zero is exact bypass. |

Use the authored positive sigma directly. There is no hidden minimum of 0.3 or 0.001. Very small positive values can quantize to an identity kernel, which is disclosed rather than relabeled as a larger sigma. Retain the existing structural definition of an active filter (`enabled && opacity>0`): an enabled positive-opacity zero/identity entry still prevents protecting or painting the target until explicitly disabled, baked or cleared. Disabled entries and opacity-zero entries remain exact bypasses. Public commands omit `parameters` entirely, including `{}`, following the existing scalar schema. Internal native scalar normalization retains its prior compatibility behavior of canonicalizing an empty object away.

Label the source controls “Gaussian Blur” and “Sharpen (RGB)”, with “Sigma, source px”. Existing per-filter opacity mixes the rounded candidate into the current RGB afterward; it is not a substitute parameter for unsharp Amount. Full Amount/Radius/Threshold controls and LAB sharpening are outside this slice. Adobe's Unsharp Mask has distinct Amount, Radius and Threshold controls; this smaller native operation does not claim those controls or numerical parity. [Adobe Unsharp Mask reference](https://helpx.adobe.com/photoshop/desktop/effects-filters/smart-filters/sharpen-images-with-unsharp-mask.html).

Discovery uses the existing `layerFilterKinds` and `layerFilterCoordinates:'source'`, plus `layerFilterSpatialPolicy:'alpha-weighted-gaussian-rgb-v1'` to make the distinct source algorithm inspectable. Existing `limits.maxFilterWork` and `limits.maxRenderScratchBytes` remain authoritative; capability limitations describe radius-dependent admission. No provider, image-generation call, source-asset mutation, new package or persistent graph field is needed.

## Why the existing global path cannot be reused

Current global `blur`/`sharpen` runs Sharp on raw8 RGBA, then retains input alpha in the compositor. That does not preserve soft-alpha RGB: independent local probes show constant `[31,121,231,1]` becomes RGB `[0,0,0]`, and alpha128 becomes `[29,119,229]`. The installed pipeline premultiplies into the input band format and later unpremultiplies. Merely restoring alpha or skipping writes at alpha zero cannot repair that intermediate color loss.

Sharp exposes floating Gaussian precision, while its parameterized sharpen operates in LAB. A float workaround would require additional wide input/output surfaces and would still not make LAB sharpen a normalized source-RGB operator. The proposed separable integer routine provides explicit alpha and rounding semantics with a bounded rolling cache. The global paths remain untouched for compatibility. [Sharp operation reference](https://sharp.pixelplumbing.com/api-operation/), [libvips Gaussian reference](https://www.libvips.org/API/current/method.Image.gaussblur.html).

## Source, alpha and ordering

For each filter entry, input `C` is the current source-space RGB after preceding entries, and `A` is the unchanged effective alpha formed from working alpha and optional source cutout alpha. Work is performed before retained crop/canvas/affine/resize geometry. Own/ancestor masks, density, positioning, layer opacity, styles, selection and clipping do not enter the Gaussian neighborhood. Their existing later behavior remains.

Each visible sample contributes in proportion to `A`; zero-alpha RGB contributes nothing. The helper returns a candidate RGBA whose alpha is copied from input. At an input pixel with `A==0`, retain all input RGBA bytes exactly. The stack's existing interpolation applies `round(C + (candidate-C)*entry.opacity)` at nonzero alpha only. A constant color therefore remains constant through blur and sharpen at alpha 1, 128 or 255, even next to arbitrary hidden RGB.

The operation blurs or sharpens interior RGB; it does not soften the cutout silhouette or expand coverage. A distinct mask/source-alpha workflow remains necessary for edge-alpha changes. Lower protected appearance uses the existing original-versus-filtered geometry restoration. Generated exclusions, group/clipping composition and decorated footprints keep their current ordering. Protected targets reject stack edits. Original/source preview remains original; normal previews and exports use the stack.

## Kernel compilation and exact arithmetic

For positive sigma `s`, set `r=ceil(3*s)`, `K=2*r+1`, `Q=65536`. Maximum radius is 150 for blur and 30 for sharpen. Compile once per entry per evaluation:

1. Center unnormalized coefficient is literal `1`, including subnormal sigma.
2. For each distance `d=1..r`, `e[d]=exp(-d*d/(2*s*s))`. If the denominator underflows to zero, the side exponent is negative infinity and `e[d]=0`; there is no `0/0` center calculation.
3. `Z=1+2*sum(e[d])`. For each positive distance, set both symmetric integer coefficients to `round(Q*e[d]/Z)`.
4. Center coefficient is the exact remainder `Q-2*sum(sideWeights)`.

The compiled integer coefficients define the native kernel. It is a symmetric, three-sigma-truncated, quantized Gaussian, not a continuous infinite-support Gaussian or a Sharp byte-equivalence promise. The kernel sums exactly to Q. Its center stays positive: `Q/Z-r >= 65536/301-150 > 67`, because paired side rounding shifts the center by at most r. A tiny positive sigma can have center Q and every side zero. Any implementation must validate finite bounded sigma before compilation and assert nonnegative coefficients/exact sum before using typed arrays.

Use edge replication: a sample beyond a source edge addresses the nearest source pixel, on both axes. With `k` the compiled weights, for each output pixel:

```
D = sum_i sum_j k[i]*k[j]*A(clamped neighbor)
N_c = sum_i sum_j k[i]*k[j]*A(clamped neighbor)*C_c(clamped neighbor)

blur candidate channel    = halfUpClamp(N_c / D)
sharpen candidate channel = halfUpClamp((2*C_c*D - N_c) / D)
```

The sharpen residual is rounded once, after the full signed numerator. Do not first round the blurred RGB and then subtract it. Clamp below zero and above 255 before the interior integer quotient. D is positive whenever the original output alpha is positive, because the center coefficient is positive. Zero-alpha output pixels are copied without division.

Horizontal intermediates are exact integers: RGB ≤ `65025*65536 = 4,261,478,400 < 2^32`, alpha ≤ `255*65536 = 16,711,680`. Store all four in Uint32. Vertical RGB sums are ≤ `65025*65536^2 = 279,280,248,422,400 < 2^48`; D ≤ `255*65536^2 < 2^40`. Every multiply/add is an exactly representable integer in binary64. The signed unsharp numerator remains within ±2^49 before clamping.

For `0<N<255D`, implement exact half-up byte rounding as `floor((2*N+D)/(2*D))`. Both integer operands are exact: numerator <2^49, denominator <2^41, quotient <256. A noninteger quotient is at least `1/(2D)` away from an integer boundary, more than 32 times the maximum binary64 division rounding error here. Integer quotients are themselves exactly representable. Therefore floor cannot cross a boundary; no epsilon or per-pixel BigInt fallback is required. Independent BigInt tests must pin negative sharpen values, saturation and exact half ties.

## Rolling cache and lifecycle

Maintain horizontal results only for the vertical neighborhood: `Hc=min(sourceHeight,K)` rows, each containing four Uint32 values per pixel. A source row uses slot `row % Hc`, with an Int32 row tag. Each horizontal source row is computed once during monotonically increasing output rows. The required row interval contains at most K distinct rows, so modulo eviction cannot overwrite a currently needed row. Replicated edge rows reuse the same slot.

Typed storage for one entry, excluding its returned candidate, is:

```
R = 16*sourceWidth*min(sourceHeight,K)  // horizontal RGBA sums
    + 4*min(sourceHeight,K)           // row tags
    + 4*K                            // vertical row base indices
    + 4*K                            // kernel weights
```

At source width8192 and sigma50 with sufficient height, this is about39.5 MB, rather than a full32-byte-per-source-pixel floating image. Do not allocate full horizontal images, separate floating numerator planes or four Sharp pipelines. The routine owns one `4*S` candidate plus R. It returns only the candidate Buffer; no closure, result property or retained pipeline may keep the cache reachable during subsequent geometry or another entry. Avoid per-pixel arrays/objects.

Horizontal and vertical loops yield after at most `floor(65536/K)` processed pixels, across row boundaries. This bounds each uninterrupted weighted tap batch by65,536. Reserve/initialize typed storage and copy the candidate under existing native limits; this is a tap-loop responsiveness contract, not a strict timer-latency or process-RSS claim.

## Shared work and memory admission

Use a pure metadata estimator shared by graph validation, the filter evaluator and baking. It needs only dimensions, kind, value, enabled and opacity; no image read or kernel allocation is required. Existing source limits stay8192 per axis and24 MP, eight entries per layer,64 per document. Every stored definition validates even if disabled; hidden layers are included in admission.

For enabled, nonzero-opacity entries with positive value, charge:

```
work = S * (2*K + 8)
```

Two K-tap passes account for all source rows/output pixels; eight extra visits conservatively cover candidate copying, byte results and stack interpolation overhead. Coefficients do not change this estimate even if some quantize to zero. Active value0 costs one visit per source pixel, retaining conservative private-output/identity-loop overhead, and needs no spatial cache. Disabled and opacity0 entries alone cost zero. The value-zero candidate/entry interpolation may bypass explicitly; its work charge remains one. Keep structural active-state semantics separate from computational bypass. Existing unrelated filter weights do not change. Sum all work against the existing384-million budget.

Illustrative maximum source pixels for one positive entry, before other dimension/memory/stack restrictions:

| Sigma | K | Weight | One-entry work ceiling |
| --- | --- | --- | --- |
| 1 | 7 | 22 | 17,454,545 pixels |
| 3 | 19 | 46 | 8,347,826 pixels |
| 10 | 61 | 130 | 2,953,846 pixels |
| 50 (blur) | 301 | 610 | 629,508 pixels |

Do not advertise all24 MP images at all radii. Partial value/enabled/opacity updates and recipe staging must revalidate cumulative work before publication. A client should surface the existing precise limit error, rather than silently reducing sigma or switching algorithms.

Let S be source pixels, L the largest retained source/geometry stage, N canvas pixels, and Rmax the maximum active spatial cache for that layer. Replace the existing extra filter scratch `8L+N` with:

```
filter extra scratch = max(8*L, 8*S + Rmax) + N
```

The `8*S+Rmax` phase owns mutable stack output, candidate and cache; geometry instead owns its existing extra frames and no cache. Add existing retained group/clipping scratch and the positioned-mask callback reserve exactly as today, under the same256 MiB named-buffer cap. Take the maximum over sequential entries; do not sum their caches or blindly add a large cache to an already-larger geometry phase.

Baking must pass the actual stack to its estimator. Its source materializer retains original working RGBA, optional alpha, effective input, mutable output and candidate while the cache exists. Revise only that phase:

```
filter bake phase = Ew + Ea + (hasAlpha ? 17 : 12)*S + Rmax + 64 KiB
```

Other bake phases stay unchanged: decode E+9S/4S, encode E+8S+P, publication E+4S+2P, same P/private-file/bounded-descriptor/rollback contract. The64 KiB reserve remains conservative for existing histogram/auxiliary work; explicitly included cache vectors are not omitted because that reserve exists. Plan before decoded inputs or candidate/cache allocation. Disabled/zero-only entries preserve prior lower-cost estimates.

These are named reachable-buffer/work limits, not total engine memory or RSS. Existing decoded source/native codec ownership remains as declared by the renderer and bake design. Resource fixtures must test cache-versus-geometry phase maxima, sequential versus cumulative entries, large-width/small-height sources, hidden nodes, source alpha, positioned callback coexistence and metadata-only admission failures without allocating the rejected surfaces.

## Integration boundaries

The production helper lives separately from global `spatialAdjustment` in `server/source-spatial-filters.mjs`. It exports `SOURCE_SPATIAL_FILTER_KINDS`, `SOURCE_SPATIAL_POLICY`, shared `MAX_SOURCE_FILTER_WORK`, allocation-free `sourceSpatialPlan(entry,width,height)`, `compileSourceGaussian(sigma)` and asynchronous `sourceSpatialCandidate(input,width,height,entry)`. The candidate entry point also enforces its own single-entry work limit. `layerFilterSpatialCacheBytes` selects the maximum active cache in a normalized stack. The existing stack invokes the new helper only for source `blur`/`sharpen`, then applies the same entry opacity/order/alpha rules as other candidates. Global `applyAdjustment`, global Sharp floors and LAB sharpen are unchanged.

Update source-filter kind/range validation, capability count, source-filter UI labels, shared schemas, filter-work and scratch admission, bake estimator, and discovery assertions. Existing recipe `add_layer_filter` steps must accept and preserve the two kinds through their strict allowlist, default normalization, validation, portability and cumulative-resource checks. `update_adjustment` recipe steps keep the existing global semantics. No assets are produced during recipe validation/application; baking remains explicit and outside the recipe allowlist.

Native bundles already validate stack kinds before image reads; old versions reject blur/sharpen stack entries because those were excluded. No silently ignored graph property or project-container migration is needed. PSD keeps rejecting every nonempty filter stack; an explicitly baked grade may become exportable under all existing rules. Existing source filters, global adjustments, brushes, outside-effect Gaussian blurs, masks and morphology keep their pixels unchanged.

## Feasibility evidence and remaining gate

`test-results/spatial-filters-evaluation/probe.mjs` is a test-only rolling-cache prototype. Eighty small cases match an independent naive two-dimensional BigInt implementation for blur and single-round sharpen, including one-pixel axes, odd rectangles, subnormal/tiny sigma, soft alpha and random colors. Each also proves constant colors at mixed alpha0/1/128/255 remain exact. About4,970 sigma samples verify kernel symmetry, positivity and exact sum through50.

The latest report records Node22.14.0 on Apple M5 Max/darwin arm64. Representative timings, not performance guarantees:

| Input and sigma | Time | Maximum5 ms heartbeat gap |
| --- | --- | --- |
| 1024² mixed alpha, blur1 | 57 ms | 5.12 ms |
| 1024² mixed alpha, blur3 | 110 ms | 5.13 ms |
| 1024² mixed alpha, sharpen10 | 358 ms | 5.17 ms |
| 1024² opaque, sharpen10 | 369 ms | 5.16 ms |
| 1024×512 opaque, blur50 | 870 ms | 5.20 ms |
| 8192×64 mixed alpha, sharpen10 | 177 ms | 5.15 ms |
| 64×8192 mixed alpha, sharpen10 | 169 ms | 5.14 ms |

Sigma50 uses half a megapixel because one megapixel exceeds the proposed work ceiling; no benchmark bypass is advertised as admitted production support. Mixed-alpha fixtures contain25% zero-alpha samples; the opaque cases exercise full visible output work. These runs include loop yields and candidate/cache allocation, not native decoding, stack interpolation, rendering or baking.

Independent review reports204,288 near-boundary ratio checks,256 full blur/unsharp cases and256 hidden-color perturbation comparisons, updated for the final authored-sigma contract including subnormal/.001/.1 cases. Its arithmetic and cache-lifetime/phase-accounting review found no blocker; see `SPATIAL_FILTER_REVIEW.md`.

The production owner suite adds eight tests for numerical/source invariants, zero/opacity order, a combined268MB group boundary that passes without the ring, actual stack-aware bake refusal before descriptor reads, separate-alpha masked/transformed bake equality, legacy global pixels and weighted-loop yields. The independent10 tests include the exact sigma.3977 half-tie fixture, full protection/group/clipping previews, combined positioned-mask callback admission, source bake boundary, persistence and malformed portable definitions. The two schemas and actual MCP test add typed recipes, stable retry, source/mask preview, portability and source-byte proof. Combined owner/audit/schema/MCP plus established filter/bake/recipe suites pass66/66.

`production-benchmark.mjs` and `production-report.json` run the actual exported candidate three times per fixture. On the same machine, median1MP blur sigma1/3 is49/109ms, sharpen sigma10 is354ms mixed-alpha or471ms opaque; opaque half-MP blur sigma50 is1,037ms. Wide8192×64 and tall64×8192 sharpen10 medians are201/191ms. The largest observed5ms-heartbeat gap across these runs is6.32ms. These measurements cover the candidate/cache, not decoding/composition/bake; they are evidence for the admitted tap policy, not hard runtime guarantees. Full-suite and browser release evidence are recorded by their owners.

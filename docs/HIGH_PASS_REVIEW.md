# Independent review: source High Pass

Production source and independent native audit verified, 2026-09-19. The approved [HIGH_PASS_DESIGN.md](HIGH_PASS_DESIGN.md) is implemented using the existing Gaussian ring, exact byte arithmetic and retained source-filter boundaries. This review changed only independent tests and documentation; the backend owner implemented production changes.

## Contract and source-stage meaning

Use source-only `high_pass` with a required finite scalar `value` meaning sigma0–50 source pixels. Preserve true positive/subnormal values; no minimum radius or silent rounding. The independent policy `alpha-weighted-residual-128-v1`, source coordinates and advertised kind are sufficient for Normal. Nonnormal additionally needs the existing filter-blend policy/mode; neither the older Gaussian marker nor another specialized filter policy is a substitute. Source kinds become27; global kinds remain24.

Public scalar commands omit `parameters` and follow their existing strict convention. Native scalar normalization may continue accepting empty `{}` and canonicalizing it away, while rejecting nonempty parameters. No broad tightening or global color dispatch change is needed. Unknown persisted kinds already fail closed in older readers; no migration or reinterpretation of an old kind is justified.

The candidate uses the current stack RGB and effective source alpha after source-cutout combination, before additional masks, mask position/density, selections, geometry and compositing. Fully transparent RGB and every alpha byte remain exact. Positive-alpha neighbors contribute according to the existing alpha-weighted kernel. Hidden RGB cannot bleed into visible detail. This is an encoded RGB detail map; it does not promise neutral hue, zero mean after clipping/rounding, perceptual luminance preservation or Photoshop numerical equivalence.

Sigma0 must produce RGB128 at every positive-alpha source pixel. This is a real candidate, not the input identity. It requires an owned candidate and a bounded gray-fill pass, although it requires no Gaussian kernel/ring. A tiny positive center-only kernel produces the same gray result while retaining conservative positive-sigma work/cache. Constant colors, including soft-alpha content with zero-alpha holes, also produce128 at all positive-alpha locations.

## Exact residual and half-up proof

Retain the existing symmetric Q65536 kernel, radius `ceil(3*sigma)` and replicated-edge sampling. Let `N` be the exact weighted RGB sum, `D` the exact weighted alpha sum and `C` the current byte. Compute the candidate in one step:

```text
U = (128 + C)*D - N
H = halfUp(clamp(U, 0, 255D) / D)
```

Do not subtract an already-quantized blurred byte. For sigma.3977, the compiled kernel is `[0,2560,60416,2560,0]`. Opaque input80/144 blurs to82.5/141.5. The correct High Pass values are126/131, from125.5/130.5. Pre-rounding the blur instead gives125/130. This is an actual reachable image fixture, not only synthetic arithmetic.

All Number integers remain exact: horizontal RGB totals fit Uint32, vertical `D≤255*65536²<2^40`, `N≤255D`, and raw `U` lies in `[-127D,383D]`. The largest product `(128+C)D` is below2^49. After clamping, compute `floor((2U+D)/(2D))`; its numerator is at most511D<2^49 and denominator below2^41. A noninteger exact quotient lies more than2^-41 from an integer floor boundary, versus at most2^-46 binary64 division rounding error below256. The margin exceeds32, so flooring cannot cross a boundary. No epsilon or per-pixel BigInt fallback is needed. The positive center coefficient and positive current alpha guarantee `D>0`.

The resulting candidate byte must then enter the already-defined filter blend and opacity stages. Do not combine the unrounded residual algebraically with filter opacity or a subsequent mode: clipping/quantization at the candidate boundary is intentional. Normal, rational modes and native floating modes preserve their released definitions.

## Gray128 and mode neutrality

Byte128 differs from exact normalized0.5, but the practical result depends on the selected mode. For Overlay with candidate128, the positive pre-round channel change is at most127/255, strictly below half a byte. For Soft Light, it is at most0.25 byte. Multiplication by opacity in[0,1] cannot enlarge either bound. Therefore both modes preserve every backdrop byte after final rounding at every allowed opacity. The independent probe checks all256 bytes at seven opacities, including a neighboring binary64 value.

This does not mean all blend functions have a neutral128 center. At full opacity, Hard Light changes the lower128 backdrop values by one; Linear Light changes all255 values below255; Vivid Light changes128 values. Multiply and Screen can change colors substantially. Keep the center128 fixed across modes and preserve released blend algorithms. Do not add a127.5 special case or imply exact equality of unrounded Overlay/Soft Light formulas.

For UI creation, sigma1/Normal is coherent: the user first sees the detail map and explicitly chooses an available blend. Sigma0 guidance should say that Normal produces gray128 on nontransparent source pixels; Overlay/Soft Light preserve byte colors, while other modes can change them. An active zero-sigma entry remains structurally active even when its final Overlay output happens to be unchanged. Protection, source-edit, Bake-prefix and PSD restrictions do not gain an identity exemption.

## Work, lifetime and caller invariants

Reuse the separable Gaussian ring to write residuals directly into one4S candidate. Do not allocate a blurred full image and a second residual image. For positive sigma, the existing cache is `16*w*min(h,K)+4*min(h,K)+8*K` bytes, with K=`2*ceil(3*sigma)+1`; candidate work is `(2K+8)S`. Sigma0 costs1S, cache0 and `computesCandidate:true`. Disabled/opacity0 costs0 and builds no candidate, after metadata validation. Every nonnormal mode retains the40S surcharge.

The existing384-million work limit and retained graph/Bake phases suffice. At sigma1, weights22/62 admit at most17,454,545 /6,193,548 source pixels for Normal/nonnormal before other constraints. Sigma0 nonnormal costs41S, retaining the9,365,853 ceiling. Do not lower work because a kernel quantizes to identity or a blend happens to yield the original bytes.

The renderer retains the maximum source candidate/ring or later geometry phase, plus group/clipping/positioned-mask reserves and an unrelated live Gaussian-noise table. Bake counts the same ring once with its17S/12S source phase. Sigma0 still allocates a candidate, already covered by that reserve. No new persistent table or image plane is needed; these are named-buffer limits, not whole-process RSS guarantees.

Positive traversal keeps the existing at-most65,536-tap yield count. Zero-sigma gray fill counts all visited pixels, including alpha0, and yields within65,536 pixels. The later nonnormal stage retains16,384-pixel batches and stricter existing color yields. Normal interpolation keeps its current policy.

Production must specifically avoid the current zero-setting shortcut: the spatial plan and candidate must report sigma0 High Pass as computing, while preserving blur/sharpen/Unsharp/Noise semantics. Source-only normalization, global rejection, recipe canonicalization, hidden work activation, source-stage maximum geometry, original protected context, generated exclusions and exact Bake all need actual caller tests. Parameter/value/mode activation must fail before later transaction pixel I/O; invalid portable definitions before asset reads; recipe validation remains metadata-only. Real persistence/late-transaction rollback and unchanged old filter/global outputs remain acceptance gates.

## Independent probe evidence

`test-results/high-pass-review/probe.mjs` compares the owner's test-only ring against independently accumulated2D BigInt sums with separately compiled coefficients and merged replicated-edge addresses. Its report records:

- 80 full tiny-image cases across sigma0, subnormal, .001, .1, .3977, .528474,1,2.125,10 and50, with alpha0/1/128/255 and hidden-color perturbations.
- 12 constant-color/soft-alpha cases, preserving hidden RGB while producing exact gray128 on positive alpha.
- 100,492 random/boundary integer residual checks against BigInt, including maximum denominators and half/clamp neighbors.
- The exact126/131 two-pixel half-tie fixture and the distinct incorrect pre-rounded-blur result.
- All-byte midpoint interaction counts and Overlay/Soft Light neutrality at seven opacities.
- Sigma0 planning as a real no-ring candidate, bypass planning, caller-buffer ownership and an8192-wide yielding check.

All pass. The owner's separate benchmark report, inspected during review, measures approximately3.5ms for1MP sigma0,47.6/117.8/362.5ms for1MP sigma1/3/10,966ms for768² sigma50,65ms for24MP sigma0 and929ms for8.192MP sigma3. Explicit1MP sigma1 Overlay/Soft Light/Hue probes take105/150/303ms; the largest observed heartbeat gap is10.30ms. These are test-only local candidate/blend measurements, excluding decode, full composition and encoding. They support the existing spatial weights rather than a new universal latency promise.

## Production audit evidence

`tests/high-pass-audit.test.mjs` passes all nine independent checks against the actual helper, layer-filter pipeline and native mutation paths. The source spatial, filter-blend and color-mixer independent audit suites also pass all 28 adjacent checks. The source discovery assertion now expects27 filters; global adjustment discovery remains24.

- A separately compiled kernel and direct2D BigInt accumulation verify60 deterministic mixed-alpha source images,12 constant-color cases, hidden-color exclusion and the reachable126/131 half-tie fixture. The production candidate and stack both match; caller buffers remain unchanged.
- Sigma0 is an owned real gray candidate with work1S/cache0. All256 backdrop bytes at seven opacities retain exact Overlay/Soft Light results; Linear Light demonstrates the different midpoint behavior. Disabled/zero-opacity entries bypass computation, and the nonnormal40S surcharge remains active otherwise. Wide zero/subnormal cases verify yielding and hidden-RGB preservation.
- Source-cutout alpha is combined before multiple High Pass, scalar and nonnormal stages. Exact Bake comparisons cover original working alpha, source assets, affine geometry, positioned/feathered/inverted masks with density, isolated groups and clipping. Original-context protected restoration and generated-member suppression remain correct in both composites and previews.
- Hidden earlier protected content still refuses active Bake before pixel access, including sigma0 Overlay whose final bytes would be unchanged. Protected target mutation remains blocked.
- The graph resource fixture retains two isolated groups, a clipping chain, source-sized positioned masks and a Gaussian-noise table on another leaf. The baseline is267,987,008 named bytes; a393,252-byte tiny-sigma ring fits, while a917,588-byte sigma1 ring exceeds256MiB. Both standalone activation and activation before a later transaction rasterization reject without image reads or asset writes. A separate Bake phase boundary verifies source-alpha buffers, ring accounting and the4096-byte shared table in every phase.
- Cumulative recipe validation rejects the second nonnormal source filter before any pixel or file I/O; accepted sigma0 recipes remain metadata-only. Hidden and disabled activation cases retain the same work admission rules.
- Real ENOTDIR persistence failure and a late failing mixed transaction preserve graph, history, caches and asset bytes after attempted metadata changes or Bake. Malformed disabled High Pass values/parameters in portable definitions reject before asset reads. Native empty parameters canonicalize away; global High Pass remains rejected.

No production arithmetic, caller, resource or rollback blocker was found. Browser/UI acceptance is separate and is not implied by these native checks.

## Client source review

The implemented `source-spatial-filters.ts`, `HighPassGuidance.tsx`, `LayerFilters.tsx`, API capability field and recipe support/context paths were reviewed after the client's first successful build. High Pass uses its own exact policy marker and scalar sigma parser, without requiring the older spatial policy. Its default is1/Normal, typed subnormal values remain numeric values without slider quantization, and commands omit parameters. Guidance explicitly separates a sigma0 gray candidate from a bypass; global controls remain unchanged.

The High Pass marker participates in filter submission, whole-stack and recipe validation identities. Existing draft keys exclude capability changes, preserving withdrawn settings while gating submission. Saved unsupported entries remain visible; authored commands and recipe execution still require support. Existing per-filter and whole-stack response guards, including reorder/delete, remain intact. No new source-level client defect was identified. The UI owner subsequently reports8 focused and55 adjacent browser workflows passing, plus build, including exact BigInt exports/Bake, all-byte midpoint behavior, delayed lifecycle cases and subnormal/disabled-only recipe capability checks. See [HIGH_PASS_UI_DESIGN.md](HIGH_PASS_UI_DESIGN.md) for the owner's executed browser evidence; this source review did not independently rerun those journeys.

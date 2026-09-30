# Source High Pass

Native backend implemented and verified, 2026-09-19. Root and independent review accepted the exact residual, sigma0 gray candidate and existing resource policy before implementation. The owner suite passes8/8, the independent audit passes9/9 and the adjacent owned backend suites pass63/63. Transport and browser release evidence is maintained by their respective owners. The existing filter-blend stage supplies candidate blending; this adds one source-only candidate kind and retains all previous filter/global algorithms.

High Pass exposes local RGB detail around a gray center. It is useful as an editable edge/detail stage followed by an explicit Overlay or Soft Light filter blend. Adobe's [filter reference](https://helpx.adobe.com/photoshop/using/filter-effects-reference.html#other_filters) describes retaining edges while suppressing low-frequency content. That is a workflow reference; the bounded alpha-weighted Gaussian, byte128 center, source coordinates and exact rounding here are Prism's own algorithm, with no Adobe pixel-parity claim.

## Public contract and discovery

Add the scalar source-filter kind `high_pass` through the existing commands:

```js
add_layer_filter({
  documentId, expectedRevision, layerId,
  kind: 'high_pass', value: 1,
  enabled: true, opacity: 1
})
```

`value` is required and means finite Gaussian sigma in source pixels, in[0,50]. Every positive finite value is used as authored, including subnormals; no minimum0.3 floor or silent rounding is introduced. The public scalar family omits `parameters` and rejects `{}`/unknown parameters consistently with other public scalar kinds. Native normalization may retain the existing scalar tolerance of empty `{}` canonicalizing to omission. No amount, threshold, separate center, contrast or channel controls are added in this slice.

UI creation default is sigma1, enabled, opacity1, Normal blending. Choosing another blend is explicit; creating High Pass must not silently set Overlay or discard an existing mode. Stored values have no omitted-sigma default. Partial value updates preserve current opacity/enabled/blend; recipes retain an exact scalar value and canonical blend setting.

Independent capability:

```js
layerFilterHighPassPolicy: 'alpha-weighted-residual-128-v1'
```

Authoring/execution requires source filter coordinates, kind `high_pass` and that exact marker. It does not require the earlier Gaussian/Unsharp/Noise markers. Nonnormal blending additionally requires the existing exact blend policy and supported mode. Recipe capture/import/save remains definition-only; Validate/Apply checks executable capabilities. Unsupported stored entries remain visible for explicit deletion/Bake/Clear under their own capabilities, with no silent fallback.

Source kinds become27; global `ADJUSTMENTS` and global parameter families remain24. This is a scalar source family, so it must not enter global `add_adjustment`, adjustment recipe slots or global renderer switches. Existing readers reject unknown filter kinds, giving a fail-closed portable compatibility boundary without a version migration. No new commands, asset roles, packages or provider calls are needed.

## Candidate arithmetic

For positive sigma, reuse the existing quantized source Gaussian kernel and replicated-edge policy exactly. Let Q=65536, radius r=ceil(3*sigma), K=2r+1. Symmetric nonnegative side weights are independently rounded from the authored Gaussian, with the center equal to Q minus their symmetric sum. Tiny positive sigma can underflow side coefficients to zero and yield a center-only kernel. The center remains strictly positive for every admitted sigma.

For each source pixel with positive effective alpha, the existing separable ring yields exact integer weighted channel sum N and alpha sum D. This includes source-cutout alpha before filtering. The high-pass candidate for original current-stage channel C is:

```text
M = (128 + C) * D - N
H = clampByteHalfUp(M / D)
```

Do not compute an already-rounded blur and subtract it. For the independently reproducible sigma0.3977 kernel `[0,2560,60416,2560,0]`, opaque two-pixel grayscale input80/144 has exact blurred values82.5/141.5. High Pass returns126/131 from125.5/130.5. Subtracting the rounded blur would produce125/130, losing one byte on both pixels.

Bounds are unchanged in scale from fixed source sharpen: `D<=255*Q²<2^40`, `N<=255*D`, and `M` lies in[-127D,383D]. The integer product `(128+C)*D` and subtraction are exact below2^49. After clamping M into[0,255D], compute `floor((2*M+D)/(2*D))`. The doubled numerator is at most511D<2^49 and denominator2D<2^41. A noninteger quotient is more than2^-41 from a floor boundary, whereas the maximum binary64 division half-ULP below256 is2^-46. The margin exceeds32times the rounding error, so this gives exact mathematical half-up bytes without epsilon or runtime BigInt. Positive source alpha and the positive center guarantee D>0.

At sigma0, the candidate is exactly RGB[128,128,128] at every positive-alpha source pixel. Implement a bounded copy/fill pass without a Gaussian ring. This is **not an identity candidate** and must never use the blur/sharpen/Unsharp/Noise zero-setting shortcut. A tiny positive center-only kernel also produces128 exactly but retains its current conservative positive-sigma ring/work policy. A spatially constant color with any positive constant alpha produces128 for every sigma; differing RGB hidden under alpha0 cannot contaminate visible neighbors.

Source alpha remains byte-for-byte unchanged, and alpha0 RGB remains the input RGB. Alpha1 and alpha128 must not acquire the low-alpha darkening of an unpremultiply/uchar blur. No float image planes or Sharp blur are used. The working color pipeline remains encoded sRGB8; no profile conversion or new color-space claim is introduced.

## Blending, opacity and the midpoint

H is quantized/clamped once by the formula above, then enters the existing per-filter blend stage against current source RGB C. Entry opacity is applied only after that blend, with the established Normal or exact rational/native floating blend policy. Changing opacity is not equivalent to scaling the unrounded residual before candidate clipping and rounding. Filters earlier in the stack define C; later filters consume the blended byte result.

Byte128 is not the exact normalized midpoint0.5. State this precisely without changing any existing blend formula. With a flat candidate128, current Overlay has a pre-round positive delta at most127/255<0.5, while Soft Light's delta is at most0.25. Thus **both Overlay and Soft Light preserve all256 backdrop bytes after final rounding at every entry opacity in[0,1]**. This is a useful byte-output property, not exact equality of the unrounded blend values.

Do not generalize that neutrality to all modes. At full opacity, flat128 Hard Light raises the lower128 backdrop values by one; Linear Light raises every value below255 by one; Vivid Light changes128 values. Multiply/Screen can change the image strongly. Pin these examples and the Overlay/Soft Light all-byte ramp in tests. Do not secretly use127.5, change the residual center by mode, or tune the already released blend helper.

Selection, own/ancestor additional masks and mask position/density, layer opacity, layer blend mode, groups, clipping and outside effects remain document-space stages after this source stack. High Pass samples the source working RGB and effective alpha, not a masked/composited preview. Source preview continues to ignore the stack, and immutable source bytes remain retained.

## Metadata, work and memory

Reuse the source spatial helper rather than producing a complete blurred RGBA image and then a second High Pass image. The ring can write its exact residual directly into the one existing4S candidate, where S is source pixels. Only this candidate escapes the function. Horizontal sums remain Uint32 (4planes per cached row), vertical totals remain exact Number integers, and no additional full image plane or persistent table is needed.

For enabled, positive-opacity High Pass:

| Sigma | Candidate computation | Base work | Gaussian cache |
| --- | --- | ---: | --- |
|0 | Copy alpha/hidden RGB and fill positive-alpha RGB128 |1*S |0 |
|positive | Exact weighted residual from the existing ring |`S*(2*K+8)` |`16*width*min(height,K)+4*min(height,K)+8*K` bytes |

Disabled or opacity0 costs0 and constructs no candidate. Validate dimensions/sigma/parameters/mode even in bypass states. Sigma0 is still structurally active and prevents protecting the target just like any active filter. Its metadata `computesCandidate` must be true while active, although its Gaussian cache is zero; do not equate “no ring” with “no candidate.”

Every nonnormal mode adds the existing40*S. Document-wide384million work includes hidden layers. At sigma1, base weight22 permits at most17,454,545 source pixels under Normal or6,193,548 with another mode (weight62). Sigma3 uses46/86, admitting8,347,826 /4,465,116 pixels. Sigma50 uses610/650, admitting629,508 /590,769 pixels. Sigma0 Normal retains the24MP source bound; a nonnormal mode costs41S and admits9,365,853 pixels. These ceilings precede other graph/memory limits and are not universal image-size promises. No automatic sigma reduction or approximation follows a refusal.

The existing renderer reserve remains `max(8*largestGeometryPixels,8*S+Rmax)+canvasPixels`, retained group/clipping surfaces, positioned-mask callback reserve and any unrelated persistent Gaussian-noise table. Rmax includes the actual High Pass ring for positive sigma, never a duplicate ring+blur plane. Sigma0 still fits the existing candidate allocation envelope. Bake's actual-stack phase estimator likewise includes this ring once in its17S/12S materialization phase; no surface multiplier changes. Compile scalar blend opacity before candidate construction as already implemented. These named binary-buffer bounds are not total RSS/native codec/GC limits.

Positive-sigma horizontal/vertical traversal retains the existing at-most65,536-tap yield chunks. The sigma0 fill pass yields within65,536 source pixels, including skipped alpha0. The later Normal blend loop retains its current row policy; nonnormal loops retain the minimum existing color bound and16,384-pixel rows. Initial copies/allocations and scheduling are not hard deadlines.

## Integration and preservation

Extend the source-only kind/range and scalar schema/recipe seams, source spatial kind list/plan/candidate, source work computation, capability forwarding, client source-only control and descriptions. Do not add the kind to global adjustment tables. The candidate's positive/zero paths must bypass the existing “identity candidate” skip while preserving the old paths for blur, sharpen, Unsharp and Noise exactly.

Mode/value/enabled/opacity edits revalidate work and combined ring/group/clipping/positioned-mask resources before later transaction pixel operations. Recipe Validate/Apply reuses metadata staging and never renders or publishes assets. Malformed portable High Pass records, disabled bad sigma and excessive hidden work must reject before image reads. Native direct callers and public schemas retain their existing scalar strictness convention.

Rendering, layer preview, protected lower-context restoration, generated-footprint exclusion, source geometry and explicit source filter Bake share the same candidate. Protecting a layer with an active High Pass still rejects, including sigma0. Earlier protected-content Bake guards stay unchanged. Bake restores original working alpha, keeps separate source-alpha and all masks/transforms/styles/provenance/original sourceAsset, and uses its full-interval asset ownership rollback. Newly revealed effective-alpha-zero RGB was never filtered and stays original, as for the other source filters. Nonempty stacks still require explicit Bake/Clear for editable PSD output and existing raster editing operations.

Required acceptance covers independent2D BigInt kernels/results, exact half ties/clamps, sigma0/subnormal/50, edge replication, alpha0/1/128/255 and hidden-color perturbation, constant images, all26 blend modes and midpoint caveats, opacity after candidate rounding, source dimensions/retained geometry, stable recipes/seeds/profiles, original protected/generated/group/clipping context, resource boundary activation before reads, no metadata I/O, exact source-space Bake, undo/redo/reopen/portable/idempotency and real persistence rollback. Existing global blur/sharpen and all older Normal filter pixels remain regression fixtures.

## Probe evidence

The test-only prototype is `test-results/high-pass-evaluation/prototype.mjs`, exporting `planHighPass` and `highPassCandidate`. It uses the existing kernel compiler and a copied ring traversal that directly writes the residual; it does not edit production. The independent owner oracle constructs its own coefficient array and accumulates2D BigInt sums, independently of the separable ring. `probe.mjs` checks seeded small images, all alpha levels, hidden-color independence, midpoint ramp behavior, the125.5/130.5 tie fixture and120,000 arbitrary integer residual cases.

Owner probes pass347 complete image checks, including hidden-color perturbations and constant alpha1/128/255, plus120,000 exact BigInt residual comparisons. The independent review adds80 small complete2D BigInt image cases,12 constant/soft-alpha cases and100,492 integer-rounding boundary/random cases; it also verifies sigma0 wide yielding and all256 midpoint values at seven opacities. All pass. The independent counts and oracle are recorded in `test-results/high-pass-review/report.json`.

Three-run candidate medians on Node22.14.0, Darwin arm64, Apple M5 Max:

| Source dimensions | Sigma / subsequent mode | Base work weight | Median time |
| --- | --- | ---: | ---: |
|1024² |0 / Normal |1 |3.5ms |
|1024² |Number.MIN_VALUE / Normal |14 |27.7ms |
|1024² |.001 / Normal |14 |27.4ms |
|1024² |1 / Normal |22 |47.6ms |
|1024² |3 / Normal |46 |117.9ms |
|1024² |10 / Normal |130 |362.5ms |
|768² |50 / Normal |610 |966.2ms |
|8192×128 /128×8192 |1 / Normal |22 |47.6 /48.4ms |
|1024² |1 / Overlay |22+40 |105.2ms |
|1024² |1 / Soft Light |22+40 |150.1ms |
|1024² |1 / Hue |22+40 |302.8ms |
|6000×4000 |0 / Normal |1 |65.2ms |
|8192×1000 |3 / Normal |46 |929.1ms |

The8.192MP sigma3 case uses376.832million work and2,490,596 Gaussian-cache bytes, both within the accepted policy. The largest observed5ms heartbeat gap is10.30ms, during Hue; the large zero/positive-sigma cases peak at5.75/6.45ms. Normal rows here measure candidate construction, while nonnormal rows also include the explicit blend pass. File decoding, the Normal stack opacity loop, full compositor and PNG encoding are excluded. These prototype measurements supported the existing2K+8 / zero-pass1 weights and unchanged nonnormal+40; they are not real-time guarantees.

## Production evidence

Implementation is in `server/source-spatial-filters.mjs`, the source range/work integration in `server/layer-filters.mjs`, and native capability/limitation reporting. Positive sigma reuses the released ring; the zero branch constructs gray128 with bounded yielding. It adds no Gaussian output plane, persistent table, dependency or generated external asset. Existing renderer and Bake estimators consume the same actual-stack ring plan.

`tests/high-pass.test.mjs` passes8/8, covering the independent2D BigInt oracle and exact ties, all26 blend modes, strict source-only metadata and recipes under no-I/O spies, zero/positive work and ring accounting, source-alpha preservation, positioned masks and geometry, exact Bake, protected targets, real persistence/asset rollback, and wide yielding. `tests/high-pass-audit.test.mjs` independently passes9/9, including original protected/generated context and two pre-read boundaries: the combined group/clipping/retained-mask/ring/shared-noise-table peak and source Bake admission. The seven adjacent owned filter/color/Bake suites pass63/63, including all27 source kinds against all26 filter blend modes and the all27-kind Bake loop. The independent reviewer also reports28 adjacent audit cases passing.

`test-results/high-pass-evaluation/production-probe.mjs` runs the actual `applyLayerFilters` evaluator, including candidate construction, output copying, Normal opacity and nonnormal blending. All24 comparisons against the reviewed prototype pass. Three-run medians on the same Node22.14.0 / Darwin arm64 / Apple M5 Max environment are saved in `production-report.json`:

| Source dimensions | Sigma / blend mode | Median time |
| --- | --- | ---: |
|1024² |0 / Normal |14.46ms |
|1024² |Number.MIN_VALUE / Normal |33.74ms |
|1024² |.001 / Normal |33.68ms |
|1024² |1 / Normal |53.33ms |
|1024² |3 / Normal |121.61ms |
|1024² |10 / Normal |359.91ms |
|768² |50 / Normal |916.39ms |
|8192×128 /128×8192 |1 / Normal |52.50 /56.73ms |
|1024² |1 / Overlay |100.32ms |
|1024² |1 / Soft Light |141.35ms |
|1024² |1 / Hue |280.69ms |
|6000×4000 |0 / Normal |247.00ms |
|8192×1000 |3 / Normal |1062.62ms |

The largest observed5ms heartbeat gap is14.36ms in the24MP zero-sigma workload; the8.192MP sigma3 case peaks at6.35ms. These measurements include the integrated source evaluator but exclude source decoding, the full document compositor and PNG encoding. They confirm the accepted work/cache policy without promising a hard latency deadline or total process-memory bound. Owner logs are `owner-tests.log` and `adjacent-tests.log` in the same evaluation directory; maintained tests and the independent review remain the reproducible acceptance sources.

# Independent source Unsharp Mask feasibility review

Production source and native integration independently verified, 2026-09-19. The nine checks in `tests/unsharp-mask-audit.test.mjs` pass against the implemented helpers and native commands. The preceding Gaussian-source and color audit suites also pass together (19 checks), with source discovery updated to 25 and global adjustments retained at 24. No numerical, resource-lifetime or native integration blocker remains. UI source review is complete. The UI owner reports eight focused browser workflows plus 31 adjacent workflows and the final build passing; root reports the full 814-check Node suite passing.

## Scope and parameters

Add a distinct source-filter kind `unsharp_mask`, retaining `value:0` and a canonical complete parameter object `{amount:100,sigma:1,threshold:0}`. Amount is finite 0–500 percent in canonical 0.01% increments; sigma is true finite 0–50 source pixels with no minimum floor; threshold is an integer 0–255. Unknown, wrong-family, nonfinite and finer-precision settings must reject even on disabled entries. Omitted parameters use these defaults; partial updates merge with the effective current parameters, and saved recipes materialize complete defaults independently of their eventual targets.

Adobe documents Amount, Radius and Threshold as separate controls. This proposal supplies those practical control categories but explicitly labels its neighborhood setting as Gaussian sigma. Adobe's public description does not specify this native integer kernel, RGB threshold rule, rounding or alpha handling, so it provides no numerical-equivalence evidence. [Adobe Unsharp Mask reference](https://helpx.adobe.com/photoshop/desktop/effects-filters/smart-filters/sharpen-images-with-unsharp-mask.html).

Use the already audited alpha-weighted, truncated, quantized source Gaussian. Preserve source alpha and hidden RGB exactly, combine separate source alpha before evaluating the neighborhood, and keep filters before retained geometry. Own masks/density, ancestor masks, selection, styles and clipping remain outside the sampling window. The operation sharpens RGB without expanding the cutout silhouette. Existing source `blur`, fixed-amount source `sharpen` and global Sharp/LAB adjustment paths retain their pixels and accepted settings.

Recommend an explicit **per-RGB-channel threshold**, measured against the unrounded Gaussian difference. This is easier to explain and test than an unspecified “edge” or luma threshold, and requires no extra full-image plane. Channels can cross the threshold independently, so the operation need not preserve hue. A future luminance-only variant would need a separate declared policy and gamut behavior; it must not silently replace this operation.

Amount 100%, threshold 0 and any sigma within existing sharpen's 0–10 range must be exactly equal to fixed source `sharpen`, including half ties and soft alpha. Sigma 0 and amount 0 are computational identities. With a strict threshold, threshold 255 is also a provable identity because the largest channel difference is 255; recommend the same explicit work-one/cache-zero bypass. All enabled positive-opacity identity entries remain structurally active for protection, source-edit and bake-prefix guards. Tiny positive identity kernels retain positive-sigma admission unless they fall under another explicit metadata identity.

## Exact threshold and candidate

Let `C` be the original byte, `D` the Gaussian alpha-weight denominator, and `N` its RGB numerator. Existing bounds are `D<=255*65536²<2^40` and `N<=255D<2^48`. At nonzero source alpha the center coefficient guarantees `D>0`.

Define exact integer residual `R=C*D-N`. For threshold `T`, leave a channel unchanged when `abs(R)<=T*D`; sharpen only when the difference is strictly greater. Both sides of this comparison are exact Number integers. Do not first round Gaussian RGB or use a rounded absolute difference. Equality remains unchanged, including for fractional underlying differences adjacent to an integer threshold.

Let `A=round(amount*100)` be the canonical integer hundredth-percent value, 0–50,000. The candidate before clamp is:

`C + A*R/(10000*D)`.

Round only once after the complete residual expression and byte-range clamp. Existing filter opacity then interpolates this rounded candidate with the current source RGB, as it does for other entries. Amount and filter opacity are distinct operations; opacity is not a substitute for residual amount.

The full numerator `C*D*10000+A*R` can exceed Number's safe-integer range. Do not multiply in Number and then convert the rounded result to BigInt. Exact fallback must convert the already exact `C`, `D`, `R` and `A` individually before forming its wide numerator/denominator.

## Fast exact rational branch

Reduce `A/10000` to coprime integers `p/q` once per entry. If `q<=16` and `p+q<=32`, evaluate:

`U=q*C*D+p*R`, `V=q*D`.

Every product and the signed sum are exact Number integers: their absolute worst bound is `(p+q)*255D<=8,936,967,949,516,800<2^53`. Clamp U against 0 and `255V`, then use `floor((2U+V)/(2V))`. The clamped doubled numerator is at most `511*16*D<2^53`; the divisor is less than `2^45`. A noninteger quotient is therefore more than `2^-45` from an integer boundary, while maximum division rounding error below 256 is `2^-46`. Integer quotients are representable. This proves the floor result exactly matches rational half-up rounding.

The branch includes all integer multipliers of the residual, including default 100%, and several common fractional amounts. An exhaustive metadata pass finds 70 admitted centipercent amount settings in 0–500%; the independent experiment checks 4,200 extreme-channel/denominator cases for those plans. Do not expand the shortcut merely because a particular floating result reports an integer; preserve its static safety test.

## General amount branch

Use the exact residual first: `y=C+(A/10000)*(R/D)`. This avoids subtracting a rounded Gaussian value from C before scaling. A conservative absolute floating error bound is:

`5*2^-46 + 255*2^-51 + 2*2^-43 + 2^-97`, less than `4.2e-13`.

The terms bound residual division, amount division, product/addition rounding and their cross product. Residual magnitude is at most 255, amount multiplier at most 5, and the unclamped candidate is within −1275…1530. A guard such as `64*Number.EPSILON*1530` is approximately `2.1743e-11`, over 50 times this bound. The experiment also validates a looser 4.83e-13 bound for an earlier subtract-first form; production should retain the tighter residual-first operation order without shrinking the conservative guard unnecessarily.

Outside the guard around a half integer, ordinary rounded/clamped Number output is unambiguous. Inside it, compute the exact BigInt numerator and denominator, clamp, then divide doubled integers for half-up output. Channels failing threshold or already at a clamped output need no fallback. No epsilon is added to a color. The guard controls recomputation only.

An optional base-2^26 split-product comparator was independently prototyped and passes the same oracle. It avoids BigInt but introduces custom multiword arithmetic. Prefer the simpler reduced-rational-plus-BigInt approach if its full-image worst case is acceptable; the alternative is evidence of feasibility, not a recommendation to add an additional production arithmetic engine now.

## Adversarial cases and measurements

`test-results/unsharp-review/probe.mjs` and `report.json` record:

- 250,000 seeded integer numerator/denominator/channel/amount/threshold cases, all matching an independent BigInt oracle.
- 63,037 valid targeted cases around output half boundaries, including clamp edges and maximum/adjacent denominators.
- 4,200 static exact-branch extrema over all 70 qualifying amount plans.
- 240 tiny image/parameter combinations. Default 100%/threshold 0 matches the actual current source-sharpen helper. The small reference samples the kernel independently in two dimensions and includes alpha 0/1/128/255 and subnormal sigma.

For a reachable nearly all-channel fallback image, use opaque alternating vertical RGB 80/208 columns, sigma .3977. Its kernel `[0,2560,60416,2560,0]` gives each interior pixel an exact residual of −10 or +10. Amount 5% has reduced denominator 20, outside the exact shortcut, and produces candidates 79.5/208.5. Almost every RGB channel of a wide image requires the exact fallback. The backend owner independently found another useful case: sigma .528474 with kernel `[38,8192,49076,8192,38]`, alternating RGB 20/220 and amount 37% gives residual ±50 and candidates 1.5/238.5.

The independent channel-only experiment evaluates 3,145,728 channel results with periodic yields. Recent local runs measure approximately 270–280 ms for all-tie guarded BigInt and 28 ms for its ordinary case; a split comparator measures approximately 125–130/32–40 ms. These figures exclude Gaussian traversal, source decoding, stack interpolation, rendering and baking. They are not native end-to-end performance guarantees.

The backend owner's complete test-only ring/candidate prototype is now available in `test-results/unsharp-evaluation/`. Its actual `channelByte` was additionally compared with this review's BigInt oracle for all 250,000 random and 63,037 targeted cases. Its actual image helper matches all 240 independently sampled image cases. Source inspection confirms the exact reduced numerator, residual-first approximate branch, conversion to BigInt before wide products, and unchanged ring ownership.

The owner's three-run image benchmarks on Node 22.14.0/Apple M5 Max include the Gaussian, candidate allocation and loop yields:

| Prototype fixture | Median | Observed maximum heartbeat gap |
| --- | ---: | ---: |
| 1024², default 100%, sigma 1, mixed alpha | 68.6 ms | 6.39 ms |
| 1024², generic 133.33%, sigma 1, opaque | 71.5 ms | 5.31 ms |
| 1024², all-tie 5% / 37% stripes | 155.3 / 157.9 ms | 8.34 / 5.84 ms |
| 8192×128 / 128×8192, all-tie stripes | 157.0 / 151.0 ms | 6.04 / 5.86 ms |
| 1024², generic 133.33%, sigma 10 | 548.3 ms | 5.39 ms |
| 1024×512, generic 133.33%, sigma 50 | 1272.4 ms | 5.33 ms |

The all-tie fixtures execute roughly 3.1 million exact channel fallbacks, rather than inferring worst-case behavior from ordinary photographs. These remain prototype measurements, excluding native decoding, composition, stack opacity and baking. They support proceeding with bounded native integration; they are not latency guarantees.

## Shared resources, schemas and recipes

Reuse one Gaussian ring and one RGBA candidate. There is no additional full-image RGB, luminance or blurred-output surface. Keep the source phase `max(8*largestGeometryPixels,8*sourcePixels+maxActiveRing)+canvasPixels`, with existing retained group/chain/positioned-mask reserves. Bake retains its separately declared source/alpha frames and adds the same maximum live ring. Do not accumulate ring memory across sequential entries.

Recommend uniform nonidentity work `sourcePixels*(2*K+40)` under the existing 384-million budget. The constant allowance conservatively accounts for the measured generic per-channel fallback while preserving a simple admission rule; exact-path amounts do not receive a larger admitted image merely because they happen to avoid BigInt. For example sigma 1 costs 54 visits and admits at most 7,111,111 pixels before other restrictions; sigma 50 costs 642 and admits at most 598,130 pixels. Amount 0, sigma 0 or threshold 255 costs one source-pixel visit with no ring; disabled/opacity-zero costs zero. Tiny positive identity kernels retain the normal nonidentity cost.

Metadata-only validation must recalculate work after partial amount, threshold, sigma or activation updates, including transitions out of an explicit identity. Do not permit greater work merely because ordinary photos seldom hit ties. Retain bounded yields in ring population and vertical output; periodic exact arithmetic must not defeat the existing tap limit.

This is the first distinct source-only kind: keep the global `ADJUSTMENTS`, `PARAMETERIZED_ADJUSTMENTS` and global capability list unchanged at 24. Source filters become 25. Add a source normalization branch/range rather than inserting `unsharp_mask` into the global table. Shared schemas need a source-filter parameter union distinct from global adjustment parameters; global creation, global update and adjustment recipe slots must reject this new family.

The recipe factory already derives source steps from `add_layer_filter`; native recipe normalization already calls `normalizeLayerFilter`. Use those seams to retain complete defaults and preserve partial updates without creating a global alias. Saved recipes, source stacks and portable graphs must all run canonical parameter and work/resource checks before asset reads. Older native readers reject the unknown source-filter kind, so no ignored property or project-format migration is needed.

Source/alpha assets, original previews, generated provenance/exclusion, contextual protected RGB restoration, mask order and explicit bake semantics stay unchanged. Nonempty stacks still prevent source painting and direct PSD export. UI discovery should require a precise source policy and individual kind; display amount, source sigma and per-channel threshold with finite string drafts and existing captured-result guards. Do not hide a newly unsupported saved entry or substitute existing sharpen.

## Production audit evidence

The independent audit exercises actual production entry points with separate BigInt channel and two-dimensional Gaussian references. Its nine checks cover:

- 20,000 seeded channel cases plus maximum-denominator, half-boundary and strict-threshold neighbors; default fixed-sharpen parity; original alpha and invisible RGB.
- Native sparse/default/partial parameters, canonical recipe capture and validation without pixel or asset I/O, and rejection of Unsharp as a global adjustment.
- Source-alpha recombination, two fractional-opacity entries, positioned masks/density, retained affine geometry, isolated groups and clipping; explicit Bake retains the complete rendered result and original source assets.
- Lower protected pixels and generated-member previews, including hidden protected-prefix refusal for identity settings before source reads.
- Parameter-driven work/cache preflight and a reachable 8192×1000 Bake boundary: an otherwise admitted source plus 129 MB of encoded inputs fits the old phase, but its 393,252-byte live ring correctly exceeds the 256 MiB named-buffer ceiling before decoding deliberately invalid source files.
- Real ENOTDIR persistence failures and late transaction failure after asset publication, with exact graph/history/cache/filesystem rollback; malformed portable definitions reject before asset reads.
- Unchanged legacy global Blur and LAB Sharpen pixels; an 8192×16 near-every-channel BigInt fallback fixture verifies exact bytes and event-loop progress.

The UI source inspection covers `unsharp.ts`, `UnsharpMaskControls.tsx`, `LayerFilters.tsx`, `source-spatial-filters.ts`, `EditRecipes.tsx` and `recipe-capture.ts`. Finite string drafts preserve tiny sigma, amount uses strict canonical centipercent validation, sparse stored parameters compare as complete defaults, the new marker is independent of the older Gaussian marker, and both filter and recipe identities include the new policy. Capture reads persisted values and whole-stack Bake keeps its independent capability. No source-level UI blocker was found. The UI owner subsequently verified eight focused browser workflows with independent two-dimensional BigInt threshold/tie oracles, capability partitions, sparse parameters, recipes, Bake and delayed contexts. Spatial/filter/tonal/recipe/Bake browser regressions add 31 workflows; compact-help polish was followed by another focused-eight/build run. Evidence is in `docs/UNSHARP_UI_DESIGN.md` and `test-results/unsharp-browser-report.json`.

Actual production-helper measurements are recorded separately in `test-results/unsharp-evaluation/production-report.json`: 1 MP default/generic cases take median 49.5/55.3 ms; the two all-tie fixtures take 145.9/142.7 ms; the maximum observed heartbeat gap is 8.19 ms. Sigma 10 at 1 MP takes 383.1 ms and sigma 50 at half a megapixel takes 885.6 ms. These include Gaussian traversal and the production finisher, but exclude native image decoding/composition and are measurements, not latency guarantees.

This audit changed only its test, the older discovery-count assertion and this review. Root owns full-suite/public acceptance; the UI owner owns browser evidence.

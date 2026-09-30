# Source Gaussian and unsharp review

Independent design and production audit, 2026-09-19. The native implementation passes all ten checks in `tests/source-spatial-filters-audit.test.mjs`; no production correctness blocker was found. Root reports the full 793-check suite passing, and the UI owner reports eight focused browser workflows plus adjacent regressions passing. These separately owned results do not claim Photoshop numerical parity. The independent arithmetic experiment is `test-results/spatial-filter-review/probe.mjs`, with machine-readable results in `report.json`. The backend owner's separate rolling-cache prototype is under `test-results/spatial-filters-evaluation/`.

## Recommendation and scope

Use an explicitly defined alpha-weighted Gaussian for source-filter `blur`, and a fixed-amount-one RGB unsharp residual for source-filter `sharpen`. Preserve every input alpha byte and every RGB byte whose input alpha is zero. Run after working alpha and separate cutout alpha are combined, before geometry. Additional layer masks, density, groups, selections and protected display context do not become the sampling window. Existing later mask, protection and generated-content exclusions remain in force.

Keep the global adjustment implementations unchanged. Sharp's documented supplied-sigma sharpening operates in LAB luminance with separate flat/jagged behavior; the proposed source residual is a distinct RGB operation. Label source controls with source-pixel sigma and describe preserved transparency and fixed sharpening amount. This is not a Smart Sharpen, variable-amount, noise-threshold or Adobe Gaussian parity claim. [Sharp operation documentation](https://sharp.pixelplumbing.com/api-operation/).

Reusing current raw-8-bit global Sharp calls is unsuitable for the stronger source contract. On the installed Sharp 0.35.4/libvips 8.18.6, a uniform `[31,121,231,1]` image becomes `[0,0,0,1]` under both blur and sharpen at sigma 1. At alpha 128 the same constant color becomes `[29,119,229,128]`. Restoring alpha after that operation cannot recover the lost RGB. Local `node_modules/sharp/src/pipeline.cc` premultiplies and casts to the input band format before the operation, then unpremultiplies. The experiment records these actual counterexamples; it does not generalize them to every Sharp pipeline.

## Exact kernel and alpha semantics

The final approved source contract uses the authored positive sigma directly, without the global blur's 0.3 floor. Zero is a pixel identity. For positive sigma at most 50, let `r=ceil(3*sigma)`, `K=2*r+1`, and `Q=65536`. Compute the center exponential as literal 1, symmetric side exponentials, and the normalization denominator `Z=1+2*sum(sides)`. Round each positive-distance coefficient independently to integer `round(Q*side/Z)` and put the exact remaining weight `Q-2*sum(roundedSides)` in the center. The resulting integer coefficients, rather than an ideal continuous Gaussian, define native semantics.

Tiny sigma may underflow every side exponential to zero and yield an exact pixel identity. That is valid. Literal center 1 avoids a `0/0` expression when `sigma*sigma` underflows. Do not give numerically identical positive filters special protection or structural permissions: enabled entries with nonzero opacity remain active for existing protection, bake-prefix and source-edit guards. Disabled or opacity-zero entries remain bounded metadata and allocate no spatial candidate.

The center is always positive throughout the accepted range. Since `Z<=2r+1` and each rounded side changes the paired center remainder by at most 1, its lower bound is `Q/(2r+1)-r`. At maximum radius 150 this exceeds 67.7, so the integer center is at least 68. Floating-point evaluation of exponentials/normalization is far below that margin. This proof covers unsampled fractional and tiny sigma; a sampled kernel sweep is additional evidence only. Zero-valued side coefficients are allowed and do not require local renormalization.

Clamp each sample coordinate to the nearest source edge, including repeated edge weights. For a destination with nonzero original alpha, sum the two-dimensional kernel times source alpha to obtain denominator `D`; sum the same weight times each RGB byte to obtain `N`. The positive center guarantees `D>0`. Gaussian output is rounded `N/D`; unsharp is rounded `(2*C*D-N)/D` for original channel `C`. Clamp to the byte range and quantize once. Alpha-zero destination pixels retain their original four bytes, and alpha-zero neighbors contribute no color. Constant RGB remains constant at alpha 1, 2, 128 and 255.

## Number arithmetic proof

The separable horizontal stage has exact integer bounds:

| Quantity | Maximum |
| --- | ---: |
| Horizontal channel-alpha sum | `255*255*65536 = 4,261,478,400` |
| Horizontal alpha sum | `255*65536 = 16,711,680` |
| Vertical channel-alpha sum `N` | `65025*65536^2 = 279,280,248,422,400` |
| Vertical alpha sum `D` | `255*65536^2 = 1,095,216,660,480` |

All horizontal accumulators fit unsigned 32-bit storage. Every vertical product and partial sum is an exactly represented Number integer below `2^48`. Unsharp's signed `2*C*D-N` remains exact as well. No float intermediate Gaussian image or per-stage RGB quantization is needed.

For final rounding, clamp the numerator to `[0,255D]` and compute `floor((2N+D)/(2D))`. Write `U=2N+D`, `V=2D`: both are exact integers, `U<=511D<2^49`, `V<=510*2^32<2^41`, and `U/V` lies in `[0.5,255.5]`. If the quotient is an integer it is exactly representable. Otherwise its distance from any integer is at least `1/V`, at least approximately `4.565e-13`. The maximum half-ULP below 256 is `2^-46`, approximately `1.421e-14`. Correctly rounded Number division therefore cannot cross a floor boundary; the margin exceeds 32 times its maximum rounding error. This proves exact integer half-up output without epsilon adjustments or a production BigInt fallback.

The independent BigInt experiment checks 204,288 numerator cases around half boundaries, including maximum and adjacent denominators, clamp boundaries and unsharp residuals. It also compares 256 complete blur/unsharp fixtures using independently aggregated two-dimensional clamped-edge weights against Number separable accumulation. Fixtures include 1-pixel axes, odd sizes, alpha 0/1/128/255, sigma `Number.MIN_VALUE`, .001, .1, .3, .75, 1, 2, 7.5, 10 and 50. Another 256 hidden-color perturbation checks establish that invisible neighbors cannot affect visible output. A 4,971-kernel sweep finds symmetric sums of 65,536 and minimum sampled center 514; the analytical positivity proof remains authoritative between samples.

## Cache lifetime, admission and integration

A ring of horizontal rows needs `16*width*min(height,K)` bytes: four Uint32 channels per source pixel. Include `8*K` bytes for kernel and vertical-row bases, plus `4*min(height,K)` for row tags. The owner's prototype advances source row indices monotonically and indexes rows modulo `min(height,K)`. A required interval contains at most K distinct source rows, so an evicted row cannot still be needed. Edge repetition reads the same cached row using repeated kernel weights.

The ring must be private to the spatial helper, which returns only its RGBA candidate. No closure, diagnostic result, cached kernel object or helper promise retained by the next phase should keep the ring alive into geometry or another filter. The existing source-filter surface and candidate are already part of the common filter scratch accounting; the ring is additional. Use the maximum active spatial ring in a sequential stack, not the sum of rings. Disabled/opacity-zero and value-zero spatial entries have no ring cost.

The proposed per-content renderer phase is `max(8*largestGeometryPixels,8*sourcePixels+maxSpatialRing)+canvasPixels`. Add the existing retained group/chain surfaces and positioned-mask callback reserve before the shared 256-MiB check. Include hidden content and intermediate resize/resample stages. This is a named reachable-buffer envelope, not a whole-process RSS or codec allocation promise.

Filter bake needs the same maximum ring in its source-filter phase: encoded inputs plus `(hasSeparateAlpha ? 17 : 12)*sourcePixels + maxSpatialRing + 64KiB`. Its decode, private-file encoding and publication phases keep their established estimates. Preflight against actual encoded input sizes before reading/decompressing pixels. A source filter cannot be admitted under the old bake budget merely because its kernel shares an existing kind name.

The approved weighted work is `(2*K+8)*sourcePixels` per active positive spatial entry, summed with other filter entries under the existing 384-million budget. An active sigma-zero entry costs `sourcePixels` with no spatial cache; only disabled or opacity-zero entries cost zero. Tiny positive identity kernels keep the full positive-sigma cost. The backend owner's measured prototype evidence supports this as a useful bounded first version, but it is not a real-time or 24-MP-at-every-radius promise. For example sigma 1 has K=7 and weight 22, while sigma 50 has K=301 and weight 610. Process no more than 65,536 actual taps between event-loop yields, including wide sources and initial ring population.

Shared normalizers, metadata-only recipes, filter updates and portable validation must run the new work and scratch calculations before publication or asset reads. Old readers already reject these absent source-filter kinds. Source filters increase from 22 to 24; the global adjustment kind count is unchanged. A nonempty filter stack retains existing PSD export refusal, source-edit restrictions and bake semantics. Identity pixel output must not weaken those structural rules.

## Required production evidence

1. Compare the actual rolling helper against an independent BigInt two-dimensional oracle, including tiny sigma, radius greater than both dimensions, clamped edges and alpha 0/1/128/255. Pin a half-up tie and one-pass unsharp residual separately from a blur-then-sharpen implementation.
2. Verify ordered stacks, fractional filter opacity, hidden RGB, separate source alpha, raw source/mask previews, transformed geometry and exact appearance through bake. Global blur/LAB sharpen must keep their prior output.
3. Exercise lower protected pixels through filters, isolated groups and clipping; generated content must retain its hard exclusion. Positive identity filters must not bypass protection, bake-prefix or source-edit guards.
4. Pin combined group/chain/positioned-mask plus ring boundaries, maximum intermediate geometry, metadata-only recipe validation and value-update admission. Verify bake's separate-alpha ring boundary before pixel reads and no asset writes on rejection.
5. Verify failure rollback, source immutability, undo/reopen/portable retention, and yielded responsiveness for wide sources. Keep prototype benchmarks clearly separate from measurements of the final native path.

## Independent production results

`node --test tests/source-spatial-filters-audit.test.mjs` passes ten checks against the actual source helper, filter evaluator and native command paths:

1. Seventy-two seeded image shapes/sigma cases exercise both valid kinds against a separately aggregated two-dimensional BigInt reference, with one-pixel axes, repeated edges, tiny and maximum sigma, alpha 0/1/128/255, hidden-RGB perturbations and constant low-alpha colors. At sigma .3977, the actual compiled kernel is `[0,2560,60416,2560,0]`; a 2×1 RGB pair `[80,144]` produces single-round unsharp `[78,147]`, distinguishing it from the incorrect rounded-blur residual `[77,146]`.
2. Separate cutout alpha combines before an independently evaluated blur/invert/sharpen stack with fractional opacity. Native source output and nearest geometry match every byte; additional masks/density/opacity do not change the source sampling window or assets.
3. Actual bake preserves independent expected working RGB and original working alpha, separate alpha and original assets, affine geometry, positioned feather/inversion/density masks, isolated group blend/opacity, clipping links and later protected content. The complete composite is byte-identical before and after baking both chain participants.
4. Earlier protected RGB restores under filtered isolated content. Generated clipped-member inspection remains alpha-zero throughout the original protection footprint. Enabled zero/tiny identity filters still reject protection changes and baking above hidden earlier protected content before pixel I/O.
5. The phase maximum includes exactly one active ring, separates source filtering from larger intermediate geometry, and retains cumulative work across sequential entries. A combined isolated-group/chain fixture with 246,000,000 bytes of positioned-mask reserve passes; a small source-frame increase crosses the combined cap and rejects through full native validation.
6. An 8192×1925 separate-alpha bake with tiny positive sigma passes the old filter-phase estimate but fails when the actual ring is added. It rejects before mismatched tiny source files can be decoded and produces no staging output.
7. Recipe validation performs no pixel or filesystem I/O. A later sharpen radius exceeds cumulative work and rejects the entire recipe; a supported smaller recipe applies metadata only. A subsequent over-budget value update leaves the saved graph unchanged.
8. Actual filesystem `ENOTDIR` failure rolls back both metadata edits and a freshly published baked asset. A later transaction target error also cleans its new bake asset. Publication counters prove the asset failures occur after real writes; original assets, project/history/revision and preview-cache state remain identical.
9. Invalid blur/sharpen ranges, unsupported parameters and hidden source work overflow in portable graphs reject before asset access. Disabled entries still validate their stored values.
10. Existing global Sharp blur and LAB sharpen match their independently reconstructed legacy calls, including soft alpha and low sigma. A real 8192-wide source candidate yields before completion while preserving input bytes and every output alpha byte.

The prior independent color-mixer and filter-bake suites also pass all 19 checks; the source-filter discovery assertion now expects 24 kinds. Root and the backend owner separately own broader API, persistence, schema and production benchmark evidence.

The actual UI source in `source-spatial-filters.ts`, `LayerFilters.tsx` and the narrow `EditRecipes.tsx` changes was independently reviewed without a blocker. Scientific/tiny sigma drafts avoid step rounding, unsupported saved entries remain inspectable, authoring/toggle gates require policy/coordinates/kind, response identities include the new semantics, and recipe reports invalidate on policy change without altering recovery. The UI owner reports eight focused workflows plus four prior filter, eight tonal, five recipe and six bake workflows/build passing. Final 900px evidence asserts sigma, Apply and Bake are in the viewport. The browser report records no unexpected browser/provider/key errors and only deliberate work-limit and stale-revision refusals; those are owner-run results, not independently rerun here.

No production spatial-filter file was edited by the independent reviewer.

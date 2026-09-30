# Independent review: deterministic source noise

Production source and native integration independently verified, 2026-09-19. The nine checks in `tests/noise-filter-audit.test.mjs` pass against the implemented Add Noise helpers and native commands; the adjacent Unsharp/color audit suites pass all 18 checks. Source filters now advertise 26 kinds and global adjustments remain 24. The original feasibility review found and resolved one statistical weakness before the algorithm was frozen. No backend or UI source-review blocker remains; actual browser/full-suite acceptance remains with the parent and UI workstreams.

## Recommended native contract

Use `add_noise`, scalar `value:0`, and complete defaults `{amount:5,distribution:'uniform',monochromatic:true,seed:1}`. Amount is finite 0–400% in canonical 0.01% steps; distribution is exactly `uniform` or `gaussian`; monochromatic is boolean; seed is an unsigned 32-bit integer, including zero and 4294967295. Validate all fields, including disabled/zero-opacity entries. Reject unknown fields and global-adjustment use. Omitted and partial persisted parameters have complete defaults; updates preserve effective omitted fields; recipes materialize complete parameters independently of target state.

Amount has an explicit native meaning. Let `a=255*amount/100`. Uniform deviates have an almost-`[-a,a]` midpoint range, with variance approximately `a²/3`. Gaussian deviates use `a` as a near-standard-deviation, with the exact table variance below. Changing distribution at the same Amount therefore changes strength. This follows the proposed arithmetic, not an inferred Adobe numerical convention. Root's [research note](NOISE_FILTER_RESEARCH.md) documents Adobe's workflow references separately.

Apply the saved source-local RGB effect after source-alpha combination and earlier filters, before transforms, additional masks, opacity, groups and clipping. Preserve all alpha bytes and every zero-effective-alpha RGB byte. Monochromatic means one common pre-clamp RGB delta. Channel clipping can change hue; byte rounding and clipping can change the output mean. Neither monochromatic nor zero-mean deviates imply exact hue or average-brightness preservation.

Amount zero is a pixel identity with work one per source pixel and no sampling/candidate/table requirement. Enabled positive-opacity identity entries retain existing structural protection, source-edit, Bake-prefix and PSD restrictions. Disabled/zero-opacity entries charge no work. Filter opacity remains the existing subsequent interpolation, so lowering Amount is not interchangeable with lowering opacity after a clipped candidate.

## Coordinate sampling and seed identity

Pin the complete map, with every integer word operation taken modulo 2³²:

```js
mix32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
seedKey = mix32((seed + 0x9e3779b9) >>> 0);
counter = 3 * (y * sourceWidth + x) + channel;
word = mix32(Math.imul(counter, 0x9e3779b9) ^ seedKey);
```

Use channel zero for monochromatic; color uses channels zero, one and two. The maximum counter is 71,999,999 at the 24-million-pixel cap, below 2³². Odd multiplication, xor with a constant and right-xor-shift are all invertible on uint32, so distinct counters cannot collide as full words for a fixed seed. Projected 16-/12-bit samples intentionally repeat. Seed premixing avoids adjacent seeds merely swapping nearby channel/counter inputs. It does not promise statistical independence for every possible pair of seeds.

The function takes a coordinate directly, so alpha skipping, loop partitioning, source visibility, additional masks and preview traversal cannot consume or shift a random sequence. UUIDs, document IDs, revisions and current layer order never enter it. Reopening, cloning, recipes and exports reproduce the same pattern on the same source coordinates and seed. Retained geometry transforms the sampled result. Changing the actual source width changes row-major coordinates and is a defined source change.

The counter formulation is supported conceptually by the counter-based random-generation literature; this small native mixer is not an implementation of Philox/Threefry, nor does the paper certify its quality. [Salmon et al., Random123](https://www.thesalmons.org/john/random123/papers/random123sc11.pdf). ECMAScript specifies `Math.imul` modulo 2³²; floating transcendental functions such as cosine/logarithm are implementation-approximated. Pinning integer words/table bytes avoids relying on direct Box–Muller transcendental results at output byte boundaries. [ECMAScript numeric specification](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math.imul).

## Table definition and independent certificate

The Gaussian distribution is deliberately discrete: 4096 equally likely midpoint-normal quantiles, rounded to units of 1/8192. For table index `k`, the ideal quantile is `Φ⁻¹((k+1/2)/4096)`. Store positive indices 2048–4095 in a private 2048-entry signed-16-bit little-endian table. For `k<2048`, return the negative of positive entry `2047-k`; otherwise return positive entry `k-2048`. Do not regenerate it during application startup or render.

The normal-CDF definition and integrated exponential series follow the NIST error-function integral/power series after the usual scale change. [NIST definition](https://dlmf.nist.gov/7.2.E1), [NIST series](https://dlmf.nist.gov/7.6.E1). The experiment `test-results/noise-review/certify-table.py` uses Python's `NormalDist` only to propose rounded integers. It independently certifies each proposal by evaluating both neighboring half-integer boundaries with outward 80-digit Decimal intervals. A bounded alternating Machin arctangent series supplies an independent pi interval; an alternating integrated-exponential series and its next-term bound enclose each CDF. No third-party package or copied floating inverse-CDF implementation is needed for the certificate.

All 2048 positive entries pass strict lower/upper CDF inequalities. The minimum certified probability margin exceeds `1.1384646539e-9`, while the widest CDF interval is below `4.93e-77`. Because the standard normal density is everywhere below 0.4, this implies a certified distance greater than `0.0000233157561` table units from every rounding half-boundary. No proposed integer relies on a near-zero numerical ambiguity.

The 4096-byte positive table's SHA-256, over little-endian signed 16-bit values, is:

`317cfb8ef5c5cb825f7f0530359f16c72bb981d69be1c4e7e0119d728ba15ea3`

It has exact antisymmetric mean zero, variance `0.9996779785287799`, fourth moment `2.989550502508019`, and maximum absolute value `30051/8192 = 3.6683349609375`. It is a finite midpoint quantile distribution, not continuous Gaussian noise or an unlabelled 12-uniform approximation. A 65536-bin/Q4096 comparison would improve variance to approximately `0.999978918` and extend the maximum to about 4.325, but needs 64 KiB for the positive half. Only the 4096-bin candidate was interval-certified; the larger comparison is exploratory. The compact candidate is adequate for the explicitly declared native distribution.

Use the high 12 word bits as the Gaussian index. Uniform instead uses high 16 bits `u`, with signed numerator `q=2*u+1-65536` over scale 65536. Its exact mean is zero and variance is `(1-1/65536²)/3` before scaling. Avoid endpoint samples at exactly ±1.

## Exact additive rounding

Let integer `A=round(amount*100)`, channel `C`, deviate integer `q`, and scale `S` (65536 Uniform, 8192 Gaussian). Form exact integer `D=S*10000` and `U=C*D+q*255*A`. Clamp `U` to `[0,255D]`, then return `floor((2U+D)/(2D))`. This is one half-up quantization of the signed additive candidate, not a separately rounded noise delta.

For Uniform, `|q|≤65535`, `A≤40000`, `D=655360000`; every intermediate and the largest possible positive numerator, `835573800000`, are below 2⁴⁰. For Gaussian, `|q|≤30051`, `D=81920000`; the corresponding bound is `327409800000`, below 2³⁹. Signed addition remains exact. After clamping, `2U+D≤511D` and `2D<2³¹`. A noninteger exact quotient is at least `1/(2D)>2⁻³¹` from an integer, while binary64 division within `[0.5,255.5]` has at most `2⁻⁴⁶` rounding error. Thus flooring cannot cross an integer boundary; exact integer quotients are representable. No per-pixel BigInt fallback or epsilon is required.

The independent experiment checks 3,324,544 actual byte results against BigInt, including every Uniform/table sample at seven representative amounts and six clamp-sensitive channels. It checks another 200,108 coordinate/mixer cases against BigInt modulo-word arithmetic and 12 complete images for alpha-zero skipping, alpha 1/128/255, hidden RGB, monochromatic/color channels and zero identity. These are test-only helpers; production will still require its own entry-point audit.

## Distribution finding and final measurements

The original `mix32(counter ^ seedKey)` map passed pair correlations but showed consistent overdispersion in high-bit occupancy: 1,048,576 red-channel samples, 4096 bins and seeds 0–31 produced mean Pearson chi-square/degrees-of-freedom `1.057742`, with all 32 above one (range `1.001295–1.115493`). The additional odd counter multiplication gave mean `1.000831`, range `0.960609–1.047526`. Both maps are bijections, illustrating that that proof alone does not establish useful finite-prefix quality. The reproducible comparison is `test-results/noise-review/counter-spread.mjs` and its report; root approved the refinement before vector freeze. No further generator search is needed for this scope.

Final-map probes use 1,048,576 pixels per distribution for six seeds: 0, 1, 2, 2147483647, 2147483648 and 4294967295. Uniform mean lies between −0.000635 and 0.000579; variance between 0.333072 and 0.333766. Gaussian mean lies between −0.000909 and 0.001193; variance between 0.999152 and 1.001876. Maximum absolute adjacent-pixel/vertical/within-pixel-channel correlation is below 0.00186; tested cross-seed correlation is below 0.00196. These are finite diagnostic checks, not proof of independence or a comprehensive random-generator test battery.

The independent final-map candidate copies one RGBA buffer and yields every 65,536 pixels. Three-run median measurements on the local Node environment:

| Fixture | Uniform mono / color | Gaussian mono / color |
| --- | ---: | ---: |
| 1024×1024 | 8.0 / 8.8 ms | 13.3 / 27.9 ms |
| 8192×128 | 7.8 / 8.7 ms | 13.0 / 26.7 ms |
| 6000×4000 | 184.7 / 201.8 ms | 297.4 / 612.3 ms |

Maximum observed heartbeat gap was 9.59 ms, including initial output copying. These test-only measurements exclude image decode, stack interpolation, composition and Bake encoding, and are not application latency guarantees. The owner's separately structured prototype is slower; use its conservative measurements too when choosing admission. Uniform computing work `8*sourcePixels` for every mode, identity work one and disabled work zero is reasonable under the existing 384-million budget: two 24 MP noise filters reach that cap. Preserve bounded yields regardless of source width.

## Integration/resource acceptance requirements

Retain one owned candidate plus the existing mutable stack output; no per-pixel noise plane, random-state array or additional full-image buffer is necessary. The immutable 4096-byte Gaussian table is shared across calls. For any operation with active positive-amount Gaussian noise, charge its retained table once, after the graph's existing maximum group/filter/clipping/positioned-mask buffer phase. Charging it only at the Gaussian leaf is insufficient because a warmed table remains live through a later peak in another leaf or filter. Include it conservatively once in each relevant direct-stack/Bake phase, including publication; never multiply the shared table by filter count. This is named-buffer accounting, not whole-process RSS. Hidden entries still participate in graph admission; amount/activation/distribution changes revalidate.

Keep the table bytes private and endian-independent at access. A small base64 literal decoded once into a private Buffer with LE reads avoids a second full numeric array. Pin the digest and generation certificate in durable owner tests/docs; runtime loading must not consult a package, network, generator or user file.

Extend source-only normalization/parameter unions/capabilities, not global color dispatch. No old reader may silently ignore the unknown source kind. Strict portable validation must reject malformed amount/distribution/seed/unknown fields before asset reads. Preserve complete recipe defaults and explicit local seed changes; no render-time entropy, automatic reseeding or UUID dependency.

Before public acceptance, independently verify actual production stack and native/Bake paths: source-alpha hidden RGB and source assets, masks/protection/generated original-context previews, isolated/clipping composition, repeated/reordered same-seed entries, default/sparse/partial parameters, work and retained-table boundary admission, real publication rollback, reopened/portable/repeated exports and seed-zero/max vectors. UI should describe the discrete distribution and source coordinates, keep New pattern as a local draft action, and include the precise new policy in filter/recipe result identities. Existing global adjustments remain unchanged.

Root approved this bounded implementation contract after the backend owner recorded the adopted counter map, table digest and accounting. The approved design/probes revealed no remaining arithmetic, distribution or performance blocker. Production verification is recorded below; browser and integrated acceptance remain separately tracked.


## Production audit evidence

The maintained `scripts/certify-noise-table.py --verify` completes successfully: all 2048 interval certificates, fixture bytes, certificate report and runtime base64 literal match the pinned digest. The production table uses one dedicated 4096-byte backing Buffer, private scalar access, lazy initialization and explicit little-endian reads. The test-only final owner prototype was also crosschecked independently before production: 4096 table values, 20,000 sampled coordinates, 120,000 BigInt byte comparisons and 60 full tiny images matched.

The actual nine-test production audit covers:

- Every table entry and antisymmetric counterpart; 20,000 independent uint32/BigInt cases and 120,000 channel comparisons, plus seed-zero/max coordinate and clamp-boundary cases.
- Actual source candidates/stacks in both distributions and color modes, exact original alpha and invisible RGB, state-free alpha skipping, two ordered fractional-opacity entries, source identity and source-only normalization/global rejection.
- Sparse false/zero defaults, partial native updates and canonical recipes, with validation blocked from filesystem, image, model or asset entry points and application blocked from pixel/asset operations.
- A cross-leaf retained-table boundary with a 24 MP source maximum in an isolated/clipping context and 38.216 MP of retained bitmap-mask source frames. The original graph has only 3445 bytes of headroom; activating Gaussian on a different 1-pixel leaf adds 4096 bytes and correctly refuses before pixel work, both standalone and in a transaction. This catches placing the reserve only on the noise leaf.
- All four Bake phase fields gain exactly 4096 bytes once, including a mixed spatial-ring/noise stack. A publication-dominant fixture with two 133,139,456-byte sparse encoded inputs leaves 2048 bytes before the table reserve; actual Bake rejects with `LIMIT_EXCEEDED` before digest/decode reads of the deliberately invalid source bytes. This catches charging only the materialization phase.
- Independent source-alpha recombination and noise arithmetic through affine geometry, positioned/feathered/inverted masks, density, isolated Multiply and clipping; explicit Bake preserves exact composite, restores original working alpha and keeps original source assets/metadata.
- Lower protected alpha 1/128/255 and generated clipping-member previews retain original-context exclusion. Active amount-zero above hidden protected content still rejects Bake and protection changes before image access.
- Real ENOTDIR publication failure and later transaction failure after Bake preserve project/history/cache/assets; malformed disabled portable noise definitions reject before any asset/file read.
- Fixed work/identity accounting and actual 8192-wide yielding retain deterministic output and unchanged input.

Production source review checked `source-noise-filters.mjs`, `noise-table.mjs`, `layer-filters.mjs` and `filter-bake.mjs`: no runtime transcendental/entropy path, no table allocation during normalization or estimation, table reservation after the graph maximum and in every Bake phase, and the new candidate branch cannot be skipped merely because scalar value is zero. Old global color dispatch is unchanged.

UI source review checked `noise.ts`, `NoiseControls.tsx`, `LayerFilters.tsx`, `source-spatial-filters.ts`, `EditRecipes.tsx` and `recipe-capture.ts`. Local New pattern handles valid seed zero/max, collisions and entropy failure while preserving other drafts; strict parameter parsing, complete sparse defaults, independent policy gating, captured result/report identities and persisted-only recipe capture match the contract. No source-level UI blocker was found. This source review does not substitute for the UI owner's eight browser workflows.

Only the independent audit, older discovery-count assertion, experimental files and this review were changed by this reviewer. Native/backend, shared/MCP and client production remain owned by their respective workstreams.

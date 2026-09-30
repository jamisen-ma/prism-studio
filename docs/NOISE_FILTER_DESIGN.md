# Deterministic source Add Noise

Implemented and backend-verified, 2026-09-19. Root approved the final contract after independent arithmetic, table and statistical review. The focused owner/audit/schema/MCP sweep passes 21 tests, and 47 adjacent filter/bake tests pass. Integrated acceptance also passes: 835 full-project tests, 47 browser workflows and the production build. Root inspected compact controls and actual photographic output; see [verification status](IMPLEMENTATION_STATUS.md).

Add source-only `add_noise` to editable raster stacks, with Uniform/Gaussian distribution, Monochromatic and a retained seed. Repeatable texture is useful for reducing smooth-gradient banding and matching grain across composites. [Adobe's effects reference](https://helpx.adobe.com/photoshop/using/filter-effects-reference.html) describes those distribution and monochromatic choices; its [UXP layer API](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/layer/#applyaddnoise) documents an Amount range through400%. These are workflow references. Prism's exact seed, discrete Gaussian, RGB arithmetic and transparency rules below are independently specified and do not claim Adobe pixel equivalence.

## Parameters, discovery and persistence

Use existing filter commands, recipes and explicit Bake; no new command:

```js
add_layer_filter({
  documentId, expectedRevision, layerId,
  kind: 'add_noise', value: 0,
  parameters: {
    amount: 5, distribution: 'uniform', monochromatic: true, seed: 1
  },
  enabled: true, opacity: 1
})
```

| Parameter | Required meaning | Effective default |
| --- | --- | --- |
| `value` | Exactly zero | API field remains required |
| `amount` | Finite0–400 percent, canonical0.01% increments | 5 |
| `distribution` | `'uniform'` or `'gaussian'` | `'uniform'` |
| `monochromatic` | Boolean: one shared RGB deviate or three channel deviates | true |
| `seed` | Integer0–4294967295, preserving both endpoints exactly | 1 |

Amount accepts exactly `round(v*100)/100 === v`, with no tolerance or silent quantization. Amount0 is an explicit computational identity. Validate every field even for amount0, disabled or opacity0. Reject null, arrays, wrong families/keys/types, nonfinite values, fractional/out-of-range seeds and finer amount precision. Normalizers return fresh complete plain objects. Sparse stored parameters resolve to these defaults; partial updates merge with effective current values. Recipes save complete settings including seed, independent of target IDs or target defaults.

Native source kinds become26; global adjustment kinds stay24 and global parameter normalization remains unchanged. Add the independent marker:

```js
layerFilterNoisePolicy: 'seeded-rgb-discrete-v1'
```

Clients require this exact marker, source coordinates, individual `add_noise` discovery and the appropriate existing command. Other source spatial/unsharp markers are not prerequisites. Keep unsupported saved entries visible/removable; do not substitute a global operation. Recipe definition capture/import/save remains separate from execution Validate/Apply gates. Existing unknown-kind rejection makes older native readers fail closed for persisted noise, including disabled entries; no project-version migration is necessary.

The UI presents Amount, Distribution, Monochromatic and an unsigned seed draft. “New pattern” changes only that local seed draft. A single `crypto.getRandomValues` call per click, with a guaranteed different result and a deterministic uint32 increment fallback, is acceptable. Explicit Apply commits it. Rendering never uses entropy, time, `Math.random`, implicit seed increments or fresh filter IDs.

## Source sampling and stable pattern

Noise evaluates current working-source RGB after separate cutout alpha and earlier source filters, before retained geometry. Every alpha byte stays exact. Zero-alpha RGB stays exact and its pixel does not need evaluation. Skipping an invisible pixel must not change any later sample.

Sampling uses source pixel index `p=y*sourceWidth+x` and channel `c`. With at most24M source pixels, `counter=3*p+c` is an exact unique integer below72M. Monochromatic always uses c=0 for all RGB channels; colored mode uses c=0,1,2. Thus toggling monochromatic preserves the red-channel deviate. No document/layer/filter ID, RGB value, alpha, visibility, opacity, mask, selection or processing-order value contributes to the seed or counter.

The same source coordinates/seed generate identical deviates across documents, duplicates, recipes, restarts, previews, exports and Bake. Reordering around RGB transforms retains the noise field, although RGB results change according to normal stack order and clipping. Retained move/crop/resize/affine geometry transforms the already sampled source image and does not reseed it. A source-dimension replacement changes the coordinate/index frame explicitly. Hiding/revealing source alpha cannot shift the pattern; after baking and removing the live stack, previously hidden RGB remains ungraded by the existing Bake contract.

Own additional masks/density/position, ancestor masks/opacity, selection, styles, clipping and display visibility stay outside sampling and retain their current later-stage semantics. Original-context protected RGB restoration and generated exclusions remain unchanged. Protected targets reject active entries, and active amount0 keeps the same structural protection/source-write/bake-prefix guards as other active identities.

## Exact uint32 mapping

Use the published `lowbias32` permutation from [Hash Function Prospector](https://github.com/skeeto/hash-prospector), under its UNLICENSE, with native seed/counter mapping:

```js
function mix32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
const seedKey = mix32((seed + 0x9e3779b9) >>> 0);
const word = mix32((Math.imul(counter, 0x9e3779b9) ^ seedKey) >>> 0);
```

Compile seedKey once per entry. Both multipliers in mix32 and the counter multiplier are odd, hence invertible modulo2^32; xor-shifts and xor with a fixed key are also invertible. Distinct counters within a fixed-seed image therefore produce distinct full32-bit words. Quantization intentionally maps many words to a discrete deviate. This is reproducible visual noise, with statistical tests, not a cryptographic generator or a claim of mathematical sample independence.

An earlier design omitted the counter multiplier. Independent4096-bin studies over1,048,576 red samples for each seed0…31 found consistent occupancy overdispersion: mean Pearson chi-square/4095 was1.057742, range1.001295–1.115493. The final odd premultiply improves the same study to mean1.000831, range0.960609–1.047526. This single change addresses the measured structure before freezing vectors. Adjacent seeds are themselves premixed to avoid obvious local channel/position swaps. The final formula, not either earlier variant, is the policy.

Pinned examples for source pixel0:

| Seed | Channel | uint32 word | Uniform integer q | Gaussian integer q |
| --- | ---: | ---: | ---: | ---: |
| 0 | 0 | 2926543089 | 23775 | 3861 |
| 0 | 1 | 1214650568 | −28467 | −4706 |
| 0 | 2 | 276061563 | −57111 | −12447 |
| 4294967295 | 0 | 2385989600 | 7279 | 1144 |
| 4294967295 | 1 | 1786316777 | −11021 | −1740 |
| 4294967295 | 2 | 1710019264 | −13351 | −2116 |

Full independent BigInt vectors include source indices0,1,2,8191,8192,23999999 and seeds0,1,2,large values and maxuint32. Hash constants/order, extraction bits, table bytes and arithmetic must remain stable under this policy marker.

## Uniform and discrete Gaussian

Uniform uses `u=word>>>16`, `q=2*u+1-65536`, scale Q=65536. These65536 equally spaced midpoint values are antisymmetric and lie strictly inside(−1,1) after division by Q. The complete discrete distribution has exact mean0 and variance `(1-1/65536²)/3`. At Amount a, the maximum absolute preclamp RGB delta is slightly below `255*a/100`.

Gaussian uses `i=word>>>20`, selecting one of4096 equal-probability midpoint-normal quantiles. Define the full table mathematically as nearest integers to `8192*Φ⁻¹((i+0.5)/4096)`, with exact antisymmetry. Store only positive entries j=0…2047 at probabilities `0.5+(2*j+1)/8192`. All are positive and fit signed16 bits. Reflect the lower half: `q(i)=-positive[2047-i]` for i<2048; otherwise `q(i)=positive[i-2048]`. Scale Q=8192.

This is a fixed finite discrete approximation of a standard normal, not an unbounded continuous distribution. Its exact symmetric mean is0; variance is0.9996779785287799, fourth moment2.989550502508019 and excess kurtosis approximately−0.00852317. The largest absolute value is30051/8192=3.6683349609375 standard deviations. At Amount a, the preclamp standard deviation is approximately `255*a/100`, with those bounded tails. Therefore equal Amount does not mean equal variance between Uniform and Gaussian. No runtime Box–Muller, inverse CDF, transcendentals or12-uniform approximation is used.

The positive table's4096 little-endian signed16 bytes have SHA-256:

`317cfb8ef5c5cb825f7f0530359f16c72bb981d69be1c4e7e0119d728ba15ea3`

The independent certifier uses Python's NormalDist only to propose integers. An independently bounded Machinπ calculation and outward80-digit Decimal intervals for the normal CDF certify both half-integer boundaries of every one of2048 proposals. The smallest certified probability margin is greater than1.13846e−9, versus maximum interval width4.927e−77; the corresponding conservative distance from any scaled quantile half boundary exceeds2.33157e−5. Thus the integer table does not depend on trusting binary64 inverse-CDF rounding. A larger65536-bin comparison costs64KiB and improves variance to approximately0.9999789 with tails±4.32495, but the compact4096-bin table is the chosen bounded native distribution.

The maintained certifier is `scripts/certify-noise-table.py`; certified bytes and its complete report live in `tests/fixtures/noise/gaussian-positive-q8192.bin` and `table-report.json`. Run `python3 scripts/certify-noise-table.py --verify` to independently certify every entry and compare the fixture, report, declared LE-byte hash and runtime base64 literal without writes. The verified command completes in about 0.66 seconds here. `--write` regenerates those same maintained artifacts while still requiring the pinned hash. [Fixture instructions](../tests/fixtures/noise/README.md) preserve both table and browser-golden provenance. Runtime never invokes Python or regenerates quantiles. Source comments name/link lowbias32 and the certificate.

## Exact additive byte arithmetic

Compile centipercent amount `A=round(a*100)` in0…40000. For current byte C and integer deviate q with scale Q:

```text
D = Q*10000
U = C*D + q*255*A
candidate = clamp-and-half-up(U/D)
```

Compute these integer products/sums in Number. Uniform has D=655360000 and `abs(U)<=835573800000<2^40`; Gaussian has D=81920000 and `abs(U)<=327409800000<2^39`. Every signed product and sum is exactly representable. Clamp U against0 and255D, then return `floor((2U+D)/(2D))`. The clamped doubled numerator is at most511D, still exact, and denominator2D<2^31. A noninteger quotient is more than2^-31 from an integer boundary, versus maximum division error2^-46, providing over32768× margin. Exact integer quotients are representable. No per-pixel BigInt or epsilon is required.

Opposite deviates are exactly opposite before clamp/round. Ordinary byte clipping and half-up rounding can break displayed symmetry and shift means near RGB boundaries; do not promise zero output mean or hue preservation. Monochromatic shares an additive delta across RGB, which can still change hue after different channels clamp. Per-entry opacity mixes the already rounded candidate with the current RGB using the existing rule; it is distinct from scaling amount before clipping.

## Allocation, work and responsiveness

The evaluator owns one copied4S RGBA candidate and scalar state; it allocates no random field, RGB planes or per-pixel arrays. One optional4KiB Gaussian table backing buffer is shared privately. Pin it as a base64 literal decoded lazily into a dedicated `Buffer.allocUnsafeSlow(4096)` using its bounded base64 write; assert the write filled4096 bytes and backing ArrayBuffer length is exactly4096 before publishing the private reference. This avoids a pooled slab or a second decoded buffer. Use LE reads or a noncopying explicitly little-endian view. Do not retain a second binary copy or a JS number array, and never export its mutable buffer/view. Metadata normalization, graph/recipe validation and work estimation must not initialize this table.

The shared table may remain resident after an operation, so it cannot be treated as a sequential rolling cache that becomes unreachable when a candidate returns. Let `T=4096` if any enabled, positive-opacity, amount>0 Gaussian-noise entry participates in the admitted graph/stack; otherwise T=0. Hidden layers count. This is a conservative per-use reservation even for an all-transparent source. It is distinct from total process memory: a previously initialized module table can remain resident while later operations without Gaussian do not need that operation reserve.

Keep `Rmax` as the existing maximum sequential Gaussian blur/unsharp rolling cache. For graph rendering add T **once after finding the graph's maximum retained group/clipping/filter peak**, then combine with the existing positioned-mask callback reserve and enforce256MiB. Do not attach T only to the noise leaf: it remains live through a later layer/group/chain/ring peak. An empty/early-return traversal must still reach the final shared-reserve check. Existing graphs with no computing Gaussian noise retain their prior admission.

For direct stack evaluation charge T once alongside its existing candidate/ring peak. For Bake add T once to **every** named phase estimate: decode, filter/materialization, encode/read and publication. The materialization term remains encoded inputs plus `(hasAlpha?17:12)*S+Rmax+64KiB+T`; the other phases retain their prior formulas plus T. Charge encoded working/alpha file sizes as before. This conservatively covers the persistent table after filtering without incorrectly taking `max(Rmax,T)` or dropping T before PNG publication. Partial distribution, amount or enabled/opacity changes must revalidate this shared reserve before later transaction pixel work.

Work admission is uniform8*S for every enabled positive-opacity amount>0 entry, regardless distribution or monochromatic mode. Amount0 costs1*S with no candidate/hash/table computation; disabled/opacity0 costs0. Active identities remain structurally active. The existing document-wide384M ceiling includes hidden nodes; two24MP computing noise entries consume it exactly before other filter work. Source axes≤8192, source pixels≤24M, eight entries/layer and64/document remain. No automatic amount/precision reduction or changed random algorithm follows an admission failure.

Yield at most every65536 source pixels, counting skipped transparent pixels too. Existing stack opacity interpolation keeps its own bounded row yielding. Initial buffer copies and runtime scheduling are not hard real-time guarantees. The ledger names binary buffers and deliberately does not promise total RSS/native codec/GC behavior.

## Integration and acceptance

Use a source-only helper exposing complete parameter normalization, deterministic sample/byte operations as needed for testing, metadata identity/table reservation, and asynchronous candidate generation. Keep its Gaussian backing table private. Add `add_noise:[0,0]` and the new family to the existing source-only range/parameter seams in `layer-filters.mjs`; never add it to global color tables. Shared source-filter schemas gain the strict family while global schemas and adjustment recipe slots continue to reject it. Existing source recipe normalization fills complete defaults and seed at save.

Separate `layerFilterSharedBytes` or an equivalent explicit helper from `layerFilterSpatialCacheBytes`, so the table's retained lifetime cannot be mistaken for a ring. Extend graph resource admission and actual-stack Bake estimates through that seam. Ordinary source filter transactions remain metadata-only and write no assets. Explicit Bake retains original/sourceAlpha/masks/transforms/styles/provenance and uses the existing full-interval new-asset rollback scope. Nonempty stacks retain the existing layered PSD export refusal until explicit Bake/Clear.

Acceptance must include exact uint32 vectors against a separate BigInt hash, table hash/all quantile certificates/antisymmetry, full discrete-domain byte rounding, seeds0/max and partial/default schema behavior, no global leakage, same-seed unrelated-document/filter-ID/recipe patterns, order without reseeding, alpha0/1/128/255 and hidden-RGB/alpha-skip independence, Monochromatic shared delta and opacity-after-clamp examples. Include protected/generated/group/clipping/mask contexts, current source preview and original bytes, exact Bake, undo/reopen/portable/retry, malformed disabled bundles before image access, metadata-only dry recipes, shared-table+ring+positioned peak boundaries, every Bake-phase reserve, and failed mutation/persistence ownership rollback. UI tests cover finite drafts, local-only New pattern, explicit Apply, partial policy loss and captured document/revision contexts.

## Verification evidence

Owner `test-results/noise-evaluation/{prototype.mjs,table.mjs,probe.mjs,report.json}` uses the final counter spread, private lazy LE table,626,688 exact byte comparisons, independent BigInt hash vectors and alpha-skip tests. Independent `test-results/noise-review` contains the interval certifier,3,324,544 byte checks, separate hash/image/statistical probes and the two-candidate histogram study. The earlier owner report is retained only as `initial-counter-report.json`; its vectors do not define this policy.

The final1,048,576-sample seed1 red field has Uniform mean−0.00001173, variance0.3334761 and adjacent correlation0.0004214; Gaussian mean−0.00004146, variance1.0006616 and adjacent correlation0.0000561. These finite-sample diagnostics support the mapping; the exact full-table moments above define the distributions.

The same probe was repeated against the actual production helper and private table in `test-results/noise-evaluation/production-benchmark.mjs`; `production-report.json` records another 626,688 exact byte comparisons, vectors, statistics and all timing attempts. Three-run opaque-image production full-candidate medians, Node22.14.0/Apple M5 Max/Darwin arm64:

| Size | Distribution | Monochromatic | Amount5% | Amount400% |
| --- | --- | --- | ---: | ---: |
| 1024² | Uniform | true | 9.4ms | 18.3ms |
| 1024² | Uniform | false | 10.3ms | 36.2ms |
| 1024² | Gaussian | true | 19.5ms | 20.7ms |
| 1024² | Gaussian | false | 39.2ms | 42.6ms |
| 6000×4000 | Uniform | true | 218.8ms | 410.9ms |
| 6000×4000 | Uniform | false | 230.3ms | 812.7ms |
| 6000×4000 | Gaussian | true | 446.5ms | 475.1ms |
| 6000×4000 | Gaussian | false | 896.0ms | 986.1ms |

8192×128 and128×8192 cases are also measured. The largest5ms heartbeat gap across all32 production configurations/three runs is7.48ms. These include candidate allocation, sampling, byte arithmetic and yielding; they exclude decoding, stack opacity, full graph rendering and PNG encoding. Work8 is a conservative admission policy, not a latency guarantee.

`tests/noise-filter.test.mjs` passes eight owner cases: all4096 coefficients and dedicated backing lifetime, complete strict defaults/ownership, independent BigInt hash and626,688 byte checks, alpha/order/opacity semantics, sequential-ring versus persistent-table ledgers, no-I/O metadata/native work bounds, actual separate-alpha Bake with positioned masks and retained geometry, and8192-wide yielding. The independent audit passes nine cases, including a table reserve at a different layer's group/clipping/positioned peak, all four Bake phases, publication-dominant refusal before digest/decode, protected/generated contexts, hostile portable metadata and real persistence rollback. Three schema checks and the official MCP workflow complete the21-test sweep. The47-test adjacent owner sweep includes all26 filter kinds through Bake and preserves the prior tonal/spatial/unsharp behavior. No production correctness finding remains from these checks.

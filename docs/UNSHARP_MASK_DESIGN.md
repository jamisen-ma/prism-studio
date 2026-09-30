# Editable source Unsharp Mask

Implemented backend contract, 2026-09-19. Focused owner8, independent9, schema3 and official MCP1 checks pass21/21; established adjacent source/color/filter/bake suites pass39/39. Root owns the final full-suite and UI acceptance. Existing source spatial filters were the released 793-test baseline.

This adds a distinct `unsharp_mask` kind to raster source filter stacks, with independent Amount, Gaussian sigma and Threshold controls. It uses Prism's alpha-weighted RGB Gaussian and explicitly defined per-channel threshold. Existing fixed source `sharpen`, global adjustments, brush tools and effects retain their current contracts and pixels.

[Adobe's Unsharp Mask guide](https://helpx.adobe.com/photoshop/desktop/effects-filters/smart-filters/sharpen-images-with-unsharp-mask.html), checked 2026-09-19, documents Amount, Radius and Threshold as separate controls. That is the workflow reference. Adobe's public description does not specify the kernel, RGB threshold rule, alpha treatment or rounding used here; this design makes no numerical Photoshop/LAB equivalence claim. The native neighborhood control is labeled **Gaussian sigma**, in source pixels, rather than implying Adobe Radius equivalence.

## Public and persisted contract

No new command is needed. Use the existing add/update/reorder/delete/clear filter commands, explicit filter baking, recipes and transactions.

```js
add_layer_filter({
  documentId, layerId, expectedRevision,
  kind: 'unsharp_mask', value: 0,
  parameters: { amount: 100, sigma: 1, threshold: 0 },
  enabled: true, opacity: 1
})
update_layer_filter({
  documentId, layerId, filterId, expectedRevision,
  parameters: { threshold: 12 }
})
```

| Field | Contract | Default |
| --- | --- | --- |
| `value` | Exactly zero, including for disabled entries | Required by the existing API |
| `parameters.amount` | Finite 0–500 percent; canonical 0.01% increments, `round(v*100)/100 === v` | 100 |
| `parameters.sigma` | Finite 0–50 source pixels; true authored value with no positive floor | 1 |
| `parameters.threshold` | Integer 0–255 RGB byte difference | 0 |
| `enabled`, `opacity` | Existing boolean and finite 0–1 settings | true, 1 |

Omitted or empty parameters resolve to complete defaults. Partial updates merge with effective current parameters, then normalize into a fresh complete object. Reject unknown keys, wrong parameter families, null, wrong types, nonfinite values, out-of-range values, fractional thresholds and finer amount precision. Validate every setting even on disabled, opacity-zero and computationally identity entries. Never silently round authored amount into the allowed precision. Tiny positive sigma is valid; quantized weights can become an identity without changing the authored parameter.

Native normalization and saved recipes write complete `{amount,sigma,threshold}` objects. Sparse valid stored records are accepted with these defaults when read; no target-dependent defaults remain after recipe save. Updating any parameter or activation validates the entire candidate graph's work and scratch before publication. All existing revision, session deduplication, one-undo transaction and rollback rules continue to apply. A stale retry after restart does not silently reapply an edit.

Source filter capabilities become 25 kinds while `adjustmentKinds` and `ADJUSTMENTS` remain at 24 global kinds; `PARAMETERIZED_ADJUSTMENTS` is unchanged. Advertise:

```js
layerFilterKinds: [/* existing 24 */, 'unsharp_mask'],
layerFilterCoordinates: 'source',
layerFilterUnsharpPolicy: 'rgb-residual-threshold-v1'
```

The new policy marker is independently sufficient with source coordinates, the individual kind and the appropriate existing command. It fully names the Gaussian/alpha/threshold/rounding contract here; clients need not also require `layerFilterSpatialPolicy`. That older marker continues to describe existing source blur/fixed sharpen. Capability loss disables new/changed/enabled unsupported entries; saved settings remain visible and removable. Recipe definition capture/import/save can remain available independently; execution Validate/Apply needs the same new-kind policy gate. Do not substitute fixed sharpen or add the new kind to global controls.

## Pixel contract

The input is the current stage of the working source RGBA stack. Separate cutout alpha has already been combined with working alpha. Filters run before retained geometry. Sampling excludes own additional masks/density, ancestor masks/opacity, selection, clipping, styles and display visibility; those remain later compositing stages.

Reuse the released source Gaussian exactly: `r=ceil(3*sigma)`, `K=2r+1`, a symmetric nonnegative Uint32 kernel whose sum is `Q=65536`. Evaluate authored sigma directly, with center value 1 before normalization. Round each paired side coefficient and give the center the remainder. The center is positive for every supported radius (`Q/301-150>67`), or Q for an identity kernel. Clamp coordinates to the nearest source edge. The separable horizontal cache retains alpha-weighted RGB and alpha sums without intermediate normalization or rounding.

For current byte `C`, let Gaussian RGB numerator be `N` and alpha-weight denominator be `D`. At nonzero source alpha, the positive center guarantees `D>0`. Let `R=C*D-N`. Threshold `T` applies **independently to each RGB channel**, using the unrounded difference:

```text
abs(R) <= T*D: keep C unchanged
abs(R) >  T*D: candidate = clamp(C + A*R/(10000*D), 0, 255)
```

Here `A=round(amount*100)` is an integer in 0–50,000. Equality remains unchanged. Round the complete candidate once, half up. Only then apply the existing per-entry opacity interpolation and its normal byte rounding. Do not first round blurred RGB. Amount controls the unsharp residual before clipping; opacity mixes the rounded/clipped candidate, so they are intentionally different controls. Per-channel threshold can affect channels differently and does not promise hue preservation.

Alpha is copied exactly. At source alpha zero, hidden RGB is also copied exactly and contributes zero neighborhood weight. Constant visible RGB remains constant at alpha 1, 128 or 255 and under mixed alpha. Newly revealed effective-alpha-zero source RGB stays ungraded, consistent with existing filters and source-RGB baking.

Amount 100%, threshold 0 equals fixed source `sharpen` exactly at the same sigma within its existing 0–10 range. Amount 0, sigma 0 or threshold 255 are provable computational identities and avoid Gaussian/candidate allocation. Enabled positive-opacity identities remain structurally active: they retain active-filter protection and source-write/bake-prefix guards. Positive tiny sigma does not receive a cheaper identity admission merely because the compiled kernel later becomes an identity.

## Exact arithmetic and rounding

The existing Gaussian has `D <= 255*Q² = 1,095,216,660,480 < 2^40` and `0 <= N <= 255D < 2^48`. `C*D`, signed residual `R`, its absolute value and `T*D` are all exact Number integers. The threshold branch therefore needs no tolerance.

Compile `A/10000` into reduced coprime integers `p/q` once per entry. If **`q<=16 && p+q<=32`**, compute `V=q*D`, `U=C*V+p*R`. Each product and the signed addition remain exact: their absolute bounds are at most `32*255D = 8,936,967,949,516,800 < 2^53`. This includes negative R; cancellation does not invalidate exact integer representability. Clamp U against 0 and `255V`, then return `floor((2U+V)/(2V))`.

After clamp the numerator is at most `511*16D<2^53`, and denominator `2qD<2^45`. A noninteger quotient lies more than `2^-45` from an integer boundary, while maximum division rounding error below 256 is `2^-46`. An integer quotient is itself representable. Thus floor implements exact rational half-up rounding. This static branch admits 70 canonical amount settings, including all 25% multiples and common 10/20/30% values. Do not expand it based on a dynamically rounded product appearing to be an integer.

For all other amounts use `y=C+(A/10000)*(R/D)`. This residual-first operation order avoids subtracting a rounded Gaussian value from C. A conservative absolute error is:

```text
5*2^-46 + 255*2^-51 + 2*2^-43 + 2^-97 < 4.2e-13
```

The terms cover residual division multiplied by at most 5, multiplier division multiplied by a residual of at most 255, product/addition rounding for values within −1275…1530, and the cross-product of the two division errors. Use a fixed recomputation guard `64*Number.EPSILON*1530`, approximately `2.1743e-11`, more than 50 times this bound. When interior y lies outside that distance from a half-integer, ordinary half-up Number rounding is unambiguous. Inside the guard, form `10000n*BigInt(D)` and `BigInt(C)*denominator+BigInt(A)*BigInt(R)`, then clamp and divide exact doubled integers. Never convert an already unsafe Number product into BigInt. Do not add an epsilon to the output.

Output clamp branches at y<=0 or y>=255 are safe: an error of this size cannot move the true value across the half-byte boundary required to change the clamped byte. No per-pixel cache, BigInt array or extra image plane is created; only bounded scalar temporaries are used. Independent proofs and differently structured BigInt experiments are in [UNSHARP_REVIEW.md](./UNSHARP_REVIEW.md).

## Work, memory and yielding

Keep the existing document-wide 384,000,000 weighted source-pixel work ceiling, including hidden layers and every enabled positive-opacity entry. The proposed fixed weights do not depend on ordinary photos rarely reaching the exact fallback:

| Entry | Work | Gaussian cache |
| --- | --- | --- |
| Disabled or opacity 0 | 0 | 0 |
| Active amount 0, sigma 0 or threshold 255 | sourcePixels | 0 |
| Every other active entry | `sourcePixels*(2K+40)` | Existing ring |

One nonidentity sigma-1 entry costs 54 per source pixel, admitting at most 7,111,111 source pixels if no other entries consume work. Sigma 3 costs 78 (4,923,076 pixels), sigma 10 costs 162 (2,370,370), sigma 50 costs 642 (598,130). Overall source dimension and pixel ceilings still apply. No automatic amount/sigma/precision reduction is allowed after a limit failure. Changing an identity to a computing entry can require substantially more work and memory; reject atomically.

For source size S, width W, height H, let `M=min(H,K)`. The only spatial binary cache is the current ring `Rcache=16*W*M+4*M+8*K`, accounting Uint32 RGBA horizontal rows, Int32 row tags and bases, and Uint32 weights. Use the maximum cache of sequential active entries, not their sum. A zero-computation identity has Rcache 0. One RGBA candidate is owned by the helper; only that candidate returns, with ring/kernel references out of scope before later geometry or another entry.

Renderer retained-filter scratch remains `max(8*largestGeometryPixels,8*S+maxRcache)+canvasPixels`, combined with existing group/clipping/positioned-mask reserves. Baking's materialization phase remains encoded input reserves plus `(alphaAsset?17:12)*S + maxRcache + 64KiB`; subsequent encode/read/publication phases remain unchanged. Baking must include unsharp when estimating the actual normalized stack before encoded input reads. The phase ledger names binary buffers, not total RSS, codec internals or garbage-collection deadlines. Bounded per-channel BigInt/scalar state adds no source-sized allocation.

Use the existing shared tap counter for horizontal and vertical work. Yield after `K*floor(65536/K)` tap visits, never exceeding 65,536 visits per chunk. Since positive sigma gives K>=3, even a generic all-tie image evaluates at most 21,845 output pixels (65,535 bounded channel fallbacks) between such yields. Typed-array allocation and the runtime scheduler are not hard real-time guarantees. Entry-opacity interpolation keeps its existing bounded row yield. No global/brush/effect scheduling changes are required.

## Integration and ownership

Backend implementation should expose `normalizeUnsharpParameters(parameters)` from a small `server/unsharp-mask.mjs`, plus the compiled amount/channel finisher needed by the shared Gaussian helper. The helper is independent of global color normalization and creates complete plain copies. Extend `sourceSpatialPlan`/`sourceSpatialCandidate` to recognize the new parameterized source kind without changing existing blur/sharpen arithmetic; reuse its unrounded sums, not its rounded blur result.

`server/layer-filters.mjs` should expose source-specific `LAYER_FILTER_RANGES`, `LAYER_FILTER_PARAMETERIZED_KINDS` and `normalizeLayerFilterParameters(kind,parameters)`. Its source-only kind/range map adds `unsharp_mask:[0,0]`; parameter normalization dispatches unsharp locally and otherwise delegates to existing `normalizeParameters`. Leave `server/color.mjs` global lists and global parameter functions unchanged. Update stack normalization/partial merges, work, maximum-ring calculation and candidate dispatch through these source seams. Native only adds the new capability and accurate limitations; ordinary filter dispatch, graph validation and bundle admission already reuse stack normalization.

Shared schemas must define a source-filter parameter union separate from the global adjustment parameter union. `add_layer_filter` admits the new kind/value0 and family; update arguments permit that family for later target-kind validation. Global `add_adjustment`, `update_adjustment` and recipe adjustment slots reject unsharp and its fields. Empty parameter objects retain their existing family-specific conventions. Source recipe steps already derive their shape from `add_layer_filter`; native recipe normalization already calls `normalizeLayerFilter`, so complete defaults and metadata-only resource staging flow through the same seam. Preserve the current five-command recipe allowlist.

Portable graph/bundle validation must reject malformed unsharp records before image I/O. Older readers already reject unknown filter kinds, including disabled entries; no graph-version migration or ignored new field is needed. Nonempty filter stacks retain the current layered PSD export refusal until explicit bake/clear. Baked source-RGB PNG, separate alpha, originals, additional masks, transforms, clipping links and generated provenance continue to use existing ownership rules.

Protected target rejection and original-context protected RGB restoration remain exact. Generated exclusions remain later compositing rules. Preview, full render, bake and recipe application must all use this same source candidate. Read-only recipe validation does no render, image, model, font or asset writes; application remains one ordinary atomic commit. Source writes and model/provider behavior are outside this change.

Root owns shared schemas/MCP/status/SDK/public docs. Backend owner owns helper, stack/work/cache/bake integration, native capability, owner tests and this design. Reviewer owns independent arithmetic/native audits. UI owner owns source-only parameter types/editor/discovery/recipes and browser evidence, with no changes to global controls.

## Prototype evidence and production acceptance

The test-only files `test-results/unsharp-evaluation/{prototype.mjs,probe.mjs,report.json}` perform 189 tiny-image cases against a direct 2D BigInt oracle, 100,000 seeded rational checks, and exact default parity against the released source-sharpen helper. The independent review separately covers 250,000 seeded cases, 63,037 near-half cases, 4,200 extrema over every eligible exact amount plan and 240 small-image cases. The integrated helper was then checked with the same owner probe in `production-benchmark.mjs`, with results in `production-report.json`.

Three-run full-candidate medians on Node 22.14.0, Apple M5 Max, Darwin arm64:

| Image and settings | Median ms | Maximum 5 ms heartbeat gap |
| --- | ---: | ---: |
| 1024² mixed alpha, amount100/sigma1 | 68.6 | 6.39 ms |
| 1024² opaque, amount25/sigma1 | 74.0 | 5.28 ms |
| 1024² opaque, amount133.33/sigma1 | 71.5 | 5.31 ms |
| 1024² all-channel ties, amount5/sigma.3977 | 155.3 | 8.34 ms |
| 1024² all-channel ties, amount37/sigma.528474 | 157.9 | 5.84 ms |
| 8192×128 ties, amount5/sigma.3977 | 157.0 | 6.04 ms |
| 128×8192 ties, amount37/sigma.528474 | 151.0 | 5.86 ms |
| 1024² opaque, amount133.33/sigma3 | 182.5 | 5.45 ms |
| 1024² opaque, amount133.33/sigma10 | 548.3 | 5.39 ms |
| 1024×512 opaque, amount133.33/sigma50 | 1272.4 | 5.33 ms |

The sigma.3977 kernel `[0,2560,60416,2560,0]` on alternating opaque RGB80/208 columns produces exact residual ±10. Amount5% has reduced denominator20 and candidates79.5/208.5. The sigma.528474 kernel `[38,8192,49076,8192,38]` on RGB20/220 gives residual ±50; amount37% yields1.5/238.5. Tests offset the three RGB channels to keep three separate channel calculations. Each 1MP case executes over 3.13 million exact fallbacks. Timings include Gaussian/cache/output work and yielding, but exclude decoding, stack opacity, full rendering and PNG encoding.

The actual production helper subsequently measured 1MP medians49.5ms for default100% mixed alpha,57.9ms for25%,55.3ms for generic133.33%; adversarial5%/37% ties145.9/142.7ms; wide/tall ties142.6/137.8ms. The largest heartbeat gap was8.19ms. Generic sigma3 measured128.4ms, sigma10 383.1ms and half-MP sigma50 885.6ms. The same machine, three-run protocol, oracle and output checks were retained. These actual helper measurements support the unchanged uniform2K+40 admission rather than a promise of fixed execution time.

Owner `tests/unsharp-mask.test.mjs` passes8 checks covering strict source-only/default/partial normalization, all70 exact-rational amount plans with5,040 extrema,10,000 seeded channel cases,120 small 2D image cases, default sharpen parity, constant soft alpha and hidden colors, threshold equality and fractional alpha crossing, amount/opacity/order distinction, render/bake cache maxima, hidden identity-to-computing resource rejection before rendering, exact separate-alpha masked/transformed baking and actual wide fallback yielding. The independent9 checks add exact near-half cases, source-only recipes/portable validation, contextual/generated clipping protection, real publication rollback and a reachable8.192MP bake source whose encoded inputs fit without the ring but reject before reads when the ring is included. Existing bake tests now exercise all25 source kinds through the real encoder, with nondefault unsharp settings.

Production acceptance requires:

1. Exact oracle agreement for static/generic amounts, threshold equality and adjacent differences, half ties/clamps, all alpha values, constant RGB, hidden-color perturbations, tiny/zero/max sigma, amount/threshold identities, entry opacity and ordering. Default parity with fixed source sharpen and byte-exact old global/brush/effect fixtures.
2. Sparse/full/default/partial canonical parameters, wrong-family and global rejection, immutable copies, recipe complete settings across unrelated documents, no-I/O dry validation and atomic cumulative-work refusal including hidden/disabled-to-active and identity-to-computing updates.
3. Independent ring/render/bake resource thresholds before pixel reads, sequential maximum-cache accounting, inherited group/clipping/positioned masks, generated exclusion and protected-context RGB restoration.
4. Actual native preview/render/bake equality with separate alpha and transforms, original asset/source preview preservation, source-write guards, one-undo transaction/idempotency/portable/restart, stale/malformed/real persistence rollback with no new owned blobs left behind.
5. Source-only capability/editor/recipe gates, finite drafts and captured revision lifecycle, distinct Amount versus opacity behavior, and actual all-tie wide/tall production heartbeat measurements.

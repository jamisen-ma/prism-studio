# Native source filter: Local Shadows / Highlights

Implemented and verified in focused native acceptance, 2026-09-19. Independent arithmetic and resource review is complete. The owner and independent native suites pass, and actual production measurements are recorded below. Root owns the final full-suite and UI acceptance; the comparison records why this **source-only** filter was selected.

## Choice and primary references

The current roadmap has substantial filter infrastructure: 27 source kinds, per-entry RGB blending, explicit Bake, typed recipes and an editable whole-stack source mask. Global adjustment kinds remain24. `server/color.mjs` already has `shadows` and `highlights`, but both are pointwise additions proportional to squared pixel luminance. Their behavior must remain byte-identical.

| Candidate | Additional user value | Contract/implementation cost | Recommendation |
| --- | --- | --- | --- |
| Local Shadows / Highlights | A neighborhood distinguishes a dark subject from surrounding light, with independent shadow/highlight amounts and tonal widths. Adds spatial tonal control absent from the current pointwise controls. | One explicit alpha-weighted luminance neighborhood, bounded Gaussian row cache and tone tables. Needs an honest native curve, halo disclosure and workload admission. | **Choose this next.** It builds on verified Gaussian/protection/Bake infrastructure while adding useful behavior. |
| Photo Filter | Custom warming/cooling color with density and optional luminosity preservation. | Small pointwise implementation and UI, but its exact native tint/gamut policy still needs definition. Existing temperature, Color Balance and tint already cover much of the workflow. | Lower-risk alternative, less standalone gain now. |
| Selective Color | Edit color families independently, useful for foliage, clothing and product color. | Larger multi-range parameter/UI contract; relative versus absolute CMYK-like controls on RGB require explicit native range weights and color semantics. No color-managed CMYK is implemented. | Valuable later; do not invent implicit Photoshop equivalence. |

Adobe's [Shadows/Highlights documentation](https://helpx.adobe.com/photoshop/using/adjust-shadow-highlight-detail.html) describes separate amounts, tonal widths and a neighborhood radius, and warns that aggressive controls can produce halos. This motivates the workflow, not the algorithm below. Adobe's [Photo Filter controls](https://helpx.adobe.com/photoshop/using/applying-color-balance-adjustment.html) use filter/custom color, density and optional luminosity preservation. Its [Selective Color documentation](https://helpx.adobe.com/photoshop/using/mix-colors.html) distinguishes relative and absolute component correction and permits RGB input. Neither page specifies a pixel algorithm for Prism to reproduce.

## Public scope and parameters

Source kind `shadows_highlights`, label **Local Shadows / Highlights**, `value:0`, parameters:

```
{ shadows:25, highlights:0, shadowWidth:50, highlightWidth:50, sigma:3 }
```

- `shadows`, `highlights`: finite0..100, canonical0.01% increments. Positive Shadows lifts intermediate channels; positive Highlights reduces them. Negative amounts are outside this first scope.
- `shadowWidth`, `highlightWidth`: finite1..100, canonical0.01% increments. Small widths restrict the respective tonal support;100 reaches toward the opposite endpoint. A minimum1 avoids an undefined zero-width division and an extra discontinuous “only absolute black/white” mode.
- `sigma`: any finite0..50 source pixels, using the actual authored value without a floor. Zero uses each pixel's own quantized luminance. Tiny positive sigma may compile to an identity neighborhood but retains its positive-sigma admission charge.

The default gives a modest shadow lift. It is a visible treatment, not an identity preset. `shadows:0,highlights:0` is the explicit computational identity, regardless of other validated settings. Unknown/null/nonfinite parameters reject; omitted parameters use the complete defaults. Sparse valid stored objects use effective defaults without read-time graph rewrites. Authored creation/update and saved recipes write complete canonical copies. Partial updates merge with the existing effective parameters, retaining zero values. Use the existing exact centipercent normalization rule, not an epsilon tolerance.

Independent capability `layerFilterLocalTonePolicy:'alpha-weighted-local-tone-v1'`, together with source coordinates, the source kind and existing command support. No new commands. Source kinds are28; global `ADJUSTMENTS`, global parameter unions, global24 discovery and `update_adjustment` recipe slots remain unchanged. Do not redirect existing `shadows`/`highlights` to this algorithm.

This first slice omits midtone contrast, saturation compensation, black/white clipping, separate shadow/highlight radii, bilateral/edge-aware smoothing and HDR/high-depth processing. It operates on existing encoded-sRGB RGBA8 source data. It cannot reconstruct clipped or absent detail and does not promise hue/luminosity preservation or Adobe-equivalent results.

## Explicit pixel definition

The candidate sees the preceding source-stack RGB and effective source alpha, before retained geometry and display masks. The complete source participates, including pixels outside the visible crop. The stack mask applies later to the completed stack; it must not gate this neighborhood.

### 1. Quantized input luminance and local mean

For positive-alpha pixel RGB bytes, define an encoded-sRGB tone byte:

```
Y = floor((2126*R + 7152*G + 722*B + 5000) / 10000)
```

These fixed Rec709 coefficients sum to10000. This is intentionally a rounded encoded-RGB brightness measure, not linear-light radiometry. Its integer numerator is below2^22. Hidden RGB contributes nothing because all neighborhood sums multiply by the original alpha byte.

For sigma>0, reuse the already declared symmetric integer Gaussian: radius `ceil(3*sigma)`, K=2*radius+1, nonnegative integer coefficients summing Q=65536, same coefficient quantization and clamped-image edge extension as source Blur/High Pass. Compute the exact separable two-dimensional sums:

```
N = sum(Y * alpha * horizontalWeight * verticalWeight)
D = sum(alpha * horizontalWeight * verticalWeight)
L = floor((2*N + D) / (2*D))
```

The positive center ensures D>0 wherever output alpha>0. Sigma0 sets L=Y directly. Preserve output alpha exactly and skip every RGB write at alpha0, retaining hidden RGB bytes. Constant RGB at alpha1/128/255 has the same L independently of nearby alpha changes when all participating visible pixels share that RGB. No premultiply/unpremultiply byte loss is introduced.

Local L is explicitly quantized to one byte before selecting the tone response. This 256-level control map is a precision limit; do not call it a continuous mask or silently change it later. The existing Gaussian exact half-up proof applies: N≤65025*65536²<2^48, D≤255*65536²<2^40; the doubled quotient numerator is below2^49 and the nearest noninteger floor boundary is over32 division-rounding errors away. No per-pixel BigInt or epsilon is needed.

### 2. Two small tonal-response tables

Let A and T be the integer centipercent amount/width (amount0..10000,width100..10000). For a tone byte l, use:

```
distance = max(0, 255*T - 10000*l)
weight(A,T,l) = halfUp(65536*A*distance² / (10000*(255*T)²))
s[L] = weight(shadows, shadowWidth, L)
h[L] = weight(highlights, highlightWidth, 255-L)
```

The equations above use centipercent integers, not the displayed percentage values. Compile the512 entries with exact BigInt arithmetic once per computing entry into one `Uint32Array(512)` (2048 bytes), yielding every64 entries. A zero-Amount lane writes exact zeros without BigInt evaluation but can remain in this same bounded table. If both Amounts are zero, skip the entire table/candidate allocation. Do not retain BigInt arrays, rational objects or an additional table copy in the candidate loop. Normalization/resource planning is allocation-free and does not compile tables. Setup is bounded to512 writes/evaluations with roughly72-bit or smaller numerators, separately from weighted source-pixel work; root approved retaining the proposed pixel-work formulas without a fixed512 addition. Candidate benchmarks include this setup and its eight cooperative yields; there is no per-pixel BigInt.

Every s/h is0..65536. For equal settings, the tables mirror exactly. They are independent quadratic tonal supports. At full widths/amounts, the unrounded sum is bounded by `((255-L)²+L²)/255²≤1`; at interior integer L its gap from1 is at least508/65025, far larger than the combined table rounding error. Thus the quantized sum also cannot exceed Q. This is an additional consistency check, though the final curve only needs each weight individually bounded.

### 3. Endpoint-preserving native tone curve

Use local gain ratio `g=(Q+3*s)/(Q+3*h)`, between1/4 and4. For each original RGB channel C, calculate:

```
a = Q + 3*s
b = Q + 3*h
numerator = 255*a*C
denominator = b*(255-C) + a*C
candidate = floor((2*numerator + denominator) / (2*denominator))
```

This is a rational tone curve equivalent to `255*g*C/(255+(g-1)*C)`, with one final half-up rounding. Black0 and white255 remain exact, including individually clipped channels. For fixed local gain it is monotonic in C and stays within0..255; no gamut clipping is needed. Equal s/h is exact identity. Different gains across neighborhoods can change local contrast or create halos; monotonicity at a fixed L is not a guarantee of global image ordering. Channel ordering at the same pixel is preserved, but hue/saturation can change.

All a/b are integers in[65536,262144]. The numerator≤17,045,913,600<2^34, denominator≤66,846,720<2^26 and doubled numerator plus denominator<2^35. Integer operations are exact in Number. After doubling, noninteger quotient distance from an integer is greater than2^-27, while division half-ULP is at most2^-46, leaving over500,000× margin. The same bounded quotient rule gives exact half-up bytes, including ties.

Only after producing this candidate apply the existing filter blend mode and opacity. Amount changes the nonlinear gain before candidate rounding; opacity mixes the finished candidate and is not interchangeable. Normal's existing interpolation remains byte-identical. The shared stack mask still mixes final stack RGB against original effective RGB afterward; additional layer masks remain coverage after geometry.

The first probe used a convex RGB mix toward white/black. It made solid black helmet/background pixels gray at default settings. That algorithm is rejected. The endpoint-preserving curve retains black/white and gives a more useful photographic result without claiming to restore missing detail. Earlier exploratory files are marked `prototype-convex`/`convex-report`; only `prototype.mjs` is the proposed contract.

## Work, storage and scheduling

Let S=W*H, K=2*ceil(3*sigma)+1 and M=min(H,K). Computing positive-sigma entries need one4S candidate, a two-channel Uint32 horizontal ring (luminance numerator and alpha denominator), one prepared input row and the2048-byte tone table:

```
Rlocal = 8*W*M + 3*W + 4*M + 8*K + 2048
```

The prepared row is `Uint16 Y*alpha` plus `Uint8 alpha` (3W); products≤65025 fitUint16. Ring numerator≤65025*65536<2^32 and alpha denominator≤255*65536<2^24. Tags are4M, bases/weights together8K. No full luminance image, Float32 source, third RGBA plane or persistent global table is needed. Sigma0 uses only the2048-byte response table and candidate. Dual-zero amount returns the input as identity, with no candidate/table/cache. Callers must still apply nonnormal blending to that identity candidate.

Proposed weighted source work under the existing384M budget:

| Entry state | Work | Temporary cache |
| --- | --- | --- |
| Disabled or opacity0 | 0 | 0 |
| Both amounts0, active | S | 0 |
| Computing sigma0 | 16*S | 2048 bytes |
| Computing positive sigma | (2*K+20)*S | Rlocal |
| Any active nonnormal filter blend | Add40*S | Existing bounded scalar blend scratch |

The additional20 conservatively covers row luminance preparation, output tone mapping/table lookup and ordinary stack interpolation; the K-tap terms cover horizontal and vertical sums. Work remains positive for a quantized identity neighborhood. Active structural protection and source-edit/Bake-prefix guards never depend on the result looking unchanged. At default sigma3, Normal costs58*S: one filter admits at most floor(384M/58)=6,620,689 source pixels before other filters/masks. Sigma50 costs622*S and admits617,363 pixels. Sigma0 work admits up to the existing24MP limit, subject to buffer/Bake limits. These are admission limits, not a blanket24MP feature claim or a runtime guarantee.

Reuse the existing sequential source-filter maximum-cache concept, extended to include this helper's complete Rlocal. Renderer source phase stays8S+Rmax compared with8*largestGeometry and the deferred filter-mask phase; retain existing group/clipping/positioned-mask reserves and the graph-wide persistent Gaussian Noise table afterward. Include the new cache in the masked-source preread predicate `max(12S+Rmax,8S+C+LUT)+sharedNoise` and direct evaluator admission. Hidden entries count. A resource-changing intermediate transaction step must still validate before later pixel operations.

Bake's source-filter phase remains `encodedWorking+encodedAlpha+(hasAlpha?17S:12S)+Rmax+64KiB+sharedNoise`. The deferred whole-stack mask phase, source decode, bounded PNG staging and publication phases remain separate maxima. The local ring/row/tone table must become unreachable before returning the candidate; it does not overlap later geometry or the filter-mask callback. Count the explicit2048 table even though existing auxiliary reserves are conservative. Bypass values retain existing cheaper admission where applicable. Named buffers are not an RSS/codec/disk guarantee.

Yield before the next batch would exceed65,536 weighted visits, across rows: count horizontal/vertical K taps, row preparation and per-row bases setup. Sigma0 yields at most65,536 pixels. The new kind's ordinary stack interpolation should use at most65,536 pixels per row batch, and preserve the existing tighter16,384-pixel blend yield for nonnormal entries; do not change old kinds' loops. Allocation and PNG are separate phases, while table setup yields every64 entries; no millisecond deadline is promised.

## Integration, persistence and protection

Recommended helper seam: `normalizeLocalToneParameters`, allocation-free `localTonePlan(entry,width,height)` and async `localToneCandidate`. The new helper can import the existing exported Gaussian compiler without changing its algorithm or other consumers. Add the kind only to source range/parameter dispatch, work/max-cache selection and candidate dispatch; avoid broadening global `ADJUSTMENTS` or `SOURCE_SPATIAL_FILTER_KINDS` without an explicit dispatch branch.

Normalize partial updates and recipe defaults through this same source helper. Old readers reject the unknown stored filter kind; no silently ignored new layer field is needed. Existing arrays/masked wrappers serialize unchanged except for the new canonical entry. Recipes can save/import a definition as metadata; Validate/Apply require the exact new policy/kind/coordinates and existing command support. Applying a recipe remains one revision/undo and preserves a target stack mask. Masked-stack capture remains refused by the existing recipe scope.

No new asset writes occur for authoring or dry recipe validation. Live render, source previews where applicable, retained geometry, original-context protected RGB restoration, generated exclusions, Bake and portable reopen must all use the same candidate. Never weaken protected-target rejection, filtered-source painting/extraction/placement guards or earlier-protected-context active Bake rejection. Bake retains original source assets, separate source alpha, masks/transforms/styles/provenance and uses the existing whole-transaction new-assets-only rollback scope. PSD's current filter-stack refusal/explicit Bake path is unchanged.

### Exact implementation seam map

The following maps the implemented seams. Existing generic resource, Bake, recipe and portable pathways receive the new source kind without changing their formulas or persistence formats:

| File / seam | Implementation | Preserved invariant |
| --- | --- | --- |
| `server/local-tone.mjs` | Export `LOCAL_TONE_POLICY`, `normalizeLocalToneParameters`, allocation-free `localTonePlan`, async `localToneCandidate`, async `compileLocalToneTables` and `localToneChannelByte`. The compiler returns a fresh owned table and exports no mutable shared state. Import existing `compileSourceGaussian`. | Defaults/strict keys/canonical percentages first; no input mutation or table compilation in planning. Return input only for computational identity/inactive; computing candidate alone escapes. |
| `server/layer-filters.mjs`: `LAYER_FILTER_RANGES`, `LAYER_FILTER_PARAMETERIZED_KINDS`, `normalizeLayerFilterParameters` | Add only `shadows_highlights:[0,0]` and dispatch to source normalizer. | Global `ADJUSTMENTS`/`PARAMETERIZED_ADJUSTMENTS` and legacy shadows/highlights remain unchanged. |
| `editedFilterEntries` / `editedFilterStack` | Reuse the existing normalized-entry parameter merge and `retainFilterMask`; no special update command. | Incoming partial fields override effective defaults/current values; omitted fields persist; explicit zeros are not treated as absent; complete canonical params persist. Existing mask wrapper remains independent. |
| `candidateWork` / `filterWork` | Add local work16S or(2K+20)S, dual-zero1S, disabled/opacity0 zero; keep `layerFilterBlendWork` additive. | No free active identity loop. Both zero with Multiply still costs41S and applies self-blend. |
| `layerFilterSpatialCacheBytes` | Keep its existing public name and sequential maximum, adding a local-plan branch even for computing sigma0's2048-byte LUT. | `max`, not sum; count the table/row/ring exactly once. No change to global shared-noise lifetime. Do not add this kind blindly to the legacy Gaussian dispatch list. |
| `applyLayerFilters` | Extend identity detection and candidate dispatch before the scalar `adjustmentTransform` fallback. For this new kind only, bound Normal interpolation rows to65,536 pixels; existing nonnormal rows remain16,384. | Candidate sees the whole preceding source; later blend/opacity and stack-mask mix retain existing order. Metadata work/complete-source preflight precedes pixel loops. |
| `validateLayerFilterResources` | Existing first pass picks up new work, existing leaf phase picks up new maximum cache. Preserve graph-wide shared-noise addition and hidden-node accounting. | No special new exemption in groups/clipping/positioned-mask sums. Active-mask leaves still pass the complete-source predicate as well as additional graph scratch. |
| `server/filter-mask.mjs`: `estimateFilterMaskSourceBytes` | Formula unchanged; receive new Rmax from its caller. | `max(12S+Rmax,8S+C+LUT)+T`; callback is deferred, so local cache is not added to the mask branch. Disabled/density0 retains old unmasked admission while validating metadata. |
| `server/filter-bake.mjs`: `estimateFilterBakeBytes` / `bakeFilterSource` | Formula and I/O order unchanged; source helper cache flows through existing `layerFilterSpatialCacheBytes`. | Actual encoded stats plus Rmax are checked before `readBoundedHandle`/decode. Local cache is only in filter phase, not retained through mask/encode/publication. Existing rollback and private PNG staging stay intact. |
| `server/native.mjs`: `LAYER_FILTER_COMMANDS` mutation branch | Reuse `editedFilterStack` then candidate `validateGraph` before assignment. Add capability/accurate limit copy only. | Identity→computing, sigma, enabled, opacity and blend changes validate the entire staged graph before a later transaction pixel operation. No special source/RGB writes for authored metadata. |
| `server/edit-recipes.mjs`: `normalizeEditRecipe` / `stageEditRecipe` | Existing `add_layer_filter` delegates to source normalization and stores complete params; existing per-step staging handles cumulative resources. | No table/pixel/image/font/model work in save/Validate. `update_adjustment` stays global-only. Bindings, hashes, one-undo Apply, mask retention and late-step rollback remain. |
| `server/project-bundle.mjs`: `validateGraphAndReferences` | No new archive structure or allowlist exception. Native graph validator recognizes the new kind. | Unknown fields/ranges/nulls reject before asset reads; old readers reject the kind; arrays/wrappers remain unchanged; import is inert metadata until render. |
| Root-owned `shared/commands.mjs`, `shared/edit-recipes.mjs` | Add source-only strict parameter schema/kind/range; existing source union and recipe factory pick it up. | Global kind/parameter union and adjustment slots reject it. Shared partial-update schema may structurally accept a source parameter shape; native resolves exact stored kind and validates the final merge. |
| Root-owned `server/index.mjs`, `server/mcp.mjs` | Forward the independent policy in status and describe controls/order/work on existing filter commands. | Native source discovery28, global24; no new command and no legacy-bridge admission. |
| Client-owned API/control/recipe capability helpers | Add source-only typed parameters and editor; exact independent policy+source coordinates+kind gate. Capture complete settings; don't change global adjustment controls. | Definition capture/import can be metadata-only; execution validates policy. Unsupported saved values/drafts stay visible rather than silently falling back. Existing filter-mask and blend policy gates remain additive. |

### Pre-allocation boundary fixtures

Exact arithmetic fixtures are saved in [metadata-boundaries.json](../test-results/local-tone-evaluation/metadata-boundaries.json). The maintained owner and independent suites exercise the complete masked-source, combined retained graph, sequential cache and exact Bake thresholds with dummy hash metadata and pixel/file-content spies; no large image allocation is required to test refused cases.

1. **Weighted work neighbors.** At width8192, default sigma3 Normal is admitted at height808 (383,909,888 visits) and rejected at809 (384,385,024). With an evaluating stack mask, heights710/711 give383,877,120 /384,417,792. With a nonnormal blend, heights478/479 give383,746,048 /384,548,864. Repeat hidden, disabled→enabled, opacity0→positive, dual-zero→computing and recipe cumulative cases. A sigma0 Normal computing24MP source costs exactly384M; fixed setup does not change that definition.
2. **Combined retained graph envelope.** Canvas/source8192×64, two isolated ancestors plus a clipping chain, other-leaf1px Gaussian Noise, and unfeathered positioned-mask bitmap source areas totalling127,850,000 pixels. The retained mask areas can be five6000×4000 descriptors plus one3925×2000 descriptor. Existing retained source/graph term is24S, positioned reserve2B, shared noise4096. Local sigma0 adds2048 and totals268,289,056 bytes (admitted). Sigma.01 adds223,268 and totals268,510,276 (rejected), though its work easily fits. Test update followed by rasterize/fill in a transaction: failure must occur before that later operation reads pixels.
3. **Complete masked-source predicate independently necessary.** An active dual-zero local entry still has an owned stack and structural active status. With a rectangle stack mask and graph-wide Gaussian table, source8192×2730 gives12S+4096=268,374,016 bytes; height2731 gives268,472,320 and must reject, even though additional graph scratch and9S weighted work fit. A feathered bitmap mask at density.5 instead uses13S+256+4096: heights2520/2521 give268,374,272 /268,480,768. Disabled/density0 mask is the explicit cheaper bypass, with its record still validated.
4. **Bake exact ceiling before bytes are read.** Source8192×1000 with separate alpha, an active Gaussian Noise entry, an enabled rectangle stack mask and encoded working/alpha sizes70,000,000 /59,099,776 bytes. Local sigma0 gives filter-phase exactly268,435,456 bytes; sigma.01 gives268,656,676, over by221,220. The latter's total source work, including Noise and mask, is344,064,000. Other phase totals are lower: decode202,831,872, mask235,599,872, encode236,648,448 and publication245,889,024. Pure estimates verify the admitted boundary; sparse invalid asset files allow the rejected case to prove refusal before digest/decode/temp PNG creation, without allocating their content.
5. **Sequential caches are a maximum.** On1024² source, local sigma1 needs62,548 bytes and legacy source Blur sigma3 needs311,524; Rmax is311,524, not374,072. Test both orders and a later resize large enough for geometry to dominate. The cache must not be added to a larger geometry phase or to the deferred mask phase. A different Gaussian Noise leaf still contributes its persistent4096 once after the graph peak.

Use `LIMIT_EXCEEDED` plus unchanged project/assets/preview-cache assertions for rejected native calls; recipe Validate reports the offending step without publication. Resource calculators and strict normalization must reject malformed parameters in disabled and dual-zero entries as well.

## Design probe evidence

Run `node test-results/local-tone-evaluation/probe.mjs`. The proposed prototype passes48 complete images against a separately assembled direct2D BigInt oracle (including sigma0, minimum subnormal, .01, .3977,1,3);48 hidden-RGB perturbation comparisons;76,800 tonal-weight convex-bound checks;256,002 exact BigInt channel comparisons including literal12.5→13 and242.5→243 ties; and constant-RGB alpha1/128/255 checks. A neighborhood discriminator places equal gray64 pixels among dark versus bright surroundings: sigma1 produces81 and64 respectively, while sigma0 produces73 at both. This is useful behavior absent from a purely pointwise control. These are owner design probes, not maintained acceptance or an independent production audit.

The [report](../test-results/local-tone-evaluation/report.json) records three-run candidate medians on Node22.14, Darwin arm64, Apple M5 Max. Opaque inputs measure the full visible path:

| Image | Sigma | Median | Largest observed5ms heartbeat gap |
| --- | --- | --- | --- |
| 1024×1024 | 0 | 15.4ms | 5.58ms |
| 1024×1024 | 1 | 55.0ms | 5.62ms |
| 1024×1024 | 3 | 118.1ms | 6.02ms |
| 1024×1024 | 10 | 298.6ms | 5.30ms |
| 768×768 | 50 | 723.8ms | 5.18ms |
| 8192×128 | 3 | 107.7ms | 5.12ms |
| 128×8192 | 3 | 102.1ms | 5.13ms |

These include candidate/cache/table setup and yielding; exclude decoding, composition, mask mixing, blend, PNG and publication. Sigma50 uses an admitted0.59MP image. Numbers support the proposed conservative work schedule, not a latency guarantee. The existing public NASA photograph was inspected before/after at default settings; `photo-default.png` shows the selected endpoint-preserving treatment and `photo-convex.png` the rejected black-lifting version. Original fixture bytes are unchanged. The fixed curve gives a subtle shadow treatment, not a dramatic generated reconstruction.

The final prototype now includes the64-entry setup yields. Across100 table preparations, mean elapsed time including a separate synchronous byte-equality check was0.152ms with one zero lane and0.172ms with both lanes active. These are upper-bound setup measurements with verification overhead, not pure compiler timings. The separate production measurements below include the integrated helper.

Visual review artifacts (512×512) are [original](../test-results/segmentation-public-fixture.png), [selected default output](../test-results/local-tone-evaluation/photo-default.png) and [rejected convex output](../test-results/local-tone-evaluation/photo-convex.png). Original SHA-256 is `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`; selected output is `9e58ec1e45f8f5d3a130d4d5f179fc3122dc4c9c2cff0dac65b33c2519959310`; rejected output is `efe25c3fc7e448d39ac088c04310d0a63467f6f54d31964df8c8845013ba0056`. [artifact-manifest.json](../test-results/local-tone-evaluation/artifact-manifest.json) records sizes and hashes, including the final prototype/probe/report. Existing fixture provenance identifies NASA astronaut Eileen Collins; no new stock/model/provider download or people synthesis was used.

## Production acceptance and measurements

The helper is implemented in `server/local-tone.mjs`; its only full image allocation is the candidate RGBA. A computing entry owns a 2 KiB response table, with row and rolling Gaussian storage only for positive sigma. Its metadata plan creates no typed arrays. The existing filter evaluator adds this cache to the sequential maximum and releases the helper's cache before stack-mask evaluation and geometry. Existing global adjustments and Gaussian/RGB blend algorithms are unchanged.

`node --test tests/local-tone.test.mjs tests/local-shadows-highlights-audit.test.mjs` passes **16/16**. The eight owner tests cover strict source-only normalization and fresh complete defaults; 16,384 independent BigInt table entries with 64-entry yields; 36 direct-2D BigInt images and hidden-color variants; low-alpha constant colors; 76,800 exact channel ratios and literal half ties; fixed-gain monotonicity/endpoints; all 26 blend modes and final stack-mask ordering; identity self-blends; sequential cache and exact Bake boundaries; sparse updates and metadata-only recipes; real persistence failure; Bake/Undo/portable source-byte retention; and wide-source yielding. The eight independently authored native tests add quantized-luminance ordering, separate source alpha, protected/generated clipping contexts, malformed portable refusal before image reads, cumulative recipe behavior, late Bake/brush rollback, graph-wide shared-noise and positioned-mask admission, and complete masked-source thresholds.

The targeted adjacent owner sweep passes **79/79** across layer filters, color mixer, source spatial filters, Unsharp Mask, Noise, filter blends, High Pass, Bake and filter masks. Its catalogs now exercise all 28 source kinds through actual PNG Bake, all 28×26 source blend combinations, and the final stack-mask mix. The source discovery is 28 and global discovery remains 24. Root's schema and official SDK checks run separately.

Run `node test-results/local-tone-evaluation/production-benchmark.mjs` to regenerate the [production report](../test-results/local-tone-evaluation/production-report.json). Three-run medians below use the actual helper and actual `applyLayerFilters` on opaque inputs, with both tonal amounts active, Node v22.14.0 / Darwin arm64 / Apple M5 Max. The whole-stack column includes input copying, response-table setup, candidate construction and Normal entry interpolation. It excludes image decoding, compositing, stack-mask work and PNG output.

| Source | Sigma | Candidate median | Whole-stack median | Largest observed 5 ms heartbeat gap, either path |
| --- | --- | --- | --- | --- |
| 1024×1024 | 0 | 11.2 ms | 25.6 ms | 6.36 ms |
| 1024×1024 | 1 | 60.6 ms | 58.3 ms | 5.48 ms |
| 1024×1024 | 3 | 104.3 ms | 113.1 ms | 5.59 ms |
| 1024×1024 | 10 | 288.2 ms | 290.3 ms | 5.15 ms |
| 768×768 | 50 | 723.6 ms | 735.6 ms | 7.14 ms |
| 8192×128 | 3 | 109.9 ms | 116.3 ms | 5.32 ms |
| 128×8192 | 3 | 102.5 ms | 112.5 ms | 5.14 ms |

The measurements are separate warmed runs, so small ordering differences between the helper and stack columns are timing variation. They support the declared conservative admission weights and cooperative scheduling, not a latency or total-process memory guarantee. The sigma50 workload stays within its admitted 366,870,528 weighted source visits. Across 1,000 preparations, actual 512-entry compiler means were 0.130 ms with one zero lane and 0.138 ms with both lanes active, including all eight setup yields. A direct dual-zero compiler probe measured 0.113 ms, but the production candidate bypasses that compiler entirely for dual-zero amounts.

The actual production photo matches the reviewed prototype in every decoded byte and in its final PNG bytes. [photo-production.png](../test-results/local-tone-evaluation/photo-production.png) is 692,832 bytes with SHA-256 `9e58ec1e45f8f5d3a130d4d5f179fc3122dc4c9c2cff0dac65b33c2519959310`. The production report pins the helper, caller, maintained owner test, benchmark and output hashes. This remains an explicitly defined native source-neighborhood treatment, without Adobe algorithm parity or replacement of the legacy pointwise adjustments.

Browser acceptance also exposed an execution-sensitive first-render failure in the preexisting global Shadows scalar path. The narrow dispatch refactor preserves its defined arithmetic and now passes independent fresh-process and browser comparisons. See [the separate stability finding](SCALAR_TONE_STABILITY.md); it is not a change to the local-neighborhood algorithm or a deliberate reinterpretation of legacy pixels.

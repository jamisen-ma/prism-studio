# Local Shadows / Highlights: independent design review

Reviewed 2026-09-19. The source-only design was approved and implemented. **The independent native audit passes8/8; no backend or initial client-source blocker was found.** Browser acceptance and the final integrated suite remain separate owner work. This file retains the numerical design review and records production evidence below. The reviewer changed only tests/docs. The controlling contract is [LOCAL_SHADOWS_HIGHLIGHTS_DESIGN.md](LOCAL_SHADOWS_HIGHLIGHTS_DESIGN.md).

## Utility and scope

The new neighborhood response adds behavior that the current pointwise `shadows` and `highlights` cannot provide. An independent nine-pixel fixture places gray64 inside black or white surroundings: sigma1 produces84 versus64, while sigma0 produces73 in both. This also illustrates its limitation: a dark pixel within a sufficiently bright neighborhood can receive no shadow lift. Sigma controls the neighborhood used to classify tone; it is not edge-aware subject isolation. The local mean is quantized to256 levels, and changing neighborhoods can produce halos or change local ordering. The guide should retain these statements alongside the source-pixel sigma units.

The endpoint-preserving rational curve is preferable to the rejected white/black convex mix. I inspected the existing public photograph and proposed default output: the subtle lift preserves the black helmet and background. Exact black/white channels cannot be recovered or moved; partially clipped RGB can change hue/saturation. Fixed-gain channel ordering is preserved, not luminance or hue. These are appropriate explicit native semantics, not Photoshop pixel parity. Adobe's [Shadows/Highlights controls](https://helpx.adobe.com/photoshop/using/adjust-shadow-highlight-detail.html) establish the usefulness of amounts, tonal widths and neighborhood size, and warn about halos; they do not specify the proposed formula.

The comparison with Photo Filter and Selective Color is reasonable. A neighborhood response adds more distinct capability than another pointwise tint, while keeping a smaller contract than multiple selective color families. Keep the new kind `shadows_highlights` source-only, `value:0`, and its independent policy. Existing global24 kinds and pointwise algorithms remain unchanged. Old readers already reject unknown filter kinds; no permissive new persisted layer field is needed.

## Numerical contract

The three explicit quantization stages are justified and must remain separate:

1. Rounded encoded-RGB Rec709 tone byte, using integer coefficients2126/7152/722 over10000. This is not linear-light luminance.
2. Alpha-weighted Q65536 integer Gaussian mean, rounded to local byte L before LUT lookup.
3. One final half-up RGB rational curve; existing entry opacity/blending and later whole-stack masking follow afterward.

For the Gaussian mean, N≤65025·2^32 and D≤255·2^32. All integer intermediates, including2N+D, are exact below2^49. The floored quotient is at most255.5; its rounding error is at most2^-46, while any nonintegral distance from an integer is at least1/(2D)>2^-41. Thus Number division cannot move the result across a floor boundary. The existing positive-center proof covers every finite sigma through50, including subnormal values whose side weights underflow to zero. Output alpha>0 therefore implies D>0.

The512 response entries use canonical centipercent integers and exact BigInt setup. No float square or epsilon should substitute for this setup. Each response is bounded byQ and decreases monotonically toward the opposite tone. At full amounts/widths, the continuous pair sums to at mostQ; interior integer levels have at least508/65025 margin before rounding, so the two rounded responses cannot sum aboveQ. The final curve does not need this combined bound, but it is a useful invariant.

For a=Q+3s and b=Q+3h, a,b∈[65536,262144]. The denominator is a weighted sum of a/b with weights totaling255, so it is positive and below2^26. Numerator≤17,045,913,600<2^34; doubled numerator plus denominator stays below2^35. The closest noninteger floor boundary is over2^-27 away, versus at most2^-46 division error. The final half-up result is therefore exact in Number, including ties, without per-pixel BigInt. Independently constructed ties `(C,s,h)=(5,34488,12)` and `(250,12,34488)` evaluate to12.5→13 and242.5→243.

Black0, white255 and equal s/h are exact. At a fixed gain, the curve is monotonic. The dual-zero amount shortcut must return the input candidate without a table or ring, but a nonnormal blend must still execute: identity RGB128 under Multiply becomes64. A coincidentally equal-gain pixel or an identity Gaussian kernel does not exempt a positive computing entry from work/protection rules.

## Alpha and stage boundaries

Compute from the complete preceding source-stack RGB and effective source alpha, after separate alpha-asset combination and before geometry. Hidden RGB must neither contribute to the local mean nor be overwritten. Source RGB at effective alpha0 must survive exact Bake materialization even where the original working alpha is positive and the separate cutout alpha is zero.

The whole-stack filter mask belongs after the complete stack. It must not mask the Gaussian input, alter counters, or restrict source neighborhoods to visible/captured mask regions. The independent prototype is exercised through the existing `mixFilterMask` seam to pin this ordering. Additional layer masks, positioned wrappers, clipping and ancestor opacity remain downstream display coverage. `renderLayer({filters:false})` must continue bypassing the new entry as it bypasses old entries.

Keep existing original-context protection restoration and generated-layer exclusion. Dual-zero amounts still form a structurally active entry when enabled/positive opacity, so protection and earlier-protected-context Bake refusals still apply. Source pixels are not newly editable because the candidate happens to be identity or the whole-stack mask hides it.

## Resource and scheduling review

The proposed complete temporary cache is correct for the prototype's reachable typed buffers:

`Rlocal = 8·W·min(H,K) + 3·W + 4·min(H,K) + 8·K + 2048`.

It contains the two-channel Uint32 horizontal ring, one Uint16 luminance-times-alpha row, one Uint8 alpha row, Int32 tags/bases, Uint32 Gaussian weights and one512-entry Uint32 response table. Horizontal numerator maximum65025·65536 fitsUint32; the vertical sum uses exact Number integers. There is no full luminance plane or retained BigInt array. The2KiB table remains required at sigma0. Dual-zero amounts need neither table nor candidate/cache.

Use the largest cache of sequential entries, not their sum. The local helper returns only its candidate; its ring, prepared row, weights, tags, bases and LUT must be out of scope before the caller starts geometry or deferred stack-mask preparation. Gaussian Noise's4KiB table is different: it remains persistent and must still be added after the graph maximum and in every Bake phase. Existing isolated-group, clipping-chain and positioned-mask reserves stay in the combined graph envelope.

All admission remains metadata-only. Include Rlocal in graph source scratch, direct evaluator admission, the complete masked-source predicate `max(12S+Rmax,8S+C+maskLUT)+sharedNoise`, and Bake's `encoded+(alpha?17:12)S+Rmax+64KiB+sharedNoise` filter phase. Compare the latter with decode, deferred mask, encoder and publication phases rather than adding sequential phases. These are named buffer bounds, not RSS/native-codec/disk guarantees.

Independent arithmetic confirms meaningful boundary fixtures:

- An8192×1000 alpha-backed Bake with encoded input sizes70,000,000 and59,099,776, a geometric stack mask and Gaussian Noise reserve lands exactly at256MiB for computing sigma0. Sigma0.01 adds221,220 cache bytes and must reject before source reads; its344,064,000 work remains below384M.
- A structurally active dual-zero entry under a geometric stack mask still needs the before/after source surfaces. With a4KiB shared reserve,8192×2730 fits the complete-source predicate;8192×2731 exceeds it despite zero local cache and low work.
- Sequential sigma1 local tone and sigma3 RGB Blur at1024² need cache311,524 bytes, not the sum374,072.
- Sigma50 at8192×75 costs382,156,800 visits and4,944,532 cache bytes. Sigma0 at24MP exactly consumes384M before any blend, other entry or stack-mask work. Default sigma3 admits roughly6.62MP, not every24MP image.

The agreed work weights are reasonable relative to the owner's measured candidate timings: active dual-zero1S, computing sigma0 16S, positive sigma `(2K+20)S`, disabled/opacity0 zero, and existing nonnormal blend +40S. Weight counts describe admission, not a wall-clock deadline. Treat LUT setup separately: at most512 entries with a yield every64 and a zero-amount lane shortcut. Preserve weighted Gaussian visits bounded by65,536, sigma0 pixel yields, and the tighter existing nonnormal blend loop. The independent probe was rerun after the owner added asynchronous table setup.

## Implementation acceptance still required

Production must add the new kind to source-only parameter/default/partial-update/recipe dispatch without modifying global unions. Validate all settings even for disabled, zero-opacity and dual-zero entries; preserve explicit zero during partial merges and arbitrary finite sigma, including subnormal values. Complete canonical new writes coexist with sparse effective-default reads without rewriting graphs. Portable definitions must fail before asset reads when malformed. Recipes must keep no-I/O validation and preserve a target's filter-mask wrapper; masked-stack capture still refuses discarded scope.

Required maintained tests should concentrate on native prerequisites not proven by this prototype: separate alpha before filtering and raw alpha restoration after Bake; source filter ordering/opacity/blending; protected/generated/isolated/clipped and positioned-mask contexts; exact wrapper/ordinary array behavior; every resource-changing transaction step before subsequent image access; real persistence failure and late mixed-transaction asset rollback; original-source byte retention; portable/restart; and new UI capability/draft/late-result ownership. No durable receipt or new mutation command is needed.

## Independent evidence

Run `node test-results/local-tone-review/probe.mjs`. The [report](../test-results/local-tone-review/report.json) records97 complete images against an independently compiled direct2D BigInt oracle,96 hidden-RGB perturbations,10,752 exact table entries,150,000 exact channel comparisons,1,000 fixed-gain monotonic sweeps, two independently constructed literal half ties, an actual deferred-mask stage check, identity Multiply and phase arithmetic. It includes width/height asymmetry, ring wrap, all alpha0/1/128/255, sigma0/minimum subnormal/.3977/.528474/1/3 and a maximum-radius singleton. Input bytes remain unchanged.

No numerical or phase-lifetime blocker remained in the reviewed proposal before production approval.

## Maintained production audit

`node --test tests/local-shadows-highlights-audit.test.mjs` passes8/8 against the implemented helper and native backend. The maintained oracle independently compiles the declared Gaussian and accumulates direct2D BigInt sums with clamped-edge duplicates collapsed. It does not import the production Gaussian, tone table, blend or mask helper as its pixel oracle.

- Actual candidate and filter-stack bytes match36 mixed-alpha images, including sigma0, minimum subnormal and50, one-row/column inputs and row-ring reuse. The fixture distinguishes the required input-luminance-before-Gaussian order from a rounded RGB blur followed by luminance. Hidden-RGB changes cannot affect visible output. Exact half ties and gray64 neighborhood goldens pass; dual-zero Normal aliases the helper input while Multiply still produces64 from128.
- Sparse stored parameters remain sparse on read. Partial explicit-zero updates produce complete effective settings and preserve the mask wrapper. Real saved recipes validate with filesystem/render/model/asset hooks forbidden, apply metadata-only, preserve the target mask, and fail cumulative work at the precise later step without publishing partial state.
- Independent separate-alpha combination, preceding Invert, fractional entry opacity, another identity Multiply and native-density whole-stack mixing match source output. An affine transform, positioned additional mask/density, isolated Screen group, clipping member, selection and upper protected content preserve exact live-versus-Bake appearance. Baked RGB matches the independent oracle, raw working alpha is restored, and source/alpha/provenance/geometry assets and metadata remain intact.
- Computing and dual-zero Multiply candidates preserve original protected RGB; generated clipping output excludes protected alpha1/128/255 coverage. Hidden protected predecessors still reject active Bake, and dual-zero entries cannot make a target protectable merely because their Normal candidate is unchanged.
- The combined graph boundary includes retained positioned-mask callbacks, nested isolated groups, clipping, the2KiB zero-sigma LUT and another leaf's persistent Noise table. It admits268,289,056 bytes at sigma0 and refuses sigma0.01 before any render/source/model/asset call, including as the first step of a transaction followed by rasterization. The complete masked-source identity predicate likewise rejects8192×2731 before reads.
- The alpha-backed Bake fixture lands exactly at256MiB for sigma0; sigma0.01 adds221,220 bytes and rejects before either file handle's `read` method. Sparse files supply real stat sizes without allocating image planes. Other Bake phases remain unchanged, and sequential local/RGB Gaussian entries use the largest cache rather than their sum.
- Disabled/zero-opacity malformed definitions reject before portable asset reads; bad widths, centipercent precision, null/string parameters, out-of-range sigma and unknown fields cannot hide behind bypass states. Native global adjustment and adjustment-slot recipes reject the source-only kind.
- Real `ENOTDIR` metadata and Bake persistence failures, plus a late failing transaction containing update→Bake→paint, leave graph, mask wrapper, revision/history, project files, preview cache and preexisting source assets unchanged. Newly published working assets are removed by the established transaction ownership scope.

The review also inspected the production typed-buffer lifetimes and the source-only filter work/cache/dispatch branches. The old Mixer discovery audit now expects28 source kinds and still24 globals. Existing global math, Gaussian compiler and receipt/retry contracts were not changed by this feature.

## Initial client source review

The reviewed client uses five string drafts, exact centipercent validation and unrestricted finite sigma precision, with equivalent numeric spellings compared against complete effective saved parameters. Reset is local and retains opacity/blend. The new policy is independent from earlier Gaussian/High Pass/Unsharp/Noise markers. Capability changes invalidate captured entry/stack/recipe results while preserving drafts; saved recipe capture uses persisted parameters and still refuses discarded mask scope. Source-only types and controls leave global adjustment controls alone. Existing App ownership and retry paths are reused.

The compact disclosure accurately distinguishes sigma0 treatment from dual-zero identity, encoded tone quantization, clipped endpoints, halo/hue limitations and the full neighborhood preceding the stack mask. No initial UI source finding required a production change. The UI owner subsequently reported eight focused workflows passing in the ordinary optimized runtime and 71 adjacent workflows passing; those browser runs belong to the UI owner, not this independent native audit.

## Separate legacy scalar dispatch correction

Browser acceptance exposed execution-dependent output from the preexisting global `shadows`/`highlights` dispatcher: an unchanged graph's first export could differ from later exports. The owner moved just those two branches ahead of the generic scalar `Array.map` callback and returned three explicit channel results. Independent source comparison against `test-results/color-before-tonal-dispatch.mjs` confirms the same luma expression, squared tonal weight, left-associated `value * 1.275 * tonalAmount` and final byte clamp. Other adjustment branches and the new local-neighborhood algorithm are unchanged. The underlying runtime mechanism was not established; this review does not claim a proven V8 defect.

An independent ordinary-runtime rerun of the root-owned `tests/scalar-tone-regression.test.mjs` passes 3/3. Two fresh child processes each exercise seven half-million-pixel native adjustment passes against independent scalar arithmetic. Further checks cover source alpha/hidden RGB, masked fractional global opacity and protected pixels, plus repeated native PNG exports of an unchanged Shadows→Highlights graph while another document receives local-tone edits. Graph and original source bytes remain unchanged. This narrow correction has no remaining source-review blocker.

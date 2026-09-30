# Native Photo Filter: encoded RGB transmission with optional luma preservation

Status: **implemented and closed: full backend regression1140/1140,99 browser workflows and final build passed**, 2026-09-19. Color Lookup closed at1109 backend tests and91 browser workflows. This contract follows [PHOTO_FILTER_REVIEW.md](PHOTO_FILTER_REVIEW.md). Root and independent review approved the arithmetic, resource contract and photographic default before production implementation.

## Scope and photographic choice

Add a distinct `photo_filter` adjustment to both native global and source contexts. The user selects an arbitrary RGB8 color, density, and Preserve Luminosity. The output is a full-strength RGB8 candidate for existing opacity, masks and source-entry blend handling. No command, asset type, provider, library, dependency, Kelvin calibration, automatic illuminant detection or preset compatibility is required. Existing `temperature`, Color Balance, tint and all other algorithms stay unchanged.

Adobe documents custom filter colors, Density and Preserve Luminosity enabled by default. That establishes useful controls, not a published pixel formula. This native treatment makes no Adobe byte-equivalence or spectral-filter claim. [Adobe Photo Filter controls](https://helpx.adobe.com/photoshop/using/applying-color-balance-adjustment.html), [Adobe photographic workflow](https://www.adobe.com/learn/photoshop/web/adjust-correct-color-balance-photoshop).

The selected candidate attenuates encoded RGB components by a colored transmission, then optionally restores encoded Rec.709 weighted luma and fits the result into RGB8 through one shared chroma reduction. This keeps pure black black. A direct interpolation toward a solid filter color instead raises black to that color: the warm 25% comparison turns the helmet's black into brown and washes out contrast. The transmission model is the better fit for this correction workflow. It is neither linear-light optics nor calibrated white balance.

Proposed native defaults are **color `#ff9500`, density `25`, preserveLuminosity `true`**. The 25% warm result adds a visible moderate warmth without lifting helmet black. Green `#80ff80` and magenta `#ff80ff` demonstrate correction directions not expressible by the old Red/Blue-only temperature control. Density75 results are deliberately strong, and near-black `#010203` illustrates that preservation removes mostly neutral attenuation at modest densities; at density100 the relative channel transmission becomes important. These are authored native examples, not named Adobe presets.

## Frozen public and canonical contract

```
kind: 'photo_filter'
value: 0
parameters: {
  color: '#ff9500',
  density: 25,
  preserveLuminosity: true
}
photoFilterPolicy: 'rgb-transmission-luma-fit-v1'
```

One policy capability plus existing native backend, command, kind and source-coordinate capabilities authorizes the matching scope. No separate modes list is necessary for a Boolean setting. Global/source kind counts would become 28/32; command count is unchanged. The optional Photoshop bridge refuses the native new kind. An old native reader rejects the unknown kind before asset decoding rather than interpreting it as old temperature.

Export `PHOTO_FILTER_POLICY`, frozen `PHOTO_FILTER_DEFAULTS`, `normalizePhotoFilterParameters`, `mergePhotoFilterParameters`, `photoFilterIsIdentity` and `photoFilterTransform` from `server/photo-filter.mjs`. The merge helper validates the supplied patch before spreading. Native/normalization/work consume the same definitions. The client follows existing precise-color patterns with matching constants; no shared library is needed solely for three defaults. If future UI code can import the environment-neutral helper without pulling server dependencies, it may share constants directly, but this is not required for the first slice.

Parameters are a plain or null-prototype object with only own enumerable data properties. Reject arrays, null, custom prototypes, symbols, accessors, nonenumerable fields and unknown keys before reading them in the helper. Omitted object or fields use defaults; explicit undefined uses the corresponding default, while null rejects. Color is exactly seven UTF-16 units matching `#[0-9a-fA-F]{6}` and canonicalizes to lowercase. The explicit length check rejects the trailing newline that JavaScript `$` would otherwise permit. Density is a finite Number from0 through100 with `Math.round(value*100)/100===value`; normalize negative zero to zero. Preserve Luminosity is Boolean.

Existing sparse flat update semantics are sufficient: omitted parameters or `{}` preserve settings; supplied fields replace only those fields, and the effective complete object is revalidated. Validate a supplied non-JSON patch's own-property shape before any spread so a helper's strict accessor rule is not bypassed by merging. Native execute/dispatch also perform the Photo Filter parameter check before an existing Bake/mask/recipe transaction's schema snapshot can erase property shape: explicit new kind or the current update target identifies the scope. JSON wire inputs cannot contain getters, and standalone shared validation cannot infer an update target's kind from an ID alone. No general legacy parameter policy is changed. No nested bank/range merge or representation conversion is involved. Authored new/add/update records and saved recipes materialize all three canonical fields. Valid sparse externally authored records remain readable with defaults and need no read-time graph rewrite.

Recipes have no asset dependency and need no refusal. Capturing a Photo Filter stores all three fields; applying it to an existing Photo Filter resets all three through normal complete parameter materialization. Ordinary recipe append preserves an existing whole-stack mask and every prior filter, including a Color Lookup reference. Canonical malformed persisted or portable fields reject before image access, even when disabled or opacity zero. Recipe validation and graph resource checks do not compile a pixel transform or read assets.

## Exact RGB8 candidate arithmetic

Let input bytes be `(R,G,B)`, filter bytes be `(F_R,F_G,F_B)`, and integer density `d=Math.round(density*100)` in0..10000. All coefficients below are integers:

```
t_c = 255*(10000-d) + d*F_c
M_c = C_c*t_c
K   = 2126*R + 7152*G + 722*B
J   = 2126*M_R + 7152*M_G + 722*M_B
```

With preservation off, `N_c=M_c` and `D=2550000`. With preservation on, if `J===0` return the original RGB; otherwise compute `Mmax=max(M_R,M_G,M_B)`. If `Mmax*K<=255*J`, use `N_c=M_c*K`, `D=J`. If that restored color would exceed255, use:

```
neutral = K*Mmax - 255*J
scale   = 2550000 - K
N_c     = neutral + scale*M_c
D       = 10000*Mmax - J
```

Each final byte is exactly `Math.floor((2*N_c+D)/(2*D))`. There is one final half-up rounding per channel and no intermediate byte rounding. No epsilon, generic floating fallback, per-pixel BigInt, lookup cache or channelwise clipping is needed.

The restoration before gamut fitting is `M_c*K/J`. The fit moves that color toward neutral gray `K/10000` by the largest common factor keeping its maximum at255. Restored components are nonnegative, so an upper bound is the only constraint. The simplified expression above is algebraically identical to that geometric rule while avoiding the excessive products in a direct rational implementation.

Bounds: `0<=t<=2550000`, `M<=650250000`, `K<=2550000`, `J<=6502500000000`. `K*Mmax<=1658137500000000`. The fit's two positive terms sum to no more than `2550000*Mmax`, so all intermediate integer operations remain exact under2^53. Both branches have `0<=N<=255D` and `D<=6502500000000`; thus `2N+D<=3322777500000000<2^52`. For noninteger exact `(2N+D)/(2D)`, its distance from the closest integer is at least `1/(2D)>7.68e-14`. The maximum binary64 rounding error below256 is at most `2^-46≈1.42e-14`, leaving more than a fivefold margin. Exact integer half boundaries themselves are representable. Number division followed by floor therefore produces the exact rational half-up byte under these bounds. The independent oracle must use unsimplified rational restoration/fit rather than copying this simplified formula.

Preservation refers to the unrounded weighted encoded luma `(2126R+7152G+722B)/10000`. Independent channel rounding may change it by at most0.5 byte. This is not perceptual lightness or linear-light luminance. Shared gamut fitting reduces chroma near the RGB boundary; it must not be described as preserving arbitrary out-of-gamut colorfulness.

## Identities, endpoints and caller order

The metadata-only exact identity predicate is density0, a white filter, or any gray filter with preservation on. Return original byte values through an ordinary fresh RGB tuple. Black remains black. With preservation off, white and gray become the transmitted color and a black filter at density100 produces black. With preservation on, white remains white after fitting, while neutral midtones can receive color. Pure saturated primary pixels remain unchanged because their only nonzero channel cannot change its own encoded luma while the other channels remain absent.

If density100/filter channels annihilate every nonzero source component, `J=0` returns original RGB. This is the limit as density approaches100 for that fixed source and filter support; it does not recover clipped color or promise a universal joint limit across arbitrary changes to the filter. A black filter with preservation is identity at all densities. Density100 does not mean replacement with the filter color.

Identity candidates remain active source entries and still participate in nonnormal entry blending. They retain the existing source-edit/protection/Bake structural guards and do not cause stack masks to disappear. Do not shortcut the whole source entry merely because its candidate is identity. With Normal/full opacity the candidate is byte-identical.

Both contexts use the newer color-mapping alpha policy: alpha bytes unchanged and alpha-zero RGB untouched. Global candidates pass through existing adjustment opacity, selection/additional masks and protection with Normal-only global composition. Source candidates pass through existing per-entry blend/opacity, then the finished stack is mixed by its source filter mask, then source geometry/Distort and contextual protection. Spatial neighbours are irrelevant for this pointwise filter; no selection or mask changes the input coefficients. Bake, generated content, isolated clipping and protected-context inspection use these same caller paths.

## Work, scheduling and resource proposal

Charge **16*S** for every enabled positive-opacity computing Photo Filter, whether preservation is on or off, and **1*S** for the proved metadata identities. Disabled/opacity-zero entries cost zero candidate work but still validate. A uniform computing cost gives stable admission when the preservation toggle changes and is conservative for both division branches. Existing nonnormal blend adds40*S, and an evaluating finished-stack mask adds8*S. Under the existing384M source-work cap, one Normal computing filter admits24MP by work, one with a mask16MP, and one nonnormal filter at most6,857,142 pixels before other resource limits. Identity plus nonnormal costs41*S as with prior identity candidates.

Compilation retains only three bounded transmission coefficients, a Boolean branch and small scalar state. No typed-array cache, extra RGBA plane, asset read or per-graph preparation budget is introduced. Existing source/graph/Bake phase estimates and sequential maximum caches remain unchanged. In combinations with Curves banks, spatial kernels, Color Lookup or Distort, those features retain their current phases and stricter joint gates; Photo Filter adds work only. There is no new global work cap or promise that all global stacks finish in a fixed time.

Use bounded complete rows with at most16384 pixel visits per batch, taking the minimum of any stricter existing entry-blend cadence. Global dispatch keeps its finalized all-kind yielding loop and uses the tighter Photo Filter color cadence. Scalar setup is constant; no setup yield or table reserve is necessary. Measure the actual registered source/global callers after approval before release; current numbers are prototypes, not a production latency promise.

## Prototype and photographic evidence

Design evidence is in `test-results/photo-filter-evaluation/architecture-*`. `architecture-prototype.mjs` preserves the pre-implementation helper and a copying RGBA source-caller approximation. `architecture-probe.mjs`/`architecture-probe-report.json` pass15 strict malformed controls,61440 exact identity bytes,640 endpoint/near-black/primary/gray/midtone cases, output ranges, encoded-luma error bounds and caller alpha/input ownership. Independent unsimplified BigInt arithmetic verified183847 RGB cases/551541 bytes,19571 gamut-fit cases,11392 exact channel half ties and84000 synthetic maximum-denominator half-neighbor ratios. An additional2359296 full-photograph channels match; rounded encoded-luma drift remains below0.5 byte.

Original photograph: `test-results/segmentation-public-fixture.png`,512², SHA256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. `architecture-photo-comparison.png` shows original/warm/green/magenta/near-black at25 and75, preservation on/off;24 individual512² files also include density100. `architecture-photo-warm25-additive-comparison.png` is a deliberately separate rejected alternative. Every individual SHA and encoded-luma diagnostic is in the report; no fixture is a bundled preset or new application asset.

Uncontended Node v22.14.0/darwin-arm64 prototype medians, after coordinating root/reviewer/UI load:

| Copying RGBA caller workload | Median |
|---|---:|
| 1MP default warm preservation |21.30ms|
| 1MP warm transmission |13.76ms|
| 1MP every pixel requires gamut fitting |25.77ms|
| 1MP near-black preservation |26.80ms|
| 1MP wide / tall gamut fit |29.82 /26.31ms|
| 24MP default preservation |483.47ms|
| 24MP transmission |309.54ms|
| 24MP gamut fit |592.48ms|

Maximum observed5ms heartbeat gap was6.01ms, including output copy and excluding fixture generation/hash. The same run measured existing native Selective Color at26.00ms/1MP and Hue/Saturation at31.62ms/1MP; their dispatch loops are different, so these are context rather than exact overhead-normalized ratios. Square/wide/tall same-content hashes match. `architecture-benchmark.{mjs,json,log}` records all cases. The proposed16S is above the established12S Selective cost for a similar observed worst case and below the32S HSL/LUT charges; arithmetic/loop bounds, not one machine's timing, remain the admission basis.

## Integration and acceptance after approval

Root owns shared command kind/parameter schemas, source/global value0, bridge refusal, status policy forwarding, MCP descriptions and official SDK/schema tests. Native owner would add `server/photo-filter.mjs`, dispatch through `server/color.mjs`, source work/identity and bounded scheduling, native capabilities and owner tests. No new shared module, command, recipe exception or resource cache helper is needed. UI owner uses exact color/density drafts and explicit preservation toggle under native policy/kind gates for source/global/recipe execution; missing policy keeps an existing record inspectable without authoring it.

Required acceptance includes independent rational half/fit boundaries, strict shape/precision/ownership and all identities; fresh ordinary process reproducibility; both caller alpha policies, entry blends/opacity and deferred source mask; generated/protected/clipping contexts; all-three-field recipe reset and sparse partial retention; working-alpha/Bake/Distort/portable/restart; no-I/O identity-to-computing work refusal, masked/nonnormal accumulation, malformed inactive portable records; persistence and late-pixel transaction rollback. Source/global kind catalogs are28/32, with100 commands and no changes to legacy pixel formulas.

## Integrated backend acceptance

Maintained owner suites `tests/photo-filter.test.mjs` and `tests/photo-filter-native.test.mjs` pass4 and8 tests respectively. Two fresh ordinary Node processes repeatedly check independent literal candidate bytes before and after optimization. Native acceptance includes defaults/label/sparse merge without image I/O, direct patch getter refusal, all26 entry blends and identity blending, exact deferred mask, metadata work/no-cache admission, global protection/alpha, complete recipe resets, exact raw working-alpha Bake under Distort, original asset preservation, portable/restart and both actual ENOTDIR and late Bake/paint transaction rollback. The final added regression checks nested density and preservation getters in global/source update+Bake transactions through execute and direct dispatch, plus explicit Photo Filter add+Bake; getters and I/O remain zero and project state is unchanged.

Independent `tests/photo-filter-audit.test.mjs` passes11 tests using `tests/fixtures/photo-filter/reference.mjs`, which imports no production arithmetic and evaluates reduced rational transmission/luma/neutral-axis stages. The combined owner/independent plus all-kind blend/mask/Bake sweep passes **49/49 in1.361s**, recorded in `architecture-final.log`. Its first run found one old catalog fixture assigning scalar value1 to the new parameterized kind; the fixture now supplies required value0. The subsequent direct-JS transaction review found and closed the earlier-snapshot accessor gap described above. The final helper/native/independent/schema/SDK sweep passes **29/29 in1.243s** in `architecture-snapshot-final.log`; independent native/client13 also pass after that fix. Root's four new schema tests and two official SDK workflows pass, together with all86 schema tests. Root's full regression passes **1140/1140 in22.3546s**. Focused Photo Filter browser8, adjacent91 workflows and final build pass, closing99 browser workflows. No remaining Photo Filter acceptance work is pending.

Actual registered `applyLayerFilters` and `NativeBackend.applyAdjustment` measurements are in `architecture-production-benchmark.{mjs,json,log}`. They include normal parameter compilation, output copying, alpha/opacity logic and yields; fixture generation, hashes, PNG encoding and whole-graph decoding are outside the timed scope. These production numbers are distinct from the prototype table above.

| Production workload | Source median | Global median |
|---|---:|---:|
| 1MP default warm preservation |22.31ms|25.12ms|
| 1MP warm transmission |15.65ms|17.73ms|
| 1MP all-pixel gamut fit |16.16ms|18.49ms|
| 1MP wide / tall preservation |21.36 /21.28ms|24.65 /24.22ms|
| 24MP default preservation |512.38ms|569.40ms|
| 24MP transmission |347.29ms|403.88ms|
| 24MP all-pixel gamut fit |369.93ms|427.61ms|

All source/global and same-content square/wide/tall hashes match; a separate1024-byte independent partial-opacity/all-alpha fixture also passes. Maximum observed5ms heartbeat gap is6.53ms. Solid all-fit input is faster here than varied input, so the default varied case is the largest measured24MP time; no claim is made that one branch fixture represents every CPU distribution. Production photograph `architecture-photo-production.png` exactly matches the reviewed warm25 preservation prototype, SHA256 `b04f3ba29acc7f90d027a8fb4dfa1402935ebbeee645481175f8ba437b35e1b7`. These observations support the frozen bounded cadence/work charge and do not promise latency or process RSS.

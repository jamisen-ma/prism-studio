# Native targeted Hue / Saturation evaluation

Status: **reviewed contract implemented, 2026-09-19**. Root approved the final hybrid membership, proportional saturation and 32/1 source work policy after numerical, photographic and independent review. The native helper, global/source integration and owner/independent backend acceptance are complete. Actual production measurement and downstream release evidence are recorded below; prototype comparison modes were not promoted.

## Recommendation and useful scope

Add a distinct parameterized `hue_saturation` family to global adjustments and editable source filters. Retain one Master row and six color-family rows, each with Hue, Saturation and Lightness controls. This directly supports changing clothing or foliage color and desaturating a family in one editable entry. Existing scalar `hue`, `saturation` and `vibrance` retain their literal algorithms and saved pixels. Native discovery now reports **26 global / 30 source kinds**; no new command, asset, provider or dependency is needed.

Adobe documents Hue/Saturation/Lightness, targeted color editing, adjustable range/falloff handles and Colorize. These establish workflow value, not a complete numerical algorithm. This smaller native slice uses fixed overlapping hue triangles; it does not claim Adobe pixel equivalence or include automatic dominant-color detection, eyedropper range editing, four-handle falloffs or Colorize. [Adobe Hue/Saturation documentation](https://helpx.adobe.com/photoshop/desktop/adjust-color/color-corrections/apply-a-hue-or-saturation-adjustment.html)

HSL here means conventional HSL over the stored encoded RGB8 channels, not linear-light RGB or a perceptually uniform space. The standard sRGB/HSL conversion supplies the color-coordinate reference; the range memberships, control aggregation, saturation rule, neutral treatment and numerical order below are explicitly native. No reference implementation is copied. [W3C CSS Color 4 HSL definition and conversion](https://www.w3.org/TR/css-color-4/#hsl-to-rgb)

The independent workflow comparison recommends targeted HSL first if these utility checks pass. Four independent Master/R/G/B Curves banks are a lower-risk alternative that would consolidate four currently expressible entries. Imported `.cube` looks offer interchange value but require a typed non-image asset lifecycle, bounded table preparation and recipe dependencies; a bare hash parameter would not be a complete portable feature. Details and primary format references are in [NEXT_PRO_WORKFLOW_REVIEW.md](NEXT_PRO_WORKFLOW_REVIEW.md).

## Control comparisons and selected behavior

All alternatives classify the original RGB entering this entry. Let `H=max(R,G,B)`, `L=min(R,G,B)`, `C=H-L`, and `k=255-|H+L-255|`. The six nonnegative chromatic cube weights sum to C and reduce to at most two adjacent hues. We compared dividing those weights by:

1. **255, for all controls.** Smooth near-neutral attenuation, but fully saturated dark `[32,0,0]` and pastel `[255,223,223]` receive only 32/255 of Reds. Reds Saturation −100 gives `[30,2,2]` and `[253,225,225]`, rather than removing their color.
2. **C, for all controls, with an explicit gray bypass.** Correct full dark/pastel targeting, but named Lightness amplifies tiny neutral noise. Reds L+10 maps `[128,127,127]` to `[141,140,140]` while adjacent exact gray127 stays unchanged. The synthetic chart develops obvious stripes.
3. **k, for all controls.** This multiplies hue influence by original HSL saturation. It avoids the middle-gray problem and still reaches fully saturated dark/pastel colors, but weakens full desaturation of less-saturated Reds. It also retains HSL's endpoint singularity: `[1,0,0]` becomes `[52,0,0]` under Reds L+10, whereas black stays black.
4. **Choose hue-normalized Hue/Saturation, chroma-attenuated named Lightness.** Hue and Saturation use weight/C; named Lightness uses weight/255. Master is unattenuated. This is a deliberate per-control distinction: color-family controls can fully remove the chosen hue's color, while named brightness changes do not turn one-byte neutral differences into large luminance changes. There is no arbitrary threshold, epsilon or adjustable hidden range.

Endpoint examples assume other rows are zero; opposing Master/target controls can cancel before the aggregate clamp. Named Lightness therefore has weaker endpoints on low-chroma input; +100 is not a promise to turn every reddish pixel white. Master L+100 does produce white, and Master L−100 black. This distinction must appear in concise help. Hue memberships remain continuous around the six sectors before byte rounding. Exact gray has no named influence. Near-black/white Master Lightness can still reveal tiny existing colors through ordinary HSL saturation; this is a color-coordinate control, not noise reduction or edge-aware recovery.

We also compared two positive saturation formulas. `S+(1-S)*d` reaches full saturation at +100, but at +10 maps `[128,127,127]` to `[141,114,114]`; +30 gives `[166,89,89]`. Both Master and Reds controls amplify the same one-byte hue noise. The photographed neutral backdrop visibly becomes tinted/grainy. **Choose proportional `clamp(S*(1+d),0,1)` for both signs.** +100 doubles existing HSL saturation up to its limit; −100 removes it. On that fixture +10/+30 are byte-identical to the original, while +100 gives `[129,127,127]`. Exact gray remains gray at all Hue/Saturation settings. This is a delta control, not an absolute final-saturation setter.

The diagnostic images under `test-results/targeted-hsl-evaluation/` include `reds_light10-comparison.png`, `reds_desaturate-comparison.png`, `near-gray-light10-comparison.png`, `near-gray-saturation-comparison.png`, and `master-sat30-comparison.png`. Root and owner inspected the neutral/noise and photographic saturation comparisons. The final moderate preset is described in the evidence section; all authored defaults remain zero.

## Parameters, capabilities and lifecycle

New kind `hue_saturation` uses `value:0`. Complete normalized parameters are:

```js
{
  master: [0, 0, 0],
  reds: [0, 0, 0], yellows: [0, 0, 0], greens: [0, 0, 0],
  cyans: [0, 0, 0], blues: [0, 0, 0], magentas: [0, 0, 0]
}
```

Every row is a dense three-number tuple `[hueDegrees,saturationPercent,lightnessPercent]`. Hue is finite −180..180 degrees; S/L are finite −100..100 percent. All controls use canonical 0.01-unit increments, tested by `round(v*100)/100===v` without tolerance. Normalize negative zero to zero. Omitted parameters or `{}` produce complete zero defaults. Null, nonzero value, unknown fields, malformed/sparse rows, accessors, unsupported prototypes, symbols and nonfinite/out-of-range/finer values reject through a dedicated strict normalizer. Do not change any legacy kind's accepted inputs.

Fields are optional on author/update requests. A supplied row replaces that complete tuple; omission retains its effective current value on update. Reading a valid sparse external record may preserve its sparse stored form until ordinary editing. Evaluation uses defaults, and normalized authored records/recipes carry all seven rows. A default global recipe resets a previously nonzero target rather than inheriting omitted settings. Source recipes append their full configuration under an existing filter-stack mask; capturing a masked stack retains its established refusal. Metadata validation performs no transform compilation, image access or LUT allocation.

Proposed capability contract:

```js
hueSaturationPolicy: 'rgb-hue-triangle-hsl-v1',
hueSaturationRanges: ['master','reds','yellows','greens','cyans','blues','magentas']
```

The policy freezes the selected hybrid/proportional arithmetic; the alternatives are **not** user-selectable or persisted modes. UI requires Native, the exact policy, complete recognized range list and the applicable global/source kind and command gates. Source editing also requires the existing source-coordinate contract. Missing/malformed capability keeps existing scalar controls available and prevents authoring the new family. The optional Photoshop bridge explicitly rejects this native family. Existing readers reject the unknown kind before images/assets, so no ignored optional field can silently drop a correction. Portable projects, history, restart and recipe hashing use the existing metadata serialization.

## Membership and mathematical correction

The six integer weights are:

| Row | Integer weight |
| --- | --- |
| Reds | `max(0,R-max(G,B))` |
| Yellows | `max(0,min(R,G)-B)` |
| Greens | `max(0,G-max(R,B))` |
| Cyans | `max(0,min(G,B)-R)` |
| Blues | `max(0,B-max(R,G))` |
| Magentas | `max(0,min(R,B)-G)` |

For sorted channels `H>=M>=L`, the maximum channel chooses its primary row with weight `a=H-M`; the minimum channel chooses the adjacent secondary row with weight `z=M-L`. Thus `a+z=C`. Tie-selected rows have zero weight where ambiguity exists. Exact primary/secondary hues belong to their single row; orange is a Reds/Yellows overlap; Reds also wraps continuously into Magentas. No intermediate control changes the classification for later rows.

For C>0, aggregate Hue and Saturation as Master plus `sum(weight*rowControl)/C`. Aggregate Lightness as Master plus `sum(weight*rowControl)/255`. Clamp only the complete S and L sums to −100..100. Hue is not individually clamped after aggregation: its sum can reach ±360 and wraps modulo360. Do not clamp, round or sequentially apply separate rows. Gray has zero named contributions; Master Hue/Saturation do not invent a hue.

Original normalized coordinates are `ell=(H+L)/510` and `s=C/k` for C>0. After converting aggregated percentages to d in [−1,1]:

- `s'=min(1,max(0,s*(1+dS)))`.
- If dL<0, `ell'=ell*(1+dL)`; otherwise `ell'=ell+(1-ell)*dL`.
- `h'=wrap(h+dHue)`.

Convert the corrected HSL to encoded RGB, then clamp/round the candidate bytes once. There is no RGB quantization between row contributions or between H/S/L controls. Exact all-zero aggregate and a full ±360 turn with zero S/L return original RGB directly. All-zero authored controls compile to a private identity closure. Nonzero authored settings that happen to cancel remain computing configurations for admission.

## Fixed arithmetic and precision contract

Production should use the exact operation order demonstrated by the isolated prototype's selected branch. It is deterministic native binary64 arithmetic with `Math.round`/byte clamp at the final conversion, **not** exact-real half-up HSL at every mathematical tie. No runtime BigInt, epsilon, random state, trigonometric function or per-pixel slow fallback is proposed. The independent exact-rational oracle exists only in evaluation/tests.

Compile controls to centiunit integers. For C>0 set `Q=10000*C`, `QL=2550000`, `HB=6000*C`, `HP=36000*C`:

```text
hue = C*masterHue + a*primaryHue + z*secondaryHue
sat = clamp(C*masterSat + a*primarySat + z*secondarySat, -Q, Q)
light = clamp(255*masterLight + a*primaryLight + z*secondaryLight, -QL, QL)
nl = light<0 ? (H+L)*(QL+light)
             : (H+L)*QL + (510-H-L)*light
ds = k*Q
ns = min(ds, C*(Q+sat))
```

Original hue in units of C/60 degrees is `h6=G-B` when R is maximum, `2C+B-R` when G is maximum, otherwise `4C+R-G`; add 6C if negative. Let `dh=C*HB`; normalize `nh=(h6*HB+hue*C) mod(6dh)` into [0,6dh). Then `sector=floor(nh/dh)`, `rem=nh-sector*dh`, and `triangle=rem` for even sectors or `dh-rem` for odd sectors. The final operations are specifically:

```text
adjustedLight = nl/(2*QL)
chroma = ((255*QL-abs(nl-255*QL))/QL) * (ns/ds)
base = adjustedLight - chroma/2
secondary = base + chroma*(triangle/dh)
maximum = base + chroma
```

Permute `[maximum,secondary,base]` by the six usual hue sectors and round/clamp each channel once. Preserve this parenthesization; algebraic rearrangements can move an exact half by one byte.

All integer setup through sector selection is bounded: `nl<=1,300,500,000`, `ds<=650,250,000`, `C*(Q+sat)<=1,300,500,000`, `dh<=390,150,000`, and signed pre-modulo hue numerator has magnitude <2^33. These integers are exact Numbers. For sector selection, a noninteger quotient is at least `1/dh>2^-29` from an integer boundary, far above its binary64 division error; the sector is therefore unambiguous. Denominators are positive for chromatic RGB8. There are no subnormal RGB-coordinate gaps.

Exact branches precede the general floating conversion: original C=0, corrected saturation numerator zero, corrected lightness 0/1, effective aggregate identity and full-turn identity. Gray output uses `floor((2*nl+2*QL)/(4*QL))`; its integer operations are exact and the floor-boundary separation is much larger than division error. This gives exact authored grayscale Lightness, full desaturation, black/white endpoints, original hidden RGB policy and identity. For an original gray only Master Lightness enters nl.

The remaining divisions and products are bounded by 255 in output units. A conservative ordinary floating error estimate is below approximately `3e-13` against the corresponding real formula; this is explanatory, not an exact-real rounding promise. Literal half fixtures belong in maintained tests and cross-process checks. For example, Reds S−100 at `[224,1,127]` can evaluate its green channel as `49.49999999999999`, yielding 49 versus exact-real 50. This is a declared native byte, not silently corrected by an epsilon.

## Alpha, stage, protection and resources

The helper accepts RGB8 and returns a fresh RGB8 tuple. It owns no alpha or image plane. Source entry evaluation retains current effective alpha and skips hidden RGB where alpha is zero, then applies existing blend and opacity. The complete stack's effect mask still mixes once after the final entry, before source geometry and original-context protected restoration. A filter identity remains active structurally and can change RGB under Multiply/Screen/etc. Protection/source-edit guards must not treat it as an absent filter.

The new global kind follows the color-mapping caller policy: preserve alpha, skip hidden alpha-zero RGB and respect global masks/density/opacity/protected footprints. This changes no old scalar or Curves policy. Clipping, isolated groups and generated/protected context remain existing callers. Bake uses the same ordered source math, preserves geometry/coverage masks/source references and retains existing actual asset-size admission/rollback. No implicit baking or source edits are added.

Only 21 integer controls and small owned configuration arrays are compiled; no LUT, binary table, neighborhood ring, extra candidate image or persistent cache is introduced. Setup is bounded independently of image dimensions and measured below. A per-pixel RGB tuple matches the existing scalar transform contract. Metadata validation and work estimation remain setup-free.

Charge **32*S** for each active computing configuration; all 21 authored-zero controls charge **1*S**; disabled or opacity-zero entries charge zero. Nonzero rows with a pixel-dependent or full-turn cancellation still charge 32. Existing +40S nonnormal blend and +8S evaluating source-mask charges remain. The cumulative source budget stays 384M:

- One Normal computing entry fits at 12 MP exactly (`4000×3000`); `4001×3000` exceeds it.
- One computing entry with an evaluating whole-stack mask fits 9.6 MP before other limits.
- One computing nonnormal entry costs 72S, allowing at most 5,333,333 source pixels by work alone.
- Two computing Normal entries at 6 MP total 384M; enabling/changing identity entries must revalidate before any image access, including hidden layers and recipe dry-runs.

These are work ceilings, not blanket support promises. Existing decoded/callback/retained/procedural/source-alpha, Distort and encoded Bake phases can be stricter. The new family adds no cache bytes to the existing scalar phase maxima, complete masked-source envelope or graph-wide shared-noise reserve. Global adjustments retain the current frame/dimension limits and bounded per-pass scheduling; the source 384M budget is not a new whole-document/global work guarantee.

Use at most `min(32,max(1,floor(65536/width)))` rows per source/global pixel batch. Nonnormal source blend retains its stricter 16,384-pixel limit. Reuse the existing root-owned global yielding path without changing its numeric or alpha operations. There is no rarity assumption or unbounded per-pixel fallback in 32S.

## Implementation seams, only after review/authorization

| Seam | Proposed change |
| --- | --- |
| New `server/hue-saturation.mjs` | Frozen policy/ranges; strict `normalizeHueSaturationParameters`; authored-zero `hueSaturationIsIdentity`; private compiled `hueSaturationTransform` |
| `server/color.mjs` | New value-zero global kind, parameterized and color-mapping lists; delegate normalization/transform; bounded source yield classification |
| `server/layer-filters.mjs` | Inherit kind/range; add 32/1 work rule; no cache/ring/allocation estimate changes |
| Native capabilities/labels | New policy/range list and `Hue / Saturation` default creation label, preserving saved names |
| Shared schemas/status/MCP | Strict optional three-tuples, kind/value allowlists, capabilities, typed recipe slots and explicit bridge rejection |
| Native/recipes/portable | Effective sparse defaults, full-row partial replacement, canonical complete recipes; unknown/malformed records rejected before reads |
| Client | One shared global/source editor, 21 retained string drafts, range inspection and explicit reset/apply, exact saved/capability ownership; concise native semantics |

The optional schema keys overlap Selective Color's named rows, but tuple length is distinct (three HSL versus four CMYK); final kind-aware validation must reject the other family's shape. Do not broaden the shared union to accept arbitrary arrays. Existing recipes naturally materialize complete defaults; no Curves-style transient interpolation injection is needed. No PSD adjustment serialization or LUT asset import is included.

## Evidence and acceptance gate

All files so far are isolated evaluation artifacts, not production dependencies:

- `prototype.mjs`: strict normalization plus comparison modes and the selected `compile(params,{membership:'hybrid',saturationMode:'multiplicative'})` branch; `candidate` supplies a bounded alpha-preserving loop for probes.
- `reference.mjs`: separately structured generic BigInt fractions, conventional normalized HSL conversion and direct six-weight classification; never imported by a runtime helper.
- `probe.mjs`, JSON/log reports: arbitrary rows, byte extrema, gray and near-gray, wrapped hue, overlapping/canceling ranges, malformed metadata, closure/input ownership and all four alpha classes.
- `photos.mjs`, `saturation-comparison.mjs`: actual photo and noise-policy comparisons with exact parameters/digests.
- `goldens.mjs`, `goldens.json`: eleven literal native vectors, including both half-tie channels, dark/pastel desaturation, near-gray stability, hue wrap and gray/black/white branches. Two ordinary fresh processes each pass 220,000 compiled calls; fixture SHA-256 `8dcfe8119b25997ea35d988f98a92f5f0be1532e8713218e88b024ff77b30494`.
- `benchmark.mjs`, `benchmark.json`, `benchmark.log`: selected policy, ordinary optimized Node v22.14.0 on macOS arm64/Apple M5 Max, opacity .625 and fully opaque RGB so every pixel computes.

The initial hue-only and hybrid/piecewise probes each cover 174 configurations  × 2040 pixels: 354,960 RGB cases  / 1,064,880 candidate bytes. Each has only two one-byte differences from exact-real rational HSL, both exactly at a mathematical half; they are retained as explicit evidence rather than called exact matches. The selected hybrid/multiplicative run covers the same 354,960 RGB cases / 1,064,880 bytes and likewise has exactly those two native half-tie differences, with no other mismatch. Its report is `hybrid-multiplicative-report.json`. The alpha/input ownership fixture covers 512 pixels with alpha 0/1/128/255, and thirteen malformed metadata fixtures reject.

Prototype setup, including one invocation, measured 0.00336–0.00423 ms per compilation over three 10,000-compilation batches. Selected all-row computing medians: 1024² at 78.55 ms; 8192 × 128 at 77.60 ms; 128 × 8192 at 80.08 ms; 6000 × 4000 at 1777.32 ms. One active row at 1024² costs 59.16 ms; all-zero 16.21 ms. Maximum observed 5 ms heartbeat gap is 11.62 ms. This supports the conservative 32/1 proposal relative to previously measured simpler pointwise families. It does not promise realtime latency or process RSS, and actual integrated source/global measurements must be repeated after implementation.

The photo is the existing 512² astronaut fixture, `test-results/segmentation-public-fixture.png`, SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. No external image generation/provider was used. Owner inspected final `final-warm_retune.png` and `final-reds_desaturate.png`; the first gives a moderate warm-family adjustment while the second clearly exposes fixed hue-family targeting and overlap. The Reds-only desaturation leaves the Yellow component of orange pixels, as the triangular membership contract predicts. This is not a hard semantic object or skin selection.

`final-photo-report.json` records exact parameters, changed-byte counts, literal gray/dark/pastel endpoints and these PNG hashes:

| Artifact | Parameters | SHA-256 |
| --- | --- | --- |
| `final-warm_retune.png` | Reds `[-8,-10,3]`, Yellows `[-6,5,0]` | `2eb21452b1a7eaede7ef84b9e9f52ddc35011aaa1cf27b35fdd07734203b5102` |
| `final-reds_desaturate.png` | Reds `[0,-100,0]` | `6fefb480ea1cb555887b3265616954785781943ff9598ea50ed8731083bc92b5` |
| `final-master_sat30.png` | Master `[0,30,0]` | `6c4d8a56587b9326183a2becb5b4f3f279c9fc08ddf29c8a35342a4dbc3cc82a` |

Photo-derived conclusions are restricted to these inspected diagnostics, not broad image-quality guarantees.

Independent review closed the selected operation order, half-tie fixtures, grayscale/master/target distinction and work proposal without a blocker: [TARGETED_HSL_REVIEW.md](TARGETED_HSL_REVIEW.md). The implementation acceptance scope covers global/source partial/default/canonical recipe reset, all blends plus source alpha/mask/geometry/Bake, original protected/generated/clipping context, metadata-only work activation at exact boundaries, portable/restart, actual save/publication/late pixel rollback, and UI draft/selection/capability ownership. Existing scalar fresh-process, global yield, Smooth Curves, Selective Color and Distort regressions remain part of adjacent closure.


## Native implementation and maintained acceptance

`server/hue-saturation.mjs` exports frozen `HUE_SATURATION_POLICY` and `HUE_SATURATION_RANGES`, plus `normalizeHueSaturationParameters`, `hueSaturationIsIdentity` and `hueSaturationTransform`. It contains only the selected hybrid/proportional path, private owned coefficients and fresh RGB tuples. There is no comparison mode, exported mutable plan, binary table or runtime BigInt. The original-gray branch uses zero chromatic contributions and the same exact grayscale expression; the general chromatic floating order is unchanged from the reviewed prototype.

`server/color.mjs` registers the value-zero parameterized/color-mapping family and bounded source scheduling. `server/layer-filters.mjs` applies the exact 32/1 authored-control work rule, including active identities before blend; all cache estimates stay unchanged. Native capabilities expose the two frozen fields and 26/30 kinds, with `Hue / Saturation` as the creation-only default label. The existing root-owned global `applyAdjustment` loop was not edited. Existing recipe normalization already supplies complete rows and correct partial merging, so no special recipe production branch was needed.

Maintained owner pure tests `tests/hue-saturation.test.mjs` pass 5/5: strict canonical ownership, malformed descriptors without getter execution, authored identity versus cancellation, gray/hue/Lightness/half-tie literals, and two ordinary cold-to-warmed child processes. `tests/fixtures/hue-saturation/cold-worker.mjs` executes eleven literal vectors 20,000 times in each process. The initial ownership fixture incorrectly expected `structuredClone` to retain a null object prototype; the test now verifies data and prototype separately, with no helper change.

Owner native tests `tests/hue-saturation-native.test.mjs` pass 7/7. They cover sparse global/source updates and saved labels without pixels, all 26 blend modes, every source-mask byte at density 0.1, source/global alpha and hidden RGB, protected global samples, identity Multiply/Screen/Difference, exact 12 MP and 9.6 MP metadata work boundaries, zero cache/Bake-phase changes, preread identity activation, full-default global recipe reset plus masked-source append/Undo, separate source alpha with Distort and exact raw working Bake, portable/restart and real ENOTDIR/late Bake+brush rollback. Both wide caller paths verify yielding. An initial copied assertion referenced an unrelated method capability; that fixture-only assertion was removed.

Independent `tests/targeted-hsl-audit.test.mjs` passes 10/10, using the maintained production-independent `tests/fixtures/targeted-hsl/reference.mjs`. It includes original protected/generated clipping context, strict portable rejection before reads, work/recipe/mask activation and real rollback. The review records its numerical comparison separately rather than calling all floating output exact-real HSL.

The targeted combined closure passes **163/163 in 2.80 seconds**, logged at `test-results/targeted-hsl-evaluation/integration-closure.log`. It includes owner/audit HSL, all affected source filters/Bake/masks, Distort, Smooth Curves, Selective Color, fresh-process legacy scalar and global responsiveness families. Owned discovery assertions now expect 26/30; the all-kind Bake catalog exercises a computing HSL configuration among all 30 source kinds. No production defect was found. Root owns schema/official SDK/full-suite status and the UI owner owns browser acceptance.


## Actual production measurement and backend handoff

Run `node test-results/targeted-hsl-evaluation/production-benchmark.mjs`; JSON/log artifacts use the same basename. Ordinary Node v22.14.0 on macOS arm64/Apple M5 Max, all opaque pixels, entry opacity .625. Compilation plus one invocation costs 0.00259 ms for identity, 0.00295 ms for one active row and 0.00348 ms for all rows (medians of three 10,000-setup batches). The integrated source/global loops use the unchanged caller stages.

| Computing workload | Source | Global |
| --- | ---: | ---: |
| 1024 × 1024, all rows | 79.64 ms | 83.67 ms |
| 8192 × 128, all rows | 75.78 ms | 78.42 ms |
| 128 × 8192, all rows | 78.33 ms | 81.78 ms |
| 4000 × 3000, all rows | 861.53 ms | 907.43 ms |
| 6000 × 4000, all rows | Refused by source work limit | 1826.65 ms |

At 1024², one active row takes 61.42/63.28 ms source/global; identity takes 13.70/16.88 ms. All six matching source/global output hashes agree. The maximum observed 5 ms heartbeat gap is 17.90 ms, including setup/allocation scheduling; pixel loops remain bounded by their declared batch counts. Timing is observational and is not a hard latency or RSS guarantee. The integrated results support retaining the frozen conservative 32S/1S source admission.

Production source outputs exactly reproduce all three reviewed photos, with identical decoded pixels and PNG SHA-256 values already listed above. Files are `warm_retune-production.png`, `reds_desaturate-production.png` and `master_sat30-production.png` in the same evaluation directory. Native ownership is released with no remaining source finding; root and client owners continue full-suite/SDK/browser closure independently.

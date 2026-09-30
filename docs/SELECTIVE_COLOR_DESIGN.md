# Native Selective Color

Status: full integration approved and implemented, 2026-09-19. Native global/source registration, capabilities, work admission and ordinary recipe/Bake paths are callable. Owner and independent focused tests pass; final adjacent/backend release evidence is recorded below. Existing algorithms and the root-owned global adjustment scheduling seam remain unchanged.

## Useful scope and reference boundary

Add `selective_color` to both global adjustment layers and editable source filters. It offers nine color ranges, each with Cyan, Magenta, Yellow and Black controls, and Relative/Absolute methods. It complements Color Balance's luminance ranges and Channel Mixer's whole-image matrix: a user can adjust warm clothing without applying the same coefficients to blue details, or cool dark tones independently of highlights. Counts would become 25 global adjustment kinds and 29 source filter kinds; no new command or asset is needed.

Adobe describes color-range correction on RGB images, Relative changes proportional to an existing component, Absolute changes in percentage points, and contributions from multiple nearby ranges. Those are workflow references, not a published complete pixel algorithm or a parity target. [Adobe Selective Color guidance](https://helpx.adobe.com/in/photoshop/using/mix-colors.html)

The primary FFmpeg source implements a different Selective Color filter with coupled K arithmetic, per-range floating correction/clipping and rounding. Its source carries LGPL-2.1-or-later terms. This proposal does not transplant its implementation or treat its output as an oracle; the native membership and additive correction below are independently specified and tested. No FFmpeg dependency, preset reader or Adobe preset format is introduced. [FFmpeg primary source and license notice](https://ffmpeg.org/doxygen/trunk/vf__selectivecolor_8c_source.html)

Three approaches were considered:

1. A profile-based CMYK conversion would require an explicit profile/black-generation contract and introduces a substantially different color-management feature. Defer it.
2. Reproducing a particular existing Selective Color implementation would couple this feature to undocumented/parity details and, if code were incorporated, its license requirements. It is unnecessary for useful editable native controls.
3. **Choose an exact RGB partition and additive virtual-ink correction.** Membership is integer, continuous before byte quantization, at most four ranges contribute, and a single final rational rounding has a simple proof. The controls are not physical press separations or Adobe-compatible CMYK.

## Parameters and lifecycle

The kind is `selective_color`, with `value:0`. Proposed complete normalized parameters are:

```js
{
  method: 'relative',
  reds: [0, 0, 0, 0], yellows: [0, 0, 0, 0],
  greens: [0, 0, 0, 0], cyans: [0, 0, 0, 0],
  blues: [0, 0, 0, 0], magentas: [0, 0, 0, 0],
  whites: [0, 0, 0, 0], neutrals: [0, 0, 0, 0],
  blacks: [0, 0, 0, 0]
}
```

Each row is exactly four percentages in Cyan/Magenta/Yellow/Black order, each finite −100 through 100 in exact canonical 0.01% increments. Negative zero canonicalizes to zero. No tolerance accepts finer percentages. Method is exactly `relative` or `absolute`; Relative is the default, and every default control is zero. All-zero settings are an exact identity candidate in either method.

Public fields are optional for sparse add/update requests. Supplying a range replaces its complete four-element row; omitted ranges and method retain the effective current setting during an update. Adding with omitted parameters or `{}` uses the complete defaults. Null, unknown keys/methods, malformed/nonfinite rows and nonzero value reject. A new strict normalizer accepts plain JSON-like objects and dense numeric tuples, rejects unsupported own keys/accessors, and returns fresh owned rows. Do not broaden or tighten legacy adjustment normalization.

Saved recipes materialize every range plus method. Thus applying a default or sparse captured definition to an existing target resets omitted controls to the complete recipe defaults rather than inheriting its previous range settings. Existing recipe normalization already follows that complete-configuration pattern; no Curves-style transient mode injection is needed. Source recipes append new entries and preserve an existing shared filter mask. Capturing a masked stack remains refused by the established rule.

Reading a valid sparse external record may retain its sparse representation until ordinary editing; evaluation uses effective defaults. Metadata validation must not compile pixel transforms or allocate image buffers. Unknown `selective_color` kinds cause older native readers to reject before image/asset use; there is no ignored-field compatibility hole. History, portable projects, restart and recipe hashes use ordinary existing serialization.

Proposed capability: `selectiveColorPolicy:'rgb-partition-cmyk-v1'`, plus `selectiveColorMethods:['relative','absolute']` and `selectiveColorRanges:['reds','yellows','greens','cyans','blues','magentas','whites','neutrals','blacks']`. This policy is shared between global/source paths; their existing kind/command gates remain separate, and source authoring also requires source coordinates. UI should require Native plus the exact policy and complete recognized range/method support. Old bridges must reject the new kind explicitly.

## Exact RGB membership

All math uses encoded RGB8, not linear-light RGB, Lab or a print-profile conversion. Let `H=max(R,G,B)`, `L=min(R,G,B)`, and define the following integer weights:

| Range | Weight |
| --- | --- |
| Reds | `max(0, R-max(G,B))` |
| Yellows | `max(0, min(R,G)-B)` |
| Greens | `max(0, G-max(R,B))` |
| Cyans | `max(0, min(G,B)-R)` |
| Blues | `max(0, B-max(R,G))` |
| Magentas | `max(0, min(R,B)-G)` |
| Whites | `max(0, H+L-255)` |
| Neutrals | `2*min(L,255-H)` |
| Blacks | `max(0,255-H-L)` |

The six chromatic weights sum to `H-L`. For ordered channels `H>=M>=L`, only the primary amount `H-M` and adjacent secondary amount `M-L` can be nonzero. The achromatic component comprises `L` white and `255-H` black; pair equal portions of those as the middle neutral amount. Consequently Whites+Neutrals+Blacks equals `255-(H-L)`, all nine sum exactly 255, and at most four are nonzero. Tied channels need no hue division or special numerical epsilon.

Examples:

- `[255,0,0]`: Reds 255 only.
- `[255,128,255]`: Magentas 127 and Whites 128.
- `[200,150,100]`: Reds 50, Yellows 50, Whites 45 and Neutrals 110.
- Gray 127: Blacks 1 and Neutrals 254; gray 128: Whites 1 and Neutrals 254. The mathematical neutral center is 127.5, which is between RGB8 samples.
- Black and white belong entirely to their corresponding tonal range.

A narrower alternative based on all-channel thresholds (`Whites=max(0,2L-255)`, `Blacks=max(0,255-2H)`) also partitions with a residual Neutral weight, but routes `[255,128,255]` mostly through Neutrals. The chosen decomposition gives a more direct white/pure-color mixture. This is an explicit native choice, not a claim about Adobe's complete membership functions.

All memberships observe the original input RGB of this adjustment/filter entry. Changing one range does not reclassify a pixel before applying another range. Source stack order can change the next entry's input and therefore its memberships, as expected.

## Virtual ink and exact rounding

Compile each percentage to the signed integer `A=round(percentage*100)` in −10000..10000. For each range j and RGB channel c, compile `P_j,c=A_j,c+A_j,K`: Cyan pairs with Red, Magenta with Green, and Yellow with Blue. K is an equal signed contribution to all three virtual complementary channels. It is not extracted physical black ink, and there is no CMY×K cross-product.

For original byte C, calculate `S_c=sum(weight_j*P_j,c)` from the original memberships. This weighted integer may be negative. The unrounded candidate is:

- **Absolute:** `C-S_c/10000`. A positive effective ink percentage subtracts that fraction of a full byte range.
- **Relative:** `C-(255-C)*S_c/(255*10000)`. The same percentage changes the existing complementary amount `255-C`.

These definitions apply both signs symmetrically before clamping. In particular, Relative cannot alter pure white. Positive K can leave a fully saturated primary unchanged: zero complementary components cannot grow proportionally, while full components clip. Negative K can lighten it. Absolute can introduce ink at white or darken a saturated primary. Equal opposite C and K contributions cancel on Red; K still contributes to Green and Blue. These are deliberate visible properties of the native additive model, not hidden exceptions.

For an integer rational candidate `U/D`, use:

- Absolute: `U=10000*C-S_c`, `D=10000`.
- Relative: `U=2550000*C-(255-C)*S_c`, `D=2550000`.

Clamp U to the closed range `[0,255D]`, then output `floor((2U+D)/(2D))`. This is half-up rounding once after the complete range sum. Do not round individual range corrections, clamp individual range results, or round the weighted percentages first. A zero configuration returns the exact original RGB tuple.

Each compiled P lies in −20000..20000. Since nonnegative weights total 255, `|S|<=5,100,000`. Every product/sum in U stays below the conservative bound 1,950,750,000 in magnitude, below 2^31 and far below binary64's exact-integer limit. After clamp, `2U+D<=511D`; `2D<=5,100,000<2^23`. A noninteger quotient is at least `1/(2D)>2^-23` from an integer, while division's maximum half-ULP in this output range is 2^-46. Thus `Math.floor` cannot cross the intended integer boundary; exact integer quotients are representable. Runtime BigInt, floating epsilon and fallback paths are unnecessary. An independent BigInt oracle validates the implementation rather than defining its performance path.

## Stage, alpha and protection

The pure transform returns a byte candidate only. Source filters then run their unchanged per-entry RGB blend and opacity, followed by the existing whole-stack source mask, geometry and original-context protected restoration. Alpha and alpha-zero hidden RGB remain unchanged. Spatial filters neighboring this entry continue to receive the whole previous stage; the range weights do not gate their neighborhoods.

Treat this new global kind as a color-mapping adjustment: preserve alpha, skip alpha-zero hidden RGB, and respect existing global opacity/additional masks/protected footprints. This is a new kind's declared policy and does not change legacy Curves/Levels/scalar hidden-RGB behavior. Generated exclusions, isolated groups, clipping and lower protected content retain their existing callers. Add/update on protected targets keeps the existing refusal; making an already adjusted layer protected later freezes the current authored appearance.

All-zero controls are only an identity **candidate**. A source Multiply/Screen/etc blend can still change the input, and active entries still participate in protection/source-edit guards. Bake uses the same candidate/blend/opacity/whole-stack-mask order and retains working/source alpha, original asset references, geometry/masks and existing rollback scope. No implicit baking or source editing is added.

## Work, setup and memory proposal

Compile a maximum of 36 percentage integers and 27 C+K coefficients in bounded configuration arrays. No per-pixel membership array is necessary: a high/middle/low decomposition chooses two chromatic coefficient rows, one neutral row and one white-or-black row. Each pixel then has four weighted contributions per output channel. No LUT, image plane, spatial ring or shared persistent table is introduced.

Propose source work `12*S` for every active nonzero configuration, independent of method, number of nonzero rows or clipping. Exact all-36-zero configurations charge `1*S`; disabled/opacity-zero entries charge zero. Nonzero authored rows that happen to cancel remain charged 12 for stable conservative admission. Existing +40S nonnormal blend and +8S evaluating source-mask charges apply. A single Normal computing filter at the existing 24 MP source limit consumes 288M of the 384M weighted budget. Two at 16 MP consume exactly 384M. A shared evaluating mask raises a computing entry to 20S; a nonnormal blend raises it to 52S. Other source, group, Distort and Bake limits may be stricter; this is not blanket capacity or a latency guarantee.

Use `min(32,floor(65536/width))` rows, with minimum one, for source and global pixel batches. Nonnormal blends keep their stricter 16,384-pixel rule. Parent separately owns the general global-loop responsiveness follow-up; implementation should reuse the resulting common bounded scheduling instead of changing legacy numeric or alpha branches. No unbounded setup or per-pixel BigInt path exists.

Spatial/shared cache estimates remain zero. Existing scalar candidate frame maxima therefore stay unchanged in layer-filter admission, masked complete-source admission, Distort's all-leaf decoded phases and Bake's encoded/decode/filter/mask/encode/publication phases. Bounded coefficient objects are configuration metadata, not a new full-surface memory guarantee. Recipe validation and partial-update activation must still recompute cumulative source work before reads, including hidden/disabled records when activated. Existing source-alpha/procedural/callback/retained-mask/noise table reserves remain intact.

## Implementation seam map, after approval only

| Seam | Proposed change |
| --- | --- |
| New `server/selective-color.mjs` | Frozen policy/range/method constants; strict normalizer; all-zero predicate; pure compiled RGB transform |
| `server/color.mjs` | Add value-zero kind, parameterized and color-mapping dispatch; delegate normalization/transform; bounded source yield classification |
| `server/layer-filters.mjs` | Inherit new global range/kind; add stable 12/1 work rule; no spatial/shared cache or candidate plane |
| Native capabilities/default creation labels | Advertise policy/method/range lists and `Selective Color` creation label; existing saved labels unchanged |
| Native graph/recipes/portable | Existing typed normalization flows apply; malformed records reject before pixels; full normalized recipe rows prevent target inheritance |
| Shared commands/recipe schemas | Strict four-tuples, centipercent validation, optional fields, value-zero/kind allowlists; global/source kind counts 25/29 |
| Status/MCP/optional bridge | Forward capability fields; describe native arithmetic and limits; reject unsupported bridge kind |
| Client | Shared source/global control editor, exact drafts and row replacement, independent policy/kind gates; no automatic document writes |

No PSD native adjustment serialization is added. Existing PSD export refusal/flattened-output behavior remains, as do recipe size and source filter count limits.

## Prototype evidence and remaining acceptance

Proposal files: `test-results/selective-color-evaluation/{prototype.mjs,probe.mjs,report.json}`. The current run exhaustively checks all 16,777,216 RGB8 memberships: nonnegative integer weights, exact sum 255 and at most four nonzero ranges. 759,720 output bytes agree with an independently structured BigInt sorted-channel oracle, including all controls at endpoints/tiny percentages, all named ranges, both methods and mixed settings. Eleven initial normalization/ownership checks pass. `edges.mjs` and `edges-report.json` add ten literal rounding/range fixtures, 12,288 mixed-alpha output bytes, full-row update retention and identity Multiply/Screen behavior. More integration fixtures belong in maintained tests only after approval.

Independent review separately checked the actual prototype across all 16,777,216 memberships and 684 configurations × 256 pixels (525,312 output bytes) against a BigInt oracle, including channel ties, original-input ownership, hidden alpha and malformed parameter cases. No arithmetic or normalization blocker was reported. The independently maintained review is [SELECTIVE_COLOR_REVIEW.md](SELECTIVE_COLOR_REVIEW.md).

Ordinary Node v22.14.0 on Apple M5 Max, opacity .625 and opaque samples (all pixels graded):

| Proposal workload | All-range Relative | All-range Absolute |
| --- | ---: | ---: |
| 1024 × 1024 | 20.91 ms | 22.17 ms |
| 8192 × 128 | 20.62 ms | 20.76 ms |
| 128 × 8192 | 29.70 ms | 24.10 ms |
| 6000 × 4000 | 480.13 ms | 470.26 ms |

All-zero candidate is 10.02 ms at 1024² and 211.00 ms at 24 MP with the same copy/interpolation loop. One active row costs approximately the all-row path. Maximum measured 5 ms heartbeat gap is 7.31 ms in computing cases and 15.05 ms in the large identity case (allocation/setup is outside a hard loop deadline). Actual production integration must be measured again. These results support the conservative proposed 12/1 weights without a rarity assumption.

The existing 512² astronaut fixture is used, source SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. Owner visually inspected original, `warm_skin.png` and `cool_shadows.png`; range effects are visible without blanket recoloring. Warm Reds/Yellows changes 228,539 RGB bytes by at most 12; cool Blacks/Neutrals changes 439,648 by at most 20. `bright_whites.png`, `relative_white.png` and `absolute_white.png` expose the method difference. File digests and exact parameters are recorded in the JSON report. These are diagnostic presets, not nonzero defaults.

Independent prototype review and root acceptance of the weight/capability contract are complete. The integration acceptance checklist covers sparse/partial/full defaults, all range/method endpoints, simultaneous summation, source/global alpha, blend/opacity/deferred mask and geometry/Bake, protection/generated/isolated/clipping, graph/recipe pre-read work activation boundaries, portable/restart, actual persistence and late transaction rollback, and UI saved/draft capability withdrawal with exact row retention. Backend evidence follows; schema/SDK/UI/full-suite closure belongs to the corresponding owners.

## Isolated helper promotion

Root accepted the independent design review and authorized `server/selective-color.mjs` plus pure tests while the prior UI milestone closes. The helper exports frozen `SELECTIVE_COLOR_POLICY`, `SELECTIVE_COLOR_RANGES`, `SELECTIVE_COLOR_METHODS`, and three functions:

- `normalizeSelectiveColorParameters(parameters)`: validate sparse input and return complete fresh owned settings; callers merge retained settings before invoking it for a partial update.
- `selectiveColorIsIdentity(parameters)`: validate/effectively default input and report only all-36-zero controls. Nonzero C+K cancellation stays false for conservative work admission.
- `selectiveColorTransform(parameters)`: compile private bounded coefficients and return a pure RGB8-to-fresh-RGB8-tuple function. It owns no alpha, image, LUT, cache or exported mutable plan.

Owner pure tests `tests/selective-color.test.mjs` pass 6/6. Independent `tests/selective-color-audit.test.mjs` passes 4/4, using the maintained production-independent BigInt fixture `tests/fixtures/selective-color/exact-reference.mjs`; 424,278 bytes across 194 configurations × 729 pixels pass. Combined closure is 10/10 in 0.19 s, logged in `test-results/selective-color-evaluation/helper-closure.log`. Both suites cover literal overlap cancellation, one-round/half boundaries, Relative/Absolute endpoints, strict metadata, authored-zero versus cancellation, and caller/closure/output ownership. No integration imports or new advertised kinds/capabilities were added during this step. Native/SDK/browser/production timing acceptance remains pending the separate integration authorization.

## Integrated production acceptance

After the previous UI milestone closed, root released registration. `server/color.mjs` delegates the new kind to the reviewed helper and classifies it as parameterized/color-mapping. `server/layer-filters.mjs` applies the frozen 12/1 work rule, with no added image or cache reserve. Native advertises the policy/method/range fields, 25 global kinds and 29 source kinds, and gives newly created adjustments the label `Selective Color`. Existing authored names are retained. The existing complete recipe normalizer naturally materializes method and all nine rows; no new recipe-specific reset path was needed. Root's global `applyAdjustment` scheduling implementation was left intact.

Maintained owner native tests `tests/selective-color-native.test.mjs` pass 7/7. They include all 26 entry blends against an independent byte candidate, every source-mask byte with density 0.1, global hidden RGB/protection/mask/opacity, the exact 384M source-work boundary and activation refusal before reads, complete recipe reset and append beneath a retained source mask, source-alpha plus Distort/Bake exact raw working bytes, portable/restart, real ENOTDIR and late Bake/brush asset rollback, and wide source/global yield checks. The older all-kind Bake catalog now exercises computing Selective Color parameters among all 29 kinds.

Independent audit expanded from four pure cases to 11 total cases, including protected generated/clipped/isolated contexts and malformed global/source/recipe portable data before asset access. Combined pure/owner/audit closure is 24/24 in 0.62 s; log `test-results/selective-color-evaluation/integration-closure.log`. The initial recipe-only failure was the intentionally pending shared kind schema; after root landed it, all owner cases passed without a runtime correction.

The final targeted adjacent closure passes 164/164 in 2.98 s, including all three Selective suites, existing color/tonal/spatial/source/Bake/filter-mask/recipe/Distort families, Smooth Curves, fresh-process scalar regression and root's global-yield checks. Log: `test-results/selective-color-evaluation/adjacent-tests.log`. The one earlier adjacent fixture failure assigned scalar value 1 to the new value-zero kind; its all-kind catalog was updated, with no production change. Backend ownership is released for root's full-suite and SDK closure.

Actual production measurement command: `node test-results/selective-color-evaluation/production-benchmark.mjs`. JSON/log artifacts use the same basename. Ordinary Node v22.14.0, macOS arm64, Apple M5 Max; opaque RGB and opacity .625 grade every pixel. Five 10,000-compilation batches, including one sample invocation per compilation, measured 0.00386–0.00524 ms per setup. Source/global output hashes match in all 16 matching cases.

| Workload | Source Relative | Global Relative | Source Absolute | Global Absolute |
| --- | ---: | ---: | ---: | ---: |
| 1024 × 1024 | 27.48 ms | 30.17 ms | 27.60 ms | 30.26 ms |
| 8192 × 128 | 26.84 ms | 30.03 ms | 33.96 ms | 37.45 ms |
| 128 × 8192 | 31.20 ms | 33.11 ms | 37.37 ms | 41.28 ms |
| 6000 × 4000 | 605.27 ms | 678.04 ms | 768.20 ms | 860.19 ms |

The table uses computing controls in all nine ranges. One active range is in the same measured cost band; zero controls cost 13.56/17.17 ms source/global at 1024². The maximum measured 5 ms heartbeat gap across computing cases is 9.66 ms. The integrated caller is slower than the standalone prototype, as expected from its retained validation/interpolation/ownership paths; the conservative 12S work policy remains unchanged. Measurements do not promise real-time latency or process RSS.

The actual source evaluator reproduces both reviewed photographic prototypes byte-for-byte, including their PNG hashes: `warm_skin-production.png` SHA-256 `bfa4c598a73a5a618d750e43ef33e8520cdc688485848c5779a525fc36fe993d`; `cool_shadows-production.png` SHA-256 `13ad83f68481f994713241edaab84bd76745a7a3c8feea8928958319863c394d`. Both live under `test-results/selective-color-evaluation/`. No new provider, image source or dependency was used.

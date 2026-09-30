# Independent review: native Selective Color

Status: **production helper and native integration independently audited, 11/11 maintained tests passing; client source reviewed and 2/2 maintained client helper tests passing; owner's focused 8 plus adjacent 59 browser workflows passing, build passing**. Root reports the integrated suite at **1016/1016**. The contract in [SELECTIVE_COLOR_DESIGN.md](SELECTIVE_COLOR_DESIGN.md) has no remaining production source blocker from this review. Independent proposal evidence lives in `test-results/selective-color-review/`; maintained tests are `tests/selective-color-audit.test.mjs` and `tests/selective-color-client-audit.test.mjs`.

## Recommendation and reference boundary

The proposed `selective_color` is a useful bounded global/source adjustment: nine color/tone ranges, four signed CMYK-style controls per range and explicit Relative/Absolute methods. It differs usefully from a whole-image channel matrix or the existing luminance-based Color Balance controls. Zero defaults avoid imposing an authored treatment on creation.

Adobe documents editable color-range correction on RGB images, proportional Relative changes, percentage-point Absolute changes and overlapping range influence. Its half-magenta example motivates a mixture of a pure chromatic range and Whites. It does not publish a complete pixel algorithm on this page. These observations support the workflow, not numerical Photoshop equivalence. [Adobe Selective Color documentation](https://helpx.adobe.com/in/photoshop/using/mix-colors.html)

The referenced FFmpeg filter is LGPL-2.1-or-later code, with floating per-range processing and a different coupled Black formula. Its bytes are unsuitable as an exact oracle for this native proposal. This review and the architect inspected it as a comparison; neither should describe the work as a clean-room process. The proposal adopts an independently stated range partition, additive virtual ink and one final integer-rational rounding, without importing FFmpeg code or adding a dependency. If implementation code is later reused, its license obligations require explicit handling rather than assuming an algorithm citation is sufficient. [FFmpeg source and license header](https://ffmpeg.org/doxygen/trunk/vf__selectivecolor_8c_source.html), [FFmpeg licensing guidance](https://ffmpeg.org/legal.html)

The controls must be described as native encoded-RGB corrections using virtual complementary ink amounts. They are not physical CMYK separations, a print-profile conversion or an Adobe preset format.

## Range decomposition and useful semantics

The architect's final nine weights are a partition of 255. An independent way to derive them is to sort the input channels as high, middle and low. The primary vertex contributes `high-middle`; the adjacent secondary vertex contributes `middle-low`. The achromatic remainder contains `low` white and `255-high` black. Pair equal portions of those two amounts into Neutrals, leaving only Whites or Blacks alongside it.

This construction proves nonnegative integer weights, a sum of 255 and at most four contributing ranges. It is continuous before byte quantization and needs no unstable hue division at gray or tied channels. The prototype's optimized row selection agrees with a separately coded sorted-cube decomposition at all channel-tie boundaries and a regular sample of the RGB cube.

The final white/black split is preferable to the earlier all-channel-threshold alternative for this feature. `[255,128,255]` has Magentas 127 and Whites 128, a direct color/white mixture. Gray 127 has Neutrals 254 plus Blacks 1; gray 128 has Neutrals 254 plus Whites 1. The mathematical neutral midpoint is 127.5, so neither integer gray should be mislabeled an exclusive neutral range.

Every range observes the original RGB input of this adjustment entry. Corrections are simultaneous, with one final clamp and round. Do not reclassify after each edited range, round each range separately or clamp each range's correction. The order of separate filter entries remains meaningful because the next entry receives the previous result.

Black adds the same signed control to Cyan, Magenta and Yellow before membership weighting. Positive Cyan reduces Red, positive Magenta reduces Green and positive Yellow reduces Blue. Relative scales the resulting correction by the existing complementary component; Absolute uses the full byte range. This is a coherent additive native model with useful and explainable limits:

- Relative leaves pure white unchanged. Positive Black can also leave a fully saturated primary unchanged: its absent complementary component cannot grow proportionally, and the others are already at their clamp. This must be visible in help rather than advertised as universal darkening.
- Absolute can introduce a cast at white or darken a saturated primary.
- Opposite Cyan and Black cancel on Red, while Black still contributes to Green and Blue. Opposite corrections from different ranges can also cancel before the final clamp.
- All-zero rows are exact identity in both methods. Nonzero controls whose combined coefficients happen to cancel are also numerically unchanged, but need not receive a lower work charge.

The inspected warm-range and cool-dark-range photographic prototype outputs show useful selective changes with retained detail. They are diagnostic presets, not proof of Adobe parity or proposed nonzero defaults.

## Exact arithmetic and rounding proof

Canonical percentages become integers `A` in `[-10000,10000]`. A compiled channel coefficient is the corresponding CMY control plus Black, in `[-20000,20000]`. Weighted summation gives an integer `S` with `|S| <= 255*20000 = 5,100,000`.

For input byte `C`, the complete candidate is `U/D`:

| Method | U | D |
| --- | --- | --- |
| Absolute | `10000*C-S` | `10000` |
| Relative | `2550000*C-(255-C)*S` | `2550000` |

All products and additions are exact binary64 integers. Even the conservative bound formed by adding their independent magnitudes is below `2^31`. Clamp `U` to `[0,255D]`, then compute `floor((2U+D)/(2D))`. The doubled numerator is at most `511D = 1,303,050,000` for Relative, also below `2^31`.

The division followed by `floor` is exact for the intended half-up byte result. Its positive denominator is at most 5,100,000, below `2^23`; a noninteger quotient is therefore more than `2^-23` from the nearest integer boundary. Binary64 division in the clamped output range has maximum error at most `2^-46`. Exact integer quotients are representable. Neither a false crossing nor an epsilon/BigInt fallback is needed. Negative candidates are clamped before this argument is applied.

This proof covers every admitted control and byte, including exact half ties, rather than relying only on random agreement. Public arbitrary opacity is a later existing blend stage; the new exact candidate guarantee must not be expanded into a claim about unrelated floating opacity or nonseparable blending.

## Independent prototype evidence

Run `node test-results/selective-color-review/probe.mjs`. The current report passes:

- All **16,777,216 RGB8 combinations** have valid weights totaling 255 and at most four nonzero memberships.
- **684 configurations, 175,104 pixels and 525,312 output bytes** agree with a separate nine-row BigInt reference. The oracle derives memberships by sorted cube vertices and sums every row directly; it does not use the prototype's weight helper, compiled row selection or Number rounding.
- Default identity, both methods, every range/control, signed extremes, 0.01% controls, randomized complete configurations and nonzero exact-cancellation rows are included.
- A 256-pixel RGBA fixture retains alpha 0/1/128/255, hidden RGB and input ownership. Zero opacity is byte-identical. Strict malformed controls and accessors reject without evaluating a getter; normalized rows are owned copies.

Useful exact fixtures include:

| Input and settings | Expected RGB |
| --- | --- |
| White; Relative Whites `[100,100,100,100]` | `[255,255,255]` |
| White; Absolute Whites Cyan 50% | `[128,255,255]` |
| `[255,128,255]`; Absolute Whites Cyan 50% | `[191,128,255]` |
| Red; Relative Reds Black 100% | `[255,0,0]` |
| Red; Absolute Reds Black 50% | `[128,0,0]` |
| `[200,100,50]`; Absolute Reds Cyan +100%, Neutrals Cyan −100% | `[200,100,50]` |
| `[255,128,255]`; Absolute Magentas and Whites Cyan 1% each | `[252,128,255]` |

The last two distinguish simultaneous unclipped correction and single rounding from tempting per-range alternatives. These are prototype results only; production must be checked again after promotion.

## Integration and admission requirements

The new kind remains `value:0` with fresh complete normalized parameters, default method Relative and nine zero four-tuples. Sparse adds default omitted fields. Partial updates preserve omitted method/ranges and replace each supplied whole tuple. Canonical recipes contain the complete effective configuration, so applying a default recipe must reset a nondefault target rather than inherit its old settings. No special omission/reset marker is needed because the method and rows are all present after normalization.

Reject malformed methods, null, surplus keys, holes, nonfinite or finer-than-centipercent controls before pixels. Unknown kinds already make old native readers fail closed; avoid an ignored-field fallback. Valid sparse stored records need not be rewritten merely by reading them. Native/portable/recipe readers and public schemas must share effective defaults without compiling transforms during metadata validation.

Use independent Native policy plus global/source kind and command gates. The proposed policy is `selectiveColorPolicy:'rgb-partition-cmyk-v1'`, with explicit method and range capabilities. Disabled entries still require support for their saved semantics. A ready recipe report must become stale when applicable capabilities disappear.

For this new global kind, color-mapping behavior deliberately skips alpha-zero RGB and preserves alpha. Do not alter legacy Curves/Levels/scalar policies. Source processing remains source-alpha combination, byte candidate, existing entry blend/opacity, complete-stack effect mask, geometry and contextual protection. Identity candidates remain structurally active and can change RGB with a nonnormal blend. Lower protected pixels, generated exclusion, isolated groups and clipping must be exercised through their actual callers. Bake must preserve raw alpha, separate alpha, original source assets and retained geometry while consuming the editable stack/mask as usual.

The proposed **12S computing / 1S all-authored-zero / 0 disabled-or-opacity-zero** source work rule is conservative relative to the owner's bounded measurements. Keep the uniform +40S nonnormal blend and +8S active whole-stack mask charges. Metadata updates and recipe staging must revalidate cumulative work before any asset/model access, including an identity-to-computing activation that crosses the limit. A successful work check does not waive a stricter source/Bake/Distort buffer limit.

Setup stores only bounded coefficients for nine rows. No LUT, full image plane, spatial cache or shared persistent table is added, so existing scalar frame maxima and mask/Bake/Distort phase accounting remain intact. Pixel batches must remain bounded at 65,536 visits, with the existing stricter nonnormal blend cadence. This is a scheduling bound for the loop, not a whole-operation deadline or new cancellation guarantee.

The architect reports roughly 21–30 ms per 1 MP computing prototype and 470–480 ms per 24 MP, with a maximum measured computing heartbeat gap of 7.31 ms. These are owner measurements, not independent timing guarantees. The simpler exact Number path has no data-dependent BigInt fallback or rare worst case requiring a different work policy.

No design blocker remains after the final membership, additive Black and single-round contract was pinned. Before release, maintained native/schema/SDK tests should cover partial/full defaults and recipe resets; actual source/global alpha and stage order; work activation before I/O; protected/generated contexts; malformed portable metadata; exact Bake; real persistence failure and late-transaction asset rollback. UI acceptance must separately verify all nine retained row drafts, exact percentages, independent capabilities and pending-result ownership.

## Isolated production helper audit

Root initially authorized only `server/selective-color.mjs` and pure tests while Curves acceptance finished, then released native integration. Source review confirms the approved exact integer formula, original-pixel membership, single final clamp/half-up, zero-only identity predicate and bounded owned coefficients. The helper has no filesystem/model/image dependencies or registration side effects. It does not expose a diagnostic plan or retain caller-owned rows.

`node --test tests/selective-color-audit.test.mjs` passes **4/4** in approximately 0.20 seconds. The maintained oracle at `tests/fixtures/selective-color/exact-reference.mjs` imports no production normalizer or arithmetic helper.

- 194 parameter configurations across 729 RGB cube boundary samples produce **424,278 output bytes** matching the independent sorted-vertex/nine-row BigInt oracle. Both methods, every range/control endpoint and seeded complete configurations are included.
- Literal goldens pin simultaneous range cancellation, single rather than per-range rounding, native Relative white/saturated-primary limits, additive Black coupling, exact half ties and the adjacent admitted 0.01% controls. Nonzero rows that cancel stay nonidentity for admission while producing unchanged RGB.
- Plain-object/dense-row validation rejects unknown keys, nonfinite or noncanonical controls, null, holes, foreign prototypes, symbols, nonenumerable properties and accessors. Getter counters remain zero. Null-prototype data and frozen ordinary rows remain valid.
- Defaults are complete, negative zero canonicalizes, rows are separate owned copies, compiled settings survive later caller mutation, alternating transforms remain independent, and each output tuple is fresh.

No isolated-helper production blocker was found. Those first four tests deliberately make no native integration claims; the subsequent acceptance is recorded below.

## Maintained native integration audit

After root released the shared schema and native wiring, `node --test tests/selective-color-audit.test.mjs` passes **11/11** in approximately 0.56 seconds. Running it with the existing owned Channel Mixer audit passes **20/20**. The only older assertion changed was discovery count: 25 global kinds and 29 source kinds. No production files were edited by this review.

Source review confirms the new parameterized/color-mapping dispatch, bounded row scheduling, 12/1 source work, sparse normalization and existing full-configuration recipe path. No new full surface, ring or shared table was introduced. Integration evidence covers:

- Sparse graph reads retain their representation. Partial source/global updates replace the supplied complete tuple, retain omitted method/rows and preserve attached mask/density. Exact all-zero identity charges 1; nonzero coefficient cancellation still charges 12; nonnormal blend adds 40; disabled and zero-opacity work is zero. Cache/shared reserves remain zero.
- Two computing 16 MP filters admit at exactly 384M work; even an added identity then refuses. A hidden 12 MP stack's third identity-to-computing update refuses before image/filesystem access. Enabling the shared mask on a 19.2 MP computing-plus-identity stack also refuses before reads. Prior document and assets remain unchanged.
- Complete default and sparse recipes reset existing nondefault global targets instead of inheriting omitted controls, append to an already masked source stack, preserve the exact wrapper mask and keep the saved hash/definition stable. Validation has zero pixel/filesystem calls. Actual application matches explicit equivalent commands and adds one undo entry. Over-budget validation reports the limit and application refuses without I/O.
- Actual global and source paths preserve alpha-zero hidden RGB and alpha 0/1/128/255. Independent candidate bytes then follow existing partial-opacity, additional mask/density and protected-footprint order. All-zero source Multiply remains a real RGB operation.
- The source oracle combines separate alpha first, evaluates two Selective entries sequentially, rounds candidates before Normal/Multiply opacity, applies the complete-stack native-density alpha8 mask, then checks exact integer Distort translation. The fixture distinguishes evaluating the second range map from the wrong original pixels. Bake's raw working PNG matches the independently expected RGB while restoring original working alpha; separate alpha, source asset, additional positioned mask/density and geometry remain attached. Composite appearance and original asset files are identical before/after Bake.
- Lower protected soft-alpha content and its outline remain exact through an isolated group and generated clipping member. Ordinary source RGB restores in the protected footprint, generated isolated-preview alpha is zero there, and source inspection remains ungraded. Protected-target identity additions and lower-context Bake refuse before pixels.
- Malformed methods, tuple lengths, precision, bounds, unknown fields and nonzero value reject through native mutations and forged global/source/recipe portable manifests before asset reads. Spy counters are checked after exceptions, so an accidentally swallowed filesystem assertion cannot pass as ordinary validation.
- During the subsequent HSL audit, the owned portable fixture was strengthened to canonicalize its rewritten manifest and first prove an unchanged graph decodes. The previous negative fixture could reject at container canonicalization before reaching Selective validation. All11 Selective checks still pass with that independent cause excluded; no production behavior changed.
- A real `ENOTDIR` project path rejects both a metadata update and a Bake after publication of a genuinely new colored asset. Graph/history/project files and assets remain unchanged, including removal of that newly owned asset. A later transaction changes both parameter sets, Bakes, paints and finally fails on a missing layer; at least two actual pixel writes occurred, and their owned assets are removed while the entire old state is retained.

The first integration run's two failures were the expected temporary absence of root's shared Selective recipe/transaction schema, not native defects. Both pass after the schema landed. No native production blocker remains. The client design's complete hidden-row drafts, strict support gates, row-specific checkbox ownership and retained range inspection agree with this contract; actual client source/browser acceptance is still separate.

## Client source and helper audit

`node --test tests/selective-color-client-audit.test.mjs` passes **2/2** against the actual TypeScript helpers compiled through Vite. The cases cover all nine retained string rows, hidden invalid values, decimal/scientific equivalent clean comparisons, exact centipercent admission, negative-zero canonicalization, owned rows, complete typed capability lists and independent Native global/source availability. Known required methods/ranges must all be present; additional future string entries do not weaken that requirement.

Source review covers the shared controls, source editor, stable global editor, `preciseColor` response ownership and recipe capture/execution gates. Only Curves and Selective Color participate in the precise-color ownership path. Row checkbox changes capture the edited row's actual kind even when another filter is selected. Entry epochs reject away-and-back selection changes, while whole-stack actions retain their separate selected-entry-independent context. Full parameter rows are captured canonically; incomplete or unsupported drafts cannot submit.

Two bounded inspection findings were corrected by the client owner. A blanket source fieldset no longer disables Selective's range selector when the target is protected or the saved mask/blend is unavailable; individual ink, method, reset, blend, opacity and Apply controls still refuse editing. The App also retains the saved Selective adjustment inspector when the update command is withdrawn, preserving incomplete strings while submission remains disabled. These changes leave the older adjustment families' mount/fieldset rules intact. No mutation bypass or remaining production source blocker was found. Focused browser evidence remains a separate acceptance gate.

The final-source owner browser report at `test-results/selective-color-browser-report.json` records **8/8 focused workflows**. I inspected the report, which uses the maintained independent cube-partition/BigInt reference and records zero browser errors, provider calls or key reads. The two expected refusals are one `update_adjustment` revision conflict and one actual source work-limit refusal. The owner explicitly exercised both inspection fixes, cross-selected-kind toggle preview withdrawal, entry away-and-back epochs, global navigation, exact source/global pixels and raw Bake, complete recipes/masked append and portable/photo workflows. These are owner-run browser results, not a second independent browser execution. The owner subsequently closed all **59 adjacent workflows** and the build, with no pending source changes; the adjacent report is `test-results/selective-color-adjacent-report.json`.

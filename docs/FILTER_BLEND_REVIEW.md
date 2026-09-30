# Independent review: per-filter RGB blending

Production helper and native caller audit verified, 2026-09-19. The nine independent checks in `tests/filter-blend-audit.test.mjs` pass against the implemented contract in [FILTER_BLEND_DESIGN.md](FILTER_BLEND_DESIGN.md), with the final uniform **40 × source pixels** surcharge for every nonnormal mode. Existing source/global filter kinds remain 26/24; the feature adds one optional entry setting, not a new filter or compositing surface. UI browser and integrated-suite acceptance remain separately owned.

## Stage and compatibility contract

An enabled, positive-opacity entry receives its preceding stack output as byte RGB `B`, computes its existing full-strength byte candidate `F`, blends `F` with `B`, then applies the entry opacity once and rounds the final RGB bytes. Do not quantize the blend before opacity. With Multiply, `B=1,F=51,opacity=.625`, the result is 1; rounding the intermediate blend 0.2 first incorrectly produces 0.

All inspected scalar transforms already return clamped integer bytes. Spatial/noise candidates likewise return byte buffers. The test-only experiment verifies 2100 scalar outputs and 156 unchanged Normal comparisons across all 26 filter kinds and six opacities. Normal must keep its existing `B+(F-B)*opacity` expression, identity skips, work, serialization and yielding; it must not be silently routed through the new exact-rational policy.

Use the 26 existing RGB modes, excluding Dissolve. Preserve every effective alpha byte and all zero-effective-alpha RGB. Positive alpha does not multiply this blend again. Source-cutout alpha is combined before the stack; additional masks, selection, geometry, layer/group blending, clipping and document protection remain their existing later stages. Spatial candidate neighborhoods retain their own alpha-weighted behavior. Thus identical local RGB at alpha1 and alpha255 has the same blend stage, but a spatial candidate can differ because neighboring coverage differs.

Adobe's individual Smart Filter blend controls support this workflow; its mask applies to the filter stack. Neither fact establishes Photoshop numerical equivalence or individual filter masks for Prism. [Adobe Smart Filters](https://helpx.adobe.com/photoshop/using/applying-smart-filters.html). The W3C definition separates a pure RGB blend function from alpha compositing, which fits this source operation. [W3C blending specification](https://www.w3.org/TR/compositing-1/#blending).

Missing and explicit `normal` are equivalent; canonical writes omit the field. An omitted update preserves a saved nonnormal mode; explicit `normal` deletes it. Unknown names, Dissolve, null and misplaced parameter/global fields reject even when the entry is disabled, opacity0 or computationally identity. Existing older readers reject an unknown filter field, providing the compatibility barrier for saved nonnormal entries. An ordinary canonical Normal record remains unchanged.

## Numerical findings and accepted refinement

Reusing normalized `blendRGB` for every mode, even with the previously corrected byte formulas for Multiply/Screen, produced avoidable one-byte errors. The new filter policy needs its own helper; existing layer/group/clipping calculations remain unchanged.

| Mode | Input / candidate / opacity | Correct final byte |
| --- | --- | ---: |
| Multiply | 13 / 85 / .75 | 7 |
| Screen | 17 / 130 / .375 | 63 |
| Difference | 2 / 69 / .5 | 35 |
| Linear Burn | 2 / 254 / .5 | 2 |
| Linear Light | 0 / 128 / .5 | 1 |

The initial Multiply/Screen approach failed 48 cases in 1,179,648 exhaustive byte-pair/dyadic-opacity comparisons. Normalized whole-color sums also misclassified a tie: `[34,43,0]` and `[0,77,0]` both sum to 77, but their normalized sums differ by one floating step. New Darker/Lighter Color must compare integer RGB sums and retain the input on equality.

Eighteen separable modes have exact integer blend ratios `N/D`, with `0≤N≤255D`, `1≤D≤255`. Darker/Lighter Color choose a complete byte triple, then use denominator1. Preserve declared endpoint precedence for Burn/Dodge and exact Vivid/Hard Mix comparisons; the independently derived oracle verifies every channel pair, including conflicting endpoint cases.

For exact authored binary64 opacity `P/Q`, define:

```text
U = B*D*Q + (N-B*D)*P
V = D*Q
output = floor((2*U+V)/(2*V))
```

This performs a single half-up quantization. Both source values lie in gamut, so interpolation keeps `0≤U≤255V`; no extra clipping or blend quantization is required.

When reduced `Q≤2^36`, every Number integer intermediate is exact. Products have magnitude at most `65025Q<2^52`; the final doubled numerator is at most `511*255*2^36<2^53`. The division denominator `2V<2^45` places every noninteger exact quotient more than `2^-45` from an integer floor boundary. Correctly rounded binary64 division below256 has maximum half-ULP `2^-46`, so it cannot cross that boundary. Exact integer quotients are representable. This fast route includes ordinary dyadic opacity values without per-channel BigInt.

For other opacities, estimate `(B*D+(N-B*D)*opacity)/D`. The integer coefficients are exact and bounded by `255D`. Multiplication, addition and division each contribute bounded absolute error; after division the total is less than `4*255u`, where `u=2^-53`. Gradual-underflow absolute error is negligible against that bound. The `64*Number.EPSILON*255` half-byte guard is more than32 times this bound. Outside it, normal rounding is safe; inside it, evaluate the exact BigInt fraction. No epsilon is added to colors. Clamping an estimate at an endpoint cannot change a byte when its error is this small.

Compile the opacity fraction once per entry. Its numerator/denominator and the temporary decoding storage are bounded scalar state, not an image-sized allocation or per-pixel memoization. Release temporary IEEE decoding storage before candidate allocation; do not retain a growing cache of authored opacities. Subnormal opacity is valid and bounded by a 1074-bit denominator. The oracle uses repeated exact doubling rather than the owner's bit-field decoder, providing an independent check of its representation.

Soft Light and Hue/Saturation/Color/Luminosity retain the existing native binary64 core, followed by declared byte-space opacity interpolation. They do not promise correctly rounded exact-real algebra or Adobe equality. The existing nonseparable luma is `.3R+.59G+.11B`, distinct from the Rec.709 tonal helpers. Keep the mode distinction explicit; do not imply that rational-mode proofs cover the floating functions.

## Independent actual-helper evidence

The reproducible scripts and reports live under `test-results/filter-blend-review/`; they are design experiments, not maintained production tests. `compare-owner.mjs` imports only the owner's test-only helper as its subject. Its oracle independently expresses normalized mode definitions as BigInt fractions and derives exact binary64 opacity by repeated doubling.

The refined helper passes:

- All **1,179,648** byte-pair cases across all18 rational channel modes at full opacity.
- **204,800** randomized full RGB/opacity cases across all20 rational modes, with20 opacity values including zero, subnormals, small powers of two, decimal fractions, and immediate neighbors of .5/.75/1. These trigger27,223 generic exact fallbacks.
- Whole-color tie, candidate-before-opacity, ordinary half-byte and immediate-neighbor goldens. Identity Difference at RGB1 returns1 immediately below opacity.5 and0 immediately above; exactly.5 returns1 under half-up rounding.
- A separate1,179,648-case exhaustive Multiply/Screen dyadic-opacity oracle, 29,952 additional opacity-boundary checks, the156 legacy Normal comparisons and2100 scalar-byte checks above.

The benchmark exercises the actual test-only compiled helper with input/candidate/output RGBA buffers,16,384-pixel batches, three runs per fixture, exact expected output checks and5ms heartbeat observation. It excludes decoding, candidate generation, composition and encoding; numbers are local measurements, not application deadlines.

| Fixture, 1,048,576 pixels | Median |
| --- | ---: |
| Difference, opacity.5, exact Number path | 46.5ms |
| Difference, neighboring opacity, every channel fallback | 332–335ms |
| Multiply, neighboring opacity.75, every channel fallback | 339–343ms |
| 8192×128 Difference / Multiply, every channel fallback | 313 /342ms |

Each fallback fixture performs3,145,728 exact channel fallbacks. Maximum observed heartbeat gap is15.56ms. The owner's independently structured full-filter probe gives different Difference timings but a similar large-numerator Multiply maximum; the shared conservative surcharge should follow the latter. The original normalized-core benchmark remains in `report.json` for diagnosis and does not measure the refined rational evaluator.

## Work, identity and retained buffers

Keep existing candidate work unchanged and add40S for every enabled, positive-opacity nonnormal mode. Normal adds zero. Identity blur/sharpen, Unsharp and Noise entries therefore cost41S, computing Noise48S, and preserved Color Balance80S. The384-million document work cap admits at most9,365,853 identity-source pixels with a nonnormal mode. Hidden entries count; mode-only, enabled and opacity activation must revalidate before pixels/assets and roll back atomically. No opacity-dependent work discount: adversarial near-half opacity can be much slower than .5 despite nearly identical visual settings.

Computational identity is not final identity. For RGB128, identity candidates under Multiply/Screen/Difference produce64/192/0, or96/160/64 at half opacity. Blur/sharpen sigma0, all three Unsharp identities and Noise amount0 must enter nonnormal blending while retaining no Gaussian ring, noise table/hash work or full candidate allocation. Alias the current output as the candidate and snapshot all three RGB components before writes, particularly for whole-color/nonseparable modes. Disabled and opacity0 remain complete bypasses. Tiny positive Gaussian identities retain their previous conservative candidate work/cache.

No new image plane is required. The existing candidate/current-output lifetime, spatial ring maximum, persistent4096-byte Gaussian reserve, group/clipping/positioned-mask accounting and four Bake phase fields remain valid. Nonseparable short arrays and bounded BigInt temporaries are scalar JS state, not a claim of total RSS. New blend loops yield after at most16,384 visited pixels, including skipped alpha0, and keep stricter existing color yields. Candidate construction retains its own bounds. Normal keeps its existing path unchanged.

## Integration and UI review

Production acceptance must still verify actual normalization/update dispatch, work preflight, source-alpha/hidden RGB, protected lower-context restoration, generated exclusions, isolated/clipping composition, Bake, recipes and storage rollback. The new helper alone does not establish those caller invariants. An identity candidate under a nonnormal mode remains structurally active: existing protection/source-edit/PSD and Bake-prefix restrictions apply. Bake must use the same evaluator, restore original working alpha, retain source assets and preserve whole-operation cleanup.

Recipes should capture saved canonical mode and complete parameters, never local drafts. Old Normal-only definitions must not acquire an unnecessary new field. Malformed modes/portable definitions reject before asset reads. Normalized recipes and graph admission must use the same work calculation; mode-only changes cannot bypass it. Source/global schema separation remains strict.

The [UI design](FILTER_BLEND_UI_DESIGN.md) correctly separates draft identity from capability-sensitive submission identity. Capability withdrawal preserves the authored draft while invalidating pending completions and recipe reports. Normal remains usable by omission when new discovery is absent/malformed; nonnormal requires the exact independent policy, source coordinates, kind and mode. Unsupported saved nonnormal entries remain inspectable, with editing/toggle and all reordering blocked; explicit Delete and independently supported Bake/Clear stay separate. Family resets preserve blend/opacity. Conditional zero-effect/threshold help must describe the candidate stage, because later blending can still alter those channels. The requested wording refinement is “unrounded blend result,” not “floating blend result,” to cover the exact rational modes accurately.

## Production audit evidence

The actual nine-test native audit passes:

- Independent normalized BigInt comparisons for25,600 full RGB/opacity cases across20 rational modes,720 endpoint cases and the explicit half/whole-color ties; four independently calculated nonseparable goldens. No production helper supplies the expected arithmetic.
- All six computational identity cases under Normal/Multiply/Screen/Difference, exact alpha0/1/128/255 and hidden RGB, zero ring/table, unchanged Bake phase estimates, disabled/opacity0 bypass and unchanged Normal interpolation.
- Source-alpha combination followed by three ordered candidate/blend/opacity stages, ignoring the active selection, then affine geometry, positioned inverted/feathered mask, density, isolated Multiply and clipping. Explicit Bake preserves the rendered result, restores original working alpha, keeps source/metadata bytes and permits protected content above the target.
- Original-context protected RGB restoration and generated member suppression in both composition and isolated inspection; hidden earlier protected content still rejects identity-candidate Bake before reads, and protecting/editing protected targets retains existing restrictions.
- Uniform work refusal for Multiply, Soft Light and Hue on hidden9.6MP sources, mode-only transaction rejection before a subsequent rasterizing step, disabled/opacity0 admission followed by refused activation, and cumulative recipe failure on its second step. Pixel/asset methods are replaced with failing spies; recipe validation additionally prohibits filesystem calls.
- Mode-only updates and explicit Normal reset retain sparse false/zero Noise settings; canonical recipes omit Normal and preserve nonnormal settings. Successful validation and application remain metadata-only with unchanged assets.
- The same retained mask/group/clipping scratch and all Bake phase values before/after a mode setting; malformed inactive mode records reject from portable import before filesystem/asset access, and source-parameter placement rejects.
- Actual ENOTDIR metadata/Bake publication failure and a late mixed mode-edit/Bake transaction failure preserve graph, history, cached preview accounting, existing project files and owned assets.
- Wide8192-pixel rows yield during both generic exact fallback and entirely alpha0 input, while preserving caller buffers.

Source review also found a leftover prototype `transform.plan` property exposing mutable compiled state. The backend owner removed it; the evaluator retains private closure state. Root's additional MCP correction replaces raw SDK schema shapes with strict Zod objects, preventing an unsupported top-level field from being silently stripped into a different valid command. Inspection of the installed SDK confirms that full object schemas preserve this strictness; the parent's actual SDK test covers the public rejection and unchanged state.

The UI source review found correct mode/default/capture/report behavior and one lifecycle gap: reorder/delete still used the uncaptured generic runner, so an already pending result could escape the new capability/document checks. The UI owner added the existing whole-stack capture to both actions and extended the narrow guarded result path. A source reread confirms that the identity excludes the selected filter and saved entries, so successful deletion does not invalidate itself. The owner's focused8 browser workflows subsequently passed, including delayed reorder/document navigation and own selected deletion, closing this finding. Their remaining regression/layout acceptance is separately recorded in the UI design.

No backend arithmetic, protection, resource or rollback blocker remains. Root owns final integrated acceptance.

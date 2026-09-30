# Independent review: targeted Hue / Saturation

Status: **production helper/native audit10/10 and actual-client helper audit2/2 passing; root reports full1046/1046, and the UI owner reports75 browser workflows plus build passing**. Root authorized implementation after the design review below. The selected contract in [TARGETED_HSL_EVALUATION.md](TARGETED_HSL_EVALUATION.md) has no remaining production source blocker from this review. The reviewed arithmetic is specifically the former prototype's `membership:'hybrid', saturationMode:'multiplicative'`; comparison alternatives are absent from production.

## Utility and scope

I support the distinct global/source `hue_saturation` family. It adds direct Master plus six-family H/S/L control while preserving the old scalar Hue, Saturation and Vibrance algorithms. The reference boundary is conventional encoded-sRGB HSL, not a perceptual tone/exposure model or Photoshop pixel equivalence. Adobe's documented color targeting motivates the workflow; its automatic color detection, editable falloffs and Colorize remain outside this slice. [Adobe Hue/Saturation documentation](https://helpx.adobe.com/photoshop/desktop/adjust-color/color-corrections/apply-a-hue-or-saturation-adjustment.html), [W3C HSL conversion definition](https://www.w3.org/TR/css-color-4/#hsl-to-rgb)

The hybrid membership is a useful explicit compromise. Hue and Saturation use adjacent hue weights totaling one for chromatic pixels. Thus Reds −100 Saturation removes color from fully matched dark and pale Reds: `[32,0,0]` becomes `[16,16,16]`, and `[255,223,223]` becomes `[239,239,239]`. Dividing every control's weights by255 instead would leave those colors substantially saturated.

Named Lightness instead uses original chroma attenuation, avoiding the large neutral discontinuity of hue-only targeting. I inspected `near-gray-light10-comparison.png`: the hue-only alternative introduces conspicuous stripes from one-byte RGB differences, while the selected hybrid retains the neutral chart. `[128,127,127]` and `[1,0,0]` both remain byte-identical under Reds L+10. Named ±100 Lightness is consequently weaker on dark/pale/near-gray input; it is not an unconditional black/white setter.

I also inspected `near-gray-saturation-comparison.png` and the photographed `master-sat30-comparison.png`. The positive `S+(1-S)*d` alternative makes one-byte color noise strongly visible. Proportional `S*(1+d)` retains a much cleaner neutral backdrop in these diagnostics. Its honest meaning is **+100 doubles existing HSL saturation, capped at one**, while −100 removes saturation at full influence. `[160,96,96]` at Master S+100 becomes `[192,64,64]`; the output need not reach a gamut edge.

The chosen operations have bounded behavior near neutral input when Master Lightness is zero. Named lightness change has magnitude at most `chroma/255`, hence shifts byte lightness by at most the original chroma. With no lightness change, proportional saturation creates at most twice the original chroma; hue rotation cannot amplify that amplitude. Exact gray has no named contribution and Master Hue/Saturation cannot colorize it. These statements do not imply noise reduction: unattenuated Master Lightness can reveal tiny existing color near black/white, as the evaluation correctly discloses.

All ranges classify the original input to this entry. Master and named rows aggregate before their clamp/wrap, so changing Master Hue does not retarget another row. Full desaturation produces HSL lightness gray, not Rec.709 grayscale: pure red255 becomes gray128. The UI and MCP copy should preserve that distinction.

## Integer bounds and branch correctness

Let `C=max-min>0`, `k=255-|max+min-255|`, `Q=10000*C` and `QL=2550000`. Chromatic RGB8 guarantees `1<=C<=k<=255`. Each stored control becomes an exact centiunit integer; the two contributing named weights are nonnegative integers summing to C.

All arithmetic before the final HSL-to-RGB divisions is exact Number integer arithmetic:

| Quantity | Bound |
| --- | --- |
| Q | 2,550,000 |
| Absolute aggregated Hue numerator | `36000*C` |
| Absolute unclamped S/L numerators | 5,100,000 |
| Corrected lightness numerator nl | 1,300,500,000 |
| Saturation denominator ds | 650,250,000 |
| Saturation candidate `C*(Q+sat)` before clamp | 1,300,500,000 |
| Hue-sector denominator `dh=6000*C*C` | 390,150,000 |
| Hue period `6*dh` | 2,340,900,000 |
| Absolute pre-modulo hue numerator | less than 4,681,800,000, hence below 2^33 |

Hue-sector selection is exact despite using Number division. A nonintegral `nh/dh` is at least `1/dh>2^-29` from an integer, while the quotient is in `[0,6)` and its binary64 rounding error is orders of magnitude smaller. Integer quotient boundaries are themselves representable. Primary/secondary tie selection is harmless because an ambiguously selected row has zero weight.

The aggregate identity branch is valid for zero effective H/S/L and for a full ±360 turn with zero S/L. Both exact turns and nonzero opposite row cancellation are checked independently. These pixel identities must not reduce a nonzero authored configuration's work charge or make its source stack structurally absent.

Original gray is handled before any zero hue/saturation denominator can be used. It receives only Master Lightness. Corrected zero saturation also enters the gray branch; corrected lightness endpoints return exact black/white. Gray half-up uses `(2*nl+2*QL)/(4*QL)` followed by floor. All integer terms are below2^32, and the denominator is10,200,000: the integer-boundary separation exceeds division error by many orders of magnitude. It gives exact grayscale half ties without BigInt.

## Declared floating byte contract

The general final conversion deliberately uses the evaluation's fixed binary64 parenthesization, then `Math.round` and byte clamp. It does not promise exact-real half-up at every rational tie. Preserve that sequence during promotion and later optimization; no epsilon or hidden fallback belongs in this contract.

The evaluation's approximate error estimate is reasonable. Taking unit roundoff `u=2^-53` and absolute bounds in byte units, corrected-lightness division contributes at most255u. The chroma product contributes at most approximately3·255u. The final secondary channel combines base, hue-fraction and product/addition errors to approximately9.5·255u, below3e-13, apart from negligible products of errors. Cancellation does not invalidate this absolute-error argument. It explains why disagreement with an exact rational oracle is restricted to extremely close half boundaries; it is not itself a byte-equivalence guarantee.

The explicit native regression fixture is:

| Input/settings | Native RGB | Exact-real half-up RGB |
| --- | --- | --- |
| `[224,1,127]`, Reds `[0,-100,0]` | `[176,49,121]` | `[176,50,121]` |

The green exact fraction is99/2; the selected runtime sequence gives `49.49999999999999`. The mirrored blue fixture has the same distinction. The provisional UI table initially used the rational50 value; I sent the client owner the correction to49. Browser exact expected bytes must follow the declared native fixture, not silently replace runtime semantics with the ideal rational result. No Photoshop equivalence or exact-real guarantee is inferred from ordinary test agreement.

## Independent evidence and ownership

Run `node test-results/targeted-hsl-review/probe.mjs`. This review's reference imports neither the owner's reference nor its membership helper. It derives adjacent weights from the hue arc, sums all six rows using BigInt fractions, and converts with a twelve-unit periodic channel expression rather than the prototype's optimized maximum/minimum row choice and six-sector channel permutation.

- **48 configurations ×888 RGB samples =127,872 bytes** agree with the exact rational reference. This sampled set is supplemented by the explicit native half-tie fixture above, whose intended discrepancy is recorded rather than hidden.
- Exact defaults, authored full360 turns, nonzero opposite-row cancellation, +120 cyclic channel permutation and +180 complement pass across those888 pixels. All256 exact grays retain neutrality under arbitrary named correction and Master Hue/Saturation.
- **14 malformed parameter cases** reject without invoking getters. Dense ordinary tuples, bounded exact centiunits, plain/null-prototype objects, negative-zero canonicalization, separately owned default rows and captured compiled settings are reviewed. Mutating caller rows or a returned normalization after compilation does not alter the compiled correction. The exported range array is frozen; final production policy/range exports should remain frozen and closure internals private.
- The prototype candidate preserves input ownership, every alpha byte and hidden RGB across **1,024 alpha0/1/128/255 pixels**. Zero opacity is byte-identical. Actual native source-alpha combination and protected composition are not claimed by this isolated probe and remain integration acceptance work.

The owner separately reports1,064,880 selected-policy candidate bytes, with only the two retained exact-half discrepancies and no other differences. Owner timing is approximately79ms per1MP all-row computation,1.78s per24MP and11.62ms maximum observed5ms heartbeat gap. These are evidence for admission/scheduling, not independent timing guarantees.

## Compatibility, resources and client contract

The proposed new kind/value0 and strict dedicated normalizer preserve legacy scalar records and make older readers fail closed on an unknown kind. Seven complete three-number rows fit existing metadata. Source/global partial updates replace a supplied tuple and retain omitted rows; normalization and recipe capture materialize full defaults. A zero/default global recipe must reset a nonzero target. Kind-aware schema validation must distinguish these HSL triples from Selective Color's overlapping-name CMYK four-tuples.

The helper adds bounded compiled controls, no asset, LUT, spatial cache or persistent table. The existing source candidate/stack-mask/Bake/Distort frame accounting should remain unchanged. **32S computing /1S all-authored-zero** is conservative relative to the reported measurements; nonzero cancellation remains32S, disabled/opacity-zero remains0, blend adds40S and an evaluating stack mask adds8S. Thus12MP Normal reaches384M work; masked9.6MP and nonnormal5,333,333 pixels are work-only ceilings, with other existing memory constraints still applicable. Activation and recipes must validate the staged graph before image I/O. The source budget does not become a new global whole-document budget.

The global kind should enter the established color-mapping alpha policy, while legacy Curves/scalar hidden RGB stays unchanged. Source order remains separate alpha, candidate bytes, per-entry blend/opacity, whole-stack effect mask, geometry and contextual protection. All-zero candidates remain real active entries under nonnormal blending. No implicit Bake or source edit is justified by identity.

The [UI design](TARGETED_HSL_UI_DESIGN.md) matches these semantics after correcting the half-tie expected byte. Its21 retained strings, complete typed capability list, independent global/source command gates, inspection outside blanket disabled fieldsets, captured row-kind ownership and recipe defaults follow the accepted Selective/Curves patterns. Master-versus-named Lightness and proportional Saturation belong in concise help; low-level rounding details do not. Only the policy `rgb-hue-triangle-hsl-v1` is exposed, not prototype alternatives. No remaining design blocker is identified. Production/native/schema/SDK/browser/rollback acceptance must still be completed after root authorizes implementation.

## Maintained production audit

After implementation authorization, `node --test tests/targeted-hsl-audit.test.mjs` passes **10/10** in approximately0.47 seconds. Running it with the existing owned Channel Mixer audit passes **19/19**. The older discovery expectation now correctly records26 global and30 source kinds. No production implementation was edited by this review.

The maintained fixture is `tests/fixtures/targeted-hsl/reference.mjs`. It exports `TARGETED_HSL_RANGES`, `targetedHslNativeReference(rgb,parameters)`, `targetedHslExactReference(rgb,parameters)` and `TARGETED_HSL_GOLDENS`. Neither reference imports production code. The native oracle sums six independently derived hue-arc weights before applying the published operation order; the exact reference retains its separate rational/twelve-period formulation. Nine literal native goldens include the mirrored49-versus50 half fixtures. This separates the declared runtime bytes from a mathematical comparison instead of calling every rational result the expected byte.

Source review confirms that `server/hue-saturation.mjs` promotes only the selected arithmetic, exports a frozen range list and immutable policy string, retains private owned coefficients, and returns fresh tuples. Its original-gray simplification uses zero hue/saturation numerators and is equivalent to the prototype's explicit gray bypass. The new color dispatcher and source work predicate leave legacy scalar functions and the global scheduling implementation unchanged. No cache, image plane, asset class or recipe special-case was introduced.

Maintained evidence covers:

- **75 configurations ×336 RGB samples =75,600 native-order bytes**, plus independent rational samples, nine literal goldens and exact identity/cancellation/full-turn/120°/180° branches. All256 gray inputs and signed/near-endpoint Lightness controls use the exact gray reference. Nonzero cancellation retains computing admission.
- Strict plain-object/dense-tuple/centiunit normalization rejects getters without executing them, malformed shapes including the other family's four-tuples, hidden/symbol fields, unsupported prototypes and nonfinite/finer values. Defaults and caller snapshots are separately owned; mutated output tuples cannot affect later results.
- Sparse source/global records are read unchanged. Partial rows retain omitted settings and masks. Source work is32/1 with existing blend surcharge and zero cache/shared reserve. A12MP computing entry admits exactly384M work and rejects another identity before reads. Hidden6.4MP identity activation and9.6MP stack-mask activation refuse before pixel/filesystem access, leaving prior metadata/assets unchanged.
- Complete default and sparse recipes reset existing global settings, append under a retained source mask, preserve canonical hashes, add one undo entry and match explicit commands. Metadata validation has no pixel/filesystem calls. An over-budget recipe reports and refuses without I/O.
- Actual global/source paths retain every alpha byte and hidden RGB, including partial opacity, mask density and protected footprints. The literal green49 and mirrored blue49 outputs are pinned through both native callers, not just the helper. A zero HSL candidate under Multiply remains a real RGB change.
- A separate-alpha fixture independently computes two sequential HSL entries, Normal/Multiply opacity, the deferred whole-stack alpha8 mask and exact integer Distort translation. Raw Bake RGB matches that oracle, original working alpha is restored, separate alpha/source references/positioned visibility mask/geometry survive, composite appearance is unchanged and existing asset bytes remain exact.
- Lower protected alpha1/128/255 content, its outline, an isolated group and a generated clipping member preserve the protected footprint. Source inspection stays ungraded and generated isolated-preview alpha is excluded. Protected-target identity edits and lower-context Bake refuse before pixels.
- Malformed native and global/source/recipe portable settings reject before assets. The forged-bundle helper produces canonical metadata and first proves that an unchanged graph successfully decodes, so an unrelated noncanonical-container error cannot satisfy the negative test.
- Actual `ENOTDIR` rejects both metadata publication and Bake after a genuinely new asset is written. The prior graph, history, project files and asset set are restored. A later transaction changes both parameter sets, Bakes, paints and then fails on a missing layer; at least two pixel writes occurred, and all newly owned files are removed while prior state remains exact.

## Client source and helper audit

`node --test tests/targeted-hsl-client-audit.test.mjs` passes **2/2** against the actual TypeScript helper compiled with Vite. It checks every hidden row/channel, precise signed/scientific strings, different Hue versus S/L bounds, negative zero, incomplete/finer values, equivalent clean drafts, independent rows and complete typed capability lists. Known ranges plus future strings are accepted; malformed/partial/unknown-only lists are not. Global and source availability remain independent.

The actual shared editor, ProPanels, LayerFilters, App mount/precise-color guards and recipe seams agree with the design. All21 strings live in parent state; inspection does not author settings. The source selector remains usable when mutation is blocked by protection, missing mask policy or saved blend support. Global saved HSL remains mounted if its update command disappears. Range policy joins execution identities but not draft reset keys. Row toggles pass their actual kind, and entry epochs remain distinct from whole-stack identity. Existing before/after-preview and catch ownership covers HSL through the narrow precise-color registry addition.

A later specialist finding exposed a global busy-fieldset restriction on range inspection. I source-reviewed the owner's narrow correction: HSL and Selective Color alone bypass that ancestor fieldset, while mode tabs, numeric/method fields, row/all resets and bottom Reset/Apply all retain explicit busy guards. Range inspection does not change parameters or invalidate an owned completion. The final focused browser report tests held updates and held previews for both global families, with unchanged request counts and accepted own success.

The UI owner reports **8 focused plus67 adjacent workflows,75 total, and the build passing**, with all runner processes exited. Selective Color's8 cases reran after the final shared fieldset fix. Evidence is `test-results/targeted-hsl-browser-report.json`, `targeted-hsl-adjacent-report.json` and `docs/TARGETED_HSL_UI_DESIGN.md`. This review independently checked source and the two maintained actual-client tests; it did not rerun the owner's browser harness.

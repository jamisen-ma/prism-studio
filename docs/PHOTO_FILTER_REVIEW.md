# Photo Filter: independent next-feature review

Status: **accepted: full native regression 1140/1140, focused browser 8/8 plus 91 adjacent workflows, and final build pass**, 2026-09-19. Independent production native audit11/11 and actual client-helper audit2/2 pass; source review is clear. Root's full regression finished in22.3546s, and the UI owner closed99 browser workflows with current reports and photographs. The final [architecture design](PHOTO_FILTER_DESIGN.md) agrees with this review. The direct-JavaScript transaction snapshot finding below is fixed and independently verified.

## Recommendation and workflow value

Photo Filter is the strongest bounded next adjustment, followed by a separate design for asset-backed grayscale masks. Its useful distinction is an arbitrary authored filter color with a density control and an optional luminosity-preserving treatment. The existing `temperature` branch only adds `0.4*value` to Red and subtracts it from Blue, with channel clipping and Green unchanged. That cannot express arbitrary green/magenta correction or a independently chosen colored filter. Existing Black & White tint discards source chroma, so it is a different workflow.

Adobe's current [adjustment catalog](https://helpx.adobe.com/photoshop/desktop/create-manage-layers/color-adjustment-fill-layers/adjustment-layers-options.html) lists Photo Filter separately from Color Balance and Color Lookup. Its [Photo Filter instructions](https://helpx.adobe.com/photoshop/using/applying-color-balance-adjustment.html) describe preset or custom colors, a Density percentage and Preserve Luminosity enabled by default. Adobe's [photographic tutorial](https://www.adobe.com/learn/photoshop/web/adjust-correct-color-balance-photoshop) demonstrates warming/cooling correction and custom color choice. These establish workflow and controls, not an exposed pixel algorithm or equivalence target.

| Candidate | Practical next value | Cost and compatibility concern |
| --- | --- | --- |
| Photo Filter | Small, editable arbitrary-color photographic correction; portable recipe parameters | New bounded RGB mapping and precise extreme behavior; no external asset dependency |
| Global adjustment blending | Broad creative value, including luminosity-only color adjustments | Requires explicit incompatible persisted representation, complete candidate-versus-backdrop semantics, masks/protection/group tests and a new joint phase ledger |
| Asset-backed masks | Unlocks ordinary continuous channel selections and other photographic masks that exceed existing RLE limits | Changes synchronous coverage consumers, previews, mutations, geometry, captures, history/bundles, worker boundaries and recipes; a separate infrastructure design |

Do not simply enable an existing global `blendMode` string. Earlier readers recognize layer blend tokens while their adjustment renderer ignores them, so such metadata can silently change meaning across readers. Current code now rejects nonnormal adjustment records; that does not make an older reader fail closed. Similarly, the measured 512² channel/RLE failure remains a real blocker for an unrestricted channel-selection feature. Photo Filter is a useful smaller increment while these broader contracts are designed, not a substitute for them.

## Candidate treatment for photographic evaluation

Prefer evaluating colored transmission over a direct interpolation toward a solid tint. A tint interpolation lifts pure black and can wash out contrast; a transmitted-color model preserves black and naturally darkens when luminosity preservation is off. The following is an independently derived encoded-sRGB RGB8 policy candidate, not a model of spectral filters, linear-light optics, calibrated white balance or Adobe internals.

Let filter bytes be `F`, source bytes `C`, and density `d` be an exact integer from 0 to 10000 representing 0–100% in 0.01 increments. Define:

```
t_c = 255*(10000-d) + d*F_c
M_c = C_c*t_c
K   = 2126*R + 7152*G + 722*B
J   = 2126*M_R + 7152*M_G + 722*M_B
```

With Preserve Luminosity off, round `M_c/2550000` once, half up. With preservation on, restore the original unrounded encoded Rec.709 weighted luma: `M_c*K/J`. If `J=0`, return the original RGB. That covers black input and, at density 100%, a filter that removes every occupied source channel. It also equals the limit as density approaches 100% for that fixed filter and source support; no arbitrary colored output is invented.

Restored positive values can exceed 255. Merely clipping them loses the claimed preserved luma. Instead evaluate compression toward the original neutral-axis value `K/10000`, using one shared factor so all channels fit. Since the uncompressed values are nonnegative, only the upper bound can constrain this fit. The exact rational expressions simplify to small enough integer products:

```
Mmax = max(M_R, M_G, M_B)
if Mmax*K <= 255*J:
    N_c = M_c*K
    D   = J
else:
    N_c = K*Mmax + (2550000-K)*M_c - 255*J
    D   = 10000*Mmax - J
output_c = floor((2*N_c + D)/(2*D))
```

The second branch is the proposed shared chroma compression algebra; its simplified expression is important because an unsimplified luma/chroma implementation can create integers above 2^53. Here `M≤650250000`, `K≤2550000`, `J≤6502500000000`, and the sum of the two positive terms in the fitted numerator is at most `2550000*Mmax≤1658137500000000`. Every intermediate integer is exactly representable. Both branches give `0≤N≤255D`, `D≤6502500000000`, and `2N+D≤3322777500000000<2^52`. At the division result's magnitude, the distance from a noninteger exact quotient to an integer is at least `1/(2D)`, exceeding binary64 rounding error by more than five times. This supports exact half-up byte evaluation using Number with no per-pixel BigInt, subject to an independent implementation/oracle check. BigInt is suitable for the test oracle.

Preservation means the unrounded weighted encoded luma is unchanged. Final independent channel rounding can move that luma by up to half a byte. It is not perceptual lightness or linear-light luminance preservation. Gamut compression reduces chroma near clipping and must be disclosed in compact help.

## Extremes and identity decisions to pin before implementation

- Density zero is exact identity in both modes. A white filter is identity in both modes. Any gray filter is identity with preservation on; without preservation it is neutral attenuation. A black filter at full density is black with preservation off and original RGB with preservation on under the defined zero-transmission fallback.
- Black remains black. With preservation off, white becomes the filtered white and neutral grays become colored. With preservation on, white remains white after gamut fitting, neutral midtones can gain the selected color, and pure saturated primaries remain unchanged because only their occupied channel can transmit light. Photographs should confirm that this limitation is acceptable at moderate densities.
- The zero-transmission fallback is an explicit endpoint policy, not recovered clipped detail. Do not describe density 100% as guaranteed full replacement with the filter color.
- Identity candidates remain structurally active filters. A nonnormal source blend can still change RGB, and source editing/Bake guards must remain unchanged. Work admission should recognize only proved semantic identities, consistently with the declared policy; do not infer general identity from one photograph.
- Inspect red/green/blue, cyan/magenta/yellow, near-black one-byte noise, white/near-white, skin-like midtones and gray ramps at densities 0, .01, 25, 99.99 and 100. Compare preservation on/off and additive alternatives on the same photograph before selecting this policy.

## Smallest complete contract and integration

Use a distinct `photo_filter` kind with `value:0`, strict `{color:'#rrggbb', density, preserveLuminosity}` parameters and an independent native policy marker. Color is an exact RGB8 hex triplet; density uses existing exact centipercent validation; the Boolean remains authored. Sparse defaults and shallow partial updates are sufficient for these flat fields. Keep a complete canonical object for recipes and ordinary portable records; no asset dependency or recipe exception is required. Default color/density should be chosen after photograph inspection, with preservation enabled. Any convenience swatches should be explicitly native choices rather than claimed Adobe preset matches.

Both global and source scopes should use the recent color-mapping alpha policy: alpha unchanged and alpha-zero RGB untouched. Global adjustment selection/mask/protection and the existing Normal-only global composition remain intact. Source candidate bytes enter existing per-entry blend/opacity, complete-stack effect mask, geometry/Distort and contextual protection in that order. Bake preserves immutable source/alpha assets under the established source-RGB contract. Generated content and isolated clipping contexts need their own retained golden cases.

Compile only bounded scalar coefficients and allocate no extra image planes or persistent tables. Keep loop scheduling within the existing pixel-visit cap; choose a source work weight from actual preserved/unpreserved and gamut-fitted production candidates, including all-pixel worst cases, before admission is frozen. Existing joint lookup/Distort/Bake ledgers still apply when Photo Filter coexists with those features. Any optional table optimization would need its lifetime explicitly added rather than hidden behind this no-cache proposal.

Existing readers should reject the unknown kind. Public schemas, native normalization, recipes and canonical portable malformed-record tests must agree before I/O. Use the established precise-color UI ownership pattern for color-string drafts and density, including withdrawn capabilities, cross-selected toggles, own successful revision, delayed preview, refusal and stale target handling. The first slice needs no provider, new file chooser, separate approval, Kelvin conversion, spectral profile, HDR input or old-temperature migration.

## Independent prototype evidence and final clearance

`test-results/photo-filter-evaluation/review-oracle.mjs` implements the original geometry using independently reduced BigInt fractions: transmitted components, weighted luma, ratio restoration, neutral-axis chroma and all upper/lower gamut constraints. It does not import the architecture helper and does not use the simplified production-candidate numerator. A separate additive comparison preserves weighted luma by recentering and fitting its interpolated tint; neither additive alternative is proposed for production.

`review-probe.mjs` imports the actual architecture prototype as the system under test. `review-report.json` records **183,847 RGB cases / 551,541 channel comparisons**, including 19,571 fitted colors and 11,392 exact mathematical half-channel ties, with no mismatch. Structured colors, density endpoints, all combinations of boundary RGB bytes and 20,000 seeded arbitrary colors/densities pass. Unrounded rational output stays in range and preserves exact original weighted luma; final byte luma deviation is at most 0.4946 in this corpus, inside the proven 0.5 bound. Without preservation no output channel increases. Strict color/centipercent/Boolean controls and non-invoked accessor handling pass against the actual normalizer.

A further **84,000** arbitrary rational cases use denominators up to 6,502,500,000,000, both parities and numerators within three integer steps of half-byte boundaries. The Number half-up expression matches BigInt division in every case. The proof's minimum noninteger separation is approximately 7.68935e-14 against at most 1.42109e-14 division error, a factor of 5.4109. This is a proof-backed exact byte contract for the bounded authored controls, not a claim that arbitrary floating-point ratios or arbitrary-real density have exact rounding.

For a fixed source/filter whose occupied channels all have zero filter transmission, every density below 100 scales those occupied components by the same positive amount. Luma restoration is therefore exactly the original input along the entire approach; the full-density `J=0` fallback extends that path continuously. The probe pins pure Red under Cyan, Green/Blue under Red and a general RGB under Black across 0, 25, 99, 99.99 and 100. At the fit boundary, the factor equals one, so the fitted and unfitted formulas join without an extra rounding stage. Continuity is about the unrounded policy; byte outputs necessarily have quantization steps. No universal joint limit across filter-color changes is claimed.

`review-photo-probe.mjs` checks **2,359,296 additional full-photograph channels** against the independent oracle, including both saved architecture warm outputs byte for byte and an independently generated cooling example. Input is the existing 512² public fixture with SHA256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. `review-photo-report.json` records hashes and luma diagnostics. `review-photo-comparison.png` shows original, proposed warm preserve, transmission without preservation, additive preserve and cool preserve. No imported preset or new application asset was introduced.

Independent visual inspection supports the default **`#ff9500`, 25%, Preserve Luminosity on**. It warms skin and background while retaining dark helmet detail; the cooling case demonstrates the reverse correction. Additive preservation is a viable different tint effect rather than the same algorithm, but it applies stronger orange chroma to shadows and neutral areas: gray1 becomes `[2,1,0]` versus unchanged `[1,1,1]` under the proposed default. The direct additive wash without preservation visibly lifts black. Transmission is the clearer fit for this bounded photographic correction control. Gamut fitting can introduce neutral components—for example `[255,255,0]` becomes `[255,242,129]` at the warm default—so the existing compression disclosure is material, not decorative.

The final design's uniform computing **16S**, exact-identity **1S**, maximum **16,384 pixel visits per batch** and no additional cache agree with the measured prototype and bounded scalar work. No new frame/resource formula is required; existing stricter joint gates remain. Reviewed flat sparse updates, canonical recipe resets, inactive validation and independent capability marker are consistent. Patch property shape must be validated before native merging; the normalizer's accessor check alone cannot protect a preceding spread. No remaining design or numerical blocker was found. The following maintained tests cover the released native implementation; client browser acceptance remains separate.

## Maintained production acceptance

The maintained independent oracle is [`tests/fixtures/photo-filter/reference.mjs`](../tests/fixtures/photo-filter/reference.mjs). `photoFilterReference(rgb, parameters={})` and `photoFilterReferenceStages` retain reduced BigInt fractions and the original luma/gamut geometry. They import neither the runtime nor the design prototype. Test-authored defaults, twenty literal half/gamut/endpoint cases and photographic provenance are exported alongside it. The maintained `tests/fixtures/tonal-color/astronaut.png` has exactly the same source SHA as the design photograph. Output PNG hashes identify inspected artifacts, while actual comparisons use decoded bytes.

[`tests/photo-filter-audit.test.mjs`](../tests/photo-filter-audit.test.mjs) passes eleven tests against production. Its numerical corpus compares 13,824 structured and 1,500 seeded arbitrary RGB cases to the unsimplified oracle, checks exact rational luma and non-increasing unpreserved channels, and retains the literal half ties, fit and annihilation endpoints. A separate bounded-ratio check probes both sides of half boundaries at the largest permitted denominator. Strict parameter normalization, plain/null-prototype controls, fresh compiled tuples and direct update accessors are independently checked.

Native checks cover sparse reads, flat updates, explicit zero/false, complete recipe resets, unchanged recipe hashes and source effect scope. Metadata-only work cases include the exact 24 MP/384M computing boundary, gray-preserving identity becoming computing, disabled activation, nonnormal identity blending and mask activation; every refusal precedes intercepted image/filesystem access. The helper adds no spatial cache or shared table in source/Bake estimates.

Actual global/source bytes retain hidden RGB and alpha, protected pixels, candidate-byte-before-opacity rounding, separate source alpha, sequential Normal/Multiply entries, the deferred inverted effect mask, positioned additional mask and integer Distort. Raw Bake matches the oracle RGB while retaining original working alpha, source/alpha assets and geometry; visible rendering remains identical. Generated clipping and isolated-group cases retain lower protected footprints and source inspection; protected writes and contextual Bake refuse. Canonical malformed portable controls preserve original assets and prove a valid control before rejecting inactive global/source/recipe metadata without reads. Real ENOTDIR publication and a late transaction after Bake/paint writes retain the prior graph, history, project files and asset set. Adjacent owned Mixer/Gradient tests pass 9/9 with discovery counts 28 global and 32 source; combined native command passes 20/20 in approximately 0.64 seconds.

[`tests/photo-filter-client-audit.test.mjs`](../tests/photo-filter-client-audit.test.mjs) imports the transformed actual TypeScript helper and passes 2/2. It pins exact incomplete strings, hex length/newline refusal, scientific centipercent inputs, uppercase canonical comparison, zero/false, draft ownership, semantic identity and independent global/source capability gates. Root's malformed-list finding was fixed by the UI owner: required kind lists must be arrays containing only strings. Tests now reject a scalar `'photo_filter'` and mixed lists. The helper intentionally projects already validated native saved metadata; it is not a second generic metadata validator.

Source review covers `PhotoFilterControls`, global/source mounts, policy signatures, actual-kind toggles, the existing `preciseColor` ownership path, bound-target recipe support and complete recipe capture. No new App runner/retry behavior was introduced. The controls preserve invalid color/density strings, keep false/zero and expose truthful identity/gamut help. Root's command-policy withdrawal and the established own-result/late-preview cases remain required browser acceptance.

One direct-JavaScript edge was found after the ordinary update checks passed: a Photo Filter parameter getter inside an `apply_transaction` containing Bake was invoked by the preexisting schema snapshot before `mergePhotoFilterParameters`. The native owner added a narrow pre-snapshot check in both `execute` and `dispatch`, resolving explicit Photo Filter additions or the current target kind. The independent audit now covers global/source updates followed by Bake, separately using density and `preserveLuminosity`-only getters: no getter calls, no image/filesystem calls and unchanged document. Final native/client rerun passes **13/13** in approximately 0.58 seconds. The guarantee applies to the native API and ordinary JSON transport; standalone `validateCommand` has no graph with which to identify an arbitrary update target, and JSON cannot carry accessors. No generic schema framework or unrelated-kind validation was changed. No remaining native or client-source blocker was found.

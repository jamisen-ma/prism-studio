# Source High Pass controls

Implemented and verified, 2026-09-19. The controls follow [HIGH_PASS_DESIGN.md](HIGH_PASS_DESIGN.md) and [HIGH_PASS_REVIEW.md](HIGH_PASS_REVIEW.md). Source kinds are 27; global adjustment kinds remain 24, and command count is unchanged.

## Controls and truthful help

Add **High Pass** (`high_pass`) to source filter discovery only. It uses the existing scalar `value` as Gaussian sigma in source pixels, with creation default **1**, **Normal** blend and 100% opacity. Do not add `parameters` or choose Overlay automatically. Editing an existing High Pass preserves its saved blend and opacity; changing a new filter kind resets to that new kind's defaults as today.

Reuse the exact source-sigma string draft, numeric field `step="any"`, range0–50 and convenience slider from Gaussian Blur. Manual positive/subnormal values remain authored exactly, including `5e-324`; the slider does not quantize typed values. Blank/incomplete/nonfinite/negative/>50 input stays local, disables Apply and sends no command. Equivalent spellings such as `1e0` compare clean to saved1. Keep the recently corrected fractional opacity display and all existing explicit Apply behavior.

The always-visible description is **“Builds a gray-centered detail map from source RGB.”** Put details in an initially collapsed **How High Pass works** disclosure:

- Normal shows the detail map. Choose an available Overlay or Soft Light filter blend explicitly to combine it with the input image.
- Sigma sets the source-pixel neighborhood before transforms. High Pass subtracts its alpha-weighted smooth neighborhood and centers the result at gray 128.
- Flat areas produce gray 128. Overlay and Soft Light preserve those input byte colors after rounding; other modes can change them. This is not a claim that all modes treat128 as an exact midpoint.
- Alpha and the cutout silhouette stay unchanged; fully transparent RGB stays ungraded. Selection is ignored; masks, layer opacity and geometry retain their later stages.
- Filter opacity fades the result after the selected filter blend. Larger sigma/source images and additional filters can exceed work limits; a refusal leaves the saved stack unchanged.

At sigma0 show a short specific note: **“Sigma 0 produces gray 128 before blending. It does not bypass High Pass.”** Retain the existing structural/source-edit explanation without calling this an identity. Tiny positive sigma may produce the same gray result, but must remain a positive saved value with its declared resource cost. Never reuse the current blur/sharpen zero-setting note for this kind. The generic blend disclosure about zero *amount* need not claim sigma0 is a bypass.

## Narrow integration

Extend `SOURCE_SPATIAL_DEFINITIONS` with High Pass1/0–50 and extend the source sigma parser. Dispatch support independently: `layerFilterHighPassPolicy:'alpha-weighted-residual-128-v1'`, source coordinates, matching backend, individual `high_pass` kind and applicable command. The old Gaussian, Unsharp and Noise policies are not prerequisites. Nonnormal modes additionally require the existing blend policy/mode list. Normal keeps its legacy blend omission behavior but still needs the new High Pass policy.

Adding High Pass to the source-sigma kind helper must not alias it to global blur/sharpen or their policy/help. Keep global adjustment types, dispatch and recipe slots unchanged. The existing scalar command/capture path emits `value` with no `parameters`; no new source parameter union member is needed.

Add the new marker to filter submission/whole-stack capability signatures and the recipe inspection/report context. Reuse the released draft/submission identity split: capability changes retain sigma/blend/opacity drafts but invalidate late responses; target/kind/revision changes restore the current canonical values. Apply, toggle, reorder/delete and Bake/Clear retain their existing before/after-preview guards. A normal accepted add selects its own entry; stale or obsolete results cannot retarget another filter/layer/document. No retry rewrite.

Saved unsupported High Pass remains readable with exact sigma/blend/opacity; authoring/toggle/recipe execution are gated. Kind loss keeps a new-kind selector usable to choose a different supported filter. Its own unsupported nonnormal blend continues to block all stack reorder under the existing rule. Explicit Delete and independently advertised Bake/Clear retain their established command/protection checks. No fallback to Gaussian Blur or automatic blend replacement.

Recipe capture/import/save remains definition-only. Saved exact scalar values, disabled state, opacity and nonnormal mode transfer unchanged; unsaved sigma/blend drafts are excluded. Validate/Apply additionally checks the independent High Pass marker, including disabled entries, and invalidates ready reports when that support is withdrawn. Existing response-loss/restart reconciliation remains unchanged.

## Eight focused workflows

1. **Discovery/defaults/drafts:**27 source/24 global kinds; High Pass defaults1/Normal/100%, sends no parameters, and never auto-selects Overlay. Blank/finer-than-slider/subnormal/boundary/equivalent sigma values, mode-only and value-only changes, fractional opacity, ID preservation, Undo/Redo and reopen.
2. **Independent exact pixels:** sigma.3977 on opaque input80/144 must export126/131, not the pre-rounded-blur125/130. Add independent2D BigInt fixtures for mixed alpha0/1/128/255, replicated edges and clipping; compare actual exports and raw Bake bytes without using the production helper as oracle. Sigma0/tiny positive produce gray 128 on positive alpha while preserving hidden RGB.
3. **Midpoint, opacity and order:** all256 backdrop bytes under sigma0 Overlay/Soft Light remain unchanged at full/fractional opacity; Hard Light and Linear Light must show the reviewed one-byte deviations, and Multiply must visibly alter ordinary inputs. Verify Normal gray output, post-candidate opacity, source stage/order, alpha/masks/selection/transforms, and active-zero structural/protected-prefix/source-edit guards.
4. **Independent capability partitions:** absent/unknown High Pass marker, missing source coordinates/kind, old markers absent, add-only/update-only, unsupported saved entry, Normal with missing blend metadata and nonnormal requiring its own advertised mode. Preserve withdrawn sigma/mode/opacity drafts; never replace the kind or choose a blend implicitly. Existing26 kinds retain their own rules.
5. **Captured lifecycle:** delayed Apply/toggle/preview plus layer/document/filter switches and policy withdrawal cannot install or select obsolete state. Own success remains valid. Preserve recent reorder/delete whole-stack guards. A stale sigma edit refreshes current settings once without replay; captured commands retain exact sigma/mode/opacity.
6. **Recipes and history:** capture scalar High Pass with subnormal/zero/disabled/fractional-opacity/nonnormal entries while local drafts differ, transfer definition and apply to an equal source as one Undo. Normal omission remains canonical; no parameters appear. Policy withdrawal clears a ready report and blocks execution even for a disabled High Pass step. Existing recovery suite remains untouched.
7. **Bake and real refusal:** mixed High Pass/color/nonnormal stack bakes to exact pixels while preserving source/alpha/hiddenRGB/masks/geometry; eligible paint continues with separate Undo, Clear removes the map. Test a real radius or nonnormal-work boundary, retaining drafts/history/assets. Sigma0 has no resource exemption merely because Overlay's final bytes can be unchanged.
8. **Photograph/compact layout:** actual original, Normal gray detail, Overlay and Soft Light PNG exports with recorded sigma/opacity. Inspect1440/900px controls and collapsed/expanded High Pass help; sigma, mode, exact opacity and Apply remain reachable without horizontal overflow. Preserve original NASA fixture hash, zero provider/key calls and no browser errors.

Run focused8 plus blend8, spatial8, Unsharp8, Noise8, existing filters4, tonal8, recipes5 and Bake6: **63 browser workflows**, then build. Root owns native/shared/MCP/count acceptance; coordinate existing browser discovery expectations to27 without weakening independent policy subsets. Native audits own full work/memory/resource/protection/portable arithmetic matrices. UI tests report only exercised evidence.

Owned implementation seams are source API capability, source sigma/policy helper, narrowly separated High Pass guidance in `LayerFilters`, filter/recipe capability signatures, scoped styles and the focused browser script/fixtures/package alias. Preserve fractional opacity formatting and recent reorder/delete lifecycle protection. No providers, packages, source-generation requests or live user documents are involved.


## Implementation and browser evidence

The independent client source review found no blocker. The implementation adds a source-only scalar kind, its own capability marker and compact guidance; existing opacity precision, reorder/delete guards, recipe recovery and global adjustment controls are unchanged. Unsupported High Pass settings remain visible, and loss of its policy invalidates both filter completions and recipe validation reports.

`npm run test:high-pass-browser` passed all eight workflows. The final fixture includes exact `5e-324` recipe capture and a separately imported disabled-only High Pass recipe whose ready report is removed when its policy is withdrawn. The focused run also exercised a real work-limit refusal and stale revision refresh, with no automatic replay. The report records only those two expected HTTP failures, no browser errors, no key access and no provider calls.

Pixel checks use a standalone full two-dimensional BigInt Gaussian/residual oracle, without importing production rendering helpers. Actual PNG exports and raw baked assets match at sigma0, the smallest positive binary64 value, .3977,1.25 and50. The opaque80/144 half-tie fixture gives126/131. A complete256-byte ramp checks Overlay/Soft Light preservation at full/fractional opacity and the one-byte Hard Light/Linear Light deviations. Separate source alpha, hidden RGB, density/mask/geometry, original-source preview, ordered filters and paint after Bake are covered.

Maintained evidence:

- [Focused browser script](../tests/high-pass-browser.mjs) and [eight-workflow report](../test-results/high-pass-browser-report.json).
- [900px controls](../test-results/high-pass-900.png), [expanded help](../test-results/high-pass-900-help.png) and [1440px controls](../test-results/high-pass-1440.png), inspected visually. Sigma, blend, opacity and Apply remain reachable without horizontal overflow. User-facing midpoint wording is “gray 128.”
- Actual512×512 photograph exports: [original](../test-results/high-pass-photo-original.png), [sigma2 Normal detail](../test-results/high-pass-photo-sigma2-normal.png), [Overlay100%](../test-results/high-pass-photo-sigma2-overlay.png), [Overlay50%](../test-results/high-pass-photo-sigma2-overlay50.png) and [Soft Light100%](../test-results/high-pass-photo-sigma2-soft-light.png). These are local native renders, not generated images.
- The existing [NASA fixture provenance](../tests/fixtures/tonal-color/README.md) remains authoritative. Its original bytes retain SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`.

`npm run build` passes. Existing Vite bundle-size and Lucide module-directive warnings remain. Native/shared/MCP arithmetic, serialization and resource acceptance belong to the backend and root evidence; the UI report does not substitute for those checks.

All requested adjacent browser suites passed against the final27-kind discovery contract: Blend8, source spatial8, Unsharp8, Noise8, original filters4, tonal color8, recipes5 and Bake6. Together with High Pass8, acceptance is **63/63 browser workflows**. Existing browser count assertions were updated for the new independent High Pass kind; native/schema/MCP counts remained with their designated owners. The final High Pass photographs and 900px help screenshot were regenerated after the “gray 128” wording polish.

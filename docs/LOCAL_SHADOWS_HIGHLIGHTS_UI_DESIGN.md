# Local Shadows / Highlights UI

Implemented and accepted in the ordinary optimized runtime, 2026-09-19. Follows the approved [native contract](LOCAL_SHADOWS_HIGHLIGHTS_DESIGN.md) and [independent review](LOCAL_SHADOWS_HIGHLIGHTS_REVIEW.md). Existing global Shadows and Highlights keep their current controls and algorithms.

## Controls and exact drafts

Add **Local Shadows / Highlights** only to raster Layer filters: kind `shadows_highlights`, scalar `value:0`, default parameters `{shadows:25,highlights:0,shadowWidth:50,highlightWidth:50,sigma:3}`. A new filter begins in Normal at100% opacity. Defaults visibly lift some shadows; Reset does not mean a neutral treatment.

A compact two-column grid labels Shadows and Highlights separately. Each column has an Amount and Tonal width numeric field. Amounts accept0–100%; widths accept1–100%, each using exact0.01% increments. A full-width **Sigma, source px** numeric field uses `step="any"`, accepts finite0–50, and retains scientific notation/minimum subnormal values. No convenience slider is needed for this advanced source-pixel setting. No field is silently rounded or clamped.

Keep all five values as strings until Apply. Blank, incomplete, nonfinite, out-of-range and finer-than-centipercent amount/width drafts disable submission. Percent validation is exactly `Math.round(value*100)/100===value`; no epsilon. Equivalent valid numeric spellings are clean against effective saved numbers. Zero and very small positive sigma remain distinct. Sparse persisted parameter objects merge with complete typed defaults without writing the graph; explicit zero survives. A new `local-tone.ts` supplies defaults, normalization for effective display, string parsing and draft construction. `LocalToneControls.tsx` renders the five fields without extending global adjustment parameter types.

Reset is a local draft action, available independently of add/update command partitions when the controls themselves are supported. It restores all five defaults while preserving filter opacity/blend mode. Setting one Amount to0 retains its width. Apply sends a complete canonical parameter copy with `value:0`; partial server updates retain the untouched effective settings and must reopen correctly. Preserve the existing exact opacity display and command value, including37.5%→0.375.

Always-visible help: “Balances source tones using nearby brightness. Transparency stays unchanged.” A collapsed **How Local Shadows / Highlights works** disclosure explains:

- Sigma is in source pixels before transforms. Sigma0 uses the pixel’s own encoded-RGB tone and can still change colors; tiny positive sigma may produce the same neighborhood while retaining its authored value and admission cost.
- Tonal widths determine how far each treatment reaches toward middle/opposite tones. The local tone map has256 levels. This is a native endpoint-preserving RGB treatment, not subject isolation or clipped-detail reconstruction; strong settings can produce halos or change hue/saturation.
- Black0 and white255 channels stay unchanged by the candidate. Amount controls the candidate; filter blend mode and opacity act afterward. Two zero Amounts are an identity **candidate**: Normal leaves colors unchanged, but nonnormal modes can still change them.
- Source alpha/hidden RGB stay intact. The full source neighborhood participates; a Filter effect mask limits the completed stack afterward and does not isolate the neighborhood. The additional layer mask controls visibility.
- Larger source images and sigma use more work. Native limit refusals retain the saved stack and local draft. Never automatically reduce sigma, amounts or image dimensions; no local imitation of the graph-wide admission formula.

An active dual-zero entry gets the existing compact structural-stack notice: Bake or Clear remains required before source painting. No automatic filter removal, Bake or permission dialog.

## Capabilities, recipes and lifecycle

The shared source support predicate requires native backend identity, `layerFilterCoordinates:'source'`, advertised `shadows_highlights` kind and exact independent `layerFilterLocalTonePolicy:'alpha-weighted-local-tone-v1'`. Older Gaussian, High Pass, Unsharp and Noise markers are neither substitutes nor additional prerequisites. Nonnormal mode support still requires the separate blend policy/list. A masked target also retains the effect-mask policy requirement. Full discovery becomes28 source kinds; global discovery remains24. Without source coordinates the existing22 ordinary kinds remain; removing only this marker leaves27. Missing old Gaussian policy removes only Blur/Sharpen, leaving26.

Unsupported saved entries stay selectable/readable but cannot be authored, toggled or executed through recipes. A withdrawn capability preserves the local draft rather than switching its kind or parameters. Existing explicitly supported Delete/Clear/Bake paths and protected-context guards retain their current rules. Add-only and update-only command partitions work independently; Reset never sends an unavailable command.

Extend `LayerFilters` stored/new parameter dispatch and canonical dirty comparison, plus `LayerFilterParameters` and Backend capability types. Add the new marker to selected-filter and whole-stack capability identities and to recipe validation/report/submission identity. Keep draft identity keyed by document/layer/filter/kind/revision, excluding capability changes; submission identity includes current capabilities. Existing App response/preview gates and stack-operation guards are reused, including selected-filter-independent whole-stack operations. No retouch, eyedropper or generic runner refactor is needed.

Recipe capture copies complete effective parameters, enabled state, opacity and supported saved blend from the persisted entry, never the unsaved draft. Capture/import remain definition-only. Validate/Apply require support for every source entry and the bound target’s existing mask. Masked-stack capture still refuses while Filters is checked; explicit style-only opt-out remains available. Appending filter-only recipes preserves a target effect mask. Keep same-session retry deduplication and old-revision reconciliation after restart unchanged; no new receipt or retry implementation.

## Eight focused browser workflows

1. Source28/global24 discovery, exact defaults/value0 and unchanged existing global pixels. Invalid strings/precision send nothing; Reset stays local; sigma0/subnormal and equivalent spellings survive Apply/Undo/Redo/reopen. Include sparse persisted settings and independently changed partial fields.
2. Independent synthetic neighborhood discriminator and exact output bytes: equal gray64 pixels in different surrounds diverge at sigma1 but match at sigma0. Use the reviewer’s exact fixture/BigInt expectations, not a production helper oracle. Pin alpha0/1/128/255, endpoint retention and an explicit literal-rounding fixture when admitted by actual parameters.
3. Entry ordering, exact fractional opacity, two-zero Normal identity and nonnormal identity blending. A whole-stack mask mixes after the unmasked neighborhood; source and separate-alpha bytes remain intact. Verify one Undo per edit.
4. Exact/missing/wrong marker, source-coordinate and kind partitions; independence from older policy markers; add-only/update-only controls; readable unsupported saved entries and retained drafts across withdrawal/recovery. Delete/Clear/Bake retain their own gates.
5. Delayed Apply/toggle/reorder response after filter/target/document/capability changes, and capability loss during masked preview. Own accepted revision remains valid; old response/preview cannot retarget or erase the current draft. No automatic replay.
6. Saved-only recipe capture with sparse defaults/zero fields, definition transfer, explicit bindings, validation invalidation and single-Undo replay. Append onto a masked stack without losing scope; masked capture still requires explicit Filters opt-out.
7. Real native work refusal when an identity becomes computing or sigma increases; unchanged graph/assets/history and retained draft. Exact live-versus-Bake output with transformed separate alpha/mask, source preservation, protected-prefix refusal and brush continuation after explicit Bake.
8. Actual maintained NASA photograph at defaults and a deliberate mixed Shadows/Highlights setting, before/after exports and900/1440 screenshots. Verify disclosure opens, opacity/Apply remain reachable, no horizontal overflow, portable reopen retains settings and no key/provider calls occur.

Targeted regression gates: layer filters4, spatial8, High Pass8, Unsharp8, Noise8, tonal8, blend8, filter-mask8, recipes5 and Bake6 (71 adjacent workflows,79 including focused8), plus build. Update only relevant browser source-kind discovery counts. Root owns shared/schema/MCP/status/public docs; architecture owns helper/native behavior and independent review supplies exact pixel fixtures. Native callable readiness is required before the final browser run.


## Completed UI evidence

`npm run test:local-tone-browser` passes all eight maintained workflows in ordinary Node (no optimizer-disabling flags). `npm run build` passes. The 71 targeted adjacent workflows also passed: Layer filters 4, spatial filters 8, High Pass 8, Unsharp 8, Noise 8, tonal color 8, filter blending 8, filter masks 8, recipes 5 and filter baking 6. Together these cover 79 browser workflows. Tonal color and Layer filters were additionally rerun after the narrow legacy scalar-color fix described below.

Implemented files are `client/local-tone.ts`, `LocalToneControls.tsx`, `local-tone.css`, source-only API types and the existing LayerFilters/support/recipe-capture/capability-identity seams. Global parameter types, App response/retry code, retouch and eyedropper code were not changed by this UI increment. Browser source discovery assertions now expect 28 without altering 24 global kinds or blend-mode counts.

The [focused report](../test-results/local-tone-browser-report.json) records independent direct-2D BigInt neighborhood/LUT/curve comparisons, the literal 84/64 versus 73/73 neighborhood discriminator, fractional and minimum-subnormal sigma, hidden alpha, exact Bake, mask-after-neighborhood order, real resource refusal, saved-only recipes and actual portable transfer. It includes delayed filter/document responses, policy loss during masked preview, explicit stale rejection, independent command partitions and retained drafts. The only HTTP refusals were the intentional stale-revision 409 and work-limit 400. Provider calls, key reads and browser errors were all zero.

The photograph is the existing NASA/scikit-image fixture whose maintained provenance is in [tests/fixtures/tonal-color/README.md](../tests/fixtures/tonal-color/README.md), SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. No new image generation was used. Original asset bytes are asserted unchanged. Inspectable exports and screenshots:

- [Original photo](../test-results/local-tone-photo-original.png), [default treatment](../test-results/local-tone-photo-default.png), and [mixed treatment](../test-results/local-tone-photo-balanced.png): Shadows 42.5%, Highlights 18.25%, widths 70%/55%, sigma 6.5, Normal at 100%.
- [900px inspector](../test-results/local-tone-900.png), [expanded help](../test-results/local-tone-900-help.png), and [1440px workspace](../test-results/local-tone-1440.png). All five fields, blend, opacity and Apply fit the collapsed 900px inspector. The expanded help is reachable without horizontal overflow. Root and UI owner inspected the actual output and narrow layout.

The unchanged-global comparison exposed an older cold-render optimization-sensitive Shadows/Highlights path. Architecture isolated it before browser navigation and replaced that legacy closure branch with explicit RGB evaluation preserving the original formula and arithmetic order. The focused suite retains its unchanged global graph/pixel assertions at both checkpoints and now passes with normal optimization enabled; the diagnostic `--no-opt` run was not used as acceptance evidence.

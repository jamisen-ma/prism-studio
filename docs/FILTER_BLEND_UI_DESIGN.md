# Individual source-filter blending controls

Implemented and browser-verified, 2026-09-19, against the approved native arithmetic/work contract and independent review. Source filter kinds remain 26, global adjustment kinds remain 24, and no command is added. Browser/build acceptance is recorded below.

Adobe exposes blending options on individual Smart Filters. That supports the workflow goal of controlling one saved filter separately from the containing layer; it does not establish byte equivalence with Prism's evaluator. [Adobe Smart Filter documentation](https://helpx.adobe.com/photoshop/using/applying-smart-filters.html#edit_smart_filter_blending_options). Prism retains its current source-coordinate, alpha-preserving RGB filter model and explicit Apply flow.

## Contract and meaning

Add an optional sibling `blendMode` to each source `LayerFilter`, beside `kind`, `value`, `parameters`, `enabled` and `opacity`. It never belongs inside a parameter family or global adjustment parameters. The policy is `layerFilterBlendPolicy:'candidate-rgb-v1'`, with independent `layerFilterBlendModes` discovery. The mode set is the existing 26 pure RGB modes in `shared/blend-modes.mjs`, excluding Dissolve:

Normal; Darken, Multiply, Color Burn, Linear Burn, Darker Color; Lighten, Screen, Color Dodge, Linear Dodge, Lighter Color; Overlay, Soft Light, Hard Light, Vivid Light, Linear Light, Pin Light, Hard Mix; Difference, Exclusion, Subtract, Divide; Hue, Saturation, Color, Luminosity.

Missing or explicit `normal` is the same effective setting. Native filter authoring and recipe saving canonicalize Normal by omitting it. Validated externally authored records may retain an explicit Normal until the entry is edited; reading one does not rewrite the document. Adding a Normal entry omits the field. For update, omission preserves the saved setting; explicitly changing a supported nonnormal entry to Normal sends `blendMode:'normal'`, which clears the persisted field. Changing only another setting must not reset a saved nonnormal mode. An untouched explicit-Normal legacy entry opens clean, with no write or false dirty state.

For each entry, the backdrop is the source RGB after earlier filter entries. The filter computes its existing full-strength, byte-quantized result. Blend that result with the entry's input RGB, then apply this entry's opacity once to the unrounded blend result, followed by final byte rounding. Normal preserves the exact prior implementation. Alpha does not weaken this blend: alpha 1, 128 and 255 pixels with identical RGB get identical RGB results, while fully transparent RGB and every alpha byte stay unchanged. Layer opacity, layer blend mode, masks, geometry and compositing occur later under their existing rules. The active selection still does not restrict source filters.

The architecture owner defines exact byte-rational rounding through opacity for rational modes, with defined native floating semantics for Soft Light/nonseparable modes. A uniform extra 40 visits per source pixel applies to each active nonnormal entry; Normal adds none. The architecture owner retains the exact arithmetic and memory admission. The UI will not approximate a limit or silently lower mode, amount or opacity after a refusal. Computational identity avoids unnecessary candidate work but is not necessarily an identity after nonnormal blending. Existing structural active/protected/source-edit rules stay unchanged.

## Compact inspector

Add a native select labeled **Filter blend** with accessible name **Layer filter blend mode**, immediately before **Filter opacity, %** and the existing Add/Apply button. Use full-width stacked controls at the narrow inspector width so long mode names are readable; do not crowd two compressed selects into a 213px row. This is within the individual filter editor, separate from the existing whole-layer blend control near the layer list. Selecting a mode changes only a local draft.

The menu always includes Normal when the underlying normal filter is editable. Other options are the recognized, individually advertised subset in the shared stable mode order. Dissolve is never offered. A saved or draft unsupported mode remains represented by a disabled `Mode name · unavailable` option; never coerce it to Normal when support changes. Show a concise explanation for a selected unsupported saved entry, while retaining its complete parameters, opacity and enabled state for inspection.

Keep normal guidance brief: **“Blends this filter with its input RGB, before layer blending.”** A collapsed **How filter blending works** disclosure can contain the source-stage explanation, alpha preservation, order/opacity distinction and the zero-amount warning. No modal or confirmation step. Keep existing filter-specific explanations collapsed as they are today; avoid repeating multiple long explanations in the always-visible area.

The saved stack row should show `Mode · opacity` for nonnormal entries, for example `Multiply · 40%`, and `Multiply · Disabled` for a disabled saved entry. Normal retains the current compact `40%`/`Disabled` display. This reflects persisted settings, never a pending mode draft. Existing accessible Edit/Enable/Delete labels keep their filter index and kind, so mode changes do not rename controls during a pending action.

Reset Add Noise, Reset Unsharp Mask and tonal family resets continue resetting only their own parameter families. They preserve both filter opacity and the new blend draft. The explicit mode select provides the return to Normal. New pattern changes only its seed draft, never blend or opacity. New filter/kind selection initializes Normal; switching filter/layer/document/revision restores that target's effective saved mode.

## Capability truthfulness and legacy compatibility

Root-approved behavior:

| Discovery state | Normal editing | Nonnormal editing/execution |
| --- | --- | --- |
| New fields absent on a legacy companion | Existing normal flow, omit `blendMode` | Unavailable |
| Exact policy, source coordinates, matching backend, known kind, recognized mode in a valid string array | Available | Advertised recognized subset only |
| Missing/unknown policy, missing source coordinates, or missing individual mode/kind | Preserve existing normal capability rules | Unavailable for the missing requirement |
| Empty or unknown-only mode list | Available by omission | None |
| Non-array, null, or mixed-type mode list such as `['multiply',null]` | Available by omission | All unavailable; do not partially accept malformed data |
| Valid strings mixing future names with recognized modes | Available by omission | Ignore future names, allow recognized subset |
| Valid duplicate mode strings | Available by omission | Deduplicate choices; support does not widen |

Normal is the existing omitted-field operation. Its availability must not accidentally depend on new blend metadata, an explicitly listed Normal option, or either of the Gaussian/Unsharp/Noise markers. Existing kind and command requirements still apply; the four specialized source kinds retain their own independent source policies. Nonnormal blending additionally requires `candidate-rgb-v1`, source coordinates, the individual filter kind and mode, and the applicable command. Never use the whole-layer `blendModes` list as evidence of per-filter support.

A saved nonnormal entry lacking its exact support remains readable but its parameter editor, mode, opacity, Apply and enabled toggle are disabled. Root also requires **all stack reorder buttons** disabled while any saved nonnormal entry is unsupported: moving a different entry around it would change its evaluation context. Explain that this companion does not advertise the saved filter blend. Explicit Delete remains available under its existing command/protection rules. Independently advertised Bake/Clear remain available under their existing native admission/protected-prefix rules; no automatic conversion occurs. Adding or editing a separate supported entry retains its existing capability checks and does not rewrite the unsupported entry.

For a new, unsaved entry whose nonnormal mode becomes unsupported, retain all draft values and the unavailable mode choice, disable Add, and keep the mode/kind selectors usable to choose an explicitly supported alternative. For an existing entry whose **saved** mode is supported but whose **draft** mode becomes unsupported, retain the draft and let the user choose a supported mode again; Apply stays disabled until that explicit choice. This is distinct from freezing an entry whose persisted mode itself is unsupported.

## Draft and result lifetime

Extend `FilterDraft` with a mode string defaulting to Normal. Dirty comparison uses `(selected.blendMode ?? 'normal')`, not property presence. Validate the mode against known modes and actual advertised support on submission. All commands retain captured document ID/revision/layer/filter context, complete canonical parameters when already required, and the selected numeric opacity; explicit Normal clearing is sent only when necessary.

Current `LayerFilters.tsx` includes its capability signature in `identityKey`, then includes that full identity in `draftKey`. This would reset withdrawn mode drafts. Make a narrow split:

- **Draft identity:** backend, document, layer, selected-filter/new identity, kind and document revision. Capability changes alone do not reset the draft.
- **Submission identity:** the same target identity plus the current commands, recognized kinds and raw relevant policy/mode capability signature. Keep the alive ref. A policy/list/kind/command change invalidates an in-flight result.
- **Whole-stack identity:** document/layer/backend/capabilities, excluding selected filter, saved stack contents and revision as already required for successful Bake/Clear. Add the blend policy/list signature without coupling completion to removed entries.

Keep App's existing guarded source-color edit flow before `updateDocument` and after its preview await. The callback checks the latest submission identity; the submitted numeric data is a captured object, independent of later local draft state. Normal successful mode edits and adds must install/select their own result. Filter/layer/document changes, unmount or withdrawn capabilities during delayed command/preview responses cannot reinstall an obsolete result. A stale revision refreshes the current context once and asks for an explicit retry; a work/resource refusal keeps the draft and saved document unchanged.

No recipe retry, request-ID or response-loss reconciliation code changes. The existing same-session dedup/restart stale-reconciliation semantics remain intact.

## Identity and help inventory

Do not describe a zero-effect **filter candidate** as a guaranteed unchanged final image after nonnormal blending. Pass the effective local blend draft to filter-specific controls or supply an equivalent context prop. The UI should explain the effect the user is preparing to Apply, while saved-stack labels continue reflecting committed state.

| Current location | Required wording change |
| --- | --- |
| `LayerFilters.tsx`, Gaussian Blur and fixed RGB Sharpen sigma help | Replace unconditional “Sigma 0 bypasses the effect”/“Zero leaves pixels unchanged” with “Sigma 0 adds no blur/sharpening. Filter blending may still change colors.” Normal-only identity note may still state that pixels are unchanged. |
| `LayerFilters.tsx`, tiny positive sigma note | Qualify that the blur/sharpen candidate may be unchanged; a nonnormal blend can still change output. |
| `UnsharpMaskControls.tsx`, amount0/sigma0/threshold255 note | Normal: existing unchanged-pixels note. Nonnormal: “These settings add no sharpening. Filter blending can still change colors.” Retain the saved-stack/source-edit warning. |
| `UnsharpMaskControls.tsx`, threshold explanation | Threshold gates sharpening before filter blending. Equal/below-threshold channels may still change in the blend stage; remove the unconditional claim that only channels over Threshold can change final output. |
| `UnsharpMaskControls.tsx`, opacity explanation | Clarify that opacity fades the result after the selected filter blend, rather than scaling sharpening amount. |
| `NoiseControls.tsx`, Amount0 note | Normal: unchanged-pixels note. Nonnormal: “Amount 0 adds no noise. Filter blending can still change colors.” Seed remains retained and deterministic. |
| `NoiseControls.tsx`, Amount/opacity details | Amount controls noise before clipping; the filter blend runs next; opacity fades that blended result. Monochromatic still refers to the noise delta before these later stages. |
| `LayerFilters.tsx`, all-disabled/zero-opacity Bake/Clear text | Remains correct: these entries are bypassed without candidate or blend evaluation. Do not classify Amount0/sigma0 alone as inactive. |
| `filter-bake.ts`, `CutoutPanel.tsx`, canvas source-write guards | Existing structural `enabled && opacity > 0` rule remains correct. Do not introduce a UI identity exemption or change source-edit restrictions. |

Keep detailed stage/threshold explanations collapsed. A compact nonnormal identity note is warranted only where an authored filter setting computes an identity, not for every filter. Root owns corresponding public guide/contract corrections; the UI implementation must call out stale global “Amount 0 always unchanged” wording for that pass.

## Recipes and portability

Extend `recipe-capture.ts`'s allowed `add_layer_filter` fields with `blendMode`. Capture the saved effective nonnormal mode, omit absent/explicit Normal, retain order/disabled/opacity/canonical parameter behavior, and exclude unapplied mode/seed drafts. Recipe import recognizes the field; an explicit Normal can be canonically omitted in the definition preview/save payload so a normal-only legacy flow does not acquire an unnecessary unknown field. No nonnormal mode is silently removed or substituted. Global adjustment recipe steps still reject this source-only field.

Extend the shared source-entry support predicate and recipe report signature with the filter blend marker and raw mode list. Each source-filter step must satisfy its existing kind/command/source-policy requirements and, when nonnormal, exact blend support. Disabled or opacity0 nonnormal recipe entries still require their defined mode; metadata is not a license to silently skip an unsupported step. Capture/import/save remain definition operations; Validate/Apply is the execution gate. A withdrawn mode or malformed list removes a ready report and disables execution. A legacy Normal-only recipe remains executable under its prior capabilities.

Transfer/reopen/Undo/Redo retain saved modes and source assets under the native contract. Explicit Bake fixes the complete saved blended stack as pixels and removes entries, preserving the same original/source-alpha/mask/geometry behavior. Nonempty filter stacks keep the existing PSD/source-edit restrictions. No new UI migration, destructive normalization or permission dialog.

## Eight focused browser workflows

Use only isolated native fixture documents, independent expected pixels and the unchanged NASA photograph. No provider calls, key reads, generation or user-project mutation.

1. **Discovery, scope and canonical drafts:** 26 source kinds and 24 global kinds remain; 26 filter modes exclude Dissolve. Default Normal/absent/explicit Normal all open clean. Mode selection is local until Apply; changing only mode creates one revision, ID preserved. Nonnormal→Normal sends explicit clearing; legacy Normal parameter changes omit the new field. Whole-layer blend and global controls remain independent. Family resets preserve pending mode/opacity.
2. **Exact blend/opacity pixels:** independent rational fixtures verify source input→quantized candidate→blend→single opacity mix. For RGB128, identity blur/noise under Multiply/Screen/Difference produces RGB64/192/0 at opacity1 and RGB96/160/64 at opacity0.5, for each nonzero alpha1/128/255; alpha0 hidden RGB stays exact in baked assets. Add nonidentity directional and final-rounding cases from the independent reviewer, and one nonseparable Color/Luminosity golden. Do not import the production blend/filter helper as the oracle.
3. **Saved order, identity help and alpha/source boundaries:** stack reorder changes inputs as expected; normal legacy output is byte-exact. Exercise blur sigma0, fixed sharpen sigma0, all three Unsharp identities and Noise amount0 under Normal/Multiply/Screen. Verify conditional short/detail guidance, strict threshold qualification, structural guards, disabled/opacity0 bypass, masks/selection/geometry/source preview and exact alpha/hidden RGB.
4. **Capability partitions and withdrawal:** absent/unknown marker, absent source coordinates/kind, missing/empty/unknown-only/mixed malformed mode list, valid recognized+future subset and missing explicit Normal. Normal remains usable by omission; nonnormal freezes appropriately. Old Gaussian/Unsharp/Noise policies are independent. Saved unsupported entry is readable, toggle/editor/all reorder blocked, Delete and independently advertised Bake/Clear available. Add-only/update-only controls retain their local resets. A withdrawn draft remains intact and can be explicitly changed to a supported mode without reset.
5. **Captured lifecycle:** delayed Apply, enabled toggle and preview, selected-filter/layer/document changes, command/capability/mode withdrawal and unmount preserve the current context. A successful own edit installs normally. The draft and submission identity split preserves local mode/parameters on status-only changes but invalidates in-flight completion. A stale revision refreshes without automatic replay; normal legacy payloads remain omission-only throughout.
6. **Saved recipes and transfer:** capture mixed Normal/nonnormal/disabled/opacity0 entries while unsaved mode/seed edits exist; preview/save/export/import retain only saved canonical modes. Normal explicit/absent equivalence does not create needless fields. Bind an equal-source target and compare independent exact pixels with one Undo. Withdraw mode support after validation; the ready report disappears and execution blocks, including disabled nonnormal definitions. Existing response-loss/restart retry suite stays unchanged.
7. **Bake, source continuation and refusal:** mixed blended stack with fractional opacity bakes to exact composite/source pixels; source/alpha/masks/transforms remain intact, followed by ordinary eligible painting and separate Undo. Clear restores the unfiltered result. Protected target/prefix and unsupported mode gates remain explicit. If the approved nonnormal admission surcharge creates a meaningful boundary, exercise a real boundary rejection with draft/history/assets retained; do not manufacture a client-only refusal or claim resource coverage until the native design is final.
8. **Photographic and 900px usability:** export the original, Normal reference and useful contrasting blended variants, such as Gaussian Blur + Soft Light/Screen and sharpening + Luminosity, with recorded parameters/mode/opacity. Check saved seed stability for a blended noise example if useful. Inspect actual PNGs plus 1440px and 900px screenshots; long mode names, filter opacity, Apply, short identity notes and both expanded/collapsed explanations stay reachable without horizontal overflow. Preserve original fixture hash and record zero provider/key/browser errors.

Run focused8 plus source-filter4, spatial8, Unsharp8, Noise8, tonal8, recipes5 and Bake6, then build. The current source/global kind counts do not increase. Root/backend reviewers own the complete 26-mode arithmetic, work/memory, transaction/protection, schema/global-family and MCP/portable compatibility matrices. UI results should report only exercised evidence.

## Implementation boundaries

Implemented owned seams: a small filter-blend capability/label helper, source API fields, `LayerFilters` mode/draft/identity/gates, `NoiseControls`/`UnsharpMaskControls` and spatial help, narrow recipe capture/import/report support, scoped styles and focused browser fixtures/script. No global blend-family refactor, whole-layer behavior change, automatic live preview or retry rewrite.

The native field/stage/policy contract and uniform active-nonnormal work surcharge of 40 per source pixel are approved. Source identities therefore cost 41 per pixel when blended, while a computing Add Noise entry costs 48. Normal preserves its previous work and arithmetic branch.

## Implementation and acceptance evidence

`client/filter-blend.ts` consumes the shared mode/policy exports, validates capability subsets and formats decimal opacity without changing the stored number. The source API, `LayerFilters`, narrow recipe import/capture/report predicate, filter guidance and scoped styles are integrated. Capability changes preserve drafts while invalidating captured submissions. Reorder/Delete now use the existing whole-stack capture; App includes these two commands in its pre/post-preview result guards, with stale action copy that identifies the rejected action. This closes the independently reviewed delayed-stack-response gap without tying successful deletion to its disappearing selected entry.

The filter opacity number field uses `step="any"`. Decimal formatting displays saved 0.375 as 37.5%, leaves the untouched entry clean, and preserves exactly 0.375 through a mode-only command. No global opacity control or recipe retry code changed. The existing Unsharp, Noise and spatial capability-withdrawal tests now expect retained local parameter drafts, as required by the new draft/submission identity split.

The focused browser suite is `npm run test:filter-blend-browser`. Its independent constants include:

| Input / filter result / mode | Opacity | Expected byte(s) |
| --- | --- | --- |
| RGB128 identity, Multiply / Screen / Difference | 1 | RGB64 / RGB192 / RGB0 |
| RGB128 identity, Multiply / Screen / Difference | 0.5 | RGB96 / RGB160 / RGB64 |
| B13, F85, Multiply | 0.75 | 7 |
| B17, F130, Screen | 0.375 | 63 |
| B2, F69, Difference | 0.5 | 35 |
| B2, F254, Linear Burn | 0.5 | 2 |
| B0, F128, Linear Light | 0.5 | 1 |
| B[60,120,180], F[200,50,100], Color | 0.5 | [134,89,144] |
| Same RGB pair, Luminosity / Hue / Saturation | 0.5 | [56,116,176] / [124,94,144] / [54,121,189] |

These fifteen cases use no production blend/filter helper as an oracle. Identity vectors exercise alpha 1/128/255 and exact hidden alpha0 RGB in baked assets. Separate synthetic workflows exercise every source identity family, mask/geometry/selection stages, order, source-alpha retention and one-time filter opacity. A real 4000×2400 identity source rejects Multiply at 393.6M work, above the 384M limit, preserving the full draft/graph/history/assets.

Photographic evidence uses the unchanged NASA fixture, SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`, with [recorded provenance](../tests/fixtures/tonal-color/README.md). Actual native exports are [original](../test-results/filter-blend-photo-original.png), [blur4 Normal](../test-results/filter-blend-photo-blur4-normal.png), [blur4 Soft Light at50%](../test-results/filter-blend-photo-blur4-soft-light-50pct.png), [blur4 Screen at35%](../test-results/filter-blend-photo-blur4-screen-35pct.png) and [Unsharp100/sigma1 in Luminosity](../test-results/filter-blend-photo-unsharp100-sigma1-luminosity.png). The actual Soft Light output and [900px inspector](../test-results/filter-blend-900.png) were visually inspected. [1440px](../test-results/filter-blend-1440.png) and [expanded blend help](../test-results/filter-blend-900-help.png) show the same running application. Filter parameters, mode, opacity and Apply remain reachable without horizontal overflow.

| Acceptance | Passed workflows |
| --- | ---: |
| Focused filter blending | 8 |
| Existing layer filters | 4 |
| Source Gaussian Blur / RGB Sharpen | 8 |
| Unsharp Mask | 8 |
| Add Noise | 8 |
| Tonal color | 8 |
| Recipes, including unchanged response-loss/restart recovery | 5 |
| Explicit filter Bake | 6 |
| **Total** | **55** |

TypeScript and the production build passed. Focused8 and build were rerun after the narrow opacity display correction; the other47 browser results remain applicable because no shared/global opacity component changed. The [final focused report](../test-results/filter-blend-browser-report.json) records zero browser errors, credential reads and provider calls. Its two expected mutation failures are the actual work-limit refusal (HTTP400) and stale revision refusal (HTTP409). The additional normal-only recipe case validates and applies under absent blend capabilities; a zero-opacity Screen recipe step still blocks execution when Screen support is withdrawn. All original source asset bytes remain exact. Independent source review closed the reorder/delete late-response finding after checking the captured whole-stack identities and the focused delayed navigation/own-delete evidence.

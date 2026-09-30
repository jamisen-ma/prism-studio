# Layer Fill controls

Status: **implemented and accepted in focused/adjacent browser checks**, 2026-09-19. Root released the agreed client/helper implementation while native integration proceeds. The native command/capabilities and client are implemented; all 67 browser workflows and build pass. It follows the [independent native review](LAYER_FILL_DESIGN_REVIEW.md) and the actual Layers, clipping, styles and recipe controls.

## Small useful workflow

Add **Fill, %** beside the existing overall **Opacity** control for native raster, solid, text, shape, path and gradient layers. Fill controls the rendered body, including a vector layer's intrinsic stroke. Existing outside outline, shadow and glow remain governed by their own settings and overall Opacity. Groups and adjustment layers retain only their existing Opacity control.

Use one precise text input, **Apply Fill**, and **Reset to 100%**. Enter in the Fill input performs the same deliberate Apply; blur only retains the local draft. Reset sets the local draft to `100`, without sending a command. A following Apply writes `fillOpacity:1`. Resetting an already saved 100% value leaves Apply clean/disabled. No slider, automatic preview edit or second permission dialog is needed.

Always-visible copy: “Fill fades the layer content. Overall Opacity also fades its outside styles.” At saved/draft Fill zero, add: “At 0% Fill, only enabled outside styles can remain visible.” This is not a guarantee that a particular style produces pixels. A full-canvas opaque source or zero-width/zero-opacity styles may still show nothing. If overall Opacity is zero, show the relevant consequence: “Overall Opacity is 0%, so both content and outside styles are hidden.”

Keep extended guidance in **How Layer Fill works**:

- Outside styles use the original unfilled silhouette; Fill zero does not reveal a shadow through the former body or add inner effects.
- Fill is separate from a shape's fill color. Both painted vector fill and its intrinsic stroke fade together.
- Source pixels, cutout alpha, RGB filter settings, effect-mask settings and geometry stay editable. Baking RGB filters retains Fill as a layer setting.
- Loading a selection from layer content measures source transparency and ignores Fill; composite channel selections, eyedropper and visible-composite sampling see the rendered result.
- Source-based placement can retain a styles-only layer's underlying silhouette. Arrangement uses visible body bounds, so a Fill-zero layer has no body bounds to align.
- This is the native content-opacity behavior across existing layer blend modes. It does not claim Photoshop-specific Fill blending, knockout or PSD parity.

The public API exposes optional numeric `fillOpacity`; omission means exactly 1. The proposed private effects wrapper is not shown, copied, reconstructed or edited by the client. Public `effects` remains the existing outside-style structure.

## Placement and exact drafts

The existing App Layers header combines a blend select and a very narrow Opacity field. Keep overall Opacity's current behavior in this slice. Reflow that area into a full-width blend selector and a compact two-column percentage row, with Opacity and Fill clearly labeled. The Fill input uses an ordinary dark text field with visible focus, percent label and enough width to inspect a fractional value. Its complete string remains available to keyboard selection/copy even when it scrolls internally. Apply/Reset can wrap on the next row. Do not squeeze another 26 px number input into the existing single row.

Retain the Fill draft as a string. Use a decimal/scientific text-input strategy that preserves empty, minus and incomplete forms such as `1e`; native number-input sanitization is unsuitable. Validate the whole trimmed decimal/scientific form, finite numeric percent and range 0–100. Reject hex, Infinity, NaN, out-of-range and incomplete strings without clamping or replacing them. Fill accepts arbitrary finite native precision, not a 0.01% grid.

Reuse the proven decimal-shift display approach behind `filterOpacityPercent`, without changing filter opacity behavior. Avoid `Math.round`, `toFixed`, a slider step or a multiply/divide round-trip during initialization. For example, stored `.375` displays `37.5`, and `.07` displays `7` rather than multiplication noise. Retain the original saved Number separately. A valid draft numerically equivalent to the displayed percentage returns that original Number for comparison, so `037.500`, `3.75e1` or untouched very small values cannot silently rewrite a saved value. Otherwise parse the authored percentage and divide by 100 once for the command. A positive representable percentage that underflows to zero in that conversion is invalid rather than silently becoming an authored zero.

Apply is enabled only when the parsed value is valid, differs exactly from effective saved Fill and the captured target is editable. Negative zero is equivalent to zero. `Number.MIN_VALUE`, near-zero positive values, arbitrary long saved fractional values and values adjacent to 1 must remain inspectable without a floor or implicit reset. Reset and local reload provide deliberate recovery from an incomplete draft.

Keep target draft identity separate from capabilities. Capability withdrawal does not erase an incomplete or fractional string. A clean draft can follow fresh saved metadata; an external revision while dirty preserves the draft, shows that it is stale and requires **Reload saved Fill** before a new Apply. That read-only local reload adopts the current document's value/revision and is available under unsupported/protected inspection. It sends no write and does not silently retry. Switching to another document/layer starts that target's draft; returning later does not revive an old request.

## Eligibility and independent capabilities

Proposed names supplied by the native owner and accepted by root:

```text
set_layer_fill({documentId, expectedRevision, layerId, fillOpacity})
layerFillPolicy: 'content-alpha-outside-effects-v1'
layerFillContentTypes: ['raster','solid','text','shape','path','gradient']
```

The revision is mandatory and positive. Fill is a single-target document mutation, independent of active selection or checked multi-layer targets. Require Native backend, connected status, the exact policy, a well-formed all-string command list containing `set_layer_fill`, a well-formed all-string type list containing this supported content type, and valid current target metadata. Unknown or duplicate type entries, malformed mixed/non-array lists and empty lists grant no Fill editing. A supported subset enables its own types. Do not infer support from `set_layer`, layer-style commands, source-filter capabilities, bridge connectivity or a numeric public field alone.

Mount the native content-layer Fill inspector independently of mutation availability. Saved nonunit Fill stays readable when its command/policy/type advertisement is withdrawn. Disable edits and Apply/Reset with a concise explanation, preserve any existing draft, and keep local saved-value reload usable. Restoring Fill to 100% requires the same dedicated Fill capability as any other write; there is no unauthorized “remove unsupported metadata” shortcut. Legacy overall Opacity remains independently usable under its current gates.

Protected targets cannot change Fill. Show “Unprotect this layer to change Fill.” A previously partial layer may subsequently be protected and its exact value must remain visible. Native identical-value no-ops need not produce an enabled UI Apply, since unchanged drafts are already clean. Do not automatically unprotect, clear masks, rasterize or bake.

Every clipping-chain participant must remain at Fill 100% in this first slice, including the base and hidden members. Use `clippingChainFor(document.layers, layer)` to identify participation, not only `clipBaseId`. Show “Release this clipping chain before changing Fill.” Existing clipping creation should also explain and refuse a candidate set containing any nonunit Fill, including hidden members; it must never reset them automatically. Native validation remains authoritative against a race or externally changed chain.

Hidden content layers, generated raster layers and content nested in groups can retain/edit Fill when their existing native eligibility permits it. Visibility and overall Opacity zero are not reasons to discard the setting. Do not require source RGB filters, masks or styles to exist. Do not add source-filter authoring requirements to this independent display property; existing mask/resource/native rendering validation still applies.

## Submission and preview ownership

Implement a small `LayerFill` editor and pure support/percent helper. Use a stable parent identity for its target, with a monotonic execution epoch covering backend, document, selected layer, exact Fill capability signature and eligibility changes. An A→B→A target/policy transition invalidates the old request even when the final values match. Saved revision/value must not themselves invalidate the editor's own acknowledged successful result.

At Apply, capture document/backend/layer ID, positive expected revision, exact parsed Fill, draft token and execution epoch. Recheck busy state, current target/revision, capabilities and protection/clipping before dispatch. Controls that mutate the Fill draft are disabled while pending; reading help or layer metadata does not invalidate the submission. Selection of a different layer/document or leaving/reopening the relevant inspector ends that editing session. No completion may retarget whichever layer happens to be selected later.

Add a narrow Fill gesture/result path in App.run. Before metadata installation, require the initiating identity and expected revision to remain current, and validate the returned document/backend/revision and same layer's effective Fill. A changed value should produce the native expected next revision; capture native no-op behavior explicitly if an equivalent write can reach this seam. A successful own-result acknowledgement must occur before metadata publication so the editor can accept its own revision without losing the draft or misclassifying it as external.

Pass the same ownership predicate into the existing `updateDocument(acceptPreview)` seam, strengthened with the accepted document revision and target. Recheck after its preview await before clearing the draft, publishing success or changing local saved-value state. A capability, target or revision change during preview must suppress the old image and completion. There is no new selected-layer exception or automatic first-layer selection in this command.

Stale/protected/clipping refusals retain the exact local draft. A same-target metadata refresh, if used, is guarded both before installation and after preview; it must not reopen a former document or clear a newer draft. An unknown/transport result is not reported as success. Permit explicit document refresh/reload and another deliberate Apply at the reviewed revision, with no automatic rebase/retry and no new request-receipt infrastructure. Keep existing recipe recovery unchanged.

The existing overall Opacity input may dispatch on blur while the user moves toward Fill Apply. The shared busy-ref preflight must prevent two overlapping writes; a rejected/prevented Fill dispatch retains its draft for explicit retry. This design does not refactor the generic runner or all old layer controls.

## Reuse and persistence scope

**First-slice decision: no Fill recipe authoring or capture option.** Do not register `set_layer_fill` as a recipe step, broaden the recipe import allowlist, or silently attach Fill to a saved layer-style preset. Existing effects-only presets and ordinary recipes leave the target's Fill unchanged. Unsupported imported Fill recipe commands continue to reject explicitly; they are not dropped.

When recipe capture starts from saved nonunit Fill, show “Layer Fill is not included; the target keeps its own Fill.” This applies even if the user captures the outside styles that currently produce a styles-only appearance. The capture still uses saved settings, not an unapplied inspector draft. Existing masked-filter and Color Lookup capture restrictions remain unchanged. Style-preset explanatory copy should name Fill separately from overall opacity where needed to avoid implying complete appearance capture.

Undo/Redo, duplicate, rasterize, extraction, placement, painting, source-filter Bake and unrelated layer-setting edits must retain the two independent opacity values according to native behavior. Exact editable transfer uses `.prism`; flattened image export reflects the native composite. Layered PSD continues to reject nonunit Fill in the initial native subset rather than collapsing it into overall opacity. The existing export compatibility surface should display the native reason; this control does not invent a lossy conversion.

## Eight focused browser groups

1. **Exact control and local draft:** six supported content types, omitted/default Fill1, `37.5` for `.375`, arbitrary long fractions/subnormals, equivalent decimal/scientific forms, incomplete/out-of-range strings, no blur write, keyboard Apply, local Reset100 and exact command payload. Overall Opacity and vector fill color remain independent.
2. **Body versus outside styles:** independent native/oracle pixels for F0/Ffraction/F1 and O0/Ofraction/O1, existing outline/shadow/glow from the original silhouette, masks and partial alpha. Confirm no intermediate alpha-byte quantization. Include one nonnormal blend and deterministic Dissolve; native audit owns exhaustive mode/half-tie coverage.
3. **Target eligibility:** protected saved partial Fill read-only, explicit unprotect path, base/member/hidden clipping restrictions and prospective-chain refusal without resets; valid nested/hidden/generated content; group/adjustment and bridge exclusion. Independent policy, command and type subsets/malformed arrays; capability restoration retains the exact draft.
4. **Source and display consumers:** layer-content selection ignores Fill; composite-channel selection/sample sees it. Actual photo/source bytes survive Fill, source filters/effect mask, additional positioned/dense mask and Bake. Fill-zero body-only arrangement refusal remains understandable; native/SDK owns exhaustive placement/extraction phase tests.
5. **Owned writes and previews:** held successful response/preview, target and capability away-and-back, current revision change, inspector close/reopen, stale/protected/clipping refusal and busy competition with Opacity. Exact old drafts cannot install a result or clear a newer target; a normal own success remains usable.
6. **Persistence and explicit reset:** Undo/Redo, unrelated overall-opacity/style/filter edits, duplicate, `.prism` reopen and saved Fill1 canonical restoration. Layered PSD refuses nonunit Fill honestly; flattened output matches the native composite. Native audits own old-reader rejection, wrapper malformations, persistence rollback and restart.
7. **Reuse boundary:** effect presets and ordinary recipes preserve target Fill; source nonunit capture disclosure is visible; uncommitted Fill draft is excluded; an unsupported Fill recipe step is rejected. No recipe retry/reconciliation implementation change.
8. **Actual photo and access:** original and fractional/styled-zero photo exports, 1440/900 px normal/help screenshots, no overflow, readable exact field, keyboard order/Enter/Reset/help and clear read-only/validation status. No provider calls, key reads or new image generation.

Targeted regressions should include layer styles, clipping, arrangement, layer selection, dense channel selection, mask inspection/position, source-filter Bake, professional paint/retouch, recipes and build. Pin their actual suite counts when implementation begins rather than importing a previous milestone total. Coordinate any browser run with native measurement windows.

## Bounded source seams and release gate

Owned client changes would be `api.ts`, a small `layer-fill.ts`/`LayerFill.tsx` and scoped styles, App's Layers layout plus narrow guarded mutation/preview branch, GestureContext, clipping eligibility and the two scoped reuse disclosures. Add one focused browser script and package alias. No new geometry renderer, source materialization, alpha asset, generic retry layer, overall-Opacity behavior rewrite or recipe command is in scope.

Root approved the final native design/review and released implementation. The private effects wrapper is native-owned; the UI relies only on projected numeric Fill and normal `{document}` results. Malformed values use `INVALID_ARGUMENT`, missing targets `NOT_FOUND`, ineligible types/clipping `INVALID_TARGET`, protected changes `PROTECTED_LAYER`, and stale revisions the existing revision error. Identical-value writes follow ordinary revision/history semantics; clean UI drafts never send them. Final browser/build evidence will be recorded below once acceptance completes.


## UI implementation evidence

The implemented controls use exact text drafts and a separate explicit Apply. The existing overall Opacity behavior is unchanged. Native content uses a full-width blend selector followed by equal-width Opacity/Fill fields, with theme-token backgrounds, borders, readable values and keyboard focus. Saved unsupported/protected/clipped Fill remains readable; local validation and external-revision notices retain the authored string.

The final focused run passes **8/8 workflows in 51.247 seconds** (`test-results/layer-fill-browser-report.json`). It covers arbitrary/subnormal/scientific percent strings, lexical and division underflow rejection, all six content types, strict known capability subsets, partial-alpha blending under six modes, outside styles at zero Fill, original-photo exact pixels, selection scope, masked filter Bake, response/preview ownership, Undo/Redo, duplication, editable portable transfer, PSD refusal and explicit preset/recipe exclusions. The capability away/back preview case delivers two already-started status reads while the mutation preview is held; it does not rely on polling that is intentionally paused while busy.

Actual-client helper audits and independent App/source review are clear. The photograph fixture remains byte-identical (SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`). The focused run reports no browser errors, image-provider calls or key reads. Original, partial Fill, styled partial Fill, styles-only Fill0 and outlined-text exports are in `test-results/layer-fill-*.png`; `layer-fill-900.png`, `layer-fill-900-help.png` and `layer-fill-1440.png` cover compact/default/help layouts. The keyboard-accessible disclosure opens with Enter; compact fields/actions remain reachable with no document or inspector overflow. Visual inspection confirms the photo body fades independently of the outside outline/shadow.

Build passes with TypeScript and 1,992 bundled modules (Vite 130 ms). The approved targeted regression run passes **59/59 workflows in 136.988 seconds**: styles 4, clipping 3, arrangement 4, layer selections 4, dense selections 8, mask inspection 4, mask positioning 8, filter Bake 6, professional editing 8, retouch sampling 5 and recipes 5. The total is **67 browser workflows** including focused Fill. `test-results/layer-fill-adjacent-report.json` records every suite with exit 0. Final TypeScript/Vite build passes in **0.555306 seconds**, measured end to end in `test-results/layer-fill-build-report.json`. All owned browser/build processes exited. Root's full native/shared/client suite passes **1,206/1,206** after its test-loader integration correction; independent actual-client2 and native audit10 also pass. Native/root audits own exhaustive wrapper malformations, restart/rollback, prospective clipping and placement/extraction phase coverage; the browser evidence does not claim to replace those tests.

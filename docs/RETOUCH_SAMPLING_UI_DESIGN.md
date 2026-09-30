# Repair-layer sampling UI

Status: implemented and browser-verified, 2026-09-19. Verification used isolated synthetic projects; no live user project was edited. Native semantics are coordinated with [RETOUCH_SAMPLING_DESIGN.md](RETOUCH_SAMPLING_DESIGN.md); that contract and its advertised capabilities govern implementation. This delivers explicit sampling for the existing deterministic clone and sampled healing brushes, not content-aware reconstruction or a new AI provider.

## Existing behavior and integration points

`client/CanvasTools.tsx` owns the clone/heal source point, brush draft, pointer capture, and final `paint_stroke`. `App.tsx` supplies the selected layer and document, captures revision conflicts in `run`, and selects newly created layers. The hook already captures the whole brush, source point, document ID, backend, target ID, and revision at pointerdown. Matching pointer IDs, Escape, pointercancel, and lost capture prevent stale partial strokes from committing.

Today the native brush samples a frozen visible composite for clone/heal. Source pixels are never read from the evolving stroke output. The fixed source crosshair is a document-coordinate sampling anchor; it is not a cached source image. Every separate stroke takes a new snapshot of its declared scope. The proposed UI preserves these distinctions and the legacy All layers behavior.

The existing `.brush-options` row wraps at narrow widths. Add a separate compact retouch row immediately after it for clone/heal only, instead of widening every paint tool. Keep the existing color, pressure, hardness and opacity controls; no unrelated brush redesign. The retouch row can move the existing sample/reset button out of the shared row to avoid duplication.

## Controls and wording

| Control | Behavior |
| --- | --- |
| **Sample** | Select **All layers**, **Current layer**, or **Current & below**. All layers is the initial/default setting. Options follow backend support; Current & below is disabled for an ineligible target, with an adjacent reason. |
| **Ignore adjustment layers** | Initially unchecked. Available only for composite scopes and an advertised skip-adjustments capability. Current layer disables it and resets its value to false; switching back does not silently re-enable it. |
| **Source set · Reset** | Existing Option/Alt-click interaction and crosshair. Also expose a concise status such as `Source: 120, 84 · Current & below`; coordinates are rounded for display only. Before a source is set: `Option / Alt-click the canvas to sample.` |
| **Create repair layer** | Creates one ordinary transparent paint layer immediately above the explicitly selected source. The selected source name and insertion position are disclosed beside the action. It does not duplicate, rasterize, unprotect, or flatten the source. |

Scope help changes with the selection and remains readable at 900px:

- **All layers:** “Samples the visible composite at the start of each stroke.”
- **Current layer:** “Samples this layer’s transformed pixels and subject alpha, before its mask, opacity, styles, and surrounding layers.” A blank repair layer therefore samples transparent pixels; do not silently fall back to another scope.
- **Current & below:** “Samples this layer and the layers below it. Existing repair pixels are included at the start of each stroke.”
- When adjustment skipping is checked: “Skips adjustment layers in the sample. Editable source filters still apply.” This skips standalone adjustment nodes even inside retained groups; it does not remove a source layer’s filter stack or change the visible composition.
- For a separate repair above protected content: “Protected pixels stay protected, including underneath this repair layer.” The presence of a repair layer is not permission to repaint protected subjects.
- Healing remains labeled “Sampled texture blending”; scope does not imply Photoshop-identical healing or generative fill.

At 900px, use a wrapping row with two short field groups and an action group; explanatory text spans the row, wraps normally, and is not hidden by the existing `.selection-guidance` narrow-layout rule. All controls have distinct accessible labels. Disable mutations while another command is busy, without suppressing the explanation of why a scope or target is unavailable.

## Confirmed target semantics

The ordinary native paint target guards remain authoritative: raster target, not protected, no nonempty filter stack (including disabled filters), and valid command geometry. Existing UI also asks for a shown, nonzero-opacity target before painting. Sampling does not relax those rules, the active selection, or the whole graph’s protected write coverage.

| Operation | Eligibility beyond the existing paint gates |
| --- | --- |
| All layers | Existing clone/heal target support is unchanged. Nested targets and clipping participants retain their legacy sampling path. |
| Current layer | Same target scope as ordinary clone/heal. Uses frozen transformed working RGBA including source `alphaAsset`; ignores the additional mask, display opacity, styles, ancestor display context, clipping-chain display contribution, and dynamic generated-layer display clipping. |
| Current & below | Target must be a root raster layer and not participate in a clipping chain as either base or member. It includes the target’s existing visible pixels and only preceding complete root subtrees. Intact lower groups and clipping chains are allowed. Never derive this scope by truncating an arbitrary flat array. |
| Create repair layer | Explicit root raster source, not a clipping member or a base with members. Source may have filters, transforms, protection, hidden state, or generated provenance because creation does not write it. New layer is visible, normal, empty and unprotected, with no inherited filter stack, mask, generated provenance, or protection. Layer-count and other native limits still apply. |

For nested/clipped Current & below targets, leave the chosen scope visible but disable starting a stroke and explain: “Current & below needs a root raster layer outside a clipping chain. Choose All layers, Current layer, or another target.” Do not silently change an existing scope merely because a user selects a different layer. If a backend lacks a setting entirely, use the legacy behavior and omit unsupported arguments.

For Create repair layer, selection is the explicit source; do not infer it from the sample crosshair, nearest visible layer, or a remembered layer ID. Root group, text, shape, adjustment, clipped raster and no-selection states show a disabled action and a short eligibility hint. A source may be protected without disabling creation, but the protected-write explanation remains. Source visibility, generated provenance, and existing filters are not grounds for an extra UI-only restriction.

## Repair-layer action and explicit preset

Call the dedicated `create_repair_layer` command once with explicit `sourceLayerId`, captured `documentId` and `expectedRevision`, and a bounded default name such as `Repair · <source name>`. Optional fields are `name` and caller-supplied `newLayerId`; the normal UI uses `name` and consumes the returned `layerId`. Do not emulate insertion with multiple client mutations. Native creation is one undo step; each subsequent stroke is one undo step. A caller-supplied new-layer UUID, if the native contract includes one for MCP transactions, is not needed by this normal UI flow.

After successful creation, identify the returned new layer by new ID, select it only in the same active document/backend context, clear the old source anchor, and keep the chosen clone/heal tool. Use the returned `layerId` in App’s guarded creation handler rather than assuming the new layer is `layers.at(-1)`; the repair can be below existing grades and upper artwork. On conflict or failure, do not select a guessed layer or change sampling settings.

The coordinator approved an explicit repair preset. The action’s visible help says **“Creates above the selected source; starts Current & below, ignoring adjustment layers.”** Only after successful creation in the captured document/revision/target context, choose Current & below and enable adjustment skipping. This avoids sampling an upper grade and grading the copied pixels twice. Ordinary clone/heal initialization remains All layers/false. A late successful creation for a context the user has left must not change the new context’s selection or sampling settings.

The newly inserted paint layer contains no model output, does not establish a live link to the source, and is not a smart object. Normal paint-layer editing, undo, portable save, export and reopen apply.

## Capability and state contract

Approved fields are `retouchSampleModes: ['current','current-and-below','all']`, `retouchSamplingTools: ['clone','heal']`, `retouchIgnoreAdjustments: true`, `retouchCurrentAndBelowScope: 'root-target'`, and `repairLayerPlacement: 'above-root-raster'`, plus the `create_repair_layer` command. A scope array must not imply broader target eligibility than described above. The UI should gate the selection and checkbox independently; missing fields preserve the old All layers path with no extra `paint_stroke` properties. All layers remains available as the legacy default even when a partial capability array does not list it; omit its `sampleMode` field in that case. Unsupported saved preferences are cleared when capabilities change, so they do not revive when support returns. The optional Photoshop backend must never receive native sampling arguments based solely on a matching tool label.

Keep `RetouchSamplingSettings` separate from generic `BrushSettings`. The current hook spreads brush properties into every raster stroke, so putting sampling flags into that object risks sending clone-only arguments to Brush/Eraser, and other tools. Construct sampling arguments only for captured clone/heal strokes and only when advertised. Every other tool’s existing payload remains unchanged.

Sampling choices are local workspace preferences; they are not new document properties. A backend capability change clears unsupported preference state and source interpretation without sending a command. A document/target switch clears the source point and cancels an in-flight stroke; it can keep an explicitly selected scope visible with an eligibility hint. Completed normal strokes may retain the source anchor so the user can make multiple repairs. A document revision change does not mean the anchor references an immutable old image: each next stroke reads the current declared scope.

## Gesture and async safety

1. At Option/Alt-click, capture the current document/backend, target, sample mode and ignore-adjustment interpretation with the source point. It remains a document-coordinate anchor, not original-photo coordinates. Source alpha is transformed with the selected layer for Current layer sampling.
2. At stroke pointerdown, validate target/scope, then capture the source point, sampling values, existing brush values, document revision/identity, target/tool, and artboard coordinate rectangle. The source image is frozen by native execution against that captured revision before applying any dab; the browser does not fetch a sample image or cache RGB.
3. Setting changes to Sample, Ignore adjustment layers, or Reset source cancel a current stroke before replacing state and clear the source anchor. Use an explicit cancellation callback and a latest-settings guard in move/up; an effect alone leaves a pre-effect stale event window. Preserve matching-pointer cancellation and detach refs before releasing capture.
4. Backend/document/target/tool changes continue to cancel the stroke. A locally observed revision change cancels a pending clone/heal stroke, rather than rebinding it to the new graph. A remote revision change unknown to the browser is rejected by the captured `expectedRevision`, refreshes metadata, and asks the user to sample/retry. Never automatically replay a stroke after conflict.
5. The retouch row can wrap and alter artboard position. For clone/heal, freeze the artboard mapping and cancel if width/height/left/top changes before move/up, including scroll or zoom. Do not combine points measured in two different mappings. Reuse the established Move mapping guard approach; other drawing tools need no new behavior in this milestone.
6. A second pointer, Escape, pointercancel, or lost capture cannot commit a partial stroke. Clearing the source during a stroke cannot later commit the old source. Source-setting Option/Alt applies only to clone/heal; retain existing move-guide Alt bypass elsewhere.
7. Submission uses the existing revision-guarded `run`; an async repair-creation result must not select its new layer in a document the user has switched away from. Normal busy gating should be retained, but identity checks must not depend on disabled controls alone.

The source marker denotes the chosen origin. It must not imply a live pixel preview or that each overlapping dab re-samples newly painted output. An optional moving offset marker is outside this first milestone.

## Browser acceptance

Use a real isolated companion, official native operations for fixtures and actual Chrome UI interactions for feature mutations. No API keys, external images, AI jobs or live user projects. Assert the returned graph and decoded pixels rather than screenshots alone.

1. **Separate-layer repair under a grade:** imported patterned photo, an upper adjustment, and an upper colored patch. Select the source; create the repair and assert its exact immediate sibling position, normal empty raster metadata, unchanged original bytes, existing filters preserved, and one undo entry. Set a source with Option/Alt and clone on the repair using Current & below plus ignore adjustments. Independent selected pixels show the upper color is excluded and the grade is applied once. Add a healing stroke with the same scope and assert meaningful output using the established deterministic healing reference, not an AI-equivalence claim.
2. **Scope differences and frozen source:** Current layer on an existing transparent repair cannot copy underlying RGB; Current & below includes previous repair pixels and intact lower grouped/clipped artwork, excludes upper roots; All layers reproduces the old path. A self-overlapping clone stroke reads the frozen pre-stroke sample rather than newly painted output. Use small exact fixtures and pressure/soft selection where coverage matters. Creation above protected/filtered source succeeds without altering its assets; protected destination regions remain unchanged.
3. **Unsupported state and defaults:** nested/clipping target scope rejection is explained without mutation; Current disables and clears Ignore adjustment layers; eligible root target restores availability without silently changing a chosen mode. New tools/backend missing capability fields send legacy payloads. All other brushes omit sampling fields. No source, protected target, filtered target and no-selection states remain truthful. Create action never breaks a chain or infers a different source.
4. **Lifecycle and recovery:** change settings/reset source mid-stroke, switch document/target, cancel pointer/capture, and introduce an external revision before release. No stale stroke or duplicate layer is published; explicit retry succeeds. Zoom/scroll/layout shift cancels clone/heal instead of mixing coordinate systems. Successful subsequent strokes retain the sampling anchor. Undo restores stroke and creation separately; reopen and portable project preserve resulting repair pixels/layer order, not local sampling preferences.
5. **Compact inspection:** 900px viewport with readable scope, checkbox, source status, eligibility hint and Create repair action, no horizontal document/inspector overflow, no browser errors or unexpected provider/key reads. Save a clearly synthetic screenshot such as `test-results/retouch-sampling-controls.png`.

Only run adjacent gesture/capture/retouch browser regressions justified by the changed shared hook and App new-layer handling. Pixel/core/MCP sampling algorithms and graph guards remain native/shared owners’ responsibility; the browser suite verifies the UI uses them correctly.

## Verification completed

`npm run build` passes. `tests/retouch-sampling-browser.mjs` passes five real-Chrome workflows: exact clone pixels under a source filter and upper grade, healing against the existing frozen-map kernel, explicit scope differences, unchanged imported bytes, separate creation/stroke undo, protected-source creation with all repair writes blocked, group/chain exclusions, ordinary-brush payload preservation, settings/reset/capture/context/layout cancellation, stale revision and explicit recovery, reopen, partial/absent/returning capabilities, and failed/late creation without an unwanted preset or selection change. No provider calls, key reads, or browser errors occurred.

The healing comparison intentionally reuses the established native kernel while independently constructing its sampling map; it verifies scope and transport, not a separate healing-algorithm implementation. Whole lower-group/chain sampling, transaction rollback, memory behavior and portable transfer are native/MCP acceptance responsibilities, not extra claims about this browser suite.

Adjacent `tests/pointer-capture-browser.mjs` passes four workflows and `tests/gesture-browser.mjs` passes four with nine intentional conflicts. `test-results/retouch-sampling-controls.png` was visually inspected at 900px; the scope, adjustment skipping, source marker, repair action, insertion explanation and actual synthetic repair result are visible without horizontal overflow.

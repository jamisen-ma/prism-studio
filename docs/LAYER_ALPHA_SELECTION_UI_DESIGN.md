# Layer transparency and mask selections in the UI

Status: implemented and browser-verified, September 19, 2026. Native semantics are defined in [LAYER_ALPHA_SELECTION_DESIGN.md](LAYER_ALPHA_SELECTION_DESIGN.md). This UI adds one compact card to the existing Select inspector; it does not add a toolbar tool, modal or thumbnail shortcut.

## Controls

Place **From a layer** immediately below the active-selection summary and Draw/Refine button, before selection morphology and the saved-selection library. A **Layer** dropdown uses the same selected-layer identity as Layers, includes hidden nodes and shows nesting. This makes choosing a mask source possible without switching tabs repeatedly.

| Control | Values and behavior |
| --- | --- |
| Source | **Content transparency** or **Layer mask**. Content is available only for the six advertised content types. Mask is available only when the node has its own additional mask. |
| Coverage, mask only | **With density** maps to `effective` and is the default. **Before density** maps to `raw`. Omit `maskMode` entirely for content. |
| Combine | Replace, Add, Subtract or Intersect with active selection. Default Replace. Subtract/Intersect require an active selection; an explicit empty selection still counts as active. |
| Invert source | Defaults off. Inverts incoming coverage before combining; does not edit the layer or its mask. |
| Load from layer | One explicit mutation, one undo step. Does not change the active canvas tool or create a saved-library entry automatically. |

Content wording: “Uses transformed working transparency, including source cutout alpha. Ignores visibility, opacity, layer masks and effects.” A compact details disclosure explains that parent settings, clipping-chain coverage and protected-layer display exclusions are also ignored; this is not a selection of the visible composite. RGB-only filters are bypassed. Hidden, protected, generated, filtered and clipped content remains eligible.

Mask wording: “Uses this layer’s additional mask in canvas coordinates. Feather and mask inversion are included.” Coverage help distinguishes density: With density includes its current percentage; Before density ignores only that setting. Density zero therefore loads full-canvas coverage in effective mode. Source cutout alpha is part of Content transparency, not this separate mask choice.

The target and options initialize synchronously per backend/document/revision/layer identity. Default source is Content when eligible, otherwise Layer mask if present. Disabled choices stay named, and the card explains unsupported group/adjustment content or a missing own mask. No source is silently created. All action inputs disable while a command is pending; ordinary type/own-mask eligibility is the only layer restriction.

## Capability and context safety

Require Native, connection, `commands.includes('load_layer_selection')`, and the advertised `layerSelectionSources`, `layerSelectionMaskModes` and `layerSelectionContentTypes`. Do not infer support from a segmentation model or image provider. Broaden Select-tab visibility from the old `save_selection`-only gate to either the saved library or this capability; keep unsupported library actions gated independently.

Reuse `App.run` and its captured context guard: `{backend,documentId,expectedRevision,targetLayerId}` comes from the exact rendered target at click time. The document and target must still match before dispatch; the native revision rejects changes that occur after dispatch. Keep normal selection-loading cancellation wording instead of saying the user was drawing. On revision conflict, refresh the same document only if it remains active, discard the rejected action, and require a new click. Never retry it automatically against a newer selection. Reset local source/coverage/combine/invert drafts on context changes; source loading has no asynchronous preview request that could retarget itself.

The existing live document selection, not an unfinished canvas-drag rectangle, is the input to combination and to the Subtract/Intersect gate. Existing gesture revisions cause any earlier unfinished gesture to conflict rather than overwrite a newer loaded selection.

## Empty selections

A loaded zero bitmap remains an active selection. Display **Empty selection · no pixels selected** for a materialized bitmap with no runs and no inversion. Never treat an inverted empty descriptor as empty, and never clear the result to null. The canvas may show no overlay, but Select still explains its state and allows saving, inversion, addition and undo. Mask/fill/adjustment consumers continue receiving an explicit empty mask rather than full-canvas semantics.

## Browser acceptance

Use a real isolated companion and local fixtures; no provider or segmentation calls are needed for this operation. Inspect returned alpha8 selection values, not only its dimensions or canvas outline.

1. Patterned RGBA alpha 0/1/128/255 plus existing geometry: Content loads exact working alpha despite hidden/opacity-zero/style/mask/ancestor display settings. Source assets, layer descriptors and rendered canvas are unchanged. A vector/gradient target proves this is not raster-only.
2. Raw/effective own masks on content, group and adjustment nodes: independently compute feather/inversion/clip/density coverage, including density zero and a half-byte edge. Command inversion complements materialized bytes before all four combination modes. No-mask and unsupported-content choices disable correctly.
3. Empty source produces a non-null empty selection; a selected-area edit does not spill onto the full canvas. Save it, load/add/subtract, undo and reopen; saved copies stay independent and every source byte remains intact.
4. Stage draft options, switch layer/document/revision, and confirm synchronous reset. Delay a request, change the document externally, release it and assert revision rejection, no unintended selection change and explicit recovery. Target/document changes before dispatch cannot redirect a captured action.
5. At 900px, labels and long layer names fit the existing scrolling inspector, action controls remain reachable, capability absence hides the card and no console or provider activity occurs. Preserve existing saved-selection/morphology/density workflows.

`tests/layer-selection-browser.mjs` passes four real Chrome workflows. It compares transformed working alpha and a protected vector rectangle with independent byte arrays; checks raw/effective bitmap and geometric masks, all combinations and 128→127 byte inversion; proves an actual brush gesture cannot spill out of an empty selection; and tests captured revision conflict/recovery, target/document draft resets, capability absence, source-only capability, undo, saved-copy independence and reopen. No provider, segmentation callback or credential lookup runs. Geometric feather and internal clip precision remain covered by native/SDK tests rather than duplicated in this browser fixture.

The build passes. Screenshot: `test-results/layer-selection-mask.png` at 900px. Adjacent saved-selection, morphology and mask-density browser regressions are run separately.

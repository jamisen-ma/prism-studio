# Additional-mask position controls

Implemented and browser-verified, 2026-09-19. This records the approved [native positioning contract](MASK_POSITION_DESIGN.md) and the UI decisions used by the implementation. Evidence and precise tested scope are listed below. The first interface is numeric independent positioning; it adds no dragging, linking, mask rotation or mask scaling.

## Location and visual hierarchy

Extend the existing **Layers → Layer mask** inspector in [ProPanels.tsx](../client/ProPanels.tsx), using a small `MaskPosition.tsx` component rather than enlarging its existing one-line rendering block. Keep **Inspect coverage** nearby. The controls apply to the node's own additional mask, including content, group and adjustment masks. Hidden, protected, clipped or filtered nodes are eligible when the backend supports the operation; source cutout alpha is a separate feature.

Show the ordinary source kind, such as “Ellipse mask · inverted,” followed by a small **Positioned** indicator when the persisted wrapper exists. Do not expose “positioned” as if it were the mask's geometric shape. Add the short hint: **“Moves the additional mask independently. Image pixels and subject cutout alpha stay unchanged.”**

Suggested order is mask summary and Inspect coverage; position controls; density/feather/invert; edge refinement; position-rasterization notice/action; replace/remove. With no mask, retain the existing creation guidance and omit position inputs. Positioning never creates a mask implicitly.

## Controls and commands

| Control | Behavior |
| --- | --- |
| **Mask X, px** / **Mask Y, px** | Controlled string drafts. Stored legacy position is 0/0; wrapper position comes from `x/y`. Values are absolute document-pixel offsets, not deltas and not percentages of the image. Label a positive X as right and positive Y as down in supporting text. |
| **Apply mask position** | Sends `set_layer_mask_position {layerId,x,y}` with the captured document/revision/layer. Require two finite integers in the advertised authored range, initially ±16,384; disable while busy, invalid or unchanged. Typing does not send commands. |
| **Reset position** | Sends the same command with `x:0,y:0` when the stored offset is nonzero. If only local drafts differ from stored 0/0, reset those drafts locally without a history entry. It moves the retained frame to its origin; it does not delete a mask, rasterize coverage, undo a crop or remove a bounds-domain clip. |
| **Rasterize mask position** | Sends `apply_layer_mask_position {layerId}`. Show for **wrapper presence**, even at 0/0. Never infer eligibility solely from nonzero coordinates. Disable while position drafts are dirty, with “Apply or reset your position changes before rasterizing.” It applies to the saved position only. |
| **Inspect coverage** | Opens the existing read-only additional-mask viewer at the saved revision. It does not apply a draft. Use a brief “Inspection shows the saved mask” hint when drafts differ. |

Accept blank/minus/incomplete numeric input as a draft, then show a clear validation message; do not coerce it to zero or clamp while typing. Number inputs use `step=1`. Enter in the position form applies a valid changed position; Escape in an input may restore that input's stored value without mutating. Do not nest a form inside another form. Buttons need explicit `type` values.

The native contract permits geometry-produced persisted offsets as large as ±1,000,000, even though authored positions are restricted to ±16,384. Display a larger stored offset faithfully. Show: **“Canvas changes placed this mask outside the editable position range. Enter an in-range position or Reset.”** Never clamp it on mount, revision change or blur. Rasterize remains available when the stored offset is out of range and no draft is pending. Use `min(advertisedMaximum,16384)` for authored input; do not assume an absent or malformed limit.

At 0/0, a wrapper may remain because its retained frame differs from the canvas or it has a bounds-domain clip. Show **“Position is zero; retained mask coverage is still active.”** Reset is then disabled unless it would clear a local draft, while Rasterize remains available. This distinction is essential after crop.

## Clear conversion and bounds disclosures

Place this text immediately before Rasterize, visible without opening an advanced section:

> Rasterizing keeps the mask's current canvas coverage as an 8-bit mask. Coverage outside the canvas is discarded, and feather/inversion become part of the mask pixels. Density stays editable. Undo restores the positioned mask.

Do not label this “Apply mask,” which can imply removing image pixels. Do not promise an identical composite after quantizing continuous geometric coverage, or a universal one-byte RGB error bound. The native contract's precision bound is on mask coverage. There is no new confirmation dialog: the explicit label, disclosure and undo provide the reviewable action.

Painting and morphology remain available. When `tool==='mask_brush'` and the selected additional mask is positioned, show a persistent, wrapping notice in [BrushOptions](../client/CanvasTools.tsx): **“Painting rasterizes this positioned mask to the canvas. Coverage outside the canvas is discarded; density stays editable.”** Show the matching sentence beside the **Apply layer mask edges** action in [MaskEdges.tsx](../client/MaskEdges.tsx). Do not show it for selection brushes or subject-cutout-alpha brushes. A Replace stroke retains its existing replacement meaning. These actions each send their normal single command; no preliminary hidden rasterization command or extra undo step is introduced.

In **Canvas bounds** mode of [ResizePanel.tsx](../client/ResizePanel.tsx), show this whenever any positioned mask exists: **“Changing bounds clips positioned-mask coverage to the old and new canvas. Hidden coverage may no longer return when the mask moves. Undo restores it.”** This supplements the existing transparent-padding/original-scale explanation. A plain Crop retains the positioned source frame and does not show the same loss statement. Neither interface should describe all mask geometry changes as lossless.

Replacement/removal remains explicit: replacing a mask from selection or removing it clears its positioning and follows existing density-reset behavior. The selected source cutout's Original/Mask views and alpha-repair controls stay unchanged.

## Refinement and type integration

Before this change, `LayerMaskProperties` read `layer.mask.feather`, `layer.mask.invert` and `layer.mask.shape` directly. Those accesses would be wrong for a wrapper. Introduce small read-only helpers to return the retained **legacy source** and positioning metadata; use the source for summary/feather/invert/painted-mask guidance. Send existing `modify_layer_mask` commands against the same layer ID; native code modifies the retained source. Density continues to read `layer.maskDensity`.

Keep selection types separate in [api.ts](../client/api.ts):

```ts
type LegacyMask = /* today's Mask */;
type PositionedMask = {
  shape: 'positioned'; source: LegacyMask;
  sourceWidth: number; sourceHeight: number;
  x: number; y: number;
  domain?: { x: number; y: number; width: number; height: number };
};
type AdditionalMask = LegacyMask | PositionedMask;
// Layer.mask uses AdditionalMask.
// Active/saved selections and public replacement masks remain LegacyMask.
```

Do not widen every selection overlay to accept positioned masks, and never send the persisted wrapper back as a public `set_layer_mask` argument. The UI only reads it and invokes the dedicated commands. It must not reimplement feather, inversion, density, clipping or coverage rasterization.

## Capability behavior

Add the approved capability fields to client types and forward them through status unchanged:

```text
layerMaskPositioning: 'independent-translation'
layerMaskPositionUnits: 'document-pixels'
layerMaskPositionOperations: ['set', 'rasterize']
limits.maxLayerMaskPosition
limits.maxLayerMaskSourcePixels
```

Enable **set/reset** only for native, recognized positioning/units, the `set` operation, its command, and a valid authored limit. Enable **rasterize** independently when the `rasterize` operation and command exist with recognized native semantics. A backend advertising set-only still gets set/reset; a backend advertising rasterize-only can normalize a persisted wrapper. Do not require both operations to expose either one.

Read-only mask inspection retains its own command/source/mode gates. Existing refinement controls retain their own command/property gates; a missing positioning capability does not hide density or inspection. Conversely, a known positioned mask with unavailable mutation capability should show its saved position and explain that this companion cannot change it, rather than rendering editable controls that will submit unsupported commands.

Before this change, App mounted the entire mask inspector only behind `can('set_layer_mask')`. Change the entry condition to the supported operations actually shown, so a read/refine/position-capable backend is not accidentally hidden by a missing replace/remove command. Gate replace, remove, position, refine, morphology and inspect individually. The Photoshop bridge never receives the native positioning commands.

## Drafts, revisions and in-flight work

Key the editable mask inspector or its editor child by backend, document ID, document revision, layer ID and relevant capability signature. Existing density controls already use a context key; position and feather drafts need the same protection. On a document/revision/target change, discard old drafts and derive the new saved state synchronously. A `useEffect` that eventually copies another layer's offset is insufficient because an earlier handler may submit the old draft in the meantime.

Capture `{backend,documentId,expectedRevision,targetLayerId}` at Apply/Reset/Rasterize click using the existing gesture-context mechanism. Use the app's mutation runner rather than a separate direct fetch. All three operations use their target as displayed, not whatever layer is selected after the request begins. Busy state disables mutation buttons; changing selection/backend/document invalidates the originating UI. A stale revision rejects, refreshes current metadata through the existing runner, and never automatically retries the old edit.

Add mask-specific runner messages instead of the current generic drawing message: **“The document changed before the mask edit was saved. Review its current position and try again.”** Ordinary failures preserve the current draft where its context is unchanged. Do not clear or claim success until the returned document has been accepted for the same active context. A late successful edit may have committed on the server; it must not switch the user back to another document or overwrite a newer active view. Extend the existing request-context/result checks where needed rather than assuming component unmount cancels server work.

Mask brush gestures already capture revisions. If the mask position/revision changes during a stroke, the submitted stroke must reject or be cancelled; it must not materialize a new position using points captured for the previous state. No extra per-pointer-move requests are needed.

## Raw/effective preview lifecycle

[MaskInspection.tsx](../client/MaskInspection.tsx) already keys requests by source, layer, revision, raw/effective choice, max edge and sequence, and hides stale images until explicit Refresh. Preserve this behavior. A saved position, rasterization, density/feather/inversion change, crop or bounds edit changes document revision and invalidates an in-flight old preview. Raw and effective modes both reflect the saved translation; effective additionally applies density.

Do not CSS-translate an old preview to simulate the new mask: inversion exterior, clips and density make that misleading. The returned `MaskPreview.sourceWidth/sourceHeight` still mean **current canvas dimensions**, not the retained wrapper's source frame. Keep response validation and captions using current canvas dimensions. Any optional retained-frame metadata is a separate read-only caption, never a substitute for the preview's source dimensions.

Closing inspection, switching layers/backend/documents or replacing the mask invalidates pending responses. An old effective image must never appear under a Raw label. Loading an additional mask into a selection likewise uses saved positioned coverage; it does not commit drafts or change the wrapper. Source cutout-alpha inspection remains separate.

## Actionable image-resize rejection

In **Scale image** mode, derive blockers from every current document layer whose mask is positioned, including hidden masks, density zero, groups and zero-offset wrappers. Show layer names and disable the final scaling action while blockers exist. Explain: **“Rasterize mask position on these layers before scaling the image. Crop and Canvas bounds remain available.”** The scale fields can remain editable so intent is retained.

Provide **Review mask** on each listed row. It closes Resize, selects that exact layer, opens Layers and focuses its mask-position section. Preserve the resize draft keyed by document ID while navigating; returning to Resize restores dimensions/mode for review against the latest document. Never automatically rasterize all masks, change selection to make a hidden mutation pass, or run the saved resize after rasterization. Each conversion is the explicit inspector action and each resize is a later explicit submission.

If rasterization is unavailable, say **“This companion cannot rasterize positioned masks. Update it, or use Crop/Canvas bounds.”** Reset is not advertised as a universal workaround: crop/domain wrappers may remain at zero. With many blockers, use a compact scrollable list rather than an overflowing error paragraph.

The backend's `MASK_POSITION_REQUIRES_RASTERIZE` remains authoritative. It can occur after a concurrent edit even if the panel's earlier metadata had no blockers. Preserve the resize dialog/draft, show the named-layer error, and refresh current document metadata so the review list becomes accurate. Do not parse layer IDs from an error string; derive the list from the refreshed graph. If structured affected IDs are later exposed, they must be validated against that graph. A revision conflict likewise never triggers automatic conversion or resize replay.

## Focused browser acceptance

Use isolated companions, small diagnostic masks and actual native responses. No external segmentation, image providers or credentials are needed. The browser fixture injects deterministic local subject alpha to verify source-cutout independence.

1. **Numeric positioning:** enter X/Y on a soft geometric mask; drafts cause zero requests; Apply sends one absolute-position mutation with correct document/layer/revision. Repeated move-out/move-back restores coverage, source hash and source descriptor. Empty/fractional/out-of-range input sends nothing.
2. **Reset versus Rasterize:** crop a positioned bitmap into a smaller canvas, set 0/0 and verify it remains positioned. Reset does not claim conversion; Rasterize remains enabled. Explicit rasterization clears the wrapper, retains density and produces the declared canvas coverage; undo restores frame/offset/domain.
3. **Retained refinement:** source feather/invert controls display persisted values and update the source without moving it; density stays separate. Cover content, group and adjustment masks, including hidden/protected targets and inverted bitmap exterior.
4. **Materialization disclosure:** mask-brush and morphology notices are visible before action, including at 900px. Each operation issues only its normal command, clears positioning once and preserves density; undo restores it. Source-cutout/selection brushes do not show the wrong notice or mutate the additional mask.
5. **Geometry and scaling:** exact crop is available; canvas-bounds warning is visible. Scale lists hidden, density-zero and zero-offset positioned masks; Review mask targets the right node and preserves resize drafts. No implicit rasterization or later automatic resize occurs. A backend rejection after an external edit refreshes the list without dropping the draft.
6. **Lifecycle:** change layer/document/backend or externally revise while drafts/requests are pending. No stale values submit against another mask; delayed success does not replace a newer document view. Busy/double-click handling yields at most one requested mutation. Test offsets produced outside the authored input range without any mount-time normalization.
7. **Preview correctness:** delay raw/effective reads, then move/rasterize/crop the mask. The old image becomes stale, and explicit Refresh obtains current translated coverage with current-canvas dimensions. Content-alpha and source-cutout views remain unchanged.
8. **Partial capabilities/layout:** set-only, rasterize-only, read-only, missing bounds, wrong units and Photoshop fixtures expose only supported actions. Test long layer names, many resize blockers, short viewport heights and 900px width; inputs, loss disclosures and buttons remain reachable without horizontal overflow.

Implementation should touch only the necessary inspector/types/capability forwarding, existing mask brush/edge disclosure, resize navigation and focused tests. The toolbar, Move gestures, linked transforms and source-alpha tools remain outside this UI milestone.


## Implementation and verification evidence

Implemented in [MaskPosition.tsx](../client/MaskPosition.tsx), [api.ts](../client/api.ts), [ProPanels.tsx](../client/ProPanels.tsx), [App.tsx](../client/App.tsx), [ResizePanel.tsx](../client/ResizePanel.tsx), [CanvasTools.tsx](../client/CanvasTools.tsx) and [MaskEdges.tsx](../client/MaskEdges.tsx), with compact inspector/resize styles. Source and additional-mask types remain separate. No recipe application logic was changed.

Position, feather and density editors remount on document/revision/target/capability changes. The inspector shell and edge-operation preferences remain stable across document revisions; resetting the entire shell had reset a chosen morphology radius after Undo, which the adjacent regression suite caught. Position and feather child keys have distinct prefixes. Equivalent valid numeric drafts such as `04` at saved offset `4` count as clean and do not trap Rasterize behind a disabled Apply button.

The runner captures mask targets, rejects stale results before and after preview loading, and refreshes current metadata on revision conflicts. Document-wide resize success checks backend/document/revision without requiring the selected layer to stay fixed. Both positioned-mask resize rejection and ordinary resize revision conflicts refresh the graph without replaying the edit. Feather/invert honor explicit partial property lists; an absent property list retains legacy support. Position set/rasterize remain independent of replace/remove.

`npm run build` passes. [tests/mask-position-browser.mjs](../tests/mask-position-browser.mjs) runs eight consolidated workflows against an isolated actual native companion:

| Workflow | Browser evidence |
| --- | --- |
| Numeric position and lifecycle | Empty/fractional/out-of-range drafts cause no requests; absolute translation retains source/density/selection/protection; zero draft reset adds no history; target switches, undo/redo and reload reset drafts. |
| Source refinement | Retained feather/invert and layer density modify independently; original cutout-alpha preview and source assets stay byte exact. |
| Materialization | Additional-mask brush and edge controls disclose conversion before mutation; each sends its normal single command, preserves density, and undoes once; the source-alpha brush has no additional-mask warning. |
| Retained zero offsets | Cropped 0/0 wrappers retain a 64×48 source frame on a 50×32 canvas; Reset is disabled and Rasterize remains available; inspected coverage matches the independent rectangle oracle and current-canvas dimensions. |
| Resize review | Hidden density-zero group masks appear alongside visible masks; review selects/focuses the exact mask; dimensions survive each explicit rasterization; resize runs only after a later explicit submission; 900px layout does not overflow. |
| Conflict and late mask results | Geometry-generated −16385 displays without clamping and is rasterizable; stale writes refresh saved offsets; delayed success cannot retarget a newly selected layer. |
| Resize response lifecycle | Authoritative positioned-mask rejection refreshes blockers without losing dimensions; delayed document-wide success accepts a changed selected layer but cannot reopen an old document or close a new dialog. The navigation case deliberately simulates a queued change across the normal busy-disabled selector. |
| Partial capabilities | Set-only, rasterize-only and read/refine-only companions keep inspection/refinement available without replacement/removal; explicit density-only properties hide feather/invert, while legacy absent properties retain them. |

The adjacent `test:mask-density-browser`, `test:mask-inspection-browser`, `test:morphology-browser` and `test:canvas-browser` suites pass. They provide the existing coverage for group/adjustment density, stale/out-of-order raw/effective previews, exact morphology and canvas pixel preservation. No source-alpha or provider behavior was reimplemented in the UI. This UI evidence does not claim a separate Photoshop connection or every optional fixture permutation listed in the design acceptance inventory.

Artifacts: [eight-workflow report](../test-results/mask-position-browser-report.json), [numeric controls](../test-results/mask-position-controls.png), [900px resize review](../test-results/mask-position-resize-review.png), [partial-capability inspector](../test-results/mask-position-partial-capabilities.png). The report records zero key reads, zero image-provider calls and zero browser errors. Fixtures are temporary and removed after each run.

# Rulers, guides and Move snapping

Implemented and verified, 2026-09-19. Four real Chrome workflows in `tests/guides-browser.mjs` verify the first milestone below. Existing Move (4), gesture (4), professional tools (8), and baseline browser regressions also pass. This is the bounded native feature contract, not a complete Photoshop parity claim. Numeric guide CRUD is implemented; dragging guides and grids remain deferred.

## Document contract and view state

Native documents expose `guides: []` by default. Each entry is `{id, axis, position}`: a UUID, `horizontal` or `vertical`, and an integer document-pixel coordinate. Orientation describes the line: horizontal uses Y in `0..height`; vertical uses X in `0..width`. Canvas-edge positions are valid. Up to 64 guides are retained, including distinct IDs at coincident positions.

Commands use normal `documentId` and `expectedRevision` arguments:

- `add_guide {axis, position}` creates one guide.
- `update_guide {guideId, position}` changes its position; orientation stays fixed.
- `delete_guide {guideId}` removes one guide.
- `clear_guides {}` removes all guides as one undoable edit.

Resize scales coordinates by the corresponding dimension and rounds once. Crop subtracts its X/Y origin; canvas-bounds changes use the backend's exact content-translation offset. Guides outside the new inclusive canvas bounds are dropped, with undo restoring them. UI must consume the returned graph instead of applying a second geometry transformation. `.prism` retains guides; rendered images, PSD pixel content and generation inputs do not include them.

View flags are local preferences, separate from the document and its history: rulers default **off**, guides default **on**, snapping default **off**. Hidden guides never snap. Ruler visibility is independent of guide visibility. Storage failures fall back to in-memory defaults. A document switch must never reuse another document's guide list.

Gate native CRUD by advertised commands and `guideAxes:['horizontal','vertical']`, `guideCoordinates:'document-pixels'` and `limits.maxGuides:64`. Do not infer Photoshop guide support or add this as an official Photoshop toolbar item.

## Controls and non-exported presentation

A compact **Layout** button beside the footer zoom controls opens an inspector layout panel with a return-to-Layers action. It avoids a fifth narrow inspector tab and another crowded top-bar item at 900px.

The panel offers local Rulers, Guides and Snap Move to guides switches; orientation and integer position fields; Add guide; a compact saved-guide selector/list; Update position, Delete and Clear all. Horizontal/vertical labels explicitly identify Y/X. Inputs show the relevant inclusive dimension range, reject fractions/nonfinite values, and stay local until explicit submit. A no-op update is disabled. Clear-all is disabled for an empty list. CRUD uses the existing busy/error and revision-guarded command flow. No drag handles, ruler dragging, grids, arbitrary ruler origins, physical units or guide locking are included in this milestone.

Guide lines are one CSS pixel wide and clipped to the artboard. Render coincident locations once, but retain individual entries in the editor. The whole overlay has `pointer-events:none` and is never added to image data or an export canvas. Accessible guide descriptions/counts are available in the panel; decorative lines need not create dozens of screen-reader landmarks. A snapped line may be highlighted; the Move overlay still says pixels update on release.

## Coordinate model

Current source references: `client/App.tsx` owns `viewportRef`, `imageRef`, fit zoom, scrolling and the artboard; `client/MoveTool.tsx` owns the captured layer bounds and drag; `client/gesture.ts` owns captured document/revision/target identity. The surface is flex-centered, padded 50px normally and 55px at wide viewports. Therefore padding, scroll offsets or `actualZoom` alone are not a reliable screen origin.

Measure the actual artboard and scrollport rectangles:

```
sx = artboardRect.width / document.width
sy = artboardRect.height / document.height
originX = artboardRect.left - viewportRect.left - viewport.clientLeft
originY = artboardRect.top  - viewportRect.top  - viewport.clientTop

rulerX(documentX) = originX + documentX * sx
rulerY(documentY) = originY + documentY * sy
documentX(clientX) = round((clientX - artboardRect.left) / sx)
documentY(clientY) = round((clientY - artboardRect.top) / sy)
```

An artboard child overlay can use percentage positions (`position/dimension*100%`), which automatically tracks zoom/scroll without additional reads. Rulers live in fixed approximately 20px gutters in a two-by-two canvas frame: corner, horizontal ruler, vertical ruler, and the existing scrollport. The gutter is absent when rulers are hidden. Keep `viewportRef` on the actual scrollport, so current fit and pan behavior continue to use its client dimensions. The gutters do not scroll away and never cover the scrollbar or intercept artboard drawing.

Update ruler measurements through one scheduled animation frame on scroll, ResizeObserver changes to the scrollport/artboard, zoom, inspector/layout changes and document changes. No continuous idle loop is needed. Read rectangles before setting state and avoid state updates for unchanged geometry. SVG rulers use CSS-pixel coordinates, so devicePixelRatio does not enter document geometry. Draw only the visible document range with a bounded tick count. Choose integer major intervals from the 1/2/5 progression with enough screen spacing for labels; minor ticks appear only when both integer-valued and visually separated. Origins remain document `(0,0)` after pan, zoom or centering.

## Integer Move snapping

This feature aligns the **displayed movement bounds**, not immutable source dimensions or the content-only arrangement bounds. Existing `get_layer_preview.visibleBounds` may include outlines, shadows/glows and currently clipped pixels. Canvas clipping can change final visible edges after a move; disclose this in the layout/Move guidance. This milestone does not promise to recover off-canvas content.

Free Move eligibility and protection remain unchanged. Snapping additionally requires visible guides, an enabled local snap preference, current nonempty bounds, and a safe selected target. Disable snapping when the layer or any ancestor has a document-anchored mask, when the layer or an ancestor uses dissolve blending, or when an unprotected generated layer has contextual protection that may clip its visible result. Free movement remains available with a concise reason. The native generated-content predicate is `!layer.protected && (layer.role === 'generated' || Boolean(layer.provenance?.jobId))`. Also disable snapping when the initial visible bounds touch any canvas edge; the preview cannot prove those bounds include all source content.

At pointerdown capture the existing document/layer/revision context, pointer ID, start coordinates, measured CSS/document scale, visible bounds, effective flags and deduplicated guide positions. Do not fetch bounds, render previews or read other layers on each pointermove. Local ruler/guide/snap flag changes, tool/document/target changes, Escape and the matching pointercancel cancel the gesture. A second pointer cannot overwrite or commit it. A document mutation during the gesture must retain the captured revision and reject explicitly on commit; no automatic replay.

Resolve X and Y independently from the same pure function on both pointermove and pointerup:

1. Compute the existing rounded raw document delta. If both raw deltas are zero, preserve the no-op; clicking near a guide must not move a layer.
2. For X use left/right plus an integer-valued horizontal center. For Y use top/bottom plus an integer-valued vertical center. Skip half-pixel centers instead of introducing resampling or a hidden half-pixel placement error.
3. For each compatible guide/anchor pair, `candidateDelta = guidePosition - initialAnchor`. Both are integers. Candidate distance is `abs(candidateDelta - rawDelta) * cssPixelsPerDocumentPixel`.
4. Reject candidate translations that move the displayed bounds outside the canvas; exact contact with an edge is allowed. Accept only distances at most **6 CSS pixels**. Choose the least distance, then edge before center, then start edge before end edge, then guide coordinate and stable guide ID. This gives deterministic ties independent of document-list order. Deduplicate coordinates before resolving.
5. Use the winning integer delta for that axis, or its raw integer delta when no candidate qualifies. At most three anchors per axis and 64 saved guides make the work bounded; there are no image operations inside the resolver.

Alt temporarily bypasses snapping only during Move. Use the event's modifier state on pointerup, and update the preview on Alt key transitions from the last pointer coordinates so preview and eventual commit agree. Leave clone/heal Alt source sampling untouched. Snapping flags are captured for the gesture; Alt is the sole intentional dynamic bypass.

Commit exactly one existing `transform_layer {x,y}` with the captured context. The native integer-translation path preserves protected/source-alpha pixels; snapping does not scale, repaint, change masks or mutate guide positions. Identical deltas and cancellation create no history.

Cancel if zoom/layout changes the artboard scale during the drag. A scroll or recentering change also needs explicit handling because the current Move implementation measures pointer displacement in client space: the conservative first implementation cancels on a changed artboard origin rather than silently mixing coordinate spaces. Compare the captured geometry at release as well as processing observer/scroll notifications, so a pending animation frame cannot race pointerup.

## Event and state audit findings

- App's dispatcher calls Move before raster, vector and brush/selection handlers. Keep snapping inside Move; do not rewrite the shared drawing coordinate helper.
- All noninteractive rulers/lines stay outside that event path. Numeric CRUD needs no new gesture context. Future ruler dragging would require document-scoped gesture submission: current `run(..., gesture)` assumes the captured target layer matches the current selection.
- `interactingRef` currently includes Move, vector, brush/selection and rectangle drags. No new drag is added in this milestone. If guide dragging is added later, it must join this guard and own matching pointer capture.
- A polling request already in flight can finish after a drag starts. Captured revision and keyed bounds checks remain necessary even with polling suppression.
- ResizeObserver updates caused by ruler gutters must not oscillate fit zoom; measure the actual scrollport and update only changed geometry.
- No global Alt interception or new shortcut should consume brush sampling, text input, pan, crop, lasso, pen handles or existing Escape behavior.

## Browser acceptance

1. Real native CRUD via the panel validates boundaries, rejects fractions, retains IDs on update, performs one undo per action, persists after reopen and never changes preview/export pixels. Exercise duplicate positions, maximum count and clear/undo.
2. Rulers and lines agree with actual artboard coordinates after fit zoom, explicit zoom, scrolling, inspector resize and a 900px viewport. Guide pixels align to the expected CSS location and disappear without changing image bytes.
3. Snap a selected layer's edges and integer center near horizontal/vertical guides at multiple zooms. Independently verify the 6-CSS-pixel threshold, deterministic equal-distance ties, half-center exclusion, exact committed integer translation and one-step undo. Preserve low alpha values and source assets.
4. Pointerup uses the same resolver as the last move. Test no-op click, Alt bypass/release, hidden-guide bypass, disabled snapping with masks/dissolve/contextual generation, and normal free movement when snapping is ineligible.
5. An external revision change, document/target switch, second pointer, Escape, pointercancel and zoom/layout change cannot commit an unintended move. Existing gesture/Move/pro-tool suites keep drawing and clone/heal behavior unchanged.

The browser fixture uses real native commands, synthetic local image data, and no external model/provider or credential reads. `test-results/guides-layout.png` was visually inspected at 900px. Lost pointer capture now cancels Move through the artboard handler; the captured ref is cleared before release to avoid reentrant cancellation.

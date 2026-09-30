# Document guides, rulers and Move snapping

Status: native guide metadata, CRUD, geometry transformations, capabilities and `.prism` validation are implemented. Six focused native/pure tests and the official MCP SDK test pass. The separate [UI design](GUIDES_UI_DESIGN.md) covers ruler layout and gesture integration; client verification is tracked there.

## Recommendation and scope

Implement document guides before clipping chains. Guides add bounded metadata and reuse the existing integer Move command; they do not change image rendering, source alpha, group compositing or protected footprints. Clipping chains add an independent compositing scope and must avoid multiplying soft base alpha twice, so they deserve a separate implementation and audit.

This milestone includes named-by-ID horizontal/vertical guide lines, numeric creation/edit/deletion, canvas-relative rulers, visibility controls and optional Move snapping. It excludes guide dragging, arbitrary ruler origins, physical units, rotations, grids, automatic subject snapping, inter-layer smart guides and a server-side snapping mode.

## Persisted graph and command contract

`graph.guides` is optional. Existing documents behave as an empty list; `get_document` returns `guides:[]` by default. Each record contains exactly:

```js
{ id: "server-generated UUID", axis: "vertical", position: 160 }
```

The axis names describe **line orientation**:

| Axis | Stored coordinate | Inclusive valid range |
| --- | --- | --- |
| `vertical` | x from the canvas's left edge | integer `0..document.width` |
| `horizontal` | y from the canvas's top edge | integer `0..document.height` |

Positions are boundaries in document pixel coordinates, not pixel-center indices. Thus x = width and y = height are valid right/bottom edge guides. Whole-pixel authoring supports exact integer translations. A canvas center at a half pixel is deliberately not rounded into an allegedly exact center guide; users can choose one adjacent integer position.

Maximum **64 guides** per document, including coincident ones. IDs are unique UUIDs; coordinates may coincide. Resizing can map two distinct guides onto the same integer and must not silently merge or delete their identities. Preserve array order; the UI may collapse overlapping drawn lines and snap targets while keeping both records in the list.

| Command | Additional arguments | Behavior |
| --- | --- | --- |
| `add_guide` | `axis, position` | Append one guide with a server UUID. |
| `update_guide` | `guideId, position` | Move an existing guide; its axis and ID are immutable. |
| `delete_guide` | `guideId` | Remove only that ID. |
| `clear_guides` | none | Remove every guide in this document. |

All use the normal `documentId`, expected revision, native queue, `apply_transaction`, one history commit and undo/redo rules. Do not reuse `move_layer` or create fake guide layers. The UI disables redundant unchanged submissions/empty clear; server no-op history behavior follows existing mutation conventions. Stable request IDs in the existing service protect retried mutations from duplicate application.

Validate unknown fields, axes, IDs, integers, capacity and axis-specific limits before mutation. Suggested codes follow existing conventions: `INVALID_ARGUMENT` for invalid values, `NOT_FOUND` for missing guide ID, `LIMIT_EXCEEDED` for capacity. No image read/write is needed. Guide edits preserve layers, source bytes, selection libraries, style presets, group scope and protection exactly. Normal document revision increments invalidate stale previews and outstanding gesture/AI snapshots even when the pixel image is unchanged; avoid creating a second, inconsistent revision namespace for this milestone.

Capabilities expose `guideAxes:['horizontal','vertical']`, `guideCoordinates:'document-pixels'`, and `limits.maxGuides:64`. Positions use the integer boundary convention described above; there is no separate units capability. Client-only ruler/snap flags are not native document capabilities.

## Geometry transformations

Transform each record **once** from the old document geometry, preserve its ID/order, and filter only positions outside the new inclusive bounds:

| Operation | Vertical guide | Horizontal guide |
| --- | --- | --- |
| `crop_document` | `p - crop.x` | `p - crop.y` |
| `resize_document` | `Math.round(p * newWidth / oldWidth)` | `Math.round(p * newHeight / oldHeight)` |
| `resize_canvas` | `p + canvasTransform.x` | `p + canvasTransform.y` |

Use the existing `canvasTransform` result, including its exact integer anchor rounding. Do not independently recalculate a center offset from CSS or floating-point ratios. Resize positions clamp only to the mathematically expected inclusive range to absorb floating-point endpoint noise; crop/canvas operations **drop** outside guides instead of clamping them onto an unrelated canvas edge. Undo restores the entire previous list, including removed guides. Re-expanding after a crop does not restore removed guides without undo, consistent with this bounded in-canvas representation.

Layer transforms, alignment/distribution, placement, group operations, mask edits and source extraction do not move document guides. Style preset dimensions remain unchanged. Image generation into an existing document retains guides; creating a new generated document starts with none. No guide geometry may be inferred from an AI image.

## Rendering and portable compatibility

Guides and rulers are client overlays only. Never composite them into `renderGraph`, `get_preview`, `get_layer_preview`, histogram, sampled colors, source/mask views, segmentation input, generation snapshots, generated-result masks or PNG/JPEG/WebP/TIFF/PSD pixels. Their creation or movement must leave all image bytes and decoded outputs unchanged.

`.prism` includes the optional guide list as editable document metadata. Add `guides` to the codec's explicit graph-root allowlist and validate its exact fields/limits both in native and bundle validation before image assets are written. No new blob references, archive-size change or image decoder is needed. Import creates a new document while retaining guide IDs within that document; there is no live cross-document guide link. Current-state bundles still omit undo history. Older files without guides remain valid; old builds can reject the newly added optional metadata, so do not promise old-build import compatibility.

The current strict PSD exporter does not write guide resources. Its report should state that guides are not embedded, alongside existing native selections/history metadata omissions. Ordinary image export excludes all view overlays.

## Move snapping contract

Snapping is a deterministic **client calculation** producing an ordinary integer `transform_layer` translation on pointer release. It makes no extra history entries, performs no live server writes and does not modify the source pixels or guide list. Rulers, guide visibility and snap toggles are local view preferences, never persisted into the document graph or its archive.

The present Move tool obtains `get_layer_preview.visibleBounds`, an intrinsic document-space bounding box for the isolated selected layer including its outside styles and ancestor controls. It is not the arrangement tool's style-excluded content bounds. Label the feature **Snap movement bounds**. Do not claim it identifies subject anatomy, immutable source edges or the document composite's visible outline.

For each axis independently:

1. Capture the document/revision/layer, displayed bounds, guide records and artboard pixel-to-CSS scale at pointer down using the existing gesture guard.
2. Compute the unsnapped whole-pixel translation from the pointer displacement.
3. Compare leading/trailing bounds edges, and the center only when that center is an integer, against matching-axis guide coordinates. A half-pixel center cannot align exactly with an integer guide using integer translation and must be skipped, not silently resampled.
4. Candidate deltas are `guidePosition - anchorPosition`, always integers. Accept only distances within **6 CSS pixels**, converting through the captured per-axis artboard scale. This keeps snapping sensitivity consistent across zoom and device-pixel ratios.
5. Choose smallest CSS distance; resolve equal distances by start edge, end edge, center, then guide coordinate and stable guide ID, independent of guide array order. Deduplicate identical guide coordinates for this calculation while retaining all persisted IDs.
6. Reject a candidate that would move any of the current displayed bounds outside the canvas; exact contact with an edge is allowed. If no candidate qualifies, preserve ordinary free Move behavior.
7. Show the snapped movement guide and winning guide line locally. On release, run the same function and commit its integer delta once with the captured revision. Escape, pointer cancellation or stale context clears the draft without mutation. A temporary modifier bypass may be provided, but an accessible Snap toggle is required.

Snapping must be disabled for an own or ancestor mask, with a brief reason; masks are canvas-anchored and the moved visible bounds need not equal translated pre-drag bounds. Free Move remains available with its existing clipping warning.

The approved conservative restrictions also disable snapping for a dissolve blend on the target/ancestor, unprotected generated job provenance whose alpha is contextually clipped, and initial bounds touching the canvas edge. Match the renderer's generated gate: `!layer.protected && (layer.role === 'generated' || Boolean(layer.provenance?.jobId))`. Dissolve changes coverage by destination pixel, generated protection can change after translation, and an edge-touching box may conceal clipped decoration. These are client eligibility rules, not new native transform restrictions. Free Move remains available with the existing clipping notice.

No server `snap` argument, floating-point scale, resampling pass or alignment command is involved. Existing source/protection/isolated-group transform rules remain authoritative. Guide numeric edits during a layer drag change the document revision and cancel the stale draft.

## Rulers and UI boundaries

The [UI owner’s design](GUIDES_UI_DESIGN.md) should use the artboard's actual rectangle for coordinate mapping and synchronize ruler ticks/guide lines through zoom, scroll, centering and resize. Do not assume canvas padding or a fixed screenshot-to-image scale. The first version uses numeric CRUD rather than guide-line hitboxes, avoiding interference with paint, path and Move pointer capture.

Guide positions and ruler labels remain document pixels even when displayed at another zoom. Use bounded tick density; zooming an 8192-pixel canvas must not add one DOM element for every source pixel. View controls cannot create history or dirty source data. Hidden guides should not produce invisible snapping: recommend guide visibility off also disables snap interaction until lines are shown, without deleting the remembered Snap preference.

## Acceptance and sequencing

1. Legacy documents return an empty guide list. Add/update/delete/clear obey IDs, 64-capacity, coincident-coordinate and inclusive boundary rules. Axis changes, NaN/fractions, invalid dimensions, unknown fields and missing IDs reject atomically.
2. Guide-only edits leave composite/source/layer/mask pixels, histograms, sampled colors, source/working/alpha files and generation snapshot PNG bytes unchanged. Revisions/history behave normally and assets are never written.
3. Crop, all nine canvas anchors, asymmetric resize and odd dimensions match hand-calculated positions. Boundary guides survive; outside guides drop; coincident results retain both IDs/order. Undo/redo and reopen restore exact lists.
4. Failed transactions and injected metadata persistence errors preserve graph, project file and previous guide list. Native 16 MiB metadata/history cap still applies.
5. `.prism` roundtrip preserves guides under a new document ID, and malformed/out-of-range/duplicate-ID/over-cap canonical metadata rejects before asset writes. Flattened/PSD outputs contain no guide pixels.
6. A pure snapping helper tests 6-CSS-pixel inclusion/exclusion, per-axis zoom, stable ties, duplicate locations, odd-size centers, integer-only deltas and no clipping candidates. All disabled eligibility cases permit ordinary unsnapped movement.
7. Browser tests at fit/100%/zoomed/scrolled and compact widths compare ruler ticks and guide positions against measured artboard coordinates. Turning view controls on/off never changes revision.
8. Pointer movement previews locally; pointer release commits exactly one transform and one undo step. Escape/cancel, lost pointer capture, selected-layer switch, document change and revision change do not commit stale movement.
9. Protected cutout placement snaps via integer translation without source resampling or changed original bytes. Undo restores exact pixels; post-release guide/bounds refresh is revision keyed.

Implementation sequence: pure guide validator/geometry helper → native metadata mutations/geometry integration and bundle allowlist → shared/MCP capability tests → view-only ruler/guide panel → pure snapping helper and existing Move integration → real browser coordinate/gesture checks. No new dependency or renderer branch is required.

## Backend verification

[Native/pure tests](../tests/guides.test.mjs) independently check integer/inclusive boundaries, all nine canvas anchors, odd-dimension rounding, resize collisions, dropped-guide restoration, ID/order stability, the 64-guide cap, malformed/stale/transaction/persistence rollback, reopen and portable transfer. A source-write spy rejects any guide-triggered asset write. Before/after composite/layer/source PNGs, histograms, sampled colors, generation snapshot PNGs, flattened PNG and PSD binary data are byte-identical. Malformed canonical bundle metadata rejects before publishing assets. The official MCP test verifies discovery, strict transport arguments, one-step history, geometry and portable state.

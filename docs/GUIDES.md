# Rulers, document guides and Move snapping

Guides help place content precisely without becoming part of the artwork. Prism stores up to 64 horizontal or vertical guides in each native document. Rulers and guide lines are view overlays: image exports, generation inputs and the limited PSD export contain no guide pixels. Editable `.prism` projects retain the guide list.

The general use of pixel rulers and snapping follows familiar editor workflows; the current native subset is described here rather than claiming all Photoshop guide features. [Adobe rulers](https://helpx.adobe.com/photoshop/using/rulers.html), [Adobe snapping](https://helpx.adobe.com/photoshop/using/positioning-elements-snapping.html).

## Editing guides

Use **Layout** in the canvas footer to manage guides. Add a horizontal guide by its y-position, or a vertical guide by its x-position. Positions are whole document pixels, starting at the upper-left. Both canvas boundaries are valid positions. Guides at the same coordinate remain independent entries.

Move an existing guide by editing its position. Its axis and ID remain fixed; add a different guide to change orientation. Delete removes one entry, and Clear removes the list. These edits use normal undo and revision checks and never alter layer contents, masks or source files. This first version uses numeric controls rather than draggable guide handles.

Guides follow document geometry:

- Image resize scales positions proportionally and rounds once to a whole pixel.
- Crop subtracts the crop origin and removes guides outside the new canvas.
- Canvas bounds moves guides by the selected anchor offset and removes those outside the resulting canvas.

Surviving guides retain their IDs and order. Removed guides return with Undo; enlarging later does not independently resurrect clipped guides.

## View and snapping

Ruler visibility, guide visibility and snapping are browser view preferences. Defaults are rulers off, guides shown and snapping off. Showing guides does not automatically enable snapping, and hidden guides do not snap.

Optional Move snapping aligns the displayed movement bounds to nearby guides, using a six-screen-pixel threshold and whole-pixel translations. Edges and exactly representable centers participate; an odd-width half-pixel center is skipped. Hold Alt/Option to bypass snapping for that movement. The same snapped delta is used for the guide preview and the final transform, which remains one undoable edit.

Free Move remains available when snapping cannot predict the displayed boundary reliably. Snapping is disabled for document-anchored layer/ancestor masks, dissolve blending, clipping-chain participants, contextual unprotected generated layers, or initial bounds touching a canvas edge. Snap candidates cannot move the current bounds outside the canvas. These restrictions also account for bounds that include outside styles. Changing zoom, layout or scroll position during a drag cancels the captured movement instead of applying stale coordinates.

This milestone does not include guide dragging, guide-layout grids, smart guides between objects, snapping other drawing tools, physical-unit rulers or the distance/angle measurement tool.

## MCP

All guide commands use `backend:'native'`, `documentId`, optional `expectedRevision` and normal mutation retry IDs. They also work inside a transaction.

| Command | Additional fields |
| --- | --- |
| `prism_add_guide` | `axis:'horizontal'|'vertical'`, integer `position` |
| `prism_update_guide` | `guideId`, integer `position` |
| `prism_delete_guide` | `guideId` |
| `prism_clear_guides` | None |

Read `document.guides` for stable IDs and current positions. Horizontal positions are 0..height; vertical positions are 0..width, inclusive. Capabilities expose `guideAxes`, `guideCoordinates:'document-pixels'` and `limits.maxGuides:64`. Invalid positions, malformed portable metadata and failed transactions leave the published document unchanged.

Design details and verification are tracked in [native guide design](GUIDES_DESIGN.md) and [UI coordinate design](GUIDES_UI_DESIGN.md). Browser checks run with `npm run test:guides-browser`.

# Linked Perspective

Linked Perspective adds paired corner movement to the existing Distort editor. Move one corner horizontally or vertically and its paired corner moves by the opposite amount. It works with the current quadrilateral, including a rotated or skewed one, without rebuilding it as a rectangle.

Verified on September 19, 2026 with 1,218/1,218 automated tests, 67 focused and adjacent browser workflows, and a successful production build. Shared, native, official MCP and independent client checks cover exact paired coordinates, saved stages, undo, original pixels and delayed-response ownership. See [the numerical contract](LINKED_PERSPECTIVE_DESIGN.md), [independent review](LINKED_PERSPECTIVE_REVIEW.md) and [controls design](LINKED_PERSPECTIVE_UI_DESIGN.md).

## Edit a pair

Open **Distort layer** and choose **Horizontal perspective** or **Vertical perspective** under **Corner movement**. Free corners remains the default. Horizontal movement changes X; vertical movement changes Y. The axes belong to the selected transform stage, even when its corners already form a skewed shape.

Drag a corner to move its pair, or select a corner, enter a signed **Delta X/Y, px**, and choose **Move pair**. Enter in the delta field performs the same action. Move pair changes the local draft and resets the delta to zero. **Apply distortion** saves the displayed corners as one undoable edit. The original eight coordinate fields continue to edit independently in every mode.

An unapplied nonzero or incomplete delta blocks Apply and mode/corner/stage switching. Use Move pair or **Clear delta** first. Clear delta keeps the current corners and remains available when editing access is unavailable or the document revision is stale, as long as no drag or command is pending. **Reset rectangle** and **Revert draft** reset both the corner draft and delta. Closing the editor deliberately discards local drafts. Successfully removing a saved stage also clears its pending delta; a refused removal retains the draft.

Canceling a drag restores its captured draft. A view, document or capability change cannot redirect that drag to another target. A zero displacement preserves the exact draft strings. Each pointer event starts from the original captured corners, so extra intermediate events do not accumulate movement.

Horizontal pairs are Top left ↔ Top right and Bottom right ↔ Bottom left. Vertical pairs are Top left ↔ Bottom left and Top right ↔ Bottom right. The other six coordinates stay unchanged. These are stage-axis rules, not camera calibration or automatic perspective correction.

## Bounds and saved stages

The helper accepts displacement up to twice the advertised corner limit. A larger pointer displacement cancels the drag and restores its baseline. A larger typed value stays unapplied and invalid.

A permitted displacement can still put one or both resulting corners outside the native bounds. Both numbers remain visible in the draft; neither is clamped. Correct the independent fields or use Reset/Revert before applying. Crossed or unstable quadrilaterals are refused by the existing native validator without changing the saved document.

New and trailing transform stages have canvas handles. Earlier stages remain editable numerically in their own frame, including Move pair. Apply updates that historical stage and retains later transforms. The guide shows a draft polygon; raster pixels update only after Apply. Pixels outside the fixed stage frame are clipped under the existing [Distort rules](DISTORT.md).

Source filters, masks, Fill, styles, protection and original files keep their existing behavior. Protected layers require explicit unprotection before changing geometry. Undo and editable `.prism` projects retain ordinary Distort corners. No new transform record, render algorithm, capability or MCP command is introduced.

## MCP

Use the existing `prism_add_layer_distort` or `prism_update_layer_distort` with the complete four corners, in TL/TR/BR/BL order. Capture the current stage and revision first. For a horizontal move, partner indices are `[1,0,3,2]`; vertical partners are `[3,2,1,0]`.

Compute the selected coordinate as `originalSelected + delta` and its partner as `originalPartner - delta`, from the same captured quad. Keep the other six coordinates. Submit `corners`, not a mode or delta argument. JavaScript binary64 arithmetic is the declared authoring rule; midpoint equality and reversibility are not promised beyond its ordinary rounding. The existing native sampler and geometric checks remain authoritative.

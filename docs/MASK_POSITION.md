# Move an additional layer mask

Available in the native editor and MCP. Native, independent and MCP checks pass, together with eight focused browser workflows and four adjacent browser suites.

Independent mask positioning moves an existing layer mask while the image stays fixed. It preserves the original mask definition and its coverage outside the canvas, so moving it away and back restores the same coverage. It works on content, group and adjustment masks, including protected layers. Source image pixels and subject-cutout alpha remain separate and unchanged.

In **Layers → Layer mask → Mask position**, enter **X, px** and **Y, px**, then choose **Apply position**. Positive X moves right; positive Y moves down. Values are absolute integer offsets from the retained mask frame, limited to −16,384 through 16,384. Typing alone makes no edit. Image transforms do not move this mask automatically.

**Reset position** returns the retained frame to offset zero. It does not undo a crop or remove clipping introduced by changing canvas bounds. After those operations, a mask can remain positioned even at zero. **Inspect coverage** shows the saved mask; Raw includes feather/inversion/clipping, and Effective also includes density.

## Positioning and rasterizing

**Rasterize mask position** converts current-canvas raw coverage into an ordinary 8-bit mask. It discards coverage outside the canvas and incorporates feather/inversion into the mask pixels. Density remains separately editable. It does not remove or recolor any image pixels. Undo restores the full retained mask.

Continuous geometric coverage is rounded to the nearest mask byte, so rasterizing is not promised to preserve every composited RGB byte. The raw grayscale preview retains the same sampled bytes. This is an explicit precision conversion, not a source-image edit.

| Operation | Effect on a positioned mask |
| --- | --- |
| Move its X/Y | Retains its source frame and all existing coverage; no pixel sampling. |
| Change feather or inversion | Edits the retained source without changing position. |
| Change density | Changes final mask strength; position and source remain editable. |
| Crop | Shifts the frame by the crop origin; visible coverage remains exact and off-canvas source remains retained. |
| Change canvas bounds | Translates the frame and clips retained support to the old/new canvas overlap. New padding has zero raw mask coverage. Some hidden coverage cannot return after a later move; Undo restores it. |
| Paint or reshape the mask | Rasterizes its raw current-canvas coverage as part of that explicit edit. Discards off-canvas coverage and retains density. One edit, one undo step. |
| Scale the image | Requires rasterizing every positioned mask first, including hidden masks and masks at density zero. |
| Replace or remove the mask | Clears position and follows the existing density-reset behavior. |

These rules apply to the additional layer mask. Source transparency and extracted subject alpha do not become part of it. Loading the mask as a selection uses its saved positioned coverage; loading content transparency continues to ignore the additional mask.

## MCP

Inspect the current document and native capabilities. Require `layerMaskPositioning:'independent-translation'`, `layerMaskPositionUnits:'document-pixels'`, and the corresponding entry in `layerMaskPositionOperations`.

Move the mask using `prism_set_layer_mask_position`:

```json
{
  "backend": "native",
  "documentId": "DOCUMENT_ID",
  "expectedRevision": 12,
  "layerId": "LAYER_ID",
  "x": 35,
  "y": -12
}
```

Call `prism_apply_layer_mask_position` with the same document/layer fields and its latest revision to perform **Rasterize mask position**. Both commands support `prism_apply_transaction`; an explicit rasterize-then-resize transaction can commit as one undo step. They require an existing mask; rasterizing additionally requires a positioned mask. A stale revision rejects instead of silently rebasing.

The persisted mask contains one retained source descriptor and frame, its offsets and optional bounds clip. Call the dedicated commands to change its position; do not send that internal descriptor as a public selection or replacement mask. Selections continue to use their ordinary mask format.

## Files and limits

Undo, reopening and `.prism` transfer preserve the retained frame and source. Older Prism readers reject the unfamiliar mask shape rather than silently displaying it at the wrong location. Keep a current editable project when sharing rasterized copies.

Supported PSD export samples effective mask coverage into the current-canvas PSD mask. Its exact-byte compatibility check still applies. The export report identifies omitted independent positioning and off-canvas mask data; the native mask stays unchanged.

Retained source masks remain limited to 8,192 pixels per axis and 24 megapixels, even after a tiny crop. Resource checks use those retained dimensions. Positioned documents reserve callback buffers alongside the existing group/filter/clipping scratch budget; mask inspection, selection loading, rasterization and PSD export also check their own operation buffers. These bounds account named buffers, not whole-process memory or codec internals.

This first version provides independent integer translation. Linked transforms, mask rotation, mask scaling and subpixel positioning remain outside its scope. See [the exact geometry and precision contract](MASK_POSITION_DESIGN.md) and [independent review](MASK_POSITION_DESIGN_REVIEW.md).

Verification: owner10, independent10, schema2 and official MCP1 checks pass. The full Node suite at this milestone passes **701 tests**; production build and doctor pass with92 native commands. Browser checks cover eight positioning workflows plus density3, inspection4, morphology3 and canvas4 regressions. They verify exact masks/source bytes, explicit resize recovery, partial capabilities and stale responses with zero model/provider calls. Resource-boundary checks reject before large allocations, including over-budget intermediate transactions and PSD preparation.

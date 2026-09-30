# Layer Fill

Layer Fill fades a layer's contents while keeping its outside outline, shadow and glow. Overall Opacity fades both the contents and those styles. The setting is available for raster, solid, text, shape, path and gradient layers. It is separate from a shape's fill color; a shape's intrinsic stroke fades with its contents.

Implemented on September 19, 2026. The full 1,206-test suite passes, including four official MCP workflows and three schema checks. All 67 focused and adjacent browser workflows and the production build pass. See [the implementation design](LAYER_FILL_DESIGN.md), [independent review](LAYER_FILL_DESIGN_REVIEW.md) and [API contract](LAYER_FILL_MCP_DESIGN.md).

## Use the controls

Select a content layer in the Layers panel. Enter a percentage in **Fill**, then choose **Apply Fill** or press Enter. Decimal values are retained precisely. Leaving the field does not apply a draft. **Reset to 100%** changes the draft; Apply commits it as one Undo step.

If the document changes while you are drafting, use **Reload saved Fill** before applying. A lost connection or changed selection does not send the pending edit to another layer. Unsupported connections leave saved values readable.

At 0% Fill the body disappears, but enabled outside styles can remain. They keep the original unfilled silhouette: a shadow does not appear inside the former body, and no inner effect is introduced. At 0% overall Opacity both body and decoration disappear.

Groups and global adjustment layers have no Fill setting. Clipping-chain bases and members currently require 100% Fill; release the chain before using another value. A protected layer retains its existing Fill. Explicitly unprotect it before changing that value.

## MCP workflow

Read the native capabilities and the current document first. Require `layerFillPolicy:'content-alpha-outside-effects-v1'`, the selected content type in `layerFillContentTypes`, and `set_layer_fill` in the command list.

```js
prism_set_layer_fill({
  backend: 'native',
  documentId,
  expectedRevision,
  layerId,
  fillOpacity: 0.375,
  requestId: 'stable-id-for-this-edit'
})
```

`0.375` means 37.5%. The finite scalar is required, with a positive current revision. Related operations may use `prism_apply_transaction` with the revision on the enclosing transaction, for one commit and Undo. Keep the same request ID when inspecting an uncertain outcome; do not blindly submit a second edit.

Original assets, alpha, masks, filters and transforms remain editable. Body compositing multiplies overall Opacity by Fill before the existing blend operation and rounds only at the existing final pixel stage. Outside styles receive overall Opacity. This is the declared native policy across existing blend modes; it does not reproduce Photoshop's special Fill behavior for selected blend modes.

## Source, display and reuse

Displayed previews, flattened exports, composite channel selections, composite retouch sampling and generation snapshots include Fill. Original-source inspection and content-transparency selections keep measuring the original source independently of Fill. A zero-Fill body has no body bounds for alignment, even when its outside styles remain visible.

Placement uses the unfilled source silhouette and retains Fill and overall Opacity separately. A zero-Fill styled layer therefore remains placeable. Rasterizing a vector keeps its unfilled body recoverable, with Fill still editable. Baking source filters retains Fill as a display setting. Ordinary pixel painting keeps the setting too.

Saved layer styles capture only outside decoration. Applying or clearing styles retains the target's Fill. Existing edit recipes retain Fill but do not capture or author it in this version.

Protection freezes the chosen Fill. With Fill 0, the body contributes no protected area, while visible outside decoration stays protected. Any positive Fill retains the conservative original-alpha protection rule, including extremely small values whose displayed alpha rounds to zero. Generation remains clipped locally using that saved protection.

Editable `.prism` projects, autosave and Undo retain Fill. Flattened PNG/JPEG/WebP/TIFF exports render it. The current layered PSD subset reports `FILL_UNSUPPORTED` for nonunit Fill, so it cannot silently discard or fold the setting into ordinary opacity. Older Prism readers reject nonunit Fill records; they cannot safely reopen such a project by ignoring the setting.

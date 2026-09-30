# Reusable outside layer styles

Save an outline, shadow and glow as a named style, then apply that combination to other content layers. Styles belong to the document and travel with its `.prism` project. Up to 32 styles can be saved.

In the Layers panel, expand **Saved layer styles**. Select the source layer and save its current outside settings. Choose a saved style to apply it to the selected layer or to the actual checked content layers when selecting several layers. Groups and adjustment layers are not style targets. Hidden and protected content layers can supply or receive styles.

Application replaces the target's outline and effects together. A saved shadow-only style therefore clears an existing outline and glow. It leaves the source image, alpha, masks, filter stack, geometry, opacity, blend mode and protection unchanged. The same outside-only renderer excludes occupied subject pixels and lower protected content. Applying to several targets creates one undo step.

Saved styles are independent copies. Editing a source layer later does not change its saved style. Overwriting, renaming or deleting a saved style does not restyle previous targets. Use **Apply** again when you want the updated settings. Width, blur and shadow offsets remain in canvas pixels; resizing the document does not scale the saved library.

Saving requires a nonzero outline or an enabled shadow/glow setting. A reusable setting need not produce visible decoration on every source: a full-canvas opaque layer, hidden layer or zero-offset unblurred effect may have no visible outside pixels. Saving does not render or alter the source image.

## MCP contract

All four commands use the normal `backend:'native'`, `documentId`, optional `expectedRevision` and retry `requestId` fields. They also work inside an atomic transaction. Inspect `document.layerStyles` for saved IDs and settings.

| Command | Additional arguments | Result |
| --- | --- | --- |
| `prism_save_layer_style` | `layerId`, optional `name`, optional `styleId` | Creates a saved copy, or overwrites an existing ID. Overwrite retains the name unless supplied and remains available at the 32-style cap. |
| `prism_apply_layer_style` | `styleId`, `layerIds` | Replaces both style slots on 1–64 unique content targets, after validating every target. |
| `prism_rename_layer_style` | `styleId`, `name` | Renames a preset without changing its ID or applied layers. |
| `prism_delete_layer_style` | `styleId` | Removes the saved entry; applied layers retain their settings. Undo restores the entry. |

The capability fields are `layerStyleProperties:['outline','shadow','glow']` and `limits.maxLayerStyles:32`. No filter, mask, opacity, blend mode or source image is stored inside a style. This is a document-local Prism library, not Photoshop `.asl` compatibility or linked live styles.

Portable imports validate the library before publishing assets. Invalid targets, malformed metadata, stale revisions and failed persistence leave the published graph unchanged. See [independent audit](STYLE_PRESET_AUDIT.md) for protection, copy and rollback evidence. Legacy native fractional outline values remain loadable, but a preset capture must use the public integer 0–64 width contract.

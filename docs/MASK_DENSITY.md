# Additional layer-mask density

Use **Layers → Layer mask → Density** to reduce how strongly an existing layer mask hides the image. The control applies to content, adjustment and group masks. Enter a percentage or use the slider, then choose **Apply mask density** for one undoable edit.

At 100%, the mask behaves normally. At 50%, black mask areas reveal half of the existing content; white mask areas stay fully visible. At 0%, this additional mask stops hiding content. The original image, source cutout alpha and layer opacity are separate: density cannot restore transparent source pixels or pixels removed by an earlier destructive crop.

Feather and inversion are evaluated before density. Density also applies after the mask's internal canvas clip, so reducing it may reveal existing pixels outside the mask's previous clipped area. Generated content still respects protected people and the hard exclusions applied when the generation was installed.

## Edit and save

Painting or reshaping the mask changes its stored coverage and retains density. Replacing the mask, making a new mask from selection or removing the mask resets density to 100%. Duplication, rasterization and canvas geometry retain the setting. Proportional placement samples the visible result and bakes that coverage into the newly placed cutout alpha.

Density survives undo, reopening and portable `.prism` projects. Active selections, saved selections and the original source-alpha preview have no density property. The control does not write new source image assets.

## MCP

Check `layerMaskProperties` in native capabilities, then use the existing refinement command:

```js
prism_modify_layer_mask({
  backend: 'native',
  documentId,
  expectedRevision,
  layerId,
  density: 0.5
})
```

The value must be finite and between 0 and 1. A layer must already have an additional mask. The saved scalar is `layer.maskDensity`; omission means 1. Never put `density` or `maskDensity` inside a mask descriptor. Feather and inversion may be changed in the same command.

The effective coverage is `1 - density * (1 - rawCoverage)`. Painting and morphology operate on raw coverage before this formula, so density is not baked twice. Protection uses the resulting visible footprint, including newly revealed source pixels.

The implementation evaluates interior density in byte units to avoid floating-point half-byte rounding errors. Forward and inverted bitmap masks recover their already-quantized raw byte before density; geometric coverage stays continuous. This corrects some fractional-density results by one alpha level. Density zero and one retain their exact existing behavior.

## PSD export

The limited PSD exporter writes the effective coverage into an editable alpha8 mask. Density, feather and inversion become mask pixels in that copy; `.prism` retains the separate editable settings. Export requires every resulting coverage to be exactly representable: a half-density black mask is 127.5/255 and rejects, while some binary masks at density 128/255 can be represented exactly. Compatibility inspection reports the result before export.

See [PSD export limits](PSD_EXPORT.md) and the [coverage and implementation contract](MASK_DENSITY_DESIGN.md).

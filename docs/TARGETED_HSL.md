# Targeted Hue / Saturation

The native **Hue / Saturation** adjustment provides one Master row and six color ranges: Reds, Yellows, Greens, Cyans, Blues and Magentas. Each row retains Hue, Saturation and Lightness controls. It works as a global adjustment or editable raster filter, separately from the existing scalar Hue, Saturation and Vibrance tools. Native, MCP and browser workflows are verified.

## Controls

Hue is −180 to 180 degrees. Saturation and Lightness are −100 to 100 percent. All controls accept exact 0.01-unit increments and default to zero. Choose a range to inspect its three values; switching ranges retains every other row. **Reset range** clears only that row, and **Reset all ranges** clears all seven. Resets stay local until Apply and retain filter blend, opacity and masks.

All ranges use the colors entering the adjustment or filter. Adjacent ranges overlap: orange can receive both Reds and Yellows. Master and named corrections combine from those original colors, so changing Master Hue does not reclassify a pixel for the other controls.

- **Hue** rotates the color around the hue wheel. A +120° Master shift turns pure red into green.
- **Saturation** scales the current HSL saturation. At full influence, +100% doubles it up to its limit; it does not set every color to maximum saturation. −100% removes saturation. Exact gray remains gray under Hue/Saturation.
- **Named Lightness** fades when original RGB chroma is low, avoiding large brightness changes from tiny neutral color differences. Dark, pale and nearly gray colors therefore receive weaker named Lightness changes. Its ±100% endpoints need not reach white or black.
- **Master Lightness** is unweighted and affects neutral colors too. Its full endpoints reach white or black; it can reveal tiny existing color differences near those endpoints.

Full desaturation produces HSL-lightness gray, which differs from Rec.709 grayscale: pure red255 becomes gray128. This is a conventional encoded-RGB HSL control, without perceptual exposure correction, Colorize, automatic color detection or adjustable range handles. Adobe documents the broader [Hue/Saturation workflow](https://helpx.adobe.com/photoshop/desktop/adjust-color/color-corrections/apply-a-hue-or-saturation-adjustment.html); Prism uses its own fixed numerical policy and does not claim identical Photoshop pixels.

## Editing, scope and retained settings

The shared editor retains all 21 precise text drafts. An incomplete value in a hidden range blocks Apply and identifies that range. Range inspection remains available when a saved entry is read-only; unsupported execution does not silently replace its settings. Local resets and numeric editing retain their appropriate protection/capability guards. Range inspection also stays available during a pending Apply while editing controls remain disabled.

Global adjustments use their captured selection or explicit mask and lower protected-content exclusions. Source filters run before geometry: candidate RGB, entry blend, filter opacity, then the completed stack's effect mask. Additional visibility masks and layer compositing keep their existing positions. Both new paths preserve alpha and hidden alpha-zero RGB. Original assets remain intact.

Zero controls produce an identity candidate, but a nonnormal source blend can still change pixels. Nonzero rows that cancel also remain active entries. Existing protection, source-edit and Bake guards continue to apply. Explicit Bake retains original assets, cutout alpha and geometry, and Undo restores the editable stack.

Partial MCP updates replace each supplied complete tuple and retain omitted rows. Saved recipes contain all seven effective rows, so a default recipe resets previous nonzero settings. Recipe append retains a destination's shared effect mask. Project reopening and `.prism` transfer preserve native settings; this adds no PSD adjustment serialization.

## MCP example

Require Native, `hueSaturationPolicy: 'rgb-hue-triangle-hsl-v1'`, a complete `hueSaturationRanges` list containing all seven rows, and the context's advertised kind and individual command. Source filters also require `layerFilterCoordinates: 'source'`.

Call `prism_add_layer_filter` with current IDs and revision:

```json
{
  "backend": "native",
  "documentId": "current-document-id",
  "expectedRevision": 3,
  "layerId": "current-raster-layer-id",
  "kind": "hue_saturation",
  "value": 0,
  "parameters": {
    "reds": [-8, -10, 3],
    "yellows": [-6, 5, 0]
  }
}
```

Every row is `[Hue degrees, Saturation percent, Lightness percent]`. For a global layer use `prism_add_adjustment` and omit `layerId`. A later `prism_update_layer_filter` can supply the saved `filterId` and `parameters: {"master":[0,15,0]}` while retaining the other rows. Inspect the actual preview after Apply. The optional legacy Photoshop bridge rejects this native family; no generation or API key is involved.

## Precision and limits

The selected policy uses fixed hue triangles for Hue/Saturation and chroma-attenuated named Lightness, with proportional saturation. Its finite integer setup and fixed binary64 conversion order are defined in [the evaluation](TARGETED_HSL_EVALUATION.md) and checked in [independent review](TARGETED_HSL_REVIEW.md). Candidate bytes round once after conversion. Some exact mathematical half ties fall one byte lower under the declared native operation order; no epsilon or per-pixel rational fallback silently changes those results. Exact identity, gray and corrected black/white branches are pinned separately.

An enabled computing source entry costs 32 weighted visits per source pixel; all 21 authored controls zero costs one, and disabled/opacity-zero costs none. Nonzero cancellation still costs32. A nonnormal blend adds40, and an evaluating shared effect mask adds8. Under the existing384-million source budget, one Normal entry reaches12MP; with a mask it reaches9.6MP, before other limits. These are admission ceilings, not render-time promises. Global adjustments retain the current frame limits and cooperative scheduling.

Computing batches visit at most65,536 pixels before yielding, with a stricter16,384 limit for nonnormal source blending. The helper adds no asset, image-sized cache or neighborhood plane. Allocation, decoding and other render phases remain outside that loop bound. Native editing remains full-frame, 8-bit sRGB.


## Verification

Thirty new native, independent, schema, official MCP SDK and client-helper checks pass within the full 1,046-test suite. Eight focused and 67 adjacent browser workflows pass with the production build. Actual photo exports agree byte for byte with the independent declared-order reference, and original files remain unchanged. See [browser and visual evidence](TARGETED_HSL_UI_DESIGN.md).

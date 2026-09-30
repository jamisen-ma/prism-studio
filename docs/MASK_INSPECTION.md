# Inspect selection and layer-mask coverage

Choose **Select → Inspect coverage** for the active selection, or **Layers → Layer mask → Inspect coverage** for an additional mask. The grayscale viewer is read-only: it does not change the selection, active layer, image pixels or undo history.

White means full coverage, black means none, and gray means partial coverage. Feather, inversion and internal canvas clipping are evaluated. An empty selection displays black; no active selection is a separate state with nothing to inspect.

For a layer mask, choose **With density** or **Before density**. Both include the mask's feather and inversion; only the density setting differs. At zero density, With density displays white across the canvas. Content, group and adjustment masks are supported.

This view is independent of source transparency, layer opacity, visibility, parent masks, clipping chains and protected-pixel enforcement. White does not grant permission to alter a protected person. The cutout panel's existing **Mask** view shows original source cutout alpha, which is separate from this additional mask.

## Preview size and freshness

Preview size limits the longest edge, up to 2400 pixels, without enlarging a smaller mask. **Fit** changes the display scale; **100% preview pixels** displays the sampled image at its own size. The caption shows preview dimensions, canvas dimensions and the inspected revision.

Reduced previews use nearest pixel-center sampling. They preserve sampled gray values but can omit fine details between sampled pixels. The viewer is not a full-resolution mask export.

Changing source options requests a new preview. If the document changes, the old preview becomes stale; choose **Refresh coverage** to inspect current metadata and coverage. Late responses cannot replace a newer target. Refresh reads the mask independently and does not require a successful RGB composite render.

## MCP

```js
prism_get_mask_preview({
  backend: 'native', documentId, expectedRevision,
  source: 'selection', maxEdge: 700
});

prism_get_mask_preview({
  backend: 'native', documentId, expectedRevision,
  source: 'layer-mask', layerId,
  maskMode: 'effective', maxEdge: 1400
});
```

The tool returns a PNG image block and metadata identifying its document, revision, source, dimensions and sampling method. `layerId` and `maskMode` apply only to a layer-mask source. Omit them for an active selection. `maxEdge` must be an integer from 32 to 2400; its default is 700. An optional expected revision rejects stale reads.

Capabilities advertise `maskPreviewSources`, `maskPreviewMaskModes` and the preview limits. The command is read-only and cannot be included in an edit transaction. It writes no assets and does not invoke segmentation, image generation, an RGB renderer or the composite-preview cache.

## Precision and limits

Native-size samples use rounded eight-bit coverage, encoded as opaque grayscale PNG. All 256 gray values are retained. Output dimensions use exact rational half-up rounding; source positions use the center of each output pixel. The source mask itself is never rescaled or changed.

The encoded image is capped at 8 MiB. Explicit preview buffers and transfer copies have a conservative 256 MiB accounting budget; this excludes JavaScript graph/row-cache metadata and native-library caches, and is not a total process-memory guarantee. Bitmap feather preparation still performs bounded synchronous passes; sampling yields periodically.

The shared mask-density calculation also corrects floating-point half-byte rounding on forward and inverted bitmap masks. Existing fractional-density renders may consequently improve by one alpha level at those ties. Default/full-density and disabled-mask behavior are unchanged; geometric feather coverage remains continuous until final sampling.

See [mask density](MASK_DENSITY.md), [loading selections from layers](LAYER_SELECTIONS.md) and the [implementation contract](MASK_INSPECTION_DESIGN.md).

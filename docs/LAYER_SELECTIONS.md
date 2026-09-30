# Selections from layer transparency and masks

Use **Select → From a layer** to reuse a cutout edge, a text or shape silhouette, or an existing additional layer mask. This is deterministic editing: it does not run a segmentation model or generate new pixels.

Choose the source layer, a source, the combination mode and optional **Invert source before combining**, then **Load from layer**. One action is one undo step. The original image, layer settings and saved-selection library stay unchanged. Save the loaded result separately if you want to reuse it later.

| Source | What becomes selected |
| --- | --- |
| Content transparency | The layer's transformed working alpha, including separate source cutout alpha. Works with raster images, solids, text, shapes, paths and gradients. |
| Layer mask, With density | Its own additional mask, with current feather, inversion, canvas clipping and density evaluated. Available on content, groups and adjustments with a mask. |
| Layer mask, Before density | The same additional mask coverage before density. Feather, inversion and canvas clipping are still evaluated. |

Content transparency ignores layer visibility, opacity, additional masks, outside effects, parent settings and clipping-chain coverage. A hidden or opacity-zero layer can still provide its full source silhouette. RGB-only filters are skipped. This is the source transparency, not the layer's visible contribution to the final composite. Groups and adjustments have no individual content transparency, but their own masks remain available.

Additional masks use canvas coordinates independently of the source image's alpha and transforms. Density zero produces a full-canvas selection in **With density** mode; **Before density** retains the mask's concealed region. The existing cutout **Mask** preview shows source cutout alpha, which is a different source.

## Combine and invert

Source coverage becomes an eight-bit mask first. Invert then replaces each byte with `255-byte`, before combining it with the active selection. This preserves soft edges: at half coverage, byte 128 inverts to 127.

| Mode | Result |
| --- | --- |
| Replace | Use the incoming coverage. |
| Add | Take the greater coverage at each pixel. With no active selection, behave as Replace. |
| Subtract | Multiply the active coverage by the inverse of the incoming coverage. Requires an active selection. |
| Intersect | Multiply the two coverages. Requires an active selection. |

Combination bakes active feather/inversion/clipping once into the resulting bitmap. These are Prism's defined operations; they do not claim identical Photoshop rounding.

An **Empty selection** is still active: selected edits affect no pixels. Clear the selection explicitly to return to unrestricted editing. Saving or loading an empty bitmap never silently clears it. Loading transparency also cannot bypass protected pixels or the hard exclusions applied to generation.

## MCP

```js
prism_load_layer_selection({
  backend: 'native', documentId, expectedRevision, layerId,
  source: 'content', mode: 'replace', requestId: 'load-cutout-edge'
});

prism_load_layer_selection({
  backend: 'native', documentId, expectedRevision, layerId,
  source: 'layer-mask', maskMode: 'effective',
  mode: 'intersect', invert: false, requestId: 'intersect-layer-mask'
});
```

Read the current document revision before each edit. Omit `maskMode` for a content source; supplying it rejects. Use the same request ID and arguments when retrying an uncertain response within the companion session. The operation also works in `prism_apply_transaction`, for example loading transparency and saving its selection together as one history entry.

Capabilities advertise `load_layer_selection`, `layerSelectionSources`, `layerSelectionMaskModes` and `layerSelectionContentTypes`. The operation does not require the optional segmentation model or an image provider.

The current source-geometry pipeline clips at canvas stages. Later transforms cannot recover source pixels clipped at an earlier stage. The loaded selection is an independent snapshot: later source, mask or density changes do not update it automatically. Undo, reopening and portable `.prism` files preserve it.

Native dimension, bitmap-complexity and project-metadata limits apply. A separate 256 MiB accounting limit covers selection/render binary buffers and can reject a large transformed source even when its document is within the 24 MP canvas limit. This is not a total process-memory guarantee. Sampling, combination and run encoding yield periodically; existing bitmap-feather preparation is still synchronous. Source loading relies on the native renderer's immutable internal assets.

See the [exact implementation contract](LAYER_ALPHA_SELECTION_DESIGN.md) and [UI behavior](LAYER_ALPHA_SELECTION_UI_DESIGN.md).

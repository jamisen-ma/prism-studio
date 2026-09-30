# Resize image pixels

Image resizing changes the dimensions of the whole document and adds a retained geometry step to each content layer. Originals stay intact, and Undo restores the previous dimensions and appearance. Canvas bounds is a separate operation that adds or removes visible space without rescaling image pixels.

Open **Image → Scale image**, enter Width and Height, choose **Resampling method**, then **Apply dimensions**. Use **Match original aspect ratio** for proportional dimensions. The native editor offers four methods:

| Method | Behavior |
| --- | --- |
| Nearest neighbor | Copies a pixel-center sample without blending. Useful for pixel art and hard pixel edges; reducing an image can omit fine details. |
| Cubic | Uses cubic reduction and enlargement. |
| Mitchell | Uses Mitchell reduction and cubic enlargement. |
| Lanczos3, default | Keeps Prism's existing Lanczos3 reduction and cubic enlargement. |

The three photographic choices can produce identical results when enlarging. When one dimension shrinks and the other grows, the shrinking dimension uses the selected reduction method. This follows the installed [Sharp resize behavior](https://sharp.pixelplumbing.com/api-resize/). No automatic sharpening, new details or AI enhancement is added. These controls do not reproduce Adobe's additional [specialized resampling options](https://helpx.adobe.com/photoshop/desktop/crop-resize-transform/resize-adjust-resolution/resampling-options.html).

## Exact nearest sampling

For destination pixel `(x,y)`, Nearest samples:

```text
sourceX = floor((2*x + 1) * oldWidth  / (2*newWidth))
sourceY = floor((2*y + 1) * oldHeight / (2*newHeight))
```

All four RGBA bytes are copied literally, including RGB under zero alpha and partial-alpha values. This promise applies to the pixels entering that geometry step. Decoding, previous transforms, editable filters, masks and final compositing still follow their own rules. Prism implements this copy directly because the installed Sharp nearest path can change hidden and low-alpha RGB during premultiplication.

Successive resize steps run in saved order. Shrinking and then enlarging cannot reconstruct samples discarded by the earlier step. Undo can restore the earlier geometry; retaining an original file does not make every later resize sample that original directly.

## Layers, masks and protection

Source filters and separate cutout alpha are evaluated before geometry. The chosen image method resamples their resulting RGBA once. Additional bitmap masks and bitmap selections keep their existing pixel-center nearest sampling regardless of the image method; geometric masks and selections scale their coordinates. Feathering retains the existing smaller-axis scale rule, and mask density remains separate. Guides keep their IDs and proportional integer rounding.

Positioned additional masks require an explicit **Rasterize mask position** before changing image dimensions. That action fixes current canvas coverage to alpha8 and discards off-canvas support. Your dimension text and method choice remain saved while you review masks; **Return to resize** restores that draft against the current revision. Reviewing a mask does not automatically resize the document. Hidden masks and masks at zero density still count.

Protected content allows proportional dimensions, including the existing half-pixel rounding tolerance. Changing its proportions rejects even when it is hidden or fully masked. Ordinary proportional resampling can change sampled colors; protection does not make interpolated enlargement a byte copy. Nearest has the narrower sampling guarantee above.

Text, vectors and gradients render at their retained source dimensions before resampling. Their editable typography and source coordinates remain unchanged; resizing is not text reflow or a font-size edit. Layers, groups and clipping chains remain separate. Styles retain their existing document-pixel units.

## MCP

Inspect `documentResizeMethods` and `documentResizeDefault` in native capabilities, then use the current document revision:

```js
prism_resize_document({
  backend: 'native',
  documentId,
  expectedRevision,
  width: 1200,
  height: 1600,
  resample: 'lanczos3'
})
```

`resample` accepts `nearest`, `cubic`, `mitchell` or `lanczos3`. Omission and explicit Lanczos3 use exactly the previous default path and persisted transform. Unknown values reject. The optional Photoshop bridge accepts only its legacy request with `resample` omitted.

Resize is one undoable metadata edit and supports `apply_transaction`. A positioned-mask rasterization and resize can be explicit steps of one transaction; a later failure discards the whole edit. Source image files are not rewritten. Saved nondefault methods persist in `.prism` copies and after reopening; older readers reject the new transform type instead of silently choosing another method. PNG and other native exports render the chosen method. Supported PSD copies contain rendered geometry, subject to their existing compatibility checks.

## Limits

Each source and geometry stage retains the limits of 8192 pixels per axis and 24 million pixels, with at most 500 retained transforms per content layer. The nearest helper allocates one output RGBA frame and yields within every 65,536 output pixels. Its input and output can occupy 192,000,000 bytes together at the stage limits; other renderer frames may coexist. This is not a whole-process memory or response-time guarantee. Source-filter work remains based on retained source size, even after a large image is displayed smaller.

See [implementation design](RESIZE_RESAMPLING_DESIGN.md), [independent review](RESIZE_RESAMPLER_REVIEW.md) and [current verification status](IMPLEMENTATION_STATUS.md).

# Channel Mixer and Gradient Map

These native tools provide editable color changes as adjustment layers or raster-filter entries. Both preserve alpha and original image files. They operate on 8-bit encoded sRGB pixels, with declared native math rather than Photoshop algorithm parity.

## Choosing the scope

Use the color workbench under Adjustments to add an adjustment layer. It sees the composite below it and captures the active selection as its mask. Editing the layer later keeps that mask. Its layer opacity controls strength, and lower protected content remains unchanged.

Use Layer filters on an unprotected raster layer to change only that source. Filter order matters; filters run before geometry. The active selection does not scope a raster filter. Each entry has its own enabled switch and opacity, while the layer mask controls final visibility. Originals and separate source-alpha files remain unchanged. Raw source inspection and source-oriented subject selection remain unfiltered while entries remain editable. Explicit [Bake filters](FILTER_BAKING.md) retains the current treatment in working RGB and removes entries; archived originals and separate alpha still remain intact. Clear removes the treatment instead.

Both kinds are available inside the existing isolated-group and content-clipping rules. They do not introduce clipped adjustment layers or a new way to modify protected source pixels.

## Channel Mixer

Choose an output channel and set its Red, Green, Blue and Constant percentages. Each value ranges from −200% to +200% in 0.01% increments. A constant of 100% adds 255 before final clipping. Coefficients need not total 100%; the editor does not normalize them automatically.

Each output reads the same original input channels. For example, Red `[0, 0, 100, 0]` takes blue into the red output. Setting Blue `[100, 0, 0, 0]` at the same time swaps red and blue. A row `[-100, 0, 0, 100]` inverts the original red channel.

Monochrome uses a separate Gray row and repeats its result in all three output channels. Switching monochrome on or off retains your color and gray rows. The defaults are identity color rows and Gray `[21.26, 71.52, 7.22, 0]`.

Percentages compile to exact integer hundredths before processing. The complete signed channel sum is evaluated before clipping and rounding once to an output byte. This keeps cancellation and half-byte ties deterministic within the supported precision. [Adobe's Channel Mixer concepts](https://helpx.adobe.com/photoshop/using/color-monochrome-adjustments-using-channels.html) inform the controls; the gray defaults and arithmetic are the native contract.

## Gradient Map

Gradient Map assigns colors to the image's tones. Add 2–16 color stops with strictly increasing positions from 0 to 1, including both endpoints. Reverse maps dark tones toward the opposite end. The default black-to-white gradient converts the image to grayscale.

The native tone is `(2126 × R + 7152 × G + 722 × B) / 2550000`. It is not rounded to one of 256 bins before sampling the gradient. Unequal and closely spaced stops retain their distinct positions. RGB channels interpolate linearly between neighboring colors in encoded sRGB; output rounds once to bytes. Colors use six-digit hex values.

This version has no opacity stops, dithering, midpoint controls or alternate interpolation modes. Alpha stays unchanged. The controls follow the general [Gradient Map workflow](https://helpx.adobe.com/photoshop/using/applying-special-color-effects-images.html), with explicit native interpolation.

## MCP parameters

Use `value:0` for both kinds. Their parameter objects perform the operation; zero does not bypass these tools.

```js
prism_add_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId,
  kind: 'channel_mixer', value: 0,
  parameters: {
    red: [0, 0, 100, 0],
    blue: [100, 0, 0, 0]
  }
})

prism_add_adjustment({
  backend: 'native', documentId, expectedRevision,
  kind: 'gradient_map', value: 0,
  parameters: {
    stops: [
      { offset: 0, color: '#3b2235' },
      { offset: 0.6, color: '#c88476' },
      { offset: 1, color: '#fff1d5' }
    ],
    reverse: false
  }
})
```

Creation may omit parameters for defaults. Updates use `prism_update_layer_filter` or `prism_update_adjustment` with the existing stable entry/layer ID. Supplied fields merge with current parameters: a four-number row or stop list replaces that whole field; omitted rows, stops and switches stay unchanged. Empty parameters do not clear an existing effect. Invalid families, ranges, precision and malformed stops reject atomically.

Native capabilities expose 24 adjustment kinds and 26 raster-filter kinds, including the separately documented [Color Balance and Black & White](TONAL_COLOR.md), [source Gaussian/RGB sharpen filters](SOURCE_SPATIAL_FILTERS.md), [Unsharp Mask](UNSHARP_MASK.md) and [Add Noise](ADD_NOISE.md). Under Normal blending, the filter work preflight counts three weighted source-pixel visits for Channel Mixer and five for Gradient Map under the existing 384-million limit, including hidden active stacks. An active non-Normal [filter blend](FILTER_BLENDING.md) adds 40 weighted visits per source pixel. Disabled or zero-opacity entries bypass without changing bytes. Existing combined group/chain/filter memory and document limits still apply.

Undo, reopening and editable `.prism` transfer retain the parameters. Strict PSD export rejects adjustment layers and raster-filter stacks; it does not silently bake these controls. The optional Photoshop bridge does not implement these commands for either new kind.

See [the design and acceptance tests](COLOR_MIXER_DESIGN.md). Browser and independent verification status is recorded in [implementation status](IMPLEMENTATION_STATUS.md).

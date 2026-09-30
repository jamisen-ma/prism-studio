# Photo Filter

Status: native, MCP and client integration are implemented. The full regression passes1,140 checks, all99 focused/adjacent browser workflows pass, and the production build succeeds.

Photo Filter adds a chosen color cast through a photographic transmission treatment. It can warm or cool an image, correct a green/magenta cast, or create a deliberate color treatment. It keeps the original raster intact and is designed for both global adjustments and editable source filters.

## Controls

- **Filter color:** any six-digit RGB hex color. The native default is warm orange `#ff9500`.
- **Density:** 0–100%, in0.01% increments. The default is25%. Higher values strengthen the colored transmission;100% does not replace the image with a flat color.
- **Preserve Luminosity:** enabled by default. It restores the original weighted encoded-RGB brightness and reduces chroma together where necessary to fit RGB8. Turning it off allows the filter to darken the image.

Density and layer/filter opacity have different roles. Density changes the treatment itself; opacity mixes its completed result with the prior pixels. Source filters also support the existing entry blend modes. A source effect mask mixes the complete stack before transforms. Global adjustment layers keep Normal blending and their selection or layer masks.

Black stays black. With luminosity preservation, white and pure saturated primary pixels remain unchanged. A gray filter is neutral when preservation is on and attenuates brightness when it is off. If a100% filter removes all occupied color channels, preservation returns the original RGB. These explicit endpoint rules prevent invented colors in a zero-transmission case.

This is an encoded-sRGB RGB8 treatment with a declared native formula. It is not a calibrated Kelvin control, spectral simulation, linear-light luminance correction or promise of Photoshop pixel parity. Final channel rounding can move the preserved weighted brightness by up to half a byte. See [the numerical design](PHOTO_FILTER_DESIGN.md).

## MCP contract

Require native `photoFilterPolicy:'rgb-transmission-luma-fit-v1'`, the context's advertised `photo_filter` kind and its add/update command. Source filters also require source coordinates.

```json
{
  "kind": "photo_filter",
  "value": 0,
  "parameters": {
    "color": "#ff9500",
    "density": 25,
    "preserveLuminosity": true
  }
}
```

Use these fields with `prism_add_adjustment`, or with `prism_add_layer_filter` plus the target raster's `layerId`. Include the current document ID and revision. Existing update tools retain omitted parameters: changing only `color` keeps the saved density and preservation setting. Complete saved recipe settings deliberately reset all three fields when applied.

The integration preserves alpha and hidden transparent RGB, supports Undo and editable `.prism` transfer, and uses ordinary dependency-free recipes. Source Bake retains original image assets and separate cutout alpha. Protected source layers reject filter edits; global adjustment protection follows the existing compositing contract. Native, official MCP and browser fixtures verify these behaviors, including exact independent photographic output.

## Limits

Source work is16 weighted visits per pixel for a computing filter, or1 for a proved identity. Nonnormal source blending adds40 and an evaluating stack mask adds8. One Normal computing filter admits24MP by work, or16MP with a stack mask, before other resource limits. Additional filters, retained geometry and masks can lower the limit. No new full-image cache or imported asset is needed.

Measured native mapping of a24MP fixture with default settings took512ms in the source path and569ms in the global path on the development machine. These scoped timings include output copying and cooperative yielding, and exclude image decoding, encoding and full-document compositing. They are not an end-to-end editing latency guarantee.

Implementation and test ownership are recorded in [the API/MCP plan](PHOTO_FILTER_MCP_DESIGN.md) and [independent review](PHOTO_FILTER_REVIEW.md).

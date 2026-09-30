# Selective Color

Selective Color adjusts nine color ranges independently in a native adjustment layer or editable raster filter. It uses the existing MCP commands, with `kind: 'selective_color'` and `value: 0`. Thirty native/schema/independent/MCP checks, two actual-client helper checks and67 browser workflows pass, alongside the1016-test integrated suite and build. See [current verification](IMPLEMENTATION_STATUS.md).

## Controls and visual behavior

Choose **Relative** or **Absolute**, then select Reds, Yellows, Greens, Cyans, Blues, Magentas, Whites, Neutrals or Blacks. Each range has Cyan, Magenta, Yellow and Black percentages from −100 to 100 in exact 0.01% increments. New settings are Relative with all controls zero. Changing range or method retains the other range settings.

Positive Cyan reduces Red, positive Magenta reduces Green, and positive Yellow reduces Blue. Black adds the same signed virtual-ink correction to all three channels. This is an RGB correction; it does not produce print CMYK separations. Opposite Cyan and Black cancel their Red correction, but Black still affects Green and Blue.

Relative scales existing complementary amounts. Pure white stays white, and increasing Black can leave a fully saturated primary unchanged. Absolute can change white and darken a saturated primary. For example:

| Input and controls | Relative result | Absolute result |
| --- | --- | --- |
| White; Whites Cyan +50 | `255,255,255` | `128,255,255` |
| Red; Reds Black +50 | `255,0,0` | `128,0,0` |

Nearby ranges can contribute to the same pixel. Every range observes the original input RGB for that entry; contributions are summed before one clamp and rounding step. This avoids order-dependent range corrections. The nine-range, CMYK-style workflow is also described in [Adobe's Selective Color documentation](https://helpx.adobe.com/photoshop/using/mix-colors.html); Prism implements its own declared RGB policy, with no Adobe pixel-parity or color-profile conversion claim.

The shared controls preserve all 36 draft values, including incomplete numeric text. Apply requires every range to be valid, including those not currently displayed. **Reset range** changes only the visible row; **Reset all** restores Relative and every zero row. Resets are local until Apply and retain source filter opacity, blend and the shared effect mask. Keyboard, hidden-row validation, read-only inspection and capability withdrawal are verified in the focused browser workflows.

## Scope, protection and persistence

An adjustment layer grades its composite input, with its captured selection or explicit mask and existing lower-layer protection exclusions. A source filter grades source RGB before geometry. The source filter candidate is rounded, blended with that entry's input RGB, and mixed by filter opacity; the shared stack effect mask then mixes the completed stack with the original source. Geometry, additional layer masking, clipping and compositing retain their established order.

Both Selective Color paths preserve alpha and fully transparent input RGB. Original image assets remain unchanged. All-zero controls produce an identity candidate, but a nonnormal filter blend such as Multiply can still change pixels. Identity settings remain structurally active and retain existing protection and source-edit guards. Nonzero controls that cancel are also structurally active.

Partial updates replace complete supplied four-value rows and retain omitted rows and method. Portable projects and history retain the settings. Saved recipes contain the complete effective method and all nine rows: a default recipe resets earlier nonzero target settings rather than inheriting them. Source recipe append retains an existing shared effect mask. Explicit Bake consumes the source filter stack and its mask while retaining original assets, cutout alpha and geometry; Undo restores the editable stack.

## MCP example

Read `prism_capabilities` for Native and require:

- `selectiveColorPolicy: 'rgb-partition-cmyk-v1'`;
- `selectiveColorMethods` containing `relative` and `absolute`;
- `selectiveColorRanges` containing all nine named ranges;
- the appropriate `adjustmentKinds` or `layerFilterKinds` entry and individual command; source filters additionally require `layerFilterCoordinates: 'source'`.

Use current document/layer IDs and revision. For a subtle source correction:

```json
{
  "backend": "native",
  "documentId": "current-document-id",
  "expectedRevision": 3,
  "layerId": "current-raster-layer-id",
  "kind": "selective_color",
  "value": 0,
  "parameters": {
    "method": "relative",
    "reds": [-5, 0, 3, -2],
    "yellows": [-2, 0, 2, 0]
  }
}
```

Send this to `prism_add_layer_filter`. To create a global adjustment, use `prism_add_adjustment` and omit `layerId`. To change only Blacks later, call `prism_update_layer_filter` with its saved `filterId`, current revision and `parameters: {"blacks":[3,0,-3,0]}`. Other rows and method remain unchanged. Use `prism_get_preview` and inspect the actual image after applying.

Unsupported capability combinations do not authorize execution. An optional legacy Photoshop bridge rejects this native kind and explicit Selective Color parameter semantics. There is no new command, API call, generation step or image model dependency.

## Precision and resource limits

The native policy works on encoded RGB8. Integer range memberships sum to 255, with at most four nonzero memberships. Centipercent controls compile to bounded integer coefficients. The final byte calculation uses exact bounded integer numerators and a proven half-up rounding step; it does not use per-pixel floating color-space conversion or a new image-sized cache. See [equations, golden fixtures and resource accounting](SELECTIVE_COLOR_DESIGN.md) and [independent review](SELECTIVE_COLOR_REVIEW.md).

One enabled nonzero source entry costs 12 weighted source-pixel visits under the shared 384-million budget. All 36 authored controls zero costs one; disabled or opacity-zero costs none. A nonnormal source blend adds 40, and an active stack effect mask adds eight. Nonzero cancelling settings still cost 12. Other image, graph, mask, Bake and Distort limits also apply; these weights do not promise a render duration or admit every 24 MP graph.

Computing loops yield within at most 65,536 visited pixels, with a stricter 16,384 rule for nonnormal source blending. Allocation, decoding and other render phases are outside that cooperative loop bound. This remains a full-frame, 8-bit sRGB editor, without CMYK, high-depth editing or Adobe/FFmpeg output identity.

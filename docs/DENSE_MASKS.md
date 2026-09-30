# Channel selections and detailed masks

Verified2026-09-19: the full1,177-test suite, four official MCP workflows,88 focused/adjacent browser workflows and the production build pass. See [the implementation design](DENSE_MASK_DESIGN.md), [independent review](DENSE_MASK_REVIEW.md) and [verification status](IMPLEMENTATION_STATUS.md).

## Select from the visible image

The channel selector turns brightness or transparency in the final visible composite into selection coverage. Choose Red, Green, Blue, Encoded luma or Alpha, then preview or load the result. It includes visible layers, adjustments, masks, transforms and effects. The selected layer and existing selection do not restrict the image being measured.

White in the preview means fully selected; black means unselected; gray means partial coverage. A selection made from a photograph usually contains many soft values. It is useful for controlling an adjustment or painting into bright, dark or color-dominant parts of an image. It does not identify objects or automatically separate a person from a background.

Preview reads the current image without creating a selection or an Undo step. Load measures full-resolution coverage and changes the active selection in one Undo step. Preview can be reduced for display, so very small details may be absent from the preview while remaining in the loaded selection. Changed documents or preview settings require a new Preview request.

Choose how to combine the measured coverage with the active selection:

| Mode | Result |
| --- | --- |
| Replace | Use the channel coverage. |
| Add | Keep the greater coverage at each pixel. |
| Subtract | Reduce current coverage in proportion to channel coverage. |
| Intersect | Multiply current coverage by channel coverage. |

Subtract and Intersect require an active selection. A completely black result is still an active, empty selection. Clear Selection removes the restriction entirely; it has a different meaning from an empty selection.

Invert reverses the finished coverage. **Inverted coverage fully selects transparent pixels.** This follows from the normal channel value being zero there; it is not restricted to the opaque subject. Preview before loading when working with cutouts or an expanded canvas.

Use Save Selection to retain a useful result by name. Loading a channel does not automatically add it to the saved-selection list. Saved selections can later replace or combine with the current selection. The coverage can also be copied to an additional layer mask or captured as the effect mask for an editable filter stack, subject to the existing source-coordinate capture restrictions.

## Preserve photographic detail

The editor's original run-length mask format stores repeated coverage efficiently. A detailed photograph can exceed its200,000-run limit even at512×512 pixels. The new format stores exact coverage bytes in an immutable asset when that happens. It changes storage, without thresholding, reducing image dimensions or smoothing the result.

Existing geometric and run-length masks retain their behavior. Detailed masks participate in selection painting, masked painting and filling, morphology, mask inspection, mask positioning, crop, image resize, canvas resize, saved selections, Undo and portable projects. Source filter masks retain their source-image coordinate frame when the document canvas changes.

The original image remains unchanged when creating or saving a selection. Later edits still follow their own pixel-preservation rules. For example, applying an adjustment through a partially selected area changes that area's colors; merely loading the selection does not. Protected subjects continue to use the existing hard-mask enforcement for generated content.

## Native coverage policy

Prism's `composite-byte-alpha-v1` policy uses the final encoded RGB8/alpha8 composite. It is an explicit native algorithm, without a claim of matching Adobe's internal channel arithmetic.

- Red, Green and Blue multiply the selected component by alpha and round to a byte.
- Encoded luma first rounds `0.2126R + 0.7152G + 0.0722B` to a byte, then multiplies that byte by alpha and rounds again.
- Alpha uses the composite transparency byte directly.
- Invert subtracts the finished value from255.

These are encoded color values, not linear-light luminance. For example, `[14,1,122,128]` produces luma coverage7 because the intermediate luma rounds to13. Preserving that intermediate rounding is part of the saved policy.

Additional-layer-mask density and source-filter-mask density retain their existing distinct calculations. Their Raw/Effective inspection controls explain which coverage is shown. Inspecting a stored mask reads that mask's coverage; channel preview renders the visible image to calculate new coverage.

## MCP workflow

Check the native capabilities for both policies, all five channels, the limits and the individual commands. A compatible companion advertises `denseMaskPolicy: framed-raw-alpha8-v1` and `channelSelectionPolicy: composite-byte-alpha-v1`.

Read a preview at a known revision:

```json
{
  "backend": "native",
  "documentId": "DOCUMENT_ID",
  "expectedRevision": 12,
  "channel": "luma",
  "invert": false,
  "maxEdge": 700
}
```

Send that input to `prism_get_channel_preview`. It returns an opaque grayscale PNG image block and metadata identifying the source document, revision, channel, dimensions and nearest sampling policy. The optional revision prevents reading a different document state by mistake.

Load the selection using `prism_load_channel_selection`:

```json
{
  "backend": "native",
  "documentId": "DOCUMENT_ID",
  "expectedRevision": 12,
  "channel": "luma",
  "mode": "replace",
  "invert": false,
  "requestId": "load-luma-selection-001"
}
```

The mutation requires a positive current revision. Use the returned document revision for subsequent edits. Reusing the same request ID with the same request provides the existing same-session retry protection. If a result is uncertain, inspect the current document before issuing another load. A transaction can load and save a selection together with one positive outer revision and one Undo step.

Detailed descriptors contain a verified asset hash and frame metadata; they are not file paths or arbitrary upload handles. Inspect coverage through `prism_get_mask_preview`. Ordinary document reads return compact metadata. Recipes do not embed mask assets or capture channel loads; an ordinary supported recipe may operate in a document that already contains detailed masks.

## Boundaries

The current editor remains an RGB8, full-frame engine with a24-megapixel/8192-pixel-axis limit. This feature adds continuous composite-channel selections and an exact mask representation. It does not add individual color-channel painting, custom spot channels, channel calculations, CMYK, high-bit-depth images or larger documents.

Before reading pixels, the editor checks named working buffers and planned mask-preparation work. The joint limits are256MiB and384 million preparation visits. They are not a claim that total process memory, native decoder internals or metadata fit within256MiB. An elaborate document may need fewer or simpler masks to fit.

Retained history supports up to256 unique detailed-mask assets and3GiB of those framed bytes. Identical compatible assets count once; the ordinary100-state history limit still applies. This does not impose a total disk quota or remove old unused files automatically. The existing portable-project limits remain193 assets,256MiB total and16MiB of metadata. A locally valid project can therefore be too large for portable export.

The bounded PSD exporter can evaluate these masks subject to its existing representability rules. PSD import retains its separately documented run-length-mask subset. The new private mask format does not expand PSD import compatibility.

The local Node22.14 benchmark measured three sequential samples per case: median full channel loads took22.14ms for the512×512 photograph,40.05ms for a1024×1024 fixture and546.58ms at24MP. Raw24MP feather preparation yielded with a maximum5.46ms heartbeat gap, but the full24MP load still had a319.56ms gap in existing rendering/codec phases. These are fixture timings, not a latency guarantee or a tiled-rendering claim. Exact inputs, hashes and phases are recorded in the implementation design.

# Color Range selections

Color Range selects similar colors throughout the visible image, including disconnected regions. It creates a soft grayscale mask from one to eight colors, with separate full-strength tolerance and fading distance. Original image pixels remain intact.

Implementation is available for manual testing. The four new schema checks, three official MCP workflows and eight independent native audits pass. Final client/browser acceptance and full integrated regression remain pending. See [the numerical and resource contract](COLOR_RANGE_DESIGN.md), [independent review](COLOR_RANGE_REVIEW.md) and [UI design](COLOR_RANGE_UI_DESIGN.md).

## Make a selection

Open the inspector’s **Select** tab, then **Color Range**. Choose **Add foreground color** to deliberately copy the current foreground into the sample list. Edit each sample through its hex field or color picker; remove samples you no longer need. Opening the panel does not automatically choose a color. The existing Eyedropper can set foreground first, but the sample list contains copied color values rather than live points on the image.

Choose **Tolerance** for the range that receives full membership and **Falloff** for the additional distance over which membership fades to zero. Both accept whole numbers0..255 and start at32. Lower values tighten matching; broader values can include similarly colored surroundings. Falloff0 gives a hard threshold. Matching uses encoded RGB differences, so this tool does not identify people, skin, sky or objects by meaning.

Use **Preview** to inspect coverage: white selects fully, gray partially and black not at all. The preview measures the final visible composite, including filters, adjustments, masks, Fill, styles and transforms. Selected layer and existing selection do not restrict that measurement. Preview is before combination, may omit fine detail at reduced size, and creates no history or asset.

Choose a combination mode and **Load selection**:

- **Replace** uses the new mask.
- **Add** keeps the greater coverage at each pixel.
- **Subtract** removes new coverage from the current selection.
- **Intersect** retains the overlap as multiplied coverage.

Subtract and Intersect require an existing selection. Load measures the full-resolution document again and creates one undoable change. A completely black result is an empty selection; use Clear Selection when you want unrestricted editing. Use Save Selection to retain reusable coverage. Saved masks keep their pixels, not a live set of Color Range settings.

## Transparency and protection

The tool first rounds color membership to a byte, then multiplies it by the visible pixel's alpha and rounds again. Matching translucent pixels therefore receive partial coverage. **Invert** complements the finished mask, including selecting fully transparent pixels. Several matching samples do not add their strengths together.

Color Range authoring does not unlock protected content. Painting, filtering and generated-image application retain their existing protection rules. The selection can be used by the existing mask and editing tools; exact detailed masks use the completed [dense-mask storage](DENSE_MASKS.md) when run-length storage is insufficient.

If a submitted load's result cannot be confirmed, the panel keeps it marked for review—even if you switch between Color Range and composite channels or close the panel. **Review current selection** fetches the document so you can inspect what happened. The app does not automatically resubmit an uncertain load.

## MCP

Use `prism_get_color_range_preview` for a read-only PNG and `prism_load_color_range_selection` to create the selection. Discover `colorRangePolicy:'sampled-rgb-chebyshev-alpha-v1'`, the typed limits and the corresponding command first. Loading also requires dense-mask authoring support. A current positive `expectedRevision` is required for Load; supply it for Preview to pin the read as well.

```json
{
  "backend": "native",
  "documentId": "CURRENT_DOCUMENT_ID",
  "expectedRevision": 7,
  "colors": ["#e06942", "#190d38"],
  "tolerance": 32,
  "falloff": 32,
  "invert": false,
  "mode": "replace"
}
```

This is a Load example; Preview takes `maxEdge` instead of `mode`. Its longest edge defaults to700, accepts32..2400 and never enlarges the source. Responses echo canonical settings and the measured revision. Hex colors must be exactly six digits, and duplicates after case normalization refuse. No provider, segmentation model or image generator is used for Color Range.

The editor remains a bounded full-frame RGB8 system. The operation accepts at most192 million pixel/sample comparisons and retains existing graph, mask, history and project limits. It does not add perceptual color distance, localized clusters, tonal presets or Adobe pixel equivalence. See [MCP details and evidence](COLOR_RANGE_MCP_DESIGN.md).

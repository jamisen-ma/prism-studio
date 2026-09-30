# Master and color-channel Curves

Independent **Master, Red, Green and Blue** curves keep four editable tone mappings in one global adjustment or raster filter. They share that entry's blend, opacity and mask. Existing single-curve editing remains available.

## Editing four curves

Open Curves and choose **Upgrade to channel banks**. The current RGB curve becomes Master; a current Red, Green or Blue curve goes into that matching bank. The other banks start as Linear identities. Upgrade is a local draft until Apply. It retains the current curve's exact mapping and interpolation.

Choose **Curve bank** to inspect and edit one of the four curves. Each bank keeps its own points and Linear/Smooth setting. Master runs first; the three color curves map its result. **Apply saves all four curves**, including banks currently hidden from the graph.

Each bank supports 2–16 points with input endpoints0 and255. Inputs must increase strictly; both coordinates accept finite values from0 to255, including close fractions. Input/Output fields retain exact text while editing. The graph, point selector and keyboard Add point action follow [the existing Curves controls](SMOOTH_CURVES.md). The graph shows the selected bank's transfer function. The displayed composite histogram is a reference, not a histogram recomputed at that bank's input.

**Reset this bank** restores only the selected bank to a Linear identity. **Reset all banks** restores all four while keeping the banked format. These actions remain local until Apply and preserve blend, opacity and masks. Incomplete values in another bank block Apply and identify the bank that needs attention.

To discard the other curves deliberately, expand **Replace with one curve**, choose a bank to retain, and select **Use only this curve**. Master becomes a single RGB curve; a component becomes a single curve for that color channel. The combined effect is generally not preserved. The replacement remains a draft until Apply, and Undo restores the saved banked adjustment after application.

## Native color behavior

For each input red byte, the candidate is `Red[Master[red]]`; Green and Blue use their corresponding tables. Master is rounded to a byte before the component lookup. This intermediate rounding is part of the native policy. Two curves that each halve their input map input1 to1, because each half-stage rounds; a single final rounding would produce0.

Each bank uses the existing Linear or native Smooth algorithm. Linear's old expression stays unchanged, and Smooth retains its pinned identity and authored integer knots. Banked curves do not imply Photoshop-identical pixels, higher bit depth or recovery of clipped detail.

A source filter applies its entry blend and opacity once to the completed RGB candidate. The full stack's effect mask then mixes the complete filtered result before geometry. Four separate curve entries with independent masks or blend/opacity settings can therefore produce a different result. Identity banks remain active entries and can change pixels under a nonnormal blend.

Source curves preserve all alpha and hidden alpha-zero RGB. Global curves retain their established hidden-RGB grading, adjustment mask and protected-content behavior. Original assets remain intact. Explicit Bake preserves the current admitted composition, retains geometry and cutout alpha, and remains undoable under the existing [Bake rules](FILTER_BAKING.md).

## MCP

Require Native, `curvesBanksPolicy:'master-byte-then-channel-byte-v1'`, a `curvesBankNames` list containing `master`, `red`, `green` and `blue`, and the context's existing Curves kind and command. Source editing also requires source coordinates. If **any** bank is Smooth, require the separate `curvesInterpolationPolicy:'shape-preserving-pchip-v1'` and Smooth mode support, even when that bank is not currently selected.

For example, append a filter with `prism_add_layer_filter`:

```json
{
  "backend": "native",
  "documentId": "current-document-id",
  "expectedRevision": 3,
  "layerId": "current-raster-layer-id",
  "kind": "curves",
  "value": 0,
  "parameters": {
    "mode": "banks",
    "banks": {
      "master": {
        "points": [{"x":0,"y":0},{"x":128,"y":138},{"x":255,"y":255}],
        "interpolation": "smooth"
      },
      "blue": {
        "points": [{"x":0,"y":3},{"x":255,"y":250}]
      }
    }
  }
}
```

Missing banks and bank fields default to Linear identity on creation. Saved banked records contain all four complete banks with explicit interpolation. For a global adjustment use `prism_add_adjustment` and omit `layerId`.

For later updates, always include `mode:'banks'` with a bank patch. Omitted banks retain their settings. Within a supplied bank, omitted fields retain; `points` replaces that bank's entire point list. Thus `parameters:{mode:'banks',banks:{blue:{interpolation:'smooth'}}}` changes only Blue interpolation. An empty parameter object is a no-op.

Changing representations is explicit. `mode:'banks'` on a single-curve target starts from submitted bank settings and identity defaults; it does not automatically map the old curve. To preserve the old mapping, submit its points/interpolation in Master for RGB or in the matching component. `mode:'single'` on a banked target discards all banks and creates the submitted/default legacy settings. Top-level legacy points/channel/interpolation alone cannot silently replace a banked target. Single-mode canonical records omit the mode marker, preserving the old representation.

Complete recipes retain all four effective banks and reset the target completely. An old single-curve recipe explicitly replaces a banked target during application while its saved definition and hash remain unchanged. Definition capture uses saved settings, excluding unapplied drafts. Recipe application checks both its saved configuration and the bound target. Editable project transfer and reopening retain the complete native representation; older readers refuse banked records instead of treating them as identity.

## Limits

This feature uses the existing Curves kind, commands and8-bit sRGB renderer. Four banks occupy one source-stack entry. Enabled positive-opacity source entries retain the one-visit-per-pixel work charge, plus existing blend and stack-mask costs. Disabled/zero-opacity entries still validate metadata but allocate no curve tables.

Compilation uses at most1280 bytes of named table storage, retaining768 bytes during pixel mapping. Source tables join the existing sequential cache maximum, and global banked adjustments add one conservative table reserve to graph scratch admission. Bounded point/segment objects, allocation/GC, codecs and process RSS are outside that binary-buffer count. No image plane, asset dependency or external service is introduced.

Thirty new native, independent, schema, MCP and client checks pass. The integrated suite passes 1,076 tests, and 83 focused/adjacent browser workflows and the production build pass. Independent accessibility review confirms inspection remains available while mutations are guarded. See [the native design](CURVES_BANKS_DESIGN.md), [independent review](CURVES_BANKS_REVIEW.md) and [UI design and acceptance](CURVES_BANKS_UI_DESIGN.md) for evidence.

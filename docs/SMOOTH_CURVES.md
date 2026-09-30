# Linear and Smooth Curves

Native acceptance passes 22 owner/independent/schema/MCP checks and a full 984-test integrated regression. Fifty-nine browser workflows, the final keyboard-accessibility rerun and the build pass; see [current verification status](IMPLEMENTATION_STATUS.md).

Curves maps an input tone to an output tone. It is available as an editable adjustment layer and as a raster layer filter. Choose **RGB**, **Red**, **Green** or **Blue**, then edit the control points. Each record holds one point set for the selected channel. Additional channel treatments can use separate adjustment layers or filter entries.

**Linear** keeps the existing straight segments and remains the default. **Smooth** uses Prism's shape-preserving cubic interpolation, compiled into a 256-byte lookup. It follows rising, falling and flat segments without intentionally overshooting their endpoint range. This is an encoded-RGB, 8-bit operation; it does not recover clipped detail or claim Adobe's proprietary curve behavior.

## Control points

A curve has 2–16 points. Input and Output lie between 0 and 255. The first input is 0, the last is 255, and all inputs increase strictly. Outputs can rise, fall, reverse or form a plateau. Fractional values and arbitrarily close finite input values are retained; there is no minimum input spacing.

Add point inserts a local midpoint in the largest input gap and supports keyboard activation. The Point selector makes closely spaced points independently accessible. Input/Output fields retain numeric drafts until valid submission. Changing Output leaves Input unchanged. Invalid or incomplete entries disable Apply; choosing another point preserves those drafts. Reset changes only the draft.

The graph is a draft transfer function. Smooth displays the actual 256 lookup samples, with authored points shown separately. Dragging provides whole-unit authoring; numeric fields provide fractional precision. A click without movement leaves the point unchanged. Escape or interrupted capture cancels a drag. The document image changes when you apply, with one Undo step.

## Scope and saved settings

An adjustment layer uses its existing document-space mask, opacity and protection rules. A source filter runs before geometry, then enters its saved RGB blend mode and opacity. A whole-stack effect mask mixes the completed stack afterward. Source curves preserve every alpha byte and hidden zero-alpha RGB. Global Curves retains its established behavior of grading hidden RGB while preserving alpha, except where mask, opacity or protection bypasses the edit.

A diagonal Smooth curve has an exact identity lookup. A nonnormal source-filter blend can still change the result even when that candidate is identical to its input. [Bake filters](FILTER_BAKING.md) evaluates the saved curve, blend and stack mask through the existing source pipeline. Original files, cutout alpha and retained geometry keep their usual guarantees.

Omitted interpolation means Linear when creating a curve. Partial updates retain omitted settings; explicitly choose Linear to change a saved Smooth curve back. Canonical Linear records omit the new field. Native projects, portable `.prism` files, history and recipes retain Smooth explicitly. Older readers reject that unknown parameter instead of silently drawing a different curve.

Saved adjustment recipes contain complete curve settings. Applying a Linear recipe to a Smooth target resets it to Linear without changing the recipe definition or hash. Filter recipes append a new entry in the saved mode. Existing masked-stack capture restrictions remain in force. See [recipes](EDIT_RECIPES.md).

## MCP

For Smooth, require the advertised kind and command plus:

```js
curvesInterpolationPolicy: 'shape-preserving-pchip-v1'
curvesInterpolationModes: ['linear', 'smooth']
```

Create a source filter:

```js
prism_add_layer_filter({
  backend: 'native', documentId, expectedRevision, layerId,
  kind: 'curves', value: 0,
  parameters: {
    channel: 'rgb', interpolation: 'smooth',
    points: [
      {x: 0, y: 0}, {x: 64, y: 46},
      {x: 192, y: 211}, {x: 255, y: 255}
    ]
  }
})
```

Use `prism_add_adjustment` with the same kind, value and parameters for a global adjustment. `prism_update_layer_filter` also takes `layerId` and `filterId`; `prism_update_adjustment` takes the adjustment's `layerId`. These accept a channel-only or interpolation-only parameter update. Supplying points replaces the complete list. For example, `parameters: {interpolation:'linear'}` retains points and channel while resetting the mode.

There are no new commands or filter kinds. The optional Photoshop bridge does not support explicit interpolation. A client with no Smooth capability can continue using legacy Linear; it must not silently convert an unsupported saved Smooth curve.

## Precision and limits

Smooth uses a declared native binary64 PCHIP calculation with one final byte rounding. It handles adjacent and subnormal input gaps without constructing an overflowing slope. Integer input knots return the rounded authored output directly. A two-point curve is mathematically straight, but its endpoint can differ from legacy Linear at a floating half boundary. For `(0,255),(255,0.49999999999999994)`, Smooth ends at byte 0 while the unchanged legacy expression ends at byte 1.

Compilation uses at most 15 intervals and a fresh 256-byte lookup. No image-sized cache or per-pixel cubic evaluation is introduced. Existing source-filter work, blending, mask, geometry and Bake limits remain authoritative. The output is neither an exact-real rounding guarantee nor high-bit-depth color processing.

See the [numerical and compatibility design](SMOOTH_CURVES_DESIGN.md), [independent review](SMOOTH_CURVES_REVIEW.md) and [UI contract](SMOOTH_CURVES_UI_DESIGN.md).

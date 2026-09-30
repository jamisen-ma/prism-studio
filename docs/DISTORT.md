# Four-corner Distort

Native, independent, shared-schema and two official MCP workflows pass, with 24 new checks and a full 957-test regression. Eight focused and 51 adjacent browser workflows pass, along with the production build. Production sampler measurements and photographic/compact-layout inspection are complete. See [implementation status](IMPLEMENTATION_STATUS.md).

**Distort** maps the four corners of an individual image, solid, text, shape, path or gradient layer to an editable quadrilateral. It can change perspective and skew while retaining the original source and a saved geometry stage. It requires no Photoshop installation or image generation.

## Editing a stage

The Distort inspector has X and Y fields for **Top left**, **Top right**, **Bottom right** and **Bottom left**, in that order. Coordinates describe the outer pixel edges of the stage, so an unchanged W × H rectangle is `(0,0), (W,0), (W,H), (0,H)`. Fractional positions are retained. Reset rectangle changes the draft; Apply saves one undoable change.

An appended or final stage can show four draggable corner handles. The outline is a draft guide: the saved image updates only when you apply. Keyboard or assistive activation of a corner handle focuses its X field without changing coordinates. Numeric fields remain available for earlier stages, where later geometry makes direct canvas handles misleading. A connection that can read but cannot update a saved stage shows an explicit read-only explanation; removal retains its independent availability. You can revisit or remove any saved Distort stage. Its index is its position in the complete geometry list, including crops, resizes and other transforms.

Each stage keeps its input and output frame size. Corners outside that frame clip the result; they do not enlarge the document. Revisiting a stage replays its retained input and can recover clipping caused by that stage. Pixels clipped by an earlier stage remain unavailable to subsequent stages. Appending an inverse transform does not reverse earlier clipping or interpolation.

Protected layers reject adding, editing and removing Distort. A layer distorted first and protected afterward retains its saved appearance. Groups and adjustment layers are not eligible.

## Pixels, masks and quality

Source pixels and separate cutout alpha enter the complete source-filter stack before geometry. A source filter effect mask retains its source coordinates. Additional layer masks, positioned masks, selections and guides stay in document coordinates when one layer is distorted. Capturing a selection into a source filter mask refuses a retained Distort stage; use a source-coordinate mask or capture before distortion.

Identity and exact integer translations copy RGBA bytes exactly. Other quadrilaterals use the declared native alpha-weighted bilinear sampler and can change both colors and coverage. Transparent neighbors contribute no hidden colors, and outside neighbors are transparent. General sampling does not promise preservation of RGB beneath zero alpha. Floating-point half ties can differ from exact mathematical interpolation by a byte.

The editor also provides [linked horizontal and vertical Perspective](LINKED_PERSPECTIVE.md): dragging a corner or entering a delta moves its partner oppositely along the stage axis. Independent coordinate fields remain available in every mode. Both workflows save the same four corners and use the same projective sampler.

The native projective mapping does not claim Adobe pixel equivalence. Mesh Warp, Puppet Warp and Liquify remain future work. Bilinear reduction can alias fine detail; selectable warp kernels and area prefiltering are also future work.

[Bake filters](FILTER_BAKING.md) retains distortion because it materializes source colors before geometry. Native projects and portable `.prism` files retain editable stages. Flattened exports render them; supported PSD exports rasterize geometry under their existing compatibility warning. Older Prism readers reject the new stage type.

## MCP

Require `layerDistortPolicy:'fixed-frame-projective-bilinear-v1'`, `layerDistortCoordinates:'stage-pixel-edges'`, an advertised eligible content type and the corresponding command.

```js
prism_add_layer_distort({
  backend: 'native', documentId, expectedRevision, layerId,
  corners: [
    { x: 70, y: 40 },
    { x: 470, y: 100 },
    { x: 420, y: 470 },
    { x: 100, y: 390 }
  ]
})
```

The example maps a 512 × 512 stage to an asymmetric quadrilateral within the same frame. Read the actual document and stage dimensions before choosing coordinates.

Use `prism_update_layer_distort` with `transformIndex` and a complete replacement `corners` array. Use `prism_delete_layer_distort` with that index to remove one stage. The index addresses `layer.transforms`, not a filtered list of Distort entries. A historical record's own width and height define its coordinates. Indices are revision-bound; read current state after a conflict rather than retargeting an old index automatically.

All three commands require a positive `expectedRevision`. They support `apply_transaction` with one positive outer revision and no per-step revision. Transactions validate intermediate graphs, so adding an excessive stage and deleting it later still refuses before pixel work. Stable request IDs support the existing session retry behavior; these commands are excluded from reusable edit recipes.

## Limits

Corners accept finite values within ±16384. The backend refuses crossed, mirrored, concave, collapsed, extremely thin or unstable quadrilaterals without changing the saved stage. The native engine still supports affine flips separately. See the [numerical admission and interpolation contract](PERSPECTIVE_TRANSFORM_DESIGN.md) for precise stability bounds.

Every retained Distort costs 16 times its stage area under a separate 384-million work budget, including hidden layers, identity and exact-copy stages. A document with any Distort also admits a combined 256 MiB named-buffer envelope across all content sources, filter candidates, geometry, root buffers, retained groups/clipping, bitmap masks and the shared noise table. Cropping a large retained source does not make its source storage disappear from that estimate.

For a flat unfiltered raster with one same-size stage and no masks, the graph envelope is 14 bytes per canvas pixel: 8192 × 2340 fits that bound, while 8192 × 2341 does not. Filtered content, more geometry, nested groups or masks can lower the admitted dimensions. These limits exclude encoded input, native codec allocations, some adjustment/style internals and total process memory. They are not a 256 MiB RSS or latency guarantee. Refusals retain the saved document; reduce dimensions, stages or other relevant settings explicitly.

See the [native design](PERSPECTIVE_TRANSFORM_DESIGN.md), [independent review](PERSPECTIVE_TRANSFORM_REVIEW.md) and [UI contract](DISTORT_UI_DESIGN.md) for implementation and acceptance details.

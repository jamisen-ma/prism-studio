# Bake raster filters

**Bake filters** keeps a finished filter treatment as ordinary working pixels so you can continue painting, retouching, filling or other supported source edits. The original image file remains intact. Undo restores the editable filter stack and the previous working image.

This action differs from **Clear filters**, which removes the treatment and returns to the unfiltered working image. Baking fixes the current treatment into the working RGB and removes every filter entry, including disabled entries. If the stack has a [filter effect mask](FILTER_EFFECT_MASKS.md), Bake includes its saved coverage, feather, inversion, density and enabled state in the treatment, then removes that mask too. Clear removes both without fixing the treatment into pixels. Neither action flattens the document or resets the layer's transforms.

## What stays editable

The layer keeps its ID, source dimensions, transforms, additional mask and density, independent mask position, outside styles, opacity, blend mode, group and clipping membership. Other layers, selections, guides and recipes remain unchanged. The original `sourceAsset` stays archived; only the current working `asset` may change.

A separate cutout alpha mask also stays separate. Baking filters against the current effective alpha, then restores the working image's original alpha before saving, so the cutout is applied exactly once on the next render. Source RGB beneath zero effective alpha remains unchanged. If later cutout repair reveals those pixels, they have their previous ungraded colors. Spatial filters freeze the sampling that existed when you baked; they no longer recompute after alpha changes.

For supported targets, the current rendered result is byte-identical before and after baking. This includes the consumed filter effect mask and retained additional masks, transforms, effects and compositing. The filter settings themselves stop being editable in the current state. New filters can be added afterward and apply once to the baked working image.

Source inspection still shows the archived original; source-alpha inspection still shows the separate cutout mask. `.prism` export retains original, baked working and separate alpha files. A portable file carries current state, so use Undo before export if you want the old editable stack in that copy.

## Protection and eligibility

Choose an unprotected raster layer with at least one filter entry. Baking never removes protection automatically.

An active stack cannot be baked when any earlier content layer in the document's canonical order is protected, including hidden or fully masked content. Editable filters restore unfiltered RGB in those protected regions; that behavior cannot be safely fixed into source pixels while retaining editable geometry. The editor rejects the action with `FILTER_BAKE_PROTECTED_CONTEXT` instead of changing those pixels. A background below protected subjects can be baked because its current appearance remains exact.

If all entries are disabled or have zero opacity, baking only clears their settings and any filter effect mask. It performs no image read or write, and an earlier protected layer does not block that unchanged-pixel operation. A black, disabled or zero-density effect mask does not make structurally active filter entries inactive or relax their protection checks. A protected target still rejects it. An empty stack returns `NO_FILTERS`.

After baking, ordinary tool restrictions still apply. For example, source cutout refinement requires an extracted source before placement or transforms. Baking does not remove those restrictions, rasterize an editable text layer, flatten a clipping chain or create Photoshop Smart Objects.

## MCP and atomic workflows

Use the current revision and explicit target:

```js
prism_bake_layer_filters({
  backend: 'native', documentId, expectedRevision, layerId
})
```

`expectedRevision` must be a positive integer. Baking can be included in a transaction followed by painting or retouching, with one Undo step:

```js
prism_apply_transaction({
  backend: 'native', documentId, expectedRevision,
  label: 'Bake treatment and repair',
  operations: [
    { command: 'bake_layer_filters', args: { layerId } },
    {
      command: 'paint_stroke',
      args: {
        layerId, tool: 'clone', sampleMode: 'current',
        points: [{ x: 420, y: 310 }],
        source: { x: 400, y: 310 },
        size: 12, hardness: 0.5, opacity: 1
      }
    }
  ]
})
```

Coordinates must fit your intended image operation. Put the revision on the enclosing transaction, not individual steps. Every transaction containing a bake requires that revision. A late failure restores project state and removes only newly published assets owned by that transaction, including later brush outputs. Existing deduplicated files and unrelated writes are retained.

Use a stable request ID and identical body to reconcile an uncertain response within the companion session. After restart, inspect the document; an old applied revision rejects rather than rebasing the edit. Baking is excluded from metadata-only edit recipes because it creates working pixels. The optional Photoshop bridge does not support this native command.

## Resource limits

Discovery exposes `layerFilterBaking:'source-rgb'`, `maxFilterBakeWorkingBytes:268435456` and `maxFilterBakeAssetBytes:134217728`. Existing 8192-pixel axes, 24 MP source dimensions and the shared filter workload still apply. Baking may reject a source that fits ordinary editable filtering because it needs additional buffers while preserving working and cutout alpha separately. Source Gaussian Blur, RGB Sharpen, Unsharp Mask, High Pass and Local Shadows / Highlights add their maximum live cache bytes to the filter phase; sequential caches are not summed. Local Shadows / Highlights includes its two-channel row cache and response table. Larger sigma therefore affects both the shared work budget and baking memory admission. See [source spatial limits](SOURCE_SPATIAL_FILTERS.md).

Computing Gaussian Add Noise adds one shared 4096-byte table reservation to every Bake phase: decode, filtering, encoding and publication. This persistent table is charged once, independently of filter count and the maximum spatial cache. Baking uses the saved noise seed and fixes its result into working pixels. See [repeatable Add Noise](ADD_NOISE.md).

The 256 MiB limit counts explicitly retained byte buffers across decode, filter, encode and publication phases. It is not a process-memory bound: native codec memory, caches and JavaScript metadata are outside that ledger. Input files are admitted and read through the same bounded file descriptor, with immutable hash checks. Deduplicated output is checked against its exact expected size before allocating a comparison buffer.

PNG output is first encoded in a private temporary directory. The file is admitted before allocating its JavaScript read buffer, under a ceiling of `min(128 MiB, 5 × sourcePixels + 1 MiB)`. This is an output admission rule, not a promise that every valid source will fit or a cap on temporary disk usage during encoding. Owned temporary output is removed after success or handled failure. Source-alpha combination and comparison yield every 65,536 pixels; existing filter yields remain. No model, generation provider or API key is used.

See [implementation status](IMPLEMENTATION_STATUS.md), [design and buffer ledger](FILTER_BAKE_DESIGN.md), and [independent review](FILTER_BAKE_REVIEW.md). The workflow is informed by Adobe's distinction between [editable Smart Filters](https://helpx.adobe.com/photoshop/using/applying-smart-filters.html) and [rasterized content](https://helpx.adobe.com/uk/photoshop/desktop/create-manage-layers/smart-objects/rasterize-smart-objects.html); Prism's behavior is the native contract above.

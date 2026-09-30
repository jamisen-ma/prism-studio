# Repairs on a separate layer

Implemented and verified through native, schema, independent pixel, MCP and browser checks. The complete Node suite at the initial sampling milestone passed 653 tests. Subsequent [Aligned Clone/Heal](CLONE_ALIGNMENT.md) adds a browser control to keep the same source offset across separate strokes, with additional verification recorded in [current status](IMPLEMENTATION_STATUS.md).

Choose **Clone stamp** or **Healing brush**, select a root image layer and choose **Create repair layer**. Prism inserts a transparent paint layer directly above that image. The action selects **Current & below** sampling and **Ignore adjustment layers**, as disclosed beside the button. Option/Alt-click the canvas to choose a source, then paint the repair. The original image remains a separate layer with its existing filters and source file.

The tools use the existing deterministic brush engine. Healing transfers a sampled patch with a local color correction; it is not generative removal. Ordinary clone/heal use **All layers** with adjustment skipping off until you change those settings.

## Sampling choices

| Choice | Pixels sampled at the start of a stroke |
| --- | --- |
| Current layer | The target's transformed working pixels and subject alpha, before its additional mask, opacity, styles or surrounding layers. A blank repair layer samples transparency. |
| Current & below | The visible composition through the target, including committed earlier repairs. The target must be a root raster outside any clipping chain; complete groups and chains below it retain normal rendering. |
| All layers | The complete visible composition, including layers above the target. |

**Ignore adjustment layers** skips standalone adjustment layers in the composite sample, including those inside lower groups. Source raster filter stacks still apply. Current-layer sampling has no adjustment layers to skip, so the checkbox is unavailable in that mode. Changes to the scope or source cancel an unfinished stroke; changing the canvas mapping also cancels it. Each completed stroke uses one frozen sample, so overlapping dabs never resample their own new pixels.

An additional mask still limits the repair layer's displayed result. The active selection and the complete document's protected footprints limit destination writes, independently of the sampling choice. Creating a repair above a protected photograph does not allow painting over its protected pixels. Protected targets and targets with any filter-stack entries reject painting; choose a separate repair layer to retain an editable filter stack.

The creation source may be hidden, filtered, transformed, protected or generated, but must be a root raster outside a clipping chain. The new layer inherits none of those settings and has no live link to the source. To work within a group or clipping chain, ordinary All/Current sampling retains the existing writable-target rules; Current & below and automatic repair insertion have the narrower scope above.

## MCP

Use `prism_create_repair_layer` with the current revision and explicit source layer ID. Its standalone result returns `document` and `layerId`. Then call `prism_paint_stroke` with that returned ID and the desired source point, brush settings and sampling fields:

```json
{
  "backend": "native",
  "documentId": "CURRENT_DOCUMENT_ID",
  "expectedRevision": 4,
  "layerId": "REPAIR_LAYER_ID",
  "tool": "clone",
  "source": { "x": 120.5, "y": 84.5 },
  "points": [{ "x": 240.5, "y": 160.5 }],
  "size": 12,
  "hardness": 0.7,
  "opacity": 1,
  "sampleMode": "current-and-below",
  "ignoreAdjustments": true
}
```

Sampling options apply only to clone/heal. Omission preserves All/false. `current` with `ignoreAdjustments:true` rejects. Positions use current document coordinates; source sampling retains the existing premultiplied interpolation and transparent off-canvas behavior.

For a single undo step, allocate a fresh lowercase UUID, pass it as `newLayerId` to creation inside `prism_apply_transaction`, and use that same ID as the following stroke's `layerId`. Reuse the transaction's request ID when recovering an uncertain response. Creation-containing transactions track their newly published assets through commit; failed transactions remove only those new files and preserve reused assets and the prior document.

Check `retouchSampleModes`, `retouchSamplingTools`, `retouchIgnoreAdjustments`, `retouchCurrentAndBelowScope` and `repairLayerPlacement` capabilities. These options are native-only. Resulting repairs are ordinary raster layers, so `.prism`, undo/reopen and supported exports preserve them without storing local sampling preferences.

## Limits

The existing 24 MP canvas, 64 layers, 2,000 stroke points, 512 px brush and 60-million weighted sample-visit limits remain. Full-frame sampling, rendering and parts of painting are synchronous. The 256 MiB group/filter scratch preflight is not a total retouch-memory or RSS ceiling; target, sample, output, coverage and codec buffers require additional memory. Current-layer sampling reuses the frozen target instead of allocating a second sample image. See [the detailed contract](RETOUCH_SAMPLING_DESIGN.md) and [independent review](RETOUCH_SAMPLING_REVIEW.md).

Thirteen owner, six independent and three schema/MCP checks pass. Five browser workflows verify actual sampling pixels, source filters under a grade, protection, cancellation, stale revisions, capability fallbacks and delayed creation. Capture and gesture regressions also pass. Tests use synthetic fixtures without provider or API-key access; they do not establish Photoshop-identical healing or large-document performance.

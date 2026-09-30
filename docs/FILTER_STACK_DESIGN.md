# Native editable layer filters: implementation contract

Status: this initial scoped milestone is implemented and verified in native, MCP and the browser. Subsequent milestones add [explicit baking](FILTER_BAKING.md), color mapping, tonal controls and [source Gaussian/RGB sharpen](SPATIAL_LAYER_FILTERS_DESIGN.md), bringing current discovery to24kinds. References to deferred baking/spatial kinds below describe the original slice. The original independent native/MCP run passed16tests; the UI owner reported four real-browser workflows. Source-space evaluation and no per-entry masks remain current constraints.

## Scope and research

Add a bounded, editable filter list to native raster content layers. Keep immutable source files, working raster assets, cutout alpha and existing layer geometry separate. This does not implement Adobe Smart Objects, linked documents, Camera Raw, PSD compatibility, third-party filters or higher bit depths.

Adobe documents editable filters attached to Smart Objects, filter reordering and per-filter blending. Photoshop evaluates that stack bottom-up and its documented mask is shared by the Smart Filters on the object. Prism's proposed list instead explicitly numbers execution order from first to last. Filter-specific masks are deferred; the existing layer mask still controls final visibility. These are deliberate product choices, not a claim of matching Photoshop's implementation. [Adobe: Applying Smart Filters](https://helpx.adobe.com/photoshop/using/applying-smart-filters.html)

Adobe also distinguishes filters on active layers or selections from nondestructive filters and documents image-mode restrictions. This milestone stays within Prism's existing 8-bit sRGB raster pipeline. [Adobe: Filters overview](https://helpx.adobe.com/photoshop/desktop/effects-filters/get-started-with-filters/filters-overview.html)

Preserving original data and keeping retouching separate are useful requirements for this design. An editable filter graph alone does not make every existing raster operation nondestructive. [Adobe: Nondestructive editing](https://helpx.adobe.com/photoshop/using/nondestructive-editing.html)

## Persisted representation

`layer.filters` is optional and defaults to an empty array. Each entry is:

```js
{
  id: "server-generated UUID",
  kind: "brightness",
  value: 12,
  parameters: undefined, // normalized levels/curves parameters when applicable
  enabled: true,
  opacity: 1
}
```

Entry IDs are unique within their layer. Commands always identify both layer and entry. Layer duplication may retain entry IDs because the layer ID supplies the namespace; all entry objects and parameter arrays must be deep copies. Unknown entry fields and unsupported kinds are rejected. Raster layers only; groups, adjustment layers and generated text/vector content require an explicit rasterization first.

The initial 18 kinds covered scalar color adjustments, levels, curves, median and mosaic, excluding blur and sharpen. Channel Mixer and Gradient Map have since extended the supported set to 20 kinds; see [their contract](COLOR_MIXER_DESIGN.md). Existing blur/sharpen use RGBA spatial processing; they need independent alpha-weighted RGB candidate fixtures before joining this stack. This is a scope limit, not an invisible fallback. Enforce current ranges, integer posterize/threshold/median/mosaic values, odd median size and strict normalized parameters. Threshold zero is functional and must not take a generic value-zero shortcut.

## Pixel order and coordinates

The order is working `asset` decode → retained source `alphaAsset` multiplication → filter entries in array order → layer geometry → contextual protected-pixel gate → own layer mask and opacity → outside effects and layer blending → ancestor group composition. Filters use source-pixel coordinates before geometry. Spatial radii and mosaic cell sizes are source pixels, so the filtered result transforms with the content. The UI must state this unit.

Preserved `sourceAsset` remains a read-only original. Neither changing an entry nor rendering writes any image asset. Every entry preserves the input alpha byte exactly and skips RGB changes where input alpha is zero. Median and mosaic sample using alpha weights so invisible RGB cannot contaminate visible colors. The own layer mask is applied later, so spatial sampling may use underlying pixels hidden by that layer mask. Existing document selections do not implicitly scope a new filter in this milestone; applying a document-space selection before arbitrary source transforms needs a separate mask-coordinate design.

For each channel of a visible pixel, calculate `round(input + (candidate - input) * entry.opacity)`. Apply this interpolation once per entry, using the previous entry's result. Keep alpha unchanged. Disabled entries and opacity zero must return exact bytes, with no candidate allocation. Skip identity processing only for specifically proven identities, not for every zero value.

There are no per-filter masks in this milestone. Existing own and ancestor masks keep their established geometry and feather semantics. Canvas resize/crop/expansion updates existing geometry/masks; filter parameters remain in source units and are not scaled twice.

## Protected subjects and consistent rendering

Reject stack mutations on a protected target before writing assets or history. Enabling protection on a layer with any enabled, nonzero-opacity filter rejects with an actionable explanation. The user can explicitly disable or clear first; do not silently disable filters or unprotect a subject. Disabled or zero-opacity entries may persist on a protected layer but cannot be edited while protected.

A filter on an unprotected layer must leave its unfiltered input unchanged at pixels covered by lower protected content. A filtered background below a protected cutout remains editable, including the background seen through soft alpha. Use the existing bottom-to-top protected footprint, not the union of every protected layer regardless of stacking.

`renderGraph` already has the lower footprint. Where protection overlaps a filtered layer, transform both the unfiltered and filtered source through identical geometry, then retain the unfiltered transformed RGB at protected pixels. Preserve alpha exactly. Isolated layer preview needs the same contextual gate, computed only from earlier protected leaves with their ancestor visibility, masks, opacity and outside effects. Active filters are forbidden on protected layers, so obtaining that footprint does not require recursively rendering the filtered target. Do not recursively call `renderGraph` from the low-level layer renderer. Include this additional base surface and geometry pass in resource accounting. Original and raw-alpha previews remain unchanged.

## Existing raster operations and deferred baking

Separate unfiltered base rendering from filtered appearance. Today `renderLayer` is shared by paint/fill, placement, previews, extraction and protection; adding filters to that helper without classifying callers would cause painting to bake a filter into the asset and then apply it again.

For this milestone, reject paint/fill, extraction and source-alpha refinement on targets with any nonempty stack, and placement from any source with a nonempty stack. This includes disabled entries, because later enabling them must remain meaningful. Show the explicit Clear action; painting on another layer remains available. No bake command is implemented in this milestone. Plain layer transforms, masks, opacity, effects, duplication and export preserve the stack.

`select_subject` may inspect the underlying unfiltered working pixels, because it only produces a selection. Extraction and source-alpha refinement reject every nonempty stack in this conservative first milestone, including disabled entries. This prevents source-data reconstruction from silently changing filter semantics. A future extension can define how those operations retain and evaluate the stack.

## Native and MCP commands

All mutations use document ID and expected revision, the existing serialized queue, graph validation, one history commit and native-only backend validation.

| Command | Arguments beyond document/revision | Behavior |
| --- | --- | --- |
| `add_layer_filter` | layerId, kind, value, parameters?, enabled?, opacity? | Append; server assigns ID. Source-space whole-layer operation; selection does not scope it. |
| `update_layer_filter` | layerId, filterId, value?, parameters?, enabled?, opacity? | Kind is immutable; require at least one change. |
| `reorder_layer_filter` | layerId, filterId, index | Zero-based execution order. |
| `delete_layer_filter` | layerId, filterId | Remove one entry. |
| `clear_layer_filters` | layerId | Remove every entry. |

Read stack state through `get_document`; capability metadata advertises supported kinds and limits. No separate global bypass state, filter masks or bake action in this milestone.

| Kind | Value | Parameters |
| --- | --- | --- |
| exposure | -5..5 | none |
| brightness, contrast, saturation, temperature, vibrance, highlights, shadows | -100..100 | none |
| hue | -180..180 | none |
| invert, grayscale, sepia | 0..100 | none |
| posterize | integer 2..256 | none |
| threshold | integer 0..255 | none; zero is functional |
| median | odd integer 1..15 | none; source-pixel window |
| mosaic | integer 1..128 | none; source-pixel cell size |
| levels | 0 | `{black:0..254, white:1..255, gamma:0.1..10, outputBlack:0..255, outputWhite:0..255}`; black < white, outputBlack <= outputWhite; existing defaults |
| curves | 0 | `{channel:'rgb'|'red'|'green'|'blue', points:[{x,y},...]}`; 2..16 points in 0..255, x strictly increases from 0 to 255 |

## Bounds, persistence and failure behavior

Initial structural caps: eight entries per raster layer and 64 per document. Count disabled and hidden entries for structural limits. Preflight the enabled processing workload across hidden layers too, since visibility changes must not activate an unvalidated workload. The implemented cap is 384 million weighted source-pixel visits per document: scalar weight 1, mosaic weight 3, median weight 32 + 2 × window size. This is a bounded-work policy, not a latency guarantee. The native owner measured mixed-alpha 1 MP brightness at 43 ms, mosaic16 at 26 ms and median15 at 383 ms; 6 MP median15 took 2,435 ms with a maximum recorded heartbeat gap of 48 ms. These isolated timings are owner-reported and hardware-dependent.

The implementation combines retained nonneutral-group scratch (5 bytes per canvas pixel for each active ancestor) with filter scratch (8 bytes per largest source/geometry pixel plus one byte per canvas pixel), capped at 256 MiB beyond the existing base renderer. This is a scratch accounting limit, not a bound on total process memory. Validation runs before commit/import, including hidden layers; independent metadata-only boundary fixtures verify rejection. Long JavaScript loops yield in bounded row chunks. This improves responsiveness but does not claim a worker-based or fully cancellable filter engine.

Stack commands are graph-only. A failed validation or rendering must preserve revision, graph, preview and referenced assets. Normal undo/redo and reopen retain the exact entry list and parameters. Portable `.prism` current-state bundles preserve this graph and original asset bytes without a format change; native semantic validation must reject malformed or over-budget stacks before import writes. Bundles still omit history explicitly.

## Client behavior

Show a layer-targeted Filters section with the selected layer name, numbered execution order, per-entry enable/edit/opacity controls, reorder and delete, and an explicit Clear action. Distinguish it from adjustment layers that affect the composite below them. Explain protected/nonraster/content-baking restrictions at the control that is unavailable.

State that filters affect this layer in source coordinates and that the current selection does not scope them. Keep a draft while a control is dragged and commit once on release or explicit Apply; do not create a history entry for every pointer event. Key asynchronous state by backend, document, layer and revision, discard stale reads and never automatically unprotect a layer.

## Acceptance fixtures and implementation sequence

1. Missing, disabled and opacity-zero stacks preserve exact pixels; read previews create no revisions or assets.
2. Noncommuting brightness/invert stages produce independently calculated results in both orders; reorder, update, undo and reopen preserve sequence. Threshold zero remains functional.
3. Fractional entry opacity, levels and curves match independent scalar references. Own geometric feather/inversion/clip and bitmap masks apply afterward exactly once.
4. Hidden red RGB around visible blue, plus alpha 1/128/255 samples, verifies median/mosaic weighting, unchanged alpha and unchanged alpha-zero RGB before geometry.
5. Protected-target changes and protection activation with active filters reject atomically; bypassed stacks remain valid. Lower protected footprints block filter changes while background filtering below a soft cutout remains visible.
6. Composite and isolated layer preview agree under nested groups and lower protection. Original/raw-alpha previews remain byte-identical. Own masks, opacity, outside effects and group masks are never applied twice.
7. Paint/fill/place/extract/source-alpha-refinement guards fire before asset writes for every nonempty stack, even disabled entries. Raw subject selection and raw source/mask inspection remain available.
8. Crop/resize/expansion and local affine transformations operate on the already-filtered source: asymmetric median/mosaic fixtures prove source units and absence of double scaling. Duplicate-layer edits do not alter the original entries or curves arrays.
9. Portable export/import/reopen retains groups, saved selections, stack order and immutable assets. Unknown kinds, duplicate entry IDs, invalid ranges and over-budget hidden stacks reject before writes.
10. Official MCP strict revision/backend handling, transaction rollback and real browser editing/reorder/clear/undo pass with no console errors. Record measured timing and event-loop heartbeat behavior rather than promising unmeasured performance.

Implementation order: shared schema and pure stack helpers → render-context/protection separation → classify and guard every asset-baking caller → geometry, preview, persistence and bundle tests → MCP discovery and UI → focused browser verification and capability documentation. Baking, filter-specific masks, blur/sharpen and broader Smart Object functionality remain explicitly deferred.

## Verification record

`tests/layer-filters.test.mjs` (12), `tests/layer-filters-mcp.test.mjs` (1) and `tests/layer-filter-audit.test.mjs` (3) pass together. They cover explicit scalar references, threshold zero, alpha/hidden RGB, alpha-weighted source-space spatial processing before asymmetric geometry, lower protected footprints and isolated previews, source-writing guards, graph-only updates, duplicates, undo/reopen/bundles, malformed graphs, hidden work and combined scratch limits. The audit caught explicit subject selection inadvertently using filtered pixels; the native owner added a raw-filter bypass and regression.

The UI owner reports `tests/layer-filters-browser.mjs` passing four real Chrome workflows, plus unchanged pro and cutout suites. The checks include all 18 available kinds, draft edits without history, stable filter IDs, levels/curves, ordering and undo, threshold zero, odd median validation, bypass/protection guards, raw source preview, preserved source bytes, compact layout and zero browser errors/API-key reads/provider calls. These fixtures verify the scoped stack, not Adobe Smart Object parity.


Channel Mixer and Gradient Map now share the existing filter scope, ordered execution, alpha/source preservation and protection guards. Both use scalar value0 with parameter objects. Work accounting is three source-pixel units for a mixer and five for a gradient map, under the same384-million total; no additional candidate frame is allocated. [Color controls and MCP](COLOR_MAPPING.md) describes percentages, stop order, shallow row/list replacement and current limits.

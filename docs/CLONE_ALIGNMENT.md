# Aligned Clone and Heal

Implemented and verified through eight independent native/session tests and 25 focused/adjacent browser workflows. Native Clone and Heal use the existing explicit source coordinates described below. See [implementation status](IMPLEMENTATION_STATUS.md) and [browser evidence](CLONE_ALIGNMENT_UI_EVIDENCE.md).

**Aligned** keeps the distance between your sampling point and brush across separate strokes. Leave it unchecked to start each stroke at the original sampled point. The initial setting is unchecked, preserving the existing behavior.

Choose **Clone** or **Heal**, Alt/Option-click a sample, then paint. With Aligned enabled, the first completed stroke establishes the offset. Later strokes use that same offset, so a sequence of small repairs follows the source as you move across the picture. Each stroke remains a separate Undo step.

## Sampling and the source marker

The **anchor** is your original Alt/Option-click. The moving crosshair shows the current sample center while painting. After the first aligned stroke, hovering shows the sample center for that destination. These are document coordinates, independent of zoom. A source outside the canvas is allowed: edge samples can contribute partial coverage, and fully outside samples can be transparent. The editor does not move those coordinates back inside the picture.

Each stroke takes a fresh snapshot of its chosen sampling scope. Pixels do not freeze for the entire aligned session. **Current**, **Current & Below**, **All**, and **Ignore adjustment layers** retain their existing behavior. A blank repair layer with Current selected samples its own transparency. Heal continues to calculate its usual local color correction for each stroke; alignment does not change that algorithm. See [retouch sampling](RETOUCH_SAMPLING.md).

## Reset and cancellation

Alt/Option-click again to replace the anchor and establish a new offset on the next completed stroke. Toggling Aligned keeps the anchor but clears the offset. Reset source clears both. Canceling an unfinished gesture with Escape or pointer cancellation does not establish an offset; an earlier valid offset remains available.

Changing document, target, sampling settings or canvas size requires a new sample. In Aligned mode, changing tools, Undo/Redo, an unrelated document edit, disconnection or relevant tool capability change also resets the sample. Your own successfully accepted strokes preserve it, including the native conversion of a transformed target into working canvas pixels. Changing brush settings affects later strokes; the active stroke keeps its captured settings.

A failed, stale or ambiguously interrupted submitted stroke requires sampling again. The editor does not automatically replay it. A request may already have committed when navigation abandons its local response; refreshing can reveal that saved stroke. Clearing the local sample cannot undo a saved edit.

Aligned is a browser-session preference shared by Clone and Heal. It is not saved in the project, a recipe or portable file; reloading starts with it unchecked. Projects retain the resulting edits and original source assets as usual.

## MCP

There is no `aligned` command argument. Maintain a source-minus-destination offset in the caller, and pass the appropriate explicit `source` with each existing `prism_paint_stroke` call. Capture the document revision before the stroke and use its returned document for the next one.

For anchor `(2.5, 3.5)` and first destination `(10.5, 8.5)`, the offset is `(-8, -5)`. A later stroke beginning at `(18.5, 12.5)` therefore samples from `(10.5, 7.5)`:

```js
const anchor = { x: 2.5, y: 3.5 };
const first = { x: 10.5, y: 8.5 };
const offset = { x: anchor.x - first.x, y: anchor.y - first.y };

const firstResult = await prism_paint_stroke({
  backend: 'native', documentId, expectedRevision, layerId,
  tool: 'clone', points: [first], source: anchor,
  sampleMode: 'current-and-below',
  size: 1, hardness: 1, opacity: 1
});

const next = { x: 18.5, y: 12.5 };
const secondResult = await prism_paint_stroke({
  backend: 'native', documentId,
  expectedRevision: firstResult.document.revision, layerId,
  tool: 'clone', points: [next],
  source: { x: next.x + offset.x, y: next.y + offset.y },
  sampleMode: 'current-and-below',
  size: 1, hardness: 1, opacity: 1
});
```

Use a supported root raster target for Current & Below. Stop if a call fails or its outcome is uncertain; inspect the document before deciding whether to continue. Restart behavior instead sends the unchanged anchor for every stroke. Preserve fractional coordinates and do not clamp derived sources. Within a stroke, the native engine follows its captured source offset through all points.

## Scope

Alignment adds no generated pixels, image buffers or native processing budget. Existing source immutability, selection coverage, protected-pixel rules, filter-stack restrictions, stroke limits and persistence checks still apply. This feature does not add multiple saved source slots, transformed sources, cross-document sampling, a sampled-image overlay or Photoshop-equivalent healing.

The [implementation design](CLONE_ALIGNMENT_DESIGN.md) and [independent review](CLONE_ALIGNMENT_REVIEW.md) specify coordinate arithmetic and asynchronous ownership. Adobe's documented Aligned/restart workflow informed the control; the native image algorithm remains Prism's own. See [workflow research](CLONE_ALIGNMENT_RESEARCH.md).

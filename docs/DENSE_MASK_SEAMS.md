# Dense mask storage: concrete integration seams

Status: read-only investigation, 2026-09-19. No new mask representation, limit or command is approved here. Photo Filter is the next bounded editing feature; this document preserves the infrastructure work needed afterward.

## Requirement

The current200000 nonzero-run ceiling rejects continuous Red, Green, Blue and encoded-luma coverage from the original512² photographic fixture. [Measured channel evidence](CHANNEL_WORKFLOW_EVALUATION.md) establishes a normal workflow failure, not merely an adversarial limit. A useful dense-mask design must retain exact alpha8 values and full resolution through editing, history, previews and portable projects. Raising the metadata ceiling or secretly changing coverage is not a solution.

The original RLE representation remains useful for sparse selections and compatible old projects. A new explicitly typed shape can let older readers reject unsupported dense storage while preserving the existing meaning of old bitmap records. Do not attach an optional asset field to a legacy shape that older code would ignore.

## Actual synchronous seams

| Area | Current seam | Required design decision |
| --- | --- | --- |
| Primitive masks | `masks.mjs`: `normalizeMask`, `bitmapBytes`, `maskCoverage`, `bitmapMask`, `transformMask` | Separate metadata validation from asynchronous verified byte preparation. Keep geometric coverage exact and preserve the existing feather/inversion order. No filesystem access hidden in a synchronous callback. |
| Additional layer masks | `layer-mask.mjs`: retained `positioned` source, raw/effective coverage, density and callback estimates | New dense sources must fit the retained source dimensions, domain clipping and translation rules. Raw inspection ignores density; effective inspection includes it. Existing closures can remain live across ancestor and protected-content passes. |
| Source effect masks | `filter-mask.mjs`: source-frame validation, async bitmap preparation, selection capture and whole-stack mixing | Reuse the existing asynchronous boundary, but include verified storage/read buffers and feather scratch. Preserve completed-stack mixing and source coordinates through geometry. |
| Selections | `layer-selection.mjs`, `saved-selections.mjs` | Both active/saved selections and Replace/Add/Subtract/Intersect need prepared input coverage and exact output bytes. Empty coverage must remain an explicit empty selection. Saving a selection may share an immutable asset; editing must create a new one. |
| Painting, fill and segmentation | `raster-ops.mjs` and native paint/fill/selection/mask commands | Selection and starting-mask coverage are currently synchronous. Prepare them before the existing write loop and account for source/output planes together. Preserve frozen Clone/Heal sampling and protected write boundaries. |
| Morphology and preview | `morphology-commands.mjs`, `mask-preview.mjs` | Morphology may create dense results even from simple inputs. Grayscale mask inspection must keep its no-RGB-read contract while explicitly permitting the referenced alpha asset read. |
| Canvas changes | `canvas.mjs:resizeCanvasMask`, native crop/resize/resize-canvas loops | Update active selection, all saved selections and relevant additional masks atomically. Cropping baked feather must not invent new edges; expanding an inverted mask must not select newly exposed canvas. Source filter masks retain their independent source frame. |
| Rendering and protection | native `renderGraph`, layer preview and contextual rendering | Many direct `layerMaskCoverage` calls coexist across groups, clipping and protection. A single eager graph-wide decoded-mask cache would add all planes simultaneously; its cost cannot be treated as one sequential maximum. |
| PSD export | `psd-native.mjs:exactMask` and preparation estimates | Exact byte representability and retained PSD mask planes need prepared dense coverage. Export reports must distinguish storage support from unsupported Photoshop semantics. |
| Persistence and transport | common typed asset walker, native history/startup, `.prism`, public projection | Enumerate references in active/saved selections, direct/positioned layer masks and filter-stack masks, including hidden/disabled/history-only uses. Verify dimensions, type, length and digest before publication; retain old assets for Undo and clean only newly owned files on rollback. |

The existing bitmap callback can own a full alpha plane plus a four-byte distance plane during feather construction. Two callback sets may coexist for current rendering and original protected context. Color Lookup and Distort now have stronger joint resource ledgers; dense-mask reads and callbacks must enter those same simultaneous phases. Simply adding one mask plane to a previously separate passing check would repeat the allocation gap already fixed for Color Lookup.

## Storage and lifetime questions to resolve

1. Compare an immutable exact-length raw alpha8 asset with a lossless encoded alpha asset. Raw bytes have simple validation and predictable decode ownership, but larger retained storage and bundle size. An encoded format needs strict channel/depth/dimension validation, bounded decoding and an honest simultaneous encoded/decoded ledger. Do not infer alpha semantics from an arbitrary image filename or MIME type.
2. Define canonical metadata, typed alias rules and publication ownership before adding any producer. A resolver receives a verified descriptor, not an arbitrary local path. New mask type use must fail before image I/O when metadata is malformed, even if the mask is hidden or currently bypassed.
3. Use explicit per-operation preparation/lifetimes. Do not put decoded arrays on persisted graph objects, public API records or module-global caches. A prepared coverage callback may capture bytes only for its declared phase. If deduplication retains several decoded masks, admit their sum and any overlapping distance/encode planes.
4. Decide retained-history storage admission from representative24MP edits, not by copying the LUT64MiB ceiling: a single uncompressed24MP mask is already24MB. Existing16MiB graph metadata and256MiB portable-bundle limits still apply. A larger blob history policy requires its own measured disk/cleanup design; no limit increase is assumed here.
5. Keep asset publication atomic with the command or transaction. Selection combination, canvas changes and morphology can create several candidate assets before a later operation fails. Reuse the established newly-owned rollback context, and never delete an asset shared with another history state or document.
6. Keep old RLE results byte-identical. If a producer chooses dense storage only after an exact RLE result would exceed its ceiling, that is a representation choice with identical pixels, not permission to soften, downsample or threshold the selection. The choice must remain deterministic and supported by capabilities throughout client/API/portable handling.

## Smallest useful acceptance slice

The first complete producer should exercise the blocker directly: continuous composite channel coverage on the original512² photograph and a1MP high-frequency fixture, with exact output bytes. It must also survive saved-selection reuse, a masked color adjustment, painting under the selection, crop/resize-canvas, Undo/restart and portable transfer. Unsupported dense-mask edits must fail explicitly until their consumer is implemented; do not accept a graph that ordinary rendering or history cannot read.

Independent tests need mixed RLE/dense combinations, alpha0/1/128/255, inversion-stage distinctions, feathered crop boundaries, positioned mask sources larger than the canvas, protected/generated clipping, malformed inactive descriptors, shared asset aliases, late transaction failure and real persistence failure. A resource review must enumerate simultaneous callbacks and preparation buffers before any new kind is registered.

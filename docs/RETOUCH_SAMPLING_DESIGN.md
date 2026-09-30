# Repair layers and clone/heal sampling

Status: implemented and verified in the native backend on 2026-09-19. UI/browser release evidence is maintained by its owner. This is the frozen native contract.

## Purpose and comparison

Repair a defect on a separate raster layer without baking the document's adjustment layers into the sampled repair. Adobe describes Current Layer, Current & Below and All Layers for Clone Stamp, and separate-layer retouching with adjustment layers excluded. These are workflow references, not a claim of identical Photoshop healing or compositing. [Adobe Clone Stamp sampling](https://helpx.adobe.com/photoshop/desktop/repair-retouch/heal-clone/retouch-images-with-the-clone-stamp-tool.html), [Adobe nondestructive editing](https://helpx.adobe.com/photoshop/using/nondestructive-editing.html).

This milestone retains the existing sampled healing kernel: a frozen source patch plus a local mean-color correction. It adds neither content-aware reconstruction nor model calls.

## Public commands and capabilities

`paint_stroke` adds optional `sampleMode: 'current' | 'current-and-below' | 'all'` and `ignoreAdjustments: boolean` **only for clone/heal**. Defaults are `all` and `false`, preserving existing behavior. Explicit sampling options on any other tool reject. `current` with `ignoreAdjustments: true` rejects because no adjustment layers participate in that mode.

`create_repair_layer { documentId, expectedRevision?, sourceLayerId, newLayerId?, name? }` inserts a transparent ordinary raster immediately above the named source. `newLayerId`, when supplied, must be a valid lowercase UUID and absent from the graph; it allows a following transaction stroke to name the new layer without aliases. This retains the existing persisted graph ID convention without silently changing caller references. Standalone returns `{document, layerId}`. The command is allowed in `apply_transaction`, where the normal transaction response contains the resulting document and the caller already knows its chosen ID.

Capabilities are `retouchSampleModes: ['current','current-and-below','all']`, `retouchSamplingTools: ['clone','heal']`, `retouchIgnoreAdjustments: true`, `retouchCurrentAndBelowScope: 'root-target'`, and `repairLayerPlacement: 'above-root-raster'`. Existing graph, brush and rendering limits remain the limits; no new total-memory guarantee is advertised.

## Frozen sampling semantics

| Mode | Frozen source | Scope restrictions |
| --- | --- | --- |
| `current` | Target working raster, combined with source cutout alpha, then current geometry. Excludes its additional mask/density, opacity, visibility, blend, styles, ancestor context, clipping contribution and generated display exclusion. | Any otherwise paintable raster. Existing protected-target and **any nonempty filter stack** guards still apply. |
| `current-and-below` | Normal document rendering through the complete root containing the target, inclusive. The target must itself be that root raster. | Target has no parent and participates in no clipping chain, as either base or member. Other complete lower groups/chains are supported. |
| `all` | Normal complete document rendering, including visible layers above the target. | Existing clone/heal target restrictions; grouped and clipped targets retain legacy support. |

`ignoreAdjustments` skips only adjustment-layer branches in either composite mode, including adjustments inside complete lower groups. It does not disable source raster filter stacks, masks/density, opacity, styles, blend modes, group compositing or generated/protected display rules. Thus an already filtered source remains filtered when sampled.

The existing destination pixels are included once: source-oriented working pixels in `current`, or their ordinary visible contribution in composite modes. The map is frozen before the stroke, and neither clone sampling nor healing color correction reads newly written output. Later strokes may sample committed earlier repairs. Hidden/zero-opacity target roots still establish the Current & Below cutoff; traversal must stop by root index **before** any visibility skip.

Source and stroke coordinates remain current document coordinates, with existing pixel-center and premultiplied bilinear sampling. The translation offset is `source - points[0]` throughout a stroke; out-of-image samples are transparent. There is no cross-document sampling or persistent aligned-source state. Healing uses the same chosen map for its source and destination-ring means.

## Rendering implementation boundary

Readonly options on `renderGraph`, `ignoreAdjustments` and `stopAfterRootId`, operate against the validated **original graph/tree**. The root cutoff validates before output allocation. A complete root prefix is selected without slicing the flat layer array, rewriting ancestors or splitting clipping runs. Existing protection and filter compositing run unchanged. No rendering option is persisted or exposed as an arbitrary public graph renderer. The small `server/retouch-sampling.mjs` helper owns option validation, root eligibility and frozen-buffer aliasing.

For `current`, alias the already frozen target buffer as the sample buffer. `applyStroke` copies its output and never mutates either input, so an extra full-canvas RGBA allocation is unnecessary. Ordinary `all/false` keeps the original renderer path.

The **write gate always computes protection from the complete original graph**, independently of sample scope or skipped adjustments. Visible protected layers above the target still forbid writes at their footprints. Sampling protected colors is readonly; it does not waive protection. Active selection affects destination coverage only. Explicit empty selections remain restrictive.

Existing raster writing semantics remain: paint into transformed canvas-sized working pixels, bake source cutout alpha once, reset geometry and remove the now-baked `alphaAsset`; retain immutable `sourceAsset`, additional mask/density, styles, role, parent/clipping links and other existing metadata. Nonempty target filter stacks continue to reject, even if entries are disabled.

## Repair layer creation and atomic assets

The placement anchor must be a root raster outside any clipping chain (both base and member are excluded). It may be protected, filtered, hidden, transformed or generated: creation never writes it. The empty new layer uses normal blend, opacity 1, visible true, role `paint`, canvas dimensions and an empty transform list. It has no inherited masks, effects, filters, protection, source job provenance or persistent link to the anchor. Its original blank PNG is its own immutable `sourceAsset`.

Creation validates source, capacity, UUID and name before writing an asset. A protected source remains protected: an empty repair layer above it does not make repairs over that protected footprint legal. Creation from generated content does not mislabel ordinary painted pixels as generated.

Standalone creation and transactions **containing creation** wrap the entire private mutation-to-commit lifetime in an asset collector under the existing native serial queue. An instance-owned `AsyncLocalStorage.run` scopes awaited descendant writes and restores its context automatically; unrelated direct asynchronous writes are not collected. `storeAsset` records a hash only after this operation successfully publishes it with `fs.link`; `EEXIST` is never owned. Existing explicit collectors and the active repair collector both receive new links. Later operations in the same transaction contribute their newly published assets to the same collector. On any mutation, validation or prepublication persistence failure, remove only these owned new blobs; retain preexisting deduplicated assets and the prior project/history/cache. Successful commit keeps all assets. If an injected extension publishes a project and then throws, cleanup conservatively retains its referenced blobs rather than corrupting the published project; the normal persistence path has no asynchronous failure stage after publication. Cleanup failure reports `REPAIR_ROLLBACK_FAILED`. Other ordinary command paths do not gain different cleanup semantics in this milestone.

An optional caller UUID permits a single transaction of create then clone/heal, yielding one revision and undo step. Stable transport request IDs retain existing retry behavior. No pending transaction aliases, external writes, provider calls or new persisted graph fields are introduced. Undo, reopen and portable projects naturally preserve the resulting ordinary raster layers and original sources.

## Resource and scheduling limits

Retain 8192-pixel axes, 24 million canvas pixels, 64 layer nodes, 2000 stroke points, 100,000 planned dabs, brush size at most 512, and 60 million weighted brush sample visits. Clone/heal sample cost remains four per visit. Existing group/filter/clipping scratch and filter-work preflights continue to validate the complete graph, including hidden nodes, before rendering.

For canvas size `N`, the stroke phase can retain target `4N`, composite `4N`, output `4N`, protection `N`, brush coverage up to `2N`, and a feathered selection callback up to `5N`: approximately **20N binary bytes**, before encoded inputs, source decoding/geometry, rendering and PNG staging. Current mode aliases target and sample, saving `4N`. Source rendering retains target while allocating its normal render/geometry scratch; full protection rendering retains both target and sample. PNG encoding can retain those buffers plus codec working storage and encoded output. The existing 256 MiB group/filter scratch budget is **not** a cap on total operation memory or RSS.

The new sampling modes introduce no additional full frame beyond the legacy all-layer path: current aliases; the root-prefix renderer narrows traversal; ignored adjustments skip work. Tests will inspect call paths and buffer identity rather than claim garbage collection or native-codec memory is immediately released. Existing affine, composite, brush and bitmap-feather loops remain synchronous but bounded; this milestone does not claim fully nonblocking painting.

## Required acceptance

1. Exact default/explicit-all equivalence; current copies only target working/cutout-alpha pixels despite hidden/opacity/mask/style settings. Assert current aliases its frozen target and does not render a composite.
2. Current & Below excludes upper colors/adjustments, includes preexisting repair pixels, stops at hidden/zero-opacity target roots, and renders complete lower nested/isolated groups and clipping chains normally.
3. Ignore adjustment layers prevents double grading on a repair beneath a grade; source filter stacks remain sampled. Healing and overlapping clone strokes use frozen inputs.
4. Invalid mode/tool combinations, nested/clipped cutoff targets, protected/filtered write targets, invalid/colliding UUIDs and stale revisions fail without publication. Invalid sampling options reject before asset/model/render work where the required information is available.
5. Full-graph protection still blocks protected content above a scoped sample; soft/empty selections, alpha and immutable sources remain exact.
6. Create+stroke transaction has one undo/redo step and stable preallocated ID; persistence and late-transaction failures remove every newly owned asset, including repair and stroke outputs, without removing reused assets or disturbing project/cache. Retry, reopen and `.prism` preserve results.
7. Native, schema/MCP and browser controls agree. The explicit UI repair action may select Current & Below + Ignore adjustments **only after successful creation**; ordinary clone/heal defaults remain All Layers and false.

## Verification

The owner suite `tests/retouch-sampling.test.mjs` has 13 passing cases, including the current-buffer identity, frozen clone/heal equivalence, complete lower scopes, ignored grades versus retained source filters, complete write protection, source/cutout alpha, atomic transactions, portable/reopened projects, real `ENOTDIR` publication failure, reused blank assets, explicit collectors and unrelated asynchronous publication. The independent audit reported six passing cases with no blocker. The official MCP workflow and two schema tests also pass. A separate 67-test owner/adjacent sweep includes existing native painting, clipping, cutouts/protection, groups and isolated groups.

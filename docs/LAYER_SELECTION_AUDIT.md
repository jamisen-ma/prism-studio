# Independent layer-to-selection audit

Verified September 19, 2026. The independent [audit suite](../tests/layer-selection-audit.test.mjs) passes eight tests. This records proof for the bounded native contract in [LAYER_ALPHA_SELECTION_DESIGN.md](LAYER_ALPHA_SELECTION_DESIGN.md), not complete Photoshop channel parity.

Adobe documents separate layer and mask selection sources and replace/add/subtract/intersect actions. Its UXP API describes layer transparency as selection values. Neither page specifies all density, clipping, group and rounding behavior; those choices are explicit native semantics. [Adobe boundaries](https://helpx.adobe.com/photoshop/using/load-selections-layer-mask-boundaries.html), [Adobe Selection.load](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/selection#load).

## Verified behavior

- A transformed raster fixture uses its edited working alpha and independent source cutout alpha once, with exact integer placement. A different retained original, hidden/faded isolated parent, source visibility/opacity zero, additional mask/density, Dissolve, outside shadow and editable RGB filter cannot change the loaded source silhouette. Loading writes no image asset and invokes no segmentation callback. Source layers and saved selections remain unchanged.
- Additional raw/effective masks work on groups, adjustments and a protected raster whose pixel asset is missing. Mask-only loading performs no source render/stat. An independent feathered, inverted and canvas-clipped rectangle oracle checks density 0/0.5/1, byte complement and all four combination modes. Raw means evaluated mask settings before density; it does not mean unprocessed stored runs.
- Source coverage quantizes before command inversion. A density-produced half coverage becomes 128, then command inversion becomes 127. Combination matches the existing named-selection helper for 200 seeded alpha pairs, fractional geometric coverage, bitmap feathering and inversion. No density/clip/feather metadata remains on the materialized result.
- A clipping member with generated provenance loads its own working alpha rather than its base window or protected display exclusion. A later adjustment and generated-edit snapshot still preserve the lower protected person. A clipping base loads its own transparency.
- Fully transparent content produces an explicit empty bitmap. A transaction loading it, saving it and adding an adjustment changes no rendered pixels and makes one undo entry. AI selection preparation rejects that empty scope. Undo restores the previous null selection; null and empty are never interchanged silently.
- Undo, reopening and `.prism` transfer preserve the selected bytes without changing immutable assets. Stale revisions, invalid targets/options, missing masks, missing raster files and injected save failure preserve the graph, history, revision, preview cache and files. Native run-complexity rejection also rolls back without publication.

## Resource evidence and limits

An independent phase ledger enumerates retained original, previous and next geometry frames, separate alpha combination, encoded source bytes, procedural input, materialized alpha and active-mask callback storage. It agrees with the estimator across six content types and raw/effective bitmap masks. At the exact 256 MiB accounted-byte limit, a controlled renderer is reached; one byte above it rejects first. A 24 MP affine fixture rejects before allocating raster output.

The estimate is a conservative bound on the named byte buffers, not process RSS, image-library caches, JavaScript metadata or operating-system allocation. Asset-size preflight assumes ordinary immutable application assets remain unchanged between stat and decode. Existing bitmap-feather preparation and affine geometry contain synchronous work; the new alpha/combination/RLE loops yield at bounded rows. A one-megapixel encoder heartbeat fixture confirms it yields before completion. Canonical RLE rejects after the 600,000-scalar bound, and the native project/history metadata limit remains enforced at commit.

No independent correctness defect remained after this audit. SDK/schema and real-browser checks are owned and reported separately; this document does not substitute for those results.

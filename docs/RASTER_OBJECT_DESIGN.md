# Reusable raster sources and layer style presets

Status: the outside-style preset milestone is now implemented in the native backend, shared/MCP commands and portable-project validation. Nine focused native/pure tests, one official SDK test and four independent audit tests pass. Client verification is tracked separately. The linked-raster and full-source-renderer sections remain design only.

## Recommendation

Implement **named outside-style presets next**, then a separately reviewed **same-document linked raster source** milestone. Defer a full-source transform renderer. Presets provide a useful repeated-layout operation—apply the same white outline and shadow to several cutouts in one undo step—using already tested rendering and protection rules. Linked source replacement affects more invariants and is not a prerequisite for this benefit.

| Option | User benefit | New rendering or persistence risk | Recommendation |
| --- | --- | --- | --- |
| Named outside-style presets | Reuse a cutout outline, shadow and glow; apply consistently to multiple layers | Small metadata library; existing outside-style renderer and graph budgets remain authoritative | Next milestone |
| Same-document linked raster sources | Replace one underlying picture in several independently transformed instances | Shared identity, atomic fan-out, source provenance, raster-write guards and protected-content interactions | Subsequent bounded milestone |
| Full-source transform objects | Recover off-canvas pixels and avoid repeatedly sampling earlier transformed rasters | New source-to-document geometry model, crop semantics, sampler and filter/protection scratch accounting | Separate renderer project |

Do not describe a hash-sharing duplicate as a live linked object, or the current transform list as lossless repeated transformation.

## What the engine actually does today

- `duplicate_layer` deep-copies the selected subtree, allocates new layer IDs and retains the same immutable asset hashes. Masks, filter entries, transforms and effects are independent metadata copies. Painting one copy publishes a new working hash only on that target. Sharing bytes on disk is storage deduplication, not a shared editable source identity. See [native structural mutation](../server/native.mjs).
- A raster has working `asset`, read-only original `sourceAsset`, optional source-space `alphaAsset`, source `width/height` and a transform list. Working and alpha PNGs must match those source dimensions. Original encoded bytes may have different dimensions from a placed working raster and preserve their original format. Rendering uses `asset`, not `sourceAsset`.
- The current order is working decode → source alpha → editable filters → sequential geometry → own mask/opacity → outside decoration and compositing. Each affine/crop/resize/canvas stage consumes the previous stage's raster. Earlier clipping and interpolation cannot be recovered just by reversing a later transform. Re-rendering starts from the immutable working asset, but still repeats those intermediate stages. See [filter design](FILTER_STACK_DESIGN.md) and `renderLayerGeometry`.
- Paint/fill bake the rendered geometry and source alpha into a new canvas-sized working asset, reset transforms and remove `alphaAsset`. They retain `sourceAsset`. Any filter stack, including disabled entries, blocks these writes. A future source link must not silently survive such a bake.
- `place_layer` finds current visible alpha bounds, crops and proportionally resizes them into target-canvas working/alpha assets. It preserves an original source reference for inspection, but the placed working raster is a snapshot; future source refinements do not update it. Placement rejects nonneutral source ancestors and every nonempty filter stack.
- Cutout extraction shares working RGB while publishing a separate alpha image. Source-alpha repair is currently limited to unplaced, untransformed source cutouts. That restriction is deliberate: it allows restoring missed details from unchanged working RGB.
- Protection blocks direct pixel changes, opacity changes and nonuniform scaling on protected content. Hidden and fully masked protected members still matter. Filters and AI use context-sensitive lower protected footprints; generated layer role/provenance must not be dropped to bypass this behavior.
- `.prism` stores the current graph and referenced `asset/sourceAsset/alphaAsset` blobs, with no history. Asset references are enumerated explicitly; graph root fields are allowlisted. It is not sufficient to add a new source table to native validation and assume the archive automatically includes it. See [bundle codec](../server/project-bundle.mjs).

## Proposed next milestone: outside-style presets

### Representation and commands

Add optional `graph.layerStyles`, absent on existing documents. It is a document-local array, maximum **32** entries:

```js
{
  id: "server UUID",
  name: "White portrait outline",
  outline: { width: 6, color: "#ffffff" }, // optional
  effects: { shadow: { color: "#000000", opacity: 0.35, blur: 8, x: 4, y: 6 } } // optional
}
```

The only captured properties are outside outline, drop shadow and outer glow. Use the existing effect normalizer and integer outline width 0–64; reject unknown fields. Names are trimmed, 1–200 characters. Canonical presets omit a zero-width outline. Reject structurally disabled presets: require a positive outline width or an effect with positive opacity. This is a settings check, not a rendering promise: hidden, empty or full-canvas layers may save reusable settings; zero-blur, zero-offset effects can produce no outside pixels. Do not capture layer opacity, blending, masks, filters, source pixels, protection or geometry. Existing native fractional-outline metadata remains readable, but preset capture rejects it without rounding.

| Command | Additional arguments | Semantics |
| --- | --- | --- |
| `save_layer_style` | `layerId, name?, styleId?` | Copy the selected content layer's current outside style. Without ID, create; with ID, replace that preset while retaining its ID. Existing preset name is the fallback when replacing. |
| `apply_layer_style` | `styleId, layerIds` | Apply a deep copy to 1–64 unique content targets as one atomic edit. Replace both style slots: a missing outline/effects slot in the preset clears that slot on each target. |
| `rename_layer_style` | `styleId, name` | Rename without changing any layer. |
| `delete_layer_style` | `styleId` | Delete the saved preset; previously applied layer styles stay unchanged. |

All commands include `documentId` and the ordinary expected-revision argument and participate in `apply_transaction`. No global user library, disk path, preset file, external account or live-linked style is introduced. `get_document` exposes the small saved list; capabilities advertise `maxLayerStyles:32` and `layerStyleProperties:['outline','shadow','glow']`.

Application is copy-based. Updating a saved preset does not restyle previous targets. A new apply does so explicitly and reversibly. Do not add hidden automatic restyling during render.

### Protection, units and geometry

Groups and adjustments cannot save or receive these content styles. Existing content types, including protected cutouts, can receive them because the current outside renderer excludes all occupied source pixels. The preset neither unprotects a target nor changes its RGB, alpha, mask or layer opacity. Generated targets retain all dynamic clipping rules and must not cast ghost decoration from excluded pixels.

All lengths remain **current canvas pixels**, matching existing outline/effect controls. Crop, resize and canvas expansion leave saved presets unchanged, just as a reusable numeric style should not be rescaled by every document edit. Applying to another canvas uses the saved values literally. This version does not implement relative-to-object sizes, inner effects, strokes inside the subject or arbitrary material effects.

Normalize every selected target and validate the whole staged graph before commit. The existing padded-effect 32-million-pixel check applies at current canvas dimensions and includes hidden targets. Under today's 8192-axis/24 MP/blur64 limits, the worst padded surface remains below 32 MP, so a valid document cannot naturally trigger this particular bound. Retain the preflight invariant if other limits change; do not invent an unreachable test fixture. Merely retaining an unused preset needs no render scratch.

Changing styles changes the document revision, invalidates previews and makes outstanding AI snapshots stale normally. The existing current protection-footprint computation includes rendered decoration; do not bypass it in a preset command.

### Persistence and acceptance

Add `layerStyles` to the bundle graph-root allowlist and semantic validation, with stable UUIDs and deep-copy guarantees. No new image references or archive asset-count limit are needed. Older files without a library behave identically. Old application builds may reject a bundle containing this new optional graph field; advertise required capability and do not claim older-build compatibility. Native metadata remains capped at 16 MiB, including history; bundle limits remain unchanged.

Required tests:

1. Save, rename, overwrite at capacity, delete, undo/redo and reopen preserve IDs and normalized settings. Library edits do not alter pixels.
2. Apply to a patterned source with alpha 0/1/128/255 preserves every occupied source pixel and immutable source/working/alpha asset byte; only outside decoration changes.
3. Multi-target apply is one history step. One invalid/missing/group/adjustment target rejects all targets, revision and preview unchanged. Inject a staged validation/resource failure to verify that no partial candidate is published.
4. Preset and target nested objects are independent. Editing a target or overwriting/deleting its originating preset does not alter the other.
5. Missing slots clear prior styles predictably; selections, masks, filter stacks, parents, order, opacity, blending and protection remain exact.
6. Generated/protected stacking and ancestor-clipped shadow fixtures still pass, including fully clipped AI content producing no ghost shadow.
7. Crop/resize/expansion do not change saved numeric values; full graph validation includes every applied target, including hidden targets, before commit.
8. `.prism` roundtrip preserves the library and current rendering, with fresh document identity/history as before. Unknown fields, duplicate IDs and excessive entries reject before asset writes.
9. MCP can save/apply to several selected cutouts; browser confirms copy-based behavior, revisions, undo and compact-layout controls.

Implemented files are [layer-styles.mjs](../server/layer-styles.mjs), the native validator/dispatcher, and the bundle graph allowlist/validator. `updatedLayerStyles` produces a staged candidate without mutating its input; native whole-graph validation precedes assignment. [Focused tests](../tests/layer-styles.test.mjs) and [independent audits](../tests/layer-styles-audit.test.mjs) verify these guarantees, including disk publication failure, malformed portable metadata before writes, protected source bytes and generated ghost-shadow suppression. Saved libraries never write image assets. The independent audit also confirms exact equivalence between applying a preset and issuing the existing direct outside-style commands.

## Bounded linked-source milestone after presets

### Representation without a second asset registry

For the first version, retain existing raster records and add optional `layer.rasterObjectId` (document-local UUID). All records with the same object ID must have an identical **source descriptor**:

```js
{
  asset, sourceAsset, sourceFormat, sourceBitDepth,
  width, height,
  alphaAsset, // optional, shared source alpha
  cutout     // optional, copied source-segmentation provenance
}
```

Treat this as a small validated link set, not a pointer to whichever layer happens to be first. Every member carries the same descriptor so existing renderers and asset enumerators still receive valid raster layers. Native validation rejects disagreements instead of choosing a winner. Compare normalized optional fields, not object property insertion order. `rasterObjectId` is forbidden on nonraster layers; IDs are scoped by document. One-member sets are valid and require no orphan registry entry.

Keep transform lists, filter stacks, masks, opacity, blending, visibility, name, parent, outside effects and protection independent per instance. Existing hashes alone never imply linkage. Maximum **16 distinct raster objects per document**, subject to the existing 64-node limit. No nested document object, external path, URL, file watcher, cross-document live link or object recursion.

This denormalized first representation avoids a new asset table and preserves the current 192-asset maximum. It trades a small repeated descriptor for lower integration risk. A future canonical object registry requires an explicit graph/archive migration and must not be smuggled in as renderer-only metadata.

### Proposed commands

| Command | Additional arguments | Behavior |
| --- | --- | --- |
| `create_raster_instance` | `layerId, name?` | On an eligible raster, assign an object ID if needed and create a new linked instance immediately above it in the same parent. Deep-copy instance settings and retain source hashes. One edit; no image write. |
| `detach_raster_instance` | `layerId` | Remove only this member's object ID. It keeps exact asset references, pixels, settings and immutable originals. No image write; other members remain linked. |
| `replace_raster_object_source` | `objectId, sourceLayerId` | Explicitly replace every member's source descriptor from another eligible raster in the same document. Require the same source width/height exactly. Preserve each instance's transforms and styling. One edit and one revision. |

All require an **explicit expected revision** because they can affect more than one layer. Return `affectedLayerIds` alongside the normal document result. `get_document` shows object IDs; a derived object summary may list member IDs/source dimensions without inventing a persistent master layer.

Replacement accepts an already imported native raster layer rather than new binary upload plumbing. It copies **underlying source descriptor**, not the candidate's composite appearance, filters, own mask, opacity, effects or transformed geometry. UI/MCP must say this clearly and offer raw source/mask inspection before replacement. Reject a candidate with any filter stack, `placement`/`origin` metadata, generated role/job provenance, or membership in the destination set. Allow ordinary source cutout alpha, but replace it as part of the descriptor rather than retaining the old subject mask against a new picture.

Source dimensions must match; do not silently fit, distort, crop or change source-space filter radii. Different-size replacement, choosing original-versus-working source, relinking files and recovery of prior source versions are deferred. Replacement updates `sourceAsset` to the new source; old bytes are never overwritten and remain referenced by earlier native history. A current-state `.prism` export carries current referenced sources only, so old replaced originals are not promised as an embedded source archive. Detach a copy before replacement if an old source must remain in the portable current graph.

### Eligibility, protection and explicit restrictions

- Initially create instances only from ordinary raster/cutout sources without placement/origin or generated provenance. Existing instance-local transforms and masks may remain; linking does not promise off-canvas recovery. Source provenance fields must remain shared/coherent after replacement.
- `duplicate_layer` retains its independent-copy meaning. For every copied raster in the duplicated subtree, remove the copy's object ID; do not silently join the source's link set. Users choose `create_raster_instance` for live links.
- Painting, filling, extraction, source-alpha painting/refinement and any future destructive bake reject a linked member with `LINKED_SOURCE_ACTIVE`. Require explicit detach first, even for a one-member set. Never implicitly detach, broadcast a brush stroke, or leave divergent descriptors behind one ID. Raw subject selection and read-only previews remain available.
- Instance filter edits, masks, transforms, effects and neutral-group moves stay independent and obey current protection rules. Source replacement retains filter entries exactly, with source-pixel coordinates meaningful because dimensions are identical. Work/scratch is still charged per rendered instance; sharing a hash must not incorrectly divide the filter workload.
- If **any member is protected**, even hidden or fully masked, replacement rejects with `PROTECTED_LAYER`. Creating a linked copy or detaching is pixel-neutral and can retain protection. No command auto-unprotects.
- For the bounded first version, shared source replacement also rejects if **any other protected content exists in the document**, including hidden content. A changed upper instance could otherwise paint over protected pixels; changing raw source has no existing contextual write-mask gate. This conservative restriction is intentionally stronger than current background filtering. A later implementation can replace it with a reviewed, stacking-aware source-change gate. Do not silently clip or recolor the new object to pass protection.
- Generated content and derived job provenance are excluded from linking/replacement initially. A shared replacement must not carry a job receipt onto multiple independently replaceable sources, remove required dynamic clipping, or cause generation dedup to confuse an unrelated installation with a live job.

### Geometry, groups, previews and archives

Groups keep their canonical DFS structure. Instance creation inserts a sibling, records `parentId` correctly and preflights node/depth/scratch limits. Group duplication detaches copied members as stated above. Deleting one eligible member does not change the others; normal protected deletion guards remain.

Source dimensions belong to the descriptor and do not change when the document is cropped/resized/expanded. Each member gets the same existing document geometry operation once. Local transforms remain separate; current sequential sampling and clipping remain explicit limitations. Replacing matching source dimensions leaves transform chains valid and does not change masks anchored in document coordinates.

Layer previews render the current member context, source view reads its current original `sourceAsset`, and mask view reads the shared source alpha. No file is rewritten during preview. A replacement increments revision once and invalidates the document preview cache; same-document AI jobs become stale and retain their result for review normally.

The current bundle codec already enumerates each member's three source hashes and deduplicates identical bytes. A new validator must verify link-set agreement on both reopen and bundle import before writes. Retain object IDs on bundle import because IDs are document-scoped; the fresh document identity prevents a live link to the originating project. Normal cross-document placement remains a detached raster snapshot and must never copy an object ID. PSD export may flatten each eligible instance independently, but its compatibility report must explicitly warn that live linkage is not portable. Generated content remains excluded by the existing strict PSD boundary.

### Resource, atomicity and acceptance requirements

No network or new filesystem source is needed for these graph-only commands. Validate all IDs, candidate assets/descriptors, matching dimensions, protected members, source provenance, target eligibility and staged graph resources before commit. Candidate blobs already exist; nonetheless use the same asset integrity/dimension checks as portable import when establishing a new shared source. Read/decode once per unique candidate hash rather than once per member. Bound 8192 axes, 24 MP, 16 objects, 64 nodes, eight filters per layer/64 per graph, 384-million filter work, 256 MiB scratch and 16 MiB persisted metadata as before.

Meaningful fixtures:

1. Existing ordinary duplicate/paint behavior is unchanged. Linked create and detach preserve raw RGBA, source/alpha hashes, rendering and history semantics without new asset writes.
2. Same-dimension replacement updates all and only linked members, preserving independent transforms/masks/filters/styles/parents. One undo restores the previous descriptor and exact preview; redo/reopen retain linkage.
3. Ordinary duplication of one member or a group detaches every copy, while the originals retain their link set. Placement into another document never creates a cross-document link.
4. Painting/refinement/extraction reject before writes until explicit detach, including one-member objects and disabled-filter cases. Detach permits applicable old operations under their existing guards.
5. Any protected member or other protected content, hidden/full-mask included, blocks replacement atomically. Create/detach remain pixel-neutral; no implicit unprotection occurs.
6. Mismatched dimensions, generated provenance, stale revisions, malformed descriptors, duplicate/missing IDs and over-budget fan-out reject without asset/history/preview changes.
7. Independent filter stacks with spatial source units still render independently after replacement; workload sums members rather than distinct hashes.
8. Shared cutout alpha remains coherent. Replacement cannot retain an old person's alpha/provenance against new RGB. Source-mask repair requires detach, and original source bytes remain exact.
9. Portable export/import preserves links within the new document, deduplicates identical blobs, resets history as before and never links back to the source document. Crafted inconsistent links reject before publication.
10. Persist-failure injection and transaction rollback leave every member and source reference unchanged. A successful multi-member operation invalidates cached previews once at the committed revision.

## What a later full-source renderer needs

True full-source instances need a distinct immutable source coordinate frame and an explicit mapping from it into the document. Consecutive affine edits should update a cumulative mapping rather than repeatedly resample intermediate canvases. Canvas bounds should clip only at final output when the selected operation means a bounds change. An intentional crop that permanently limits object content needs its own source-space clip contract; source/own/group masks must not be conflated.

A complete design must define pixel centers, transform order and pivots, document resize/crop interactions, source-space filters and cutout alpha, resampling kernels, integer-translation byte-exact paths and contextual protection of both filtered/unfiltered geometry. It must also preserve older sequential graphs on reopen rather than silently changing their rendered pixels. Test move-off-canvas-and-back, scale-down-and-back, transform replacement, soft-alpha fringes and masks independently. Existing `sourceAsset` alone does not contain the layer's edited working pixels, so substituting it as the render base is not a valid migration.

This work is valuable, but is larger than a duplicate-source metadata feature. Keep the product terms and capability limitations accurate until that renderer is independently verified.

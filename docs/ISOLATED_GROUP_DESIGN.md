# Isolated group compositing

Implemented and verified after reusable styles. Thirteen backend tests and four browser workflows cover this contract; the full suite passes455 tests. See [user behavior](GROUP_COMPOSITING.md) and [independent audit](ISOLATED_GROUP_AUDIT.md).

Adobe distinguishes pass-through groups from groups whose children are composited first and then blended with the surrounding image. In an isolated group, internal adjustments and blend modes operate on the group's contents rather than the outside backdrop. Prism can implement these general compositing semantics using its own existing blend engine; this does not promise Adobe-identical rendering. [Adobe group blending](https://helpx.adobe.com/photoshop/using/layer-opacity-blending.html)

Clipping chains are a separate feature: successive upper layers use a base layer's nontransparent content as a mask, with additional group-blending rules. They remain deferred until their graph and protection semantics have independent tests. [Adobe clipping masks](https://helpx.adobe.com/photoshop/using/revealing-layers-clipping-masks.html)

## Implemented contract

- Add group `mode:'isolated'` beside the existing `mode:'pass-through'`. Existing projects retain their current mode and pixels without migration.
- `set_group_compositing {documentId,expectedRevision?,layerId,mode,blendMode?}` sets the two fields atomically. Pass-through requires normal; isolated supports the existing advertised native blend modes. Omitted blend defaults to normal. The UI presents Pass through separately from isolated Normal and other blends.
- Existing `set_layer` may change a group's blend only when that group is already isolated; it does not silently change group mode.
- A group with protected descendants must remain fully opaque and normal-blended, including hidden descendants and nested groups. Any actual pass-through/isolated mode change with existing protected descendants rejects, even when group blending is normal: grouping changes rounding and the backdrop seen by a protected leaf's own nonnormal blend. Unchanged settings remain allowed. Any ancestor with nonnormal isolated blending rejects newly protecting or extracting a protected descendant; extraction checks before invoking the model or writing assets.
- Groups still have no transforms, own protection, outside effects, direct paint, rasterization or cross-document placement.
- Nonempty isolated groups cannot be ungrouped directly because it can change adjustment and blending scope. Users explicitly switch to pass-through first, then satisfy the existing visibility/opacity/mask checks.
- Moving existing protected leaves/subtrees must preserve their ordered chain of isolated ancestor IDs. Capture chains before structural mutation, compare the candidate and ignore newly duplicated IDs. Neutral pass-through regrouping inside the same isolation scope remains possible. New import/reopen uses static validation rather than transition comparison.
- Source placement and arrangement through any isolated ancestor reject in this milestone.
- Rasterization retains the same parent and layer ID. Extraction creates a sibling in the same parent. New generation and cross-document placement remain root layers. No implicit operation moves an existing protected ID across isolation.

## Renderer and resource invariants

An isolated child starts with a transparent RGBA canvas and a copy of the current lower protected footprint. Render all descendants into that child canvas. Internal adjustments cannot see outside image pixels; inherited protection still excludes generated pixels, filters and decorations where lower protected content already exists. Composite the completed child into the original backdrop once using group opacity, mask and selected blend mode. Merge newly protected coverage back into the parent without erasing previously protected pixels. Parent masks and nested rounding retain the current documented behavior.

Pass-through rendering must remain byte-identical, including alpha1 edges. Isolation always adds one live RGBA surface and one footprint copy. Count five retained bytes per canvas pixel for every isolated ancestor, even at opacity1 without a mask and even when hidden. Both group-only and combined filter/group preflights must use the same predicate. Keep the 256 MiB accounted scratch limit and eight-group depth limit; do not describe that accounting as whole-process RSS.

`protectedPixels`, layer inspection, source/mask previews, segmentation, generated-result application, placement, arrangement, undo, duplicate, reparent and portable import have been reviewed and tested. The new branch retains inherited protection for generated content, filters, adjustments and styles. PSD export continues to reject every group.

Whole-document subject selection uses actual rendered pixels. Explicit `select_subject(layerId)` deliberately samples that individual **unfiltered** layer with its own styles/mask and staged ancestor opacity/masks; it excludes the backdrop, siblings and group blend context. It is neither an immutable source preview nor a composite selection. Layer/group previews execute group compositing on transparency while revealing the selected subtree; original and source-alpha views are unchanged.

The reusable `groupNeedsSurface` predicate is shared by group and editable-filter validation. For 4000×4000 metadata-only fixtures, three retained group surfaces use 240 MB and pass; four use 320 MB and reject. One isolated ancestor plus filter scratch uses 224 MB and passes; two plus filter scratch use 304 MB and reject. These are decimal byte totals compared to the existing 256 MiB limit. Checks include hidden groups and occur before publication; the tests do not allocate the large canvases or read source images.

## Acceptance fixtures

1. A bottom image, a partially transparent grouped layer and a grouped adjustment distinguish pass-through from isolated normal. Pixels outside the isolated group's content must remain exact.
2. Multiply/screen plus partial group opacity and masks match an independent small premultiplied reference. Nested isolated/pass-through combinations apply each opacity once.
3. Low alpha, empty and hidden groups, fully transparent RGB, active selections and source assets retain their declared behavior.
4. Protected content inside normal isolated groups survives internal/external adjustments, filters, decoration and generated-image application. Lower external protected footprints exclude generated siblings inside isolated groups. Hidden protected descendants prevent nonnormal ancestor blending.
5. Reparenting, mode changes, protected changes, duplication and group creation enforce the same graph invariants; invalid transactions and injected persistence failures leave files, history and cache unchanged.
6. Eight-level and combined filter scratch boundaries reject before rendering. Unused/hidden isolated groups still count.
7. Official MCP, browser controls, undo/redo/reopen and `.prism` round trips retain group mode and exact output. Existing pass-through browser and pixel suites pass unchanged.

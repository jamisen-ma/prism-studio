# Outside-style preset audit

Reviewed 2026-09-19. The implemented native/preset codec passes four independent audit tests and the official MCP workflow. UI verification and the owner's broader lifecycle suite are separate checks. This review covers document-local copies of outside outlines, shadows and glows. It does not cover Photoshop style files, live-linked styles, filters or source replacement.

## Existing rendering contract

`set_layer_outline` and `set_layer_effects` target individual content layers, including protected or hidden content. Groups and adjustments reject. Effects replace their entire slot; null or an empty effects object clears it. Public outline widths are integers from 0 to 64; colors are RGB hex. Shadow/glow normalization supplies defaults and bounds opacity, Gaussian blur and shadow offsets.

The renderer casts decoration from transformed source alpha after the layer's own mask and generated-content protection clipping. Any nonzero effective source coverage, including translucent and alpha-one pixels, excludes decoration. Shadow is behind glow, outline is above both, and layer opacity applies once to the combined decoration. Ancestor group masks clip the completed content and decoration; they do not change the child's shadow caster. Numeric widths, blur and offsets use current canvas pixels.

Decoration on an upper layer cannot enter the existing lower protected footprint. A protected layer's visible decoration contributes to the footprint used by later adjustments and generated layers. Hidden layers and hidden ancestors contribute no rendered protection. A fully protection-clipped generated layer must cast no ghost outline, glow or shadow. This is the established stacking contract, not a promise that changing a background beneath translucent content leaves its composite appearance unchanged.

Placement and rasterization preserve editable style metadata independently of source pixels; source and raw-alpha inspection remain unchanged. Existing effect/cutout/group tests already cover these rules. Preset commands should call the same renderer and validation path without adding another compositing path.

## Required copy and mutation invariants

The approved library is optional `graph.layerStyles`, with at most 32 UUID-named entries containing only `id`, `name`, optional `outline`, and optional `effects`. Old documents expose an empty list. Names are trimmed and bounded. Saved metadata must normalize and deep-copy nested settings; target layers and saved entries must never share mutable objects.

| Operation | Required behavior |
| --- | --- |
| Save or overwrite | Capture both style slots only. An overwrite retains its ID and works at capacity. Hidden or fully masked content can supply reusable settings without rendering. |
| Apply | Resolve all 1–64 unique target IDs and validate all content types before mutation. Replace both slots; an absent slot clears the target's previous slot. One commit and one undo step cover every target. |
| Rename/delete | Change only the saved library. Already styled layers retain their copied settings and exact pixels. |
| Later layer edit | Editing a target does not modify the saved preset or other targets. A subsequent explicit apply is necessary to reuse an updated preset. |

Application must preserve selection, saved selections, masks, filters, parent/order, visibility, layer opacity, blending, protection, geometry, provenance and every asset hash/byte. It must not make source reads, write image assets, unprotect content or capture generation metadata. Transactions and stale-revision checks use the ordinary graph-mutation path.

Reject empty settings and presets whose only outline has width zero and effects have zero opacity. This is a structural enabled-setting check, not proof that a particular image gains visible decoration: fully masked content, a full-canvas opaque layer, or an unshifted unblurred effect can render no outside pixels. Avoid decoding/rendering merely to determine whether settings can be saved.

## Validation and persistence review

The preexisting graph validator accepts an outline on an adjustment layer, where rendering ignores it, and accepts fractional outline widths although the public command schema requires integers. These mismatches were reported. This milestone preserves legacy fractional layer metadata, while preset capture and import require integer widths and preset save/apply reject adjustment/group targets. Strict saved-preset normalization rejects unknown nested fields, duplicate IDs, malformed names/settings and excess entries before any asset writes. The ignored legacy adjustment-outline field remains a separate validation cleanup; it is not captured or applied by the preset commands.

Apply validates the staged graph, including hidden targets, against the existing 32-million-pixel padded-effect limit. An unused saved preset consumes metadata only and does not require rendering scratch. With today's 8192-axis, 24-million-pixel and blur-64 limits, no valid canvas reaches that padded-effect limit; the guard remains useful if limits change. Crop, resize and canvas expansion leave saved numeric values unchanged. A failed target validation, resource preflight or project persistence must leave the previous graph, files, revision, history and preview cache intact.

The portable bundle root allowlist must explicitly include `layerStyles`; existing graph validation must validate its contents before import writes. No new source references are introduced. Native and portable reopen must retain IDs/settings; the bundle still omits undo history. The existing 16 MiB project-metadata and 256 MiB archive limits remain authoritative. A fresh import creates a new document without sharing a live preset library with its origin.

## Independent acceptance fixtures

1. Apply a saved outline/shadow/glow to patterned alpha 0/1/128/255 content. Compare occupied source pixels and every working/original/alpha asset byte, including protected content and lower protected people.
2. Save hidden and fully masked content; reject group/adjustment targets even when hidden. A multi-target list containing one missing, duplicate or ineligible ID rejects the complete edit.
3. Verify slot replacement, independent nested objects, overwrite at the 32-entry limit, delete/rename independence, undo/redo, reopening and `.prism` roundtrip.
4. Preserve all non-style metadata with active selections, source-alpha cutouts, filters and nested masks. Reuse the existing generated ghost-decoration and ancestor-mask fixtures with preset application.
5. Check that document geometry leaves stored values unchanged and that staged application invokes whole-graph validation, including hidden targets. Check revision, file, cache and image assets after invalid targets and an actual filesystem persistence failure. Do not manufacture an unreachable padded-blur limit fixture under current canvas limits.
6. Reject malformed/duplicate/over-cap imported libraries before asset publication. Verify strict outline target/width rules on both persisted layers and saved presets.
7. Exercise actual HTTP/MCP revisions, capability declarations and one multi-target atomic apply. Browser checks should explain that presets are copies, show missing-slot clearing, and verify undo without source changes.

No new provider calls, credential reads or image generations are needed for these fixtures.

## Verified outcome

`tests/layer-styles-audit.test.mjs` passes four tests. A hidden donor saves reusable styles; applying to fully protection-clipped generated content produces no ghost pixels. Applying to a protected patterned subject preserves every occupied source pixel, including alpha 1 and 128, and every image asset byte. Preset output exactly matches the existing outline/effects commands. Frozen input and nested-copy checks prove separate targets and saved entries cannot alias their style objects.

Eight independently constructed canonical bundle manifests exercise fractional/unknown/over-limit/empty/duplicate style metadata and fail before any source assets or project files are published. A mixed valid/hidden-adjustment transaction, duplicate/missing targets, stale revision and real filesystem `ENOTDIR` failure preserve the published graph, project file and preview cache. The root-owned official MCP test also passes, including portable roundtrip, copy-based overwrite/delete behavior and one-step multi-target undo. The existing effect/group baseline passed 19 tests immediately before these new fixtures.

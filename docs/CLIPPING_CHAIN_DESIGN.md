# Bounded clipping-chain proposal

Status: implemented native backend; SDK, browser and independent integration audits are tracked separately. The bounded first slice fills editable text/shapes or a raster silhouette with one or more image/gradient layers while retaining the base's soft transparency and original assets. The command is `set_clipping_chain`; capabilities expose `clippingLayerTypes: ["raster", "solid", "text", "shape", "path", "gradient"]` and `clippingBlendPolicy: "grouped-base"`.

## Researched behavior and deliberate scope

Adobe describes successive upper layers being revealed by a lower base layer's nontransparent content. Its clipping workflow also has structural insertion/release behavior. [Adobe clipping masks](https://helpx.adobe.com/photoshop/using/revealing-layers-clipping-masks.html).

Adobe additionally distinguishes whether the base's blend mode applies to the assembled clipping group or only to the base. Its default groups the clipped layers for that blend; separate advanced options affect styles and mask interactions. [Adobe group blend effects](https://helpx.adobe.com/photoshop/using/layer-opacity-blending.html#group_blend_effects).

The following is the native contract derived from those concepts and the Prism renderer. It does not infer undocumented Adobe pixel arithmetic or promise full clipping/style parity. Implement one declared chain blend policy first; defer the alternative policy, clipped adjustments, group members and advanced style controls.

## Representation and command

Use optional `layer.clipBaseId` on clipped **content leaves**, pointing to a content base with no `clipBaseId`. Members and base must be direct siblings in canonical bottom-to-top order. Every member belongs to the uninterrupted run immediately above its base; no intervening unrelated layer, adjustment or group is permitted. All members in a run name the same base. IDs are explicit so reordering cannot silently switch to a different person or shape.

One atomic command:

```js
set_clipping_chain({
  documentId, expectedRevision,
  baseLayerId,
  layerIds // exact bottom-to-top contiguous upper members; [] releases the chain
})
```

Accept 0–63 unique members under the existing 64-node document limit. Validate the complete existing and proposed chain before changing fields; never automatically reorder or join an inserted layer. A replacement clears former member links absent from the new list only when the resulting graph remains valid. Releasing is explicit and can reveal formerly hidden image content, so it is one reversible edit with the ordinary expected-revision/request-ID path.

No new asset registry, source reference or graph root collection is needed. `get_document` exposes `clipBaseId`; capabilities declare the supported member types and the fixed chain-blending policy. The portable codec's native graph validator must enforce every chain relation on reopen/import, before writing assets.

## Pixel contract: preserve the base silhouette once

The incorrect shortcut is to multiply each upper layer's alpha by the base alpha and then source-over it onto the base. A base alpha of 128 plus an opaque upper layer clipped to alpha 128 becomes alpha 192. Repeated members keep thickening the edge.

Instead assemble the chain's **interior colors**, retaining the base's original coverage for the final composite:

1. Render the base's working pixels, source alpha, filters and geometry through the existing native path. Evaluate its own mask in document coordinates. The clipping silhouette is its resulting raw alpha times that mask, before base opacity and outside decorations. Alpha-zero base RGB remains unchanged and cannot reveal upper pixels.
2. Reuse the owned rendered base buffer as the interior color surface. The RGB-only blend helper treats that interior as opaque wherever base alpha and mask coverage are nonzero, while leaving every raw alpha byte untouched. This allows an opaque fill to replace a soft base's interior color without increasing its silhouette alpha; no duplicate base buffer or saved alpha plane is allocated.
3. Render each visible member's source/filters/geometry, then apply its own opacity, mask and native blend mode to the interior colors. A member never changes the saved base alpha. Internal blending sees the base and earlier chain members, not the external backdrop. Dissolve must use the existing deterministic pixel-index rule rather than being treated as Normal.
4. The raw base alpha remains exact throughout, including values 1 and 128. Composite this completed chain once against the outside backdrop using the base's own mask, opacity and blend mode. Do not quantize a fractional geometric base mask into a new byte mask: retaining raw base alpha and evaluating its existing mask at this final step preserves its current precision.
5. Apply ancestor group masks/opacity at their existing stages. Parent pass-through/isolated semantics remain unchanged. Hiding the base or setting base opacity to zero hides the whole chain; hiding a member removes only that member's contribution.

The base remains editable text/vector/raster content, and each upper member retains editable filters and geometry. Source-space filter radii retain their current meaning. No source or alpha asset is rewritten to establish, render or release clipping.

## Protection and outside styles

For a bounded first version, require the base and **all clipped members to be unprotected**, even if hidden, fully masked or zero opacity. Clipped painting changes the base's displayed interior; it must not silently bypass protected-person behavior. Protecting any member while linked rejects until the chain is released. This conservative rule can be relaxed only with a separately tested appearance-preservation policy.

Keep inherited lower protection active while rendering the chain. Upper member color contribution is zero at any lower protected footprint, including ordinary members as well as generated ones; the existing base appearance remains at those pixels. Editable filters retain their existing unfiltered-RGB restoration rule. Generated member provenance and role must survive every structural edit, and generated content cannot turn clipping into a route around local hard-mask protection. A generated **base** is deferred initially because its dynamically clipped silhouette adds another context-dependent source of coverage.

Base outside outlines, shadows and glows can reuse the existing decoration path: they are cast from base effective alpha and drawn behind the completed chain, excluded from occupied source pixels and lower protected content, with base opacity applied once. Member decoration must not accidentally leak beyond the base silhouette. Initially reject enabled outside styles on upper members rather than inventing a second style-clipping rule; shared graph validation must also reject later style/preset application that would violate this restriction. Zero-width outlines and zero-opacity effects are harmless metadata.

The operation does not unprotect, change opacity, drop job provenance, rasterize editable content or capture an active selection. Group/adjustment members and chained bases are explicitly unsupported in the first slice. Existing per-layer filters already serve many single-layer adjustment use cases while clipped adjustment semantics are designed separately.

## Structural and read-path invariants

- Existing single-node move/reorder/delete/duplicate on a chain member or base rejects until release. A neutral `group_layers` wrapper may include a complete chain; selecting only part must reject. Moving/deleting a containing group naturally moves/deletes complete chains, subject to existing protection rules.
- Subtree duplication remaps every internal `clipBaseId` together with parent/layer IDs. It must not point the copied member at the original chain. A partial copy is not silently attached or released. New layers inserted inside a chain reject; no existing command should create an invalid gap and only discover it after image assets have been written.
- Geometry edits remain independent: moving the base changes the clipping window, while moving an upper member moves its image inside that window. Document resize/crop/expansion visits each layer once; clipping coverage is recomputed from the current base, not baked into a saved mask.
- Individual rasterization retains the layer ID, parent and `clipBaseId`; base/member relationships must survive type changes. Source extraction and cross-document placement from any chain participant reject until release, because they duplicate or snapshot content without a complete chain. Arrangement likewise rejects participants. Source paint/fill and source-alpha refinement edit their individual source without baking clipping and retain every link. Numeric geometry and the Move tool may remain available if their preview guides reflect clipped visible bounds.
- Full document preview, export, histogram, generation snapshot and composite subject selection must render chains. Raw original/source-alpha previews remain exact. Explicit source-oriented subject selection retains the individual unfiltered source with its own styles/mask and staged ancestor opacity/masks; it excludes clipping, sibling colors, backdrop and group blending. Composite subject selection sees the rendered chain.
- `get_layer_preview` resolves the full chain before isolating it. Base inspection shows the assembled chain plus base styles, with member visibility respected. Member inspection shows only that member's source colors with its own alpha/mask/opacity multiplied by base alpha/mask/opacity, followed by staged ancestor masks/opacity; base and member Dissolve decisions occur independently before those coverages are combined. This is an isolated contribution without a blending backdrop or base/other-member colors, not the final appearance. The selected node, its base and ancestors are revealed only for inspection. Bounds use the clipped alpha. Original-context lower protected footprints suppress upper contributions and preserve unfiltered base RGB, even when the protected layers are outside the isolated preview graph.
- Strict PSD export must reject all chains until its format subset gains independently verified clipping records. A flat PSD silently discarding `clipBaseId` would be data loss. `.prism` retains the relationships exactly; a newly imported document has no cross-document links.

## Resource and atomicity requirements

Budget chain rendering together with the existing group/filter scratch preflight. Budget conservatively reserves five retained bytes per canvas pixel while an upper member renders. The implementation actually reuses the owned base RGBA buffer as its RGB-only interior and does not allocate a saved alpha plane. Count it even for hidden chains. Because initial chains cannot contain groups or other chains, at most one chain's extra surface is live along a group traversal path; add it to every active ancestor surface and the current member's filter budget. Do not multiply by the number of sequential members, but continue summing the existing weighted filter work across all layers.

Each rendered member reference is released before the next member or base decoration renders. There is no additional base RGBA copy retained across those awaits. The full graph and combined budget are validated before output and before commit, including chains without active filters. JavaScript stack references across awaits can otherwise retain an extra full image. Do not claim the 256 MiB scratch limit bounds process RSS. Keep 8192 axes, 24 MP, 64 nodes, eight group ancestors, filter limits and 16 MiB project metadata unchanged.

Validate all metadata and structural eligibility before image/model operations. Staged commands validate the complete final graph before commit. Rejected clipping, stale revisions, invalid nested transactions and persistence failure must preserve graph/history/cache/files. The next test slice should contain no provider, credential or image-generation calls.

## Acceptance before implementation is considered complete

1. Independent one-pixel and patterned references prove alpha 0/1/128/255 remains the base silhouette with one and several opaque/soft members. Include fractional base masks and mask inversion/clip bounds without premature quantization.
2. Normal/multiply/screen/dissolve members and base blends follow the declared interior/final stages; base opacity applies once. Hidden/zero-opacity bases, hidden members and isolated/pass-through ancestors behave consistently.
3. Original and source-alpha bytes remain exact across link, release, geometry, rasterization, undo/redo and reopen. Active selections and unrelated masks are unchanged.
4. Protected chain members reject, including hidden cases; inherited lower protected pixels remain exact through upper filters/generated content. Source provenance and saved AI masks cannot be discarded by clipping operations.
5. Base decoration remains outside-only; enabled member styles and later style-preset application reject atomically. Lower protected outlines/shadows are not recolored.
6. Missing/cross-parent/cyclic/noncontiguous references, group/adjustment/generated bases, partial structural edits and bad imported chains reject before publication. Whole-subtree duplication remaps every relationship.
7. Base/member previews, visible bounds, generation snapshots, exports and `.prism` roundtrips agree with full rendering. PSD inspection reports named unsupported chains before rendering/writing.
8. Combined group/chain/filter budget boundaries include hidden nodes. Failed persistence and stale/multi-command failures leave the previous published preview/cache and all files exact. MCP and browser demonstrate image-inside-editable-text creation, release, undo and the protection/style limitations.

Root and architecture approved this contract before schema and renderer implementation. The most important initial decisions are the fixed grouped blending policy, unprotected-member restriction and exclusion of upper outside styles; changing any of them changes rendering and protection acceptance tests.

## Test-only pixel experiment

`tests/prototypes/clipping-reference.mjs` implements a synchronous, side-effect-free experiment over small RGBA buffers. It returns independent interior and final-composite buffers, retains base alpha, applies base opacity/mask once and suppresses upper contributions at inherited protected pixels. It supports only Normal, Multiply and Screen, at most eight members and 256×256 pixels. These are prototype bounds, not editor capabilities.

`tests/clipping-prototype.test.mjs` passes five tests. One hundred twenty seeded fixtures compare every interior/composite channel against a separately derived exact BigInt rational reference. Dedicated cases prove that repeated opaque fills retain base alpha 128 and 1, a fractional base mask is not applied twice, hidden RGB and input buffers remain unchanged, hidden bases suppress output and protected pixels retain the base-only composite. Unsupported blending and malformed/oversized inputs reject.

This resolves the proposed color/alpha arithmetic for those cases; it does not prove production graph structure, geometry, style behavior, dissolve, asynchronous lifecycle, memory accounting, previews or protection across editing commands. No production module imports the experiment. The full acceptance list above still applies before implementing an editor feature.

## Backend verification

`tests/clipping.test.mjs` contains ten passing focused tests, including 1,000 deterministic interior comparisons that cover exact half-byte rounding, for production interior arithmetic, raw alpha 0/1/128/255, fractional base masks, independent Dissolve decisions, base/member/source previews, source-oriented versus composite segmentation input, lower protection, generated-member provenance, partial structure rejection before source/model writes, complete subtree ID remapping, rasterization/source edits, undo/reopen/portable projects, hidden no-filter scratch limits, stale revisions, transaction rollback and persistence failure. The existing five prototype tests continue to pass. The helper, graph validator and renderer are production code; the prototype remains test-only.

Independent verification: `tests/clipping-audit.test.mjs` passes eight tests, including 32 independently calculated color/alpha fixtures, 12 nested group fixtures, original-context protection/previews, base styles, invalid portable graphs before source work, real filesystem failure rollback and combined hidden scratch boundaries. Together with the ten owner tests and the actual MCP SDK test, 19/19 passed against the final arithmetic. A broader related group/filter/cutout/preview run passed 79/79 before the final byte-rounding refinement; the focused 15 owner/prototype tests passed again afterward. Browser acceptance is reported separately by the client owner.

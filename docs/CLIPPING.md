# Editable clipping chains

A clipping chain fills the visible silhouette of a lower layer with the colors of consecutive layers above it. Use it for a photograph inside editable text, a gradient inside a shape, or several textures inside a raster silhouette. The base and upper layers remain independently editable.

This is a bounded native implementation of the familiar [clipping-mask workflow](https://helpx.adobe.com/photoshop/using/revealing-layers-clipping-masks.html). It uses one declared blend policy and does not implement every Photoshop advanced clipping option.

## Create or release

In Layers, check consecutive content layers within the same parent group. The lowest checked layer becomes the base; the layers directly above it become its members. The clipping controls show the base and members before applying the change. Creating or replacing the chain is one undoable edit. Select a participant to release its chain.

The order is explicit: Prism does not rearrange the stack or automatically attach a layer inserted nearby. The native document retains each member's `clipBaseId`, pointing to its base. A chain can have up to 63 members within the existing 64-node document limit.

Release removes the links and restores ordinary stacking. Upper layers can then become visible outside the former silhouette. Undo restores the previous chain and appearance.

## Color, transparency and styles

Upper layers change the base's interior colors. Its original alpha remains the silhouette, including soft edges with alpha 1 or 128. Adding more fills does not thicken that alpha. Each member keeps its own mask, opacity, geometry, filters and one of the 27 native blend modes. Member blending sees the base and earlier members inside the chain.

The base mask, opacity and blend mode apply once to the completed result. Ancestor groups retain their pass-through or isolated behavior. A hidden or zero-opacity base hides the chain; hiding a member removes only that fill.

Base outside outline, shadow and glow remain available. Enabled outside styles on upper members must be cleared first. This restriction also applies when using saved style presets. Zero-width outlines and zero-opacity effects do not block clipping.

Clipping never rewrites original image or source-alpha files. Editing a source, mask, transform or filter later remains an individual layer edit; it does not silently bake the clipped result. Rasterizing a text, shape or gradient retains its layer ID and clipping relationship, while removing that layer's editability in the usual undoable way.

## Protected content and structural limits

Every participant must be unprotected, including hidden members. Release the chain before protecting one. A generated layer may be an upper member and retains its generation provenance; a generated base is unsupported. Lower protected content blocks upper color contributions and retains the existing filter-protection behavior.

Only raster, solid, text, shape, path and gradient layers can participate. Groups, adjustment layers and bases that are themselves clipped are unsupported. Clip adjustments indirectly by using an editable raster filter where appropriate.

Group a complete chain to move or duplicate its containing subtree. Duplicating that subtree creates new internal links to the copied base. Individual participant deletion, duplication, stack reordering, reparenting, subject extraction, placement and automatic alignment/distribution require releasing the chain first. Partial grouping rejects. New layers cannot split a chain.

Numeric transforms and the Move tool remain available: moving a member shifts its content inside the base window; moving the base changes the window. Guide snapping is disabled for chain participants because the clipped bounds may change shape during movement. Canvas resize, crop and bounds changes visit each layer once and recompute the clipping window.

## Inspection and files

The full preview, flattened exports, histogram, generation reference and composite subject selection show the assembled result. Individual previews have a deliberate meaning:

- A base preview shows the full chain with its base styles.
- A member preview shows only that member's contribution constrained by the base and ancestor context, without base or sibling colors. It has no external blend backdrop.
- Explicitly selected hidden participants and their base/ancestors are revealed for inspection. Full document rendering respects visibility.
- Original and source-alpha views remain unchanged. Explicit layer subject selection remains source-oriented and excludes clipping; use composite subject selection to select the assembled appearance.

Portable `.prism` projects retain editable clipping relationships and exact assets. Strict layered PSD export reports `CLIPPING_UNSUPPORTED`; it cannot preserve this native subset. Use `.prism` or a flattened image export for these documents.

The full-frame renderer conservatively budgets five additional bytes per canvas pixel for a chain together with ancestor groups and active member filters under its 256 MiB scratch limit. Hidden chains count. This is an allocation preflight, not a promise about total process memory.

## MCP

Read the current document and use stable IDs with its latest revision:

```js
prism_set_clipping_chain({
  backend: 'native',
  documentId,
  expectedRevision,
  baseLayerId,
  layerIds: [firstMemberId, secondMemberId]
})
```

`layerIds` is the exact bottom-to-top run immediately above the base. Pass `[]` to release. The command supports ordinary retry IDs and edit transactions. Capabilities expose `clippingLayerTypes` and `clippingBlendPolicy:'grouped-base'`. Invalid links, stale revisions and failed transactions leave the published document unchanged.

See [the implementation contract and acceptance criteria](CLIPPING_CHAIN_DESIGN.md). Native, independent and official MCP tests cover pixel arithmetic, protection, structural guards and persistence; browser verification is recorded in [implementation status](IMPLEMENTATION_STATUS.md).

# Layer Fill: API and workflow plan

Status: implemented; full regression passes 1,206/1,206 in 24.5539 seconds on 2026-09-19. Four official MCP workflows and three public schema checks pass, alongside native owner10 and independent native/client12 checks. All67 focused/adjacent browser workflows pass, with final build555.306ms (Vite126ms). Native discovery is103 commands, with unchanged28 global/32 source kinds. The running app's doctor is healthy.

## Public command contract

Use a dedicated native mutation:

```js
set_layer_fill({
  documentId,
  expectedRevision, // positive current revision, required
  layerId,
  fillOpacity      // finite Number from0 through1, required
})
```

Reject omitted/null/coerced/nonfinite values and unknown fields. There is no percent-number alias, mask input, transform option, asset or filter parameter. A scalar0.375 means37.5%;1 restores ordinary full content opacity. The command participates in atomic transactions with a positive enclosing revision, one commit/Undo and ordinary stable-request replay. The optional Adobe bridge rejects it explicitly. Registration takes native commands from102 to103; adjustment/filter kind counts stay28/32.

Discovery is `layerFillPolicy:'content-alpha-outside-effects-v1'` and `layerFillContentTypes` containing the supported raster, solid, text, shape, path and gradient names. Clients require the exact policy, a well-formed list of known supported content types and the individual mutation command. A supported subset enables only its advertised target types; a missing or empty list enables none. Malformed values, duplicates, unknown types and strings standing in for arrays do not enable editing. Public layer metadata has optional numeric `fillOpacity`, default1; existing numeric `opacity` remains overall opacity. Changing overall opacity, visibility, names, masks, filters or styles must preserve Fill. No control or caller may round retained fractional metadata to an integer percentage merely by inspecting it.

## What Fill means

The new control fades rendered layer contents while retaining their existing outside outline, shadow and glow. Overall Opacity still fades contents and decoration together. It is independent of a vector shape's paint color also called Fill.

After source filtering and geometry, body compositing uses `overallOpacity * fillOpacity` through the existing blend operation. Outside decoration is generated from the unfilled source silhouette and additional mask, then composited with overall opacity. Do not round source alpha to a byte after multiplying by Fill. Default1 retains the old arithmetic path and stored records. Fill0 suppresses the body but can leave outside decoration visible; it does not turn a shadow into an inner effect. Alpha/source files, filter parameters, masks and source cutout coverage are unchanged.

This is a native content-opacity policy across existing layer blend modes, without a claim about Photoshop's special Fill/blend behavior. Groups and global adjustments do not support it. First-slice clipping-chain participants require Fill1, both when setting Fill and when constructing/changing a chain. Unsupported relationships fail before source reads.

Protection can freeze an existing Fill value, matching current overall-opacity behavior. Changing a protected layer's Fill requires explicit unprotection; an identical value remains harmless. With Fill0, the body contributes no protected footprint, while nonzero outside decoration remains protected. Positive Fill keeps the established conservative positive-alpha coverage rule. This must agree between ordinary composition, original-context restoration and local generation clipping.

## Persistence and existing workflows

The private representation is a strict incompatible effects wrapper only for nonunit Fill:

```js
effects: {
  version: 1,
  fillOpacity: 0.375,
  styles: /* legacy shadow/glow record, or null */
}
```

Old native readers reject the wrapper through their existing strict effects validator; they must not silently render full body opacity. Fill1 collapses the current state to its literal old effects record/absence. The public projection unwraps styles and separately reports Fill. Graph snapshots, Undo/history and portable bundles retain the private representation. The wrapper does not itself mean that a shadow or glow is enabled.

Existing saved styles capture/apply only decoration, leaving Fill unchanged. The first slice does not add Fill steps or capture to recipes; ordinary supported recipes retain the target's Fill. Source-filter Bake and raw painting retain Fill as display metadata. Placement, rasterization and extraction must explicitly retain the setting and avoid applying it twice; the native design determines their exact source versus display phases. Source-transparency selection continues ignoring display opacity/Fill, while composite channels, all-layer sampling, previews and exports see the rendered result.

Strict layered PSD export initially refuses nonunit Fill rather than silently folding it into an opacity byte. Existing PSD import restrictions remain. Flattened PNG/JPEG/WebP/TIFF follows the actual composite, while `.prism` keeps editable Fill and original assets.

## Verified root acceptance

Root owns shared schemas, positive transaction revision requirements, optional-bridge refusal, capability forwarding, MCP help and official SDK acceptance. Registration followed native and independent review of the wrapper, source/display and protection contracts.

Schema checks should cover exact endpoints/fractions, strict types/unknown fields, outer transaction ownership and refusal of unsupported recipe/bridge authoring. SDK tests should establish the body-versus-decoration distinction from independent pixels, source retention, metadata-preserving style/opacity edits, protected/clipped rejection, source-alpha versus visible preview, scoped Bake, placement, one-step Undo, portable/restart state and actual save failure. Include a Fill0 styled layer so an accidentally empty body cannot erase retained decoration or placement geometry.

Native acceptance must additionally pin old-reader rejection, malformed inactive/history wrappers before I/O, every actual-style/resource accessor and alias-aware consumer lifetime. Existing full-frame resource bounds remain; the extra scalar must not create another image plane or weaken admission. UI acceptance owns precise drafts, capability changes, target/revision ownership, keyboard use and actual compact/wide output. Full regression and relevant adjacent browser checks close the feature after the focused paths pass.

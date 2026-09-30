# Selection and additional-mask inspection UI

Status: implemented and browser-verified, September 19, 2026. The underlying contract is [MASK_INSPECTION_DESIGN.md](MASK_INSPECTION_DESIGN.md); the completed [layer-selection UI](LAYER_ALPHA_SELECTION_UI_DESIGN.md) remains unchanged.

## One viewer, two explicit entry points

Add **Inspect coverage** beside the Active selection Draw/Refine button in Select, and beside the existing Layer mask controls in Layers. Use one new `MaskInspection.tsx` read-only dialog, reached through small callbacks from `SavedSelections` and `LayerMaskProperties`. App stores the captured source/document/layer target and opens the modal; the dialog owns preview requests, local options, loading and errors. No new toolbar tool or permanent inspector tab is needed.

The selection entry is available for a non-null current document selection, including a materialized empty bitmap. It does not inspect an unfinished pointer-drag rectangle. The mask entry requires the node's own additional mask and works for content, group and adjustment nodes. Hidden/protected/clipped layers and filters are irrelevant to inspection eligibility. Missing sources disable their entry with a short explanation. No action creates a selection, copies a mask, changes density, switches tools or changes the editing target.

Keep the Cutouts panel's **Composite / Original / Mask** preview unchanged. Its Mask means source cutout alpha. This viewer always says **Active selection coverage** or **Layer mask coverage**, with the selected document and (for a mask) layer name. The additional-mask caption explicitly says “Additional layer mask; source cutout alpha is separate.”

## Controls and display

| Element | Behavior |
| --- | --- |
| Grayscale image | Opaque PNG. White = full coverage, black = none, gray = partial coverage. Show this legend in text as well as swatches. The display makes no claim that protected pixels can be edited. |
| Coverage, mask only | **With density** (`effective`, default) or **Before density** (`raw`). The help line includes the current density percentage and says that both views evaluate feather, stored inversion and clipping. Changing the choice only requests a new preview. Omit both this control and `maskMode` for active selections. |
| Preview size | Discrete longest-edge choices **700 px**, **1400 px**, **2400 px**, bounded by advertised support. Default 700. The backend never enlarges small documents. A change requests a new read; there is no numeric field firing a request per keystroke. |
| Caption | Actual encoded width × height, full canvas width × height, and inspected revision. Reduced previews explicitly say “Nearest-sampled preview; small details may be omitted.” Native-size previews say “Native sampling.” |
| View scale | Fit and 100% refer to encoded preview pixels, not original document detail. Optional local zoom can enlarge pixels without another server call. Use `image-rendering: pixelated` when enlarging. Do not claim that CSS enlargement recovers omitted detail. |
| Refresh | Read the latest same document into a viewer-local snapshot, validate that the same source still exists, then request its preview at that exact revision. No mutations or history entries. |
| Close | Escape, close icon and backdrop remain available while loading. Closing aborts/invalidates the request and restores ordinary modal focus behavior. There is no Apply action. |

Use the existing dialog width convention with a bounded image viewport and scrollable controls at 900px. Long document/layer names wrap instead of expanding the page. A preview is an `<img>` with descriptive alternative text, not an interactive artboard; canvas pointer tools cannot receive gestures through it. Loading has a polite status; failures and stale-state guidance are readable text. Keep buttons reachable at short viewport heights.

No image download or editable Quick Mask workflow is added in this milestone. The existing bitmap canvas tint is not replaced, recolored or re-feathered here.

## Identity and request lifecycle

The dialog's target is `{backend:'native',documentId,source,layerId?}` captured when opened. It cannot silently follow whatever layer becomes selected later. Selection inspection does not depend on selected-layer identity; additional-mask inspection does.

Use local preview state rather than `App.run`, because this is a read and must not enter mutation/download handling. Add a small authenticated read helper with an optional AbortSignal, using the existing session token and `/api/command` envelope. Native still validates expectedRevision in its serialized read queue; abort is only a client lifetime optimization, not an assertion that server work instantly stopped.

The identity of one read is:

```
backend + documentId + expectedRevision + source + layerId-or-none
+ maskMode-or-none + maxEdge + requestSequence
```

A monotonic sequence and effect cleanup protect against responses arriving after mode/size changes, close, removal of the source, document/backend switch or a newer read. Clear the old image when requesting different source options, so an effective mask cannot appear under a Raw label while loading. Keep a previous successful result only as explicitly stale content, never as the new result; the simplest first version hides it.

Concrete transitions:

1. **Open**: verify capabilities and source; capture the current document revision; request once.
2. **Mode/size change**: keep the target, abort/invalidate the previous request, clear its image, request the new options against the current known revision. Controls remain usable so a second choice can cancel the first.
3. **Document or backend changes**: close/invalidate the viewer. Do not issue a request against the replacement document. For a mask viewer, a changed selected-layer identity likewise closes it. A selection viewer ignores unrelated layer selection changes.
4. **Same document revision changes**: invalidate an in-flight response and hide a prior image. Show “The document changed. Refresh coverage.” Do not automatically sample every external brush mutation. Preserve local size/coverage preferences for explicit refresh.
5. **Refresh**: capture the current target; read the latest document, ensure that target/context still matches, keep its metadata in the viewer-local snapshot, and request the preview using the returned revision. If the mask or selection disappeared, show the missing-source state instead of substituting white/full coverage or another mask. If another edit races the read, remain stale and require another explicit refresh.
6. **Native revision conflict**: show the same actionable stale state, not a generic drawing-gesture error and not an automatic retry against newer data.
7. **Other failure**: show the server message and Retry. Retry is another bounded read with the same source/options; it must recheck current context and revision. A malformed response or image decode failure gets an explicit preview error, never a broken image presented as coverage.

The local snapshot may be newer than App’s document metadata; App catching up to the same inspected revision preserves the image, while surpassing it invalidates the image. Refresh does not call App.updateDocument or render a composite; an unrelated corrupt RGB asset therefore cannot block mask-only inspection.

A successful result is accepted only when its request is still current and the envelope matches documentId/revision/source, layerId and maskMode when relevant, `mimeType:'image/png'`, positive encoded dimensions and full canvas dimensions. Require both encoded sides ≤ requested maxEdge, no enlargement, and exact rational half-up size rounding, using integer products so half ties do not drift through floating-point scale multiplication. Use the actual returned width/height for layout. An unexpectedly newer response is not a substitute for a properly matched read; refresh metadata explicitly.

## Capabilities and API needs

Approved separate capability fields:

```js
commands: [..., 'get_mask_preview']
maskPreviewSources: ['selection', 'layer-mask']
maskPreviewMaskModes: ['raw', 'effective']
limits.maxMaskPreviewEdge: 2400
limits.maxMaskPreviewBytes: 8 * 1024 * 1024
limits.maxMaskPreviewWorkingBytes: 256 * 1024 * 1024
```

Do not borrow `get_layer_preview`, layerSelectionSources, or source-cutout `alphaAsset` as a feature gate. The UI default is700; read bounds are32–2400. Missing command/source/mode support hides the corresponding entry or option. The existing saved-selection tab can expose selection inspection independently of library mutation availability if necessary.

Proposed typed response:

```ts
type MaskPreview = {
  documentId: string; revision: number;
  source: 'selection' | 'layer-mask';
  layerId?: string; maskMode?: 'raw' | 'effective';
  mimeType: 'image/png'; data: string;
  width: number; height: number;
  sourceWidth: number; sourceHeight: number;
  sampling: 'nearest-pixel-center'; maxEdge: number;
};
```

The server contract fixes nearest pixel-center sampling and opaque grayscale byte conversion. The UI only displays that PNG; it must not duplicate mask feather/density arithmetic. Native owns accounting and output bounds. Limit errors stay explicit; the UI may offer a smaller supported preview size but must not silently change the source or claim a complete native-size inspection.

## Focused browser acceptance

Use isolated companions and small local masks, with zero provider, segmentation and credential reads. Capture requests and decode actual returned PNGs through an independent byte oracle.

1. Active soft selection: correct grayscale0/1/128/255, geometry/feather/inversion/clip once, no mutation/history/asset changes. Null disables entry; explicit empty is black; inverted empty is full white. Source cutout Mask remains a distinct existing viewer.
2. Additional masks on content/group/adjustment nodes: raw/effective density0/.5/1, exact half-byte rounding, source transparency/visibility/opacity and unrelated corrupt raster assets do not change or block mask-only inspection. Local coverage choice leaves mask/density/protection unchanged.
3. Odd/tall canvas at700/1400/2400: exact encoded dimensions and nearest-center samples, no server enlargement, truthful source/preview caption. CSS Fit/100% does not trigger another read.
4. Delay a response, change coverage or size, release it after the new result and assert it never appears. Close, remove source, switch document/target/backend, or externally revise the document while pending; no stale image can attach to another context. Explicit Refresh recovers the current revision, and a lost/stale read cannot change the selection.
5. At900px, long names, grayscale legend, errors and controls remain reachable without overflow. Existing Select loading/saved selections, mask density/morphology and Cutouts source-alpha previews remain unchanged.

`tests/mask-inspection-browser.mjs` passes four workflows using actual UI requests and real PNG results. It verifies exact grayscale bytes, empty/inverted-empty states, mask density modes on content/groups/adjustments, read-only graph/source preservation, corrupt unrelated RGB, out-of-order replies and a detached-image error, stale revision/explicit refresh, removed masks, document switching, native sampling and exact rational229×457 preview dimensions. Network timing and capability-limited457 are explicit fixture injections; normal preview decoding and metadata refresh use the real companion.

The production build passes. Adjacent browser regressions pass: layer selection4, mask density3, morphology3 and Cutouts7. No provider, segmentation or credential lookup runs in the new fixture. Screenshot `test-results/mask-inspection-coverage.png` is inspected at900px. Native tests cover geometric feather/clip accounting and the full rounding domain separately; this browser result is not a claim of additional Quick Mask editing or composite overlay support.

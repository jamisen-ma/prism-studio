# Native Layer Fill

Status: implementation and acceptance complete, 2026-09-19. Full regression passed 1206/1206 in 24.553913917 seconds; focused 8 and adjacent 59 browser workflows passed, final build took 555.306 ms, and doctor reports 103 commands. Root released native integration after the separate Dense Mask resource-fix suite passed1177/1177. This design adds one display property and one mutation; it does not change the compositor's blend formulas or introduce Photoshop-specific advanced blending.

Layer Fill changes the content of a raster, solid, text, shape, path or gradient while leaving its existing outside outline, shadow and glow at the layer's overall Opacity. This supports outlined text, faint subjects with readable decoration, and outside-style-only artwork. Adobe documents the same distinction between layer opacity and Fill, but does not publish a numerical compositor contract here. The rules below are explicitly native. [Adobe layer opacity and blending](https://helpx.adobe.com/photoshop/using/layer-opacity-blending.html).

## Frozen scope proposed for implementation

- `set_layer_fill` changes a finite `fillOpacity` in `[0,1]`, with a mandatory positive document revision. No percent-integer snapping or implicit conversion from strings. Negative zero canonicalizes to zero.
- Default Fill is exactly 1. The six eligible types are `raster`, `solid`, `text`, `shape`, `path`, `gradient`. Intrinsic shape/path strokes are content and fade with the body. Groups and adjustment layers reject this command, including a request for Fill 1.
- All existing native layer blend modes retain their present blend function. Fill changes the incoming body amount only. Deterministic Dissolve uses that amount through its existing rule. No Adobe special-Fill/blend-mode parity is claimed.
- Every clipping-chain participant must have Fill 1, including hidden bases and members. Ordinary groups may contain partially filled children under their existing opacity, mask, isolation and protection rules.
- Protection can freeze an already partial Fill. Later changes require explicit unprotection; an identical value is allowed. This matches the existing overall-opacity guard rather than imposing a new protected-Fill-1 invariant.
- Native projects/history/bundles retain Fill. Flattened image outputs render it. The current strict layered PSD subset refuses nonunit Fill before pixel reads. PSD import keeps its existing identity-`iOpa` restriction.
- Fill is not added to saved styles or the five edit-recipe command families. Existing style/recipe operations preserve the target's Fill while changing their own fields.

Capability fields:

```js
layerFillPolicy: 'content-alpha-outside-effects-v1'
layerFillContentTypes: ['raster', 'solid', 'text', 'shape', 'path', 'gradient']
```

The client requires Native, the exact policy, a well-formed all-string content-type list advertising the current eligible target type, and the command. Native advertises all six; a valid supported subset can enable its own types, while mixed/non-array lists grant no editing. The optional Photoshop bridge refuses the command explicitly. One new command takes native command discovery from 102 to 103; adjustment/source-filter kind counts remain 28/32. No new numeric resource limit is necessary.

## Stored representation and old readers

A bare new layer property is unsafe as the persisted representation: current `validateGraph` does not reject arbitrary unknown layer keys, so an old reader could silently ignore it. Changing the project version would broaden the boundary to every graph and importer. An opacity union would fail closed but require replacing numeric layer-opacity reads throughout group, clipping, protection, PSD and resource code.

Use the existing strictly validated effects field instead:

```js
// Fill 1: retain the existing form, including omission when no styles exist.
opacity: 0.8,
effects: { shadow: { color: '#000000', opacity: 0.35, blur: 8, x: 4, y: 6 } }

// Fill <1: strict wrapper, even when there are no outside styles.
opacity: 0.8,
effects: {
  version: 1,
  fillOpacity: 0.25,
  styles: { shadow: { color: '#000000', opacity: 0.35, blur: 8, x: 4, y: 6 } }
}

// Fill-only layer.
effects: { version: 1, fillOpacity: 0, styles: null }
```

The wrapper has exactly the three required own enumerable data properties shown. It is a plain or null-prototype object; arrays, accessors, symbols, hidden/unknown properties, custom prototypes, missing fields, other versions and nonfinite values reject without executing a getter. A persisted wrapper requires `0 <= fillOpacity < 1`. Its `styles` is null or a nonempty ordinary shadow/glow object, with strict own-data/plain-object checks on this new nested representation before the existing style-value normalizer runs. Stored shadow records contain all five normalized `color`, `opacity`, `blur`, `x`, `y` fields; glow records contain all three `color`, `opacity`, `blur` fields. Values must match the existing normalizer's output, including normalized color spelling. Sparse nested records and `styles:{}` are not canonical persisted wrappers; authorship normalizes those old style inputs before wrapping. This ensures resource readers see the same explicit numeric settings as the renderer. A nested wrapper is invalid. This does not broaden strictness of the unchanged, unwrapped legacy style-value branch.

New authorship stores normalized owned styles. Setting Fill to exactly 1 unwraps the styles into the old representation and omits `effects` when styles are null. Setting an already legacy layer to Fill 1 preserves its literal existing effects/absence/null representation. There is no read-time migration of old graphs, no blanket normalization of legacy metadata, and no extra default property added to old persisted layers.

The current `normalizeEffects` accepts only `shadow` and `glow` keys. It rejects the wrapper's `version`, `fillOpacity` and `styles` before image I/O, including the Fill-only `styles:null` case. This is the old-reader refusal mechanism for current states, every retained history state and portable graphs. A graph returned to Fill 1 can be legacy-readable while a retained nonunit history state still correctly makes its enclosing project incompatible.

Public documents keep `opacity` numeric. For a wrapped layer, project `effects` as the ordinary styles (omit it if styles are null) and add `fillOpacity:F`. For legacy layers the optional public field is omitted and consumers use `fillOpacity ?? 1`. This preserves existing public shapes for unchanged legacy layers. Projection must own its returned graph and never mutate storage. The public `fillOpacity` name is reserved: reject it as an own property on persisted layer input, even if 1 or alongside a wrapper. Otherwise an edited manifest could again smuggle in ignored visual intent. A public projected document is not an internal persisted graph.

## Command, transaction and mutation semantics

```js
set_layer_fill({
  documentId, expectedRevision, layerId,
  fillOpacity // required finite Number, 0..1
})
// Result follows ordinary mutations: { document }.
```

The top-level shape is strict. A direct call requires a positive integer `expectedRevision`; a transaction containing this command requires a positive enclosing revision and inherits it through the existing revision-pinned mutation mechanism. Existing request-ID replay, serial mutation queue, one transaction Undo and late-step rollback rules apply. An identical value performs no Fill metadata/pixel change and uses the existing ordinary mutation revision/history behavior; this design does not add a new no-op transaction protocol.

The operation is metadata-only: resolve target, validate numeric value and eligible type, enforce protection and clipping, construct owned wrapper/canonical legacy form, then validate the candidate graph and commit. It must not decode or read source/mask assets. A missing layer is `NOT_FOUND`, an unsupported target/clipping participant is `INVALID_TARGET`, changing a protected layer is `PROTECTED_LAYER`, and malformed values use `INVALID_ARGUMENT`. Stale revision behavior stays the existing revision error.

`set_layer.opacity` continues changing only numeric overall opacity. `set_layer_effects` accepts only the old styles payload, never the internal wrapper, and replaces/clears styles while retaining Fill. `set_layer_outline` remains independent. Duplicate, text/vector updates, geometry, canvas transforms, masks, filters and source edits preserve the wrapper naturally or explicitly; none resets Fill.

Validate the clipping restriction in both directions: setting nonunit Fill on any existing participant fails, and establishing a chain with any nonunit participant fails. Validate each prospective chain before any following pixel-writing step. An already-partial protected layer is valid on restart and portable import. In a transaction, unprotect → change Fill → protect is allowed; protect → change Fill is refused at the offending step even if a later step would unprotect. Existing active-filter/protection restrictions continue independently.

## Native pixel order

Let `A` be the transformed source alpha byte, `O` numeric overall opacity, `F` Fill, and `M(x,y)` the prepared additional mask/density coverage. Retain source filters, whole-stack filter masks, source-alpha policy and geometry in their current order. Fill is evaluated after all of them and never changes source RGBA or an asset.

1. Compute outside decoration from the original transformed source alpha and `M`, without `F`, using the existing effect and outline helpers.
2. Composite decoration using `O` and the layer's existing blend mode/protection coverage.
3. For nonunit Fill, compute `bodyOpacity = O * F` once in binary64 and pass it to the existing body compositor. Its source amount retains the current operation order `(A / 255) * bodyOpacity * M(x,y)`. Blending, Dissolve and final RGBA8 rounding remain unchanged.
4. For Fill 1, retain the literal legacy call using `O`; do not route old graphs through a new alpha-materialization pass.

There is no intermediate `round(A*F)` plane. For example, `A=1`, `O=0.5`, `F=0.5` has incoming alpha 0.25 byte and finally rounds to 0 against transparency; pre-rounding `A*F` would incorrectly produce 1. With `A=255`, `O=0.5`, `F=0.5`, body alpha rounds to 64 while an opaque outside decoration receives only `O` and rounds to 128.

At Fill 0, omit the body contribution, but continue validating/rendering the original source and styles under existing budgets. Hidden layers or overall Opacity 0 still suppress both body and decoration. Resource/work admission does not gain a Fill-zero shortcut.

Outside effects deliberately exclude every pixel occupied by the **unfilled** source alpha and effective mask. Consequently Fill 0 leaves outside-only decoration and a transparent body. It does not reveal a shadow through that body, create an inner glow, add knockout or change Blend If. Style blur/offset/ring placement does not change with Fill. Global adjustments above the result, all-layer samples and flattened exports see the resulting composite normally.

`visibleLayerPixels` already materializes a display copy with byte alpha and sequential ancestor-mask/opacity rounding. Its body alpha becomes `clamp(A * (O*F) * M)` in that same loop; decoration still uses `clamp(decorationA*O)`. Retain the literal Fill-1 expression and existing sequential ancestor rounding. Add an explicit internal `fill:false` option for the placement path only; this is not a new public preview mode.

## Protection and original-context rendering

Do not fold Fill into an additional mask or into its density. Fill changes the body protection predicate as follows:

```js
bodyProtects = F > 0 && sourceAlpha > 0 && effectiveMaskCoverage > 0;
protects = ancestorCoverage > 0 && (bodyProtects || outsideDecorationAlpha > 0);
```

Keep existing visibility/overall-opacity/ancestor gates. Positive Fill retains the current conservative positive-source-alpha footprint, even if the final alpha rounds to zero or a tiny binary64 product underflows. Exact Fill 0 contributes no body footprint. Its nonzero outside decoration remains protected. This is intentionally not a new byte-visible protection policy.

Pass the same Fill predicate to both ordinary `markProtected` and the `protectedPixels` original-context path used by source-filter restoration, generated layers and isolated inspection. Do not derive it from a prefilled source buffer. Test protected partial layers and Fill-zero style-only layers with later adjustments, generated content and isolated-group/filter previews. Existing protection rules for ancestor opacity, isolation, clipping and active source filters remain unchanged.

An effects wrapper is not itself an enabled outside style. For new wrappers, contextual rendering must inspect `styles`; a Fill-only wrapper must not trigger extra protected-prefix renders, mask preparation or style buffers. For **unwrapped legacy** effects, preserve existing truthiness decisions, including the already accepted empty-object case; replacing them with a new enabled-style predicate would change unrelated legacy scheduling.

## Complete consumer map

| Consumer | Required Fill behavior |
| --- | --- |
| Native validation/history/restart/bundle | Validate the wrapper and nested styles before assets, reserve/reject persisted public `fillOpacity`, preserve old graph records without migration. Type and clipping restrictions apply to inactive/hidden metadata too. |
| `asDocument` / mutation results | Project wrapper styles plus optional numeric `fillOpacity`; numeric `opacity` is unchanged. Do not persist projected documents. |
| Ordinary `renderGraph` | Existing decoration pass gets O, existing body pass gets O×F; original-source alpha is retained for decoration and protection. |
| Isolated layer/group preview | Render through the same graph path with original filter/protection context. `view:'layer'` includes Fill; raw `view:'source'` and source cutout-alpha `view:'mask'` do not. Visible bounds can be style-only or null. |
| `visibleLayerPixels` | Apply Fill by default to body, preserve O for decoration and existing ancestor byte rounding. Placement explicitly bypasses Fill while measuring/materializing source. |
| Arrange/align/distribute | Existing calls disable outline/effects and therefore use filled body bounds. Fill-zero layers have no body bounds and return the existing empty-layer refusal, even if outside styles are visible. |
| Subject selection | Whole composite includes Fill. A selected-layer request uses `visibleLayerPixels(...,{filters:false})` and therefore includes Fill and existing styles/ancestor policy, while retaining its existing disabled-source-filter semantics. |
| Source content-alpha selection | `load_layer_selection(source:'content')` reads source transparency/geometry, as today ignoring display opacity; it also ignores Fill. Mask-selection/raw/effective mask inspection is unchanged. |
| Composite channel preview/load, select-color, histogram, eyedropper | Final-composite readers include Fill automatically. No separate channel or selection-alpha rule is added. |
| Paint/fill/retouch | Source editing retains Fill metadata. Current-layer raw source samples keep their existing semantics; all/current-and-below composite samples include Fill. Do not bake Fill into painted source alpha. |
| Generation snapshot/local apply | Snapshot composite includes Fill. Saved hard-protection masks use the new body/effect predicate; subsequent user changes do not replace the saved snapshot policy. No generation/network behavior changes. |
| Source-filter Bake | Plans/evaluates original source RGB and source whole-stack mask exactly as today, changes working asset and clears filters only. Preserve numeric O, wrapper F/styles, geometry, additional mask and separate original alpha. |
| Rasterize | `renderLayer` stays raw with respect to Fill, overall opacity and outside styles. Store that source/geometry result, reconstruct raster metadata, and copy the wrapper/outline. A Fill-zero vector can be rasterized without losing its recoverable body. |
| Extract subject | Existing raster extraction segments `sourcePixels(layer)`, ignores display Fill and combines existing separate source alpha. Clone the wrapper into the cutout; default `protect:true` freezes its existing partial Fill. Existing filter/clipping/ancestor restrictions remain. |
| Place layer | Keep existing eligible source/filter/ancestor/overall-opacity guards. Request unfilled, unstyled, opacity-1 masked body pixels with `fill:false`; find bounds, resize and build the destination RGB/alpha from that body. Preserve numeric source overall opacity and copy the original wrapper/styles separately. Fill-zero sources remain placeable when their unfilled silhouette is nonempty; no Fill is baked into destination alpha. Default protection freezes the copied Fill. |
| Duplicate/subtree/canvas changes | Preserve wrapper unchanged through owned graph copies. These operations need no new pixel processing for Fill. |
| Save/apply layer styles | Capture only unwrapped shadow/glow and outline. Applying or clearing styles keeps each target's Fill. A Fill-only layer still cannot create an empty saved outside style. |
| Edit recipes | No new Fill command, slot, capture toggle, reset/default or definition-hash rule. Existing effect/outline recipes preserve target Fill. Unrelated source/global/text recipes do likewise. |
| PSD inspection/export/import | Refuse nonunit Fill at metadata inspection before decoding, even without outside styles. Keep the current nonidentity-`iOpa` import refusal and existing export subset. Flattened/native outputs remain available. |

The critical distinction is placement versus display materialization. Copying a Fill-reduced alpha into a new source and then copying the wrapper would apply Fill twice and alter effect blur. Conversely, clearing Fill during ordinary previews or arrangement would falsely restore a hidden body. The explicit internal option prevents those two call sites from being conflated.

## Bounded helpers and exact source seams

Keep accessors in one small server module, proposed `server/layer-fill.mjs`. It may depend on the existing style normalizer; no shared numerical library or pixel helper is needed. Proposed exports:

```js
LAYER_FILL_POLICY
LAYER_FILL_CONTENT_TYPES
normalizeLayerFillOpacity(value)        // owned finite scalar; -0 -> 0
normalizeLayerFillEffects(value)        // strict new wrapper; legacy style branch stays legacy
layerFillOpacity(layer)                 // validated layer: absent wrapper -> 1
layerOutsideEffects(layer)              // wrapper.styles, otherwise original layer.effects
setLayerFillOpacity(layer, value)       // owned updated metadata/canonical Fill1
setLayerOutsideEffects(layer, effects)  // replace styles, preserve Fill
projectLayerFill(layer)                 // public projection only; no mutation
```

The exact return signature for the owned update helpers may be chosen during implementation, but there must be one canonicalization/strict-validation path and one accessor pair. Do not normalize/copy styles inside pixel loops. Direct helpers must reject a malformed new wrapper rather than quietly returning Fill 1. New strict checks inspect own property descriptors before reading wrapper/nested fields; no generalized accessor guarantee is added to unchanged legacy command families.

Current direct effects assumptions that must be migrated:

| File/seam | Accessor/canonicalization change |
| --- | --- |
| `native.mjs` graph validation | Normalize wrapper, then validate actual styles' padded-blur bounds. Reject wrapper on noncontent types and persisted public field. |
| `native.mjs` `layerDecoration` | Pass unwrapped styles to `renderOutsideEffects`; preserve the raw unwrapped legacy truthiness branch. |
| `native.mjs` ordinary-render `contextual` | Use unwrapped styles for wrappers; Fill-only must not activate original-context protection. |
| `native.mjs` style setter | Use retaining update helper rather than assigning/deleting the whole effects field. |
| `native.mjs` placement/rasterize/extraction/duplicate | Keep exact metadata copy but explicitly bypass Fill in placement's source materialization. |
| `layer-styles.mjs` save/apply | Unwrap at capture; retain Fill when replacing styles, including presets without shadow/glow. |
| `clipping.mjs` `enabledStyles` and `clippingIndex` | Read actual styles and require Fill1 for every chain participant. |
| `dense-mask-resources.mjs` `denseDecorationBytes` | Enumerate actual shadow/glow objects so wrapper metadata cannot hide blur/outline retention. Fill-only contributes no style buffers. |
| `psd-export.mjs` metadata preflight | Report `FILL_UNSUPPORTED` for nonunit Fill; style refusal inspects actual styles. Native passes internal graph to this preflight, not public projection. |

`edit-recipes.mjs` style argument normalization remains the legacy style-payload path. Saved styles remain legacy style records. PSD worker consistency checks keep refusing effects/Fill records from the current restricted importer. Numeric overall-opacity reads in groups, clipping, resources and PSD stay untouched, which is the main advantage over an opacity union.

## Resource and scheduling proof

Fill needs only a scalar value and a scalar `O*F` calculation per content rendering invocation. The ordinary compositor already accepts an opacity scalar and allocates its current bounded RGB scratch. `visibleLayerPixels` already owns a source copy and an alpha loop; changing that loop's scalar does not create a plane. Protection adds a Boolean body predicate to existing loops and footprint arrays. Metadata accessor/normalization objects are bounded by the existing two outside-style settings.

No new RGBA/alpha plane, LUT, cache, asset, mask callback, protected-prefix render or sampling pass is introduced. Keep every existing scheduling boundary; this feature does not promise that the legacy compositor's synchronous loop becomes independently nonblocking. Full runtime measurements can compare the current path after functional acceptance, without claiming a new yield guarantee.

All current named-buffer and work gates remain. Dense decoration estimation must unwrap actual styles and therefore produce exactly the old estimate for the same shadow/glow/outline settings at any Fill. Fill-only keeps the existing no-style estimate; Fill0 never discounts source decoding, filters, geometry, masks or style costs. Existing Distort/LUT envelopes retain their declared scopes. No resource cap changes, extra parser preparation, retained-history quota or total-RSS claim is necessary.

Legacy Fill1 records must preserve their original pixel path, accepted style values, contextual scheduling and resource estimates. New wrapped records can canonicalize new metadata without rewriting that legacy branch. Tests should prove equal decoration/resource numbers for legacy styles versus wrapped identical styles, including padded blur plus outline and a Fill-only wrapper under protected inspection.

## Acceptance before registration/release

1. Strict helper tests: finite values, zero/one/subnormal/adjacent-to-one values, required wrapper keys, malformed styles, custom prototypes/accessors/symbols/hidden fields with zero getter calls, owned copies, explicit Fill1 canonicalization and unchanged legacy sparse/null/empty metadata. In particular, a persisted wrapper with `styles:{shadow:{}}` or `styles:{}` refuses before resource/pixel work, while setting Fill on an accepted old sparse shadow authors complete owned defaults. Current and retained-history old-validator rejection; valid-control portable fixtures rejecting bare/conflicting public fields before source reads.
2. Independent body/effect pixels: all six content types, alpha 0/1/128/255, O/F 0/partial/1, fractional masks/density/feather, source filter mask then geometry, outline+shadow+glow, all native blends including Dissolve. Pin no intermediate alpha quantization and no changed occupied silhouette at Fill0. Fresh ordinary optimized processes for representative masked/unmasked cases; use bounded first-byte diagnostics.
3. Protection: already-partial protected records survive restart; identical setter allowed, changed setter refuses before I/O. Unprotect/change/reprotect transaction works. Exact Fill0 body footprint absent, nonzero decoration present; positive tiny Fill retains conservative footprint. Later global/source adjustments, generated content, isolated/pass-through groups and original-context previews agree.
4. Structural restrictions: groups/adjustments reject all Fill sets; existing and newly linked clipping participants reject nonunit Fill including hidden members. Prospective invalid states fail before later pixel mutations. Normal Fill1 clipping pixels/resources are unchanged.
5. Consumer semantics: raw source/mask and content-alpha selection ignore Fill; final channel/preview/export includes it. Arrangement Fill0 refusal differs deliberately from successful unfilled placement. Placement, extraction, rasterize, duplicate, source Bake, painting and canvas changes retain Fill without double application or loss of source alpha/hidden RGB.
6. Styles/recipes: clear and saved-style apply preserve Fill; capture excludes it; Fill-only empty-style capture still refuses. Existing five-family recipe bodies/hashes stay unchanged and replay preserves target Fill. No accidental Fill capture or unknown-step acceptance.
7. Metadata/resources: same decorated layer before/after Fill has equal applicable resource estimates and existing limits. Fill-only adds no protected-context mask preparations or style allocations. PSD nonunit refusal precedes pixels, while Fill1 preserves the current strict subset. Flattened output and native bundle/restart are exact.
8. Transport/UI/lifecycle: actual MCP command and transaction with positive revision, stale/no-change, one Undo/replay, late transaction and real persistence failure rollback; existing asset ownership unchanged. Exact public projection/capability gates, independent Opacity/Fill drafts, protected/clipping explanations, target/revision ownership and late-response rejection. Visual acceptance should include outlined text and a photographic subject at partial/zero Fill.

Root and independent review accepted this complete map. The metadata helper is `server/layer-fill.mjs`; registered pure tests are `tests/layer-fill.test.mjs`. Native integration now covers every listed rendering, protection, display/source, style, resource and persistence seam. Existing whole-layer copies preserve the internal wrapper through extraction, duplicate, rasterization and source Bake; placement explicitly uses unfilled source materialization. Shared/schema/status/MCP registration follows the same dedicated revision-pinned command contract.

Owner acceptance is3 pure plus7 native tests,10/10 in0.897 seconds. This covers all27 legacy blend paths, six independent native blend/body-decoration comparisons, no early alpha rounding, owned canonical styles/projection, Fill-zero placement/extraction/arrangement distinctions, rasterize, raw-source alpha through filters/Distort/Bake, PSD preread refusal, partial protection, queued argument ownership, transaction rollback and restart. `tests/fixtures/layer-fill/cold-worker.mjs` verifies all512² photographic bytes across four Fill values and masked/unmasked rendering in two fresh ordinary optimized processes. Source assets stay immutable. Early failures were test fixtures lacking segmentation dimensions/required transaction labels; no pixel defect was found.

The existing affected effects/styles/clipping/PSD suites and isolated helper checks passed38/38 before the final owner sweep. Root's independent official SDK4 plus schema3 pass7/7, including protected Fill0 versus positive subnormal Fill through the saved generation-mask workflow and real persistence failure. Independent native10 plus actual-client2 checks passed12/12 in0.639 seconds. The final full suite passed1206/1206 in24.553913917 seconds, and focused8 plus adjacent59 browser workflows, final build and doctor103 completed acceptance. These29 new maintained checks are attributed over the final Dense1177 baseline. No dedicated timing rerun is required for this scalar-only change: it adds no pixel plane, cache or sampling pass and makes no new responsiveness claim.

A dedicated Fill recipe family, clipping Fill behavior, PSD advanced Fill support and linked Perspective gestures remain separate decisions.

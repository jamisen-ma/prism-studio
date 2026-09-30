# Native Layer Fill: bounded design review

Status: **acceptance closed: full regression 1,206/1,206 in 24.554 seconds, 67 browser workflows and final build**, 2026-09-19. The independent native 10 and actual-client 2 audits pass 12/12 in 0.639 seconds. The final [native design](LAYER_FILL_DESIGN.md) and [API plan](LAYER_FILL_MCP_DESIGN.md) incorporate the complete effects-wrapper, source/display, protection and clipping map below. The UI owner reports focused 8/8 in 51.247 seconds, adjacent 59/59 in 136.988 seconds and final build in 0.555 seconds; all processes exited successfully. This reviewer owns the independent fixtures, tests and memo, and has made no production edits. Dense-mask acceptance and its narrow sparse-style resource correction are separate.

Recommend Layer Fill as the next renderer feature, provided its first contract explicitly separates content opacity from outside effects and closes old-reader compatibility. It enables outlined text, ghosted subjects and shadow/glow-only artwork that the current single Opacity control cannot express on one editable layer. Linked Perspective gestures are a smaller client-only enhancement, but the existing four-corner stage already expresses their output numerically. Fill supplies new compositing behavior; it is not a one-field UI change.

## Primary references and actual starting point

Adobe distinguishes overall layer opacity from Fill: Fill changes the layer's pixels/shapes/text while leaving effects such as shadows unaffected, and groups expose only overall opacity. Its current layer-style page also exposes Fill separately from layer/effect opacity. These references establish workflow intent, not a published numerical implementation to copy. [Adobe layer opacity and blending](https://helpx.adobe.com/photoshop/using/layer-opacity-blending.html), [Adobe layer-style options, updated February 23, 2026](https://helpx.adobe.com/photoshop/desktop/create-manage-layers/apply-layer-effects/layer-style-effects-and-options-overview.html).

The current compositor already generates outside effects separately, composites decoration with `layer.opacity`, then composites the content with the same opacity. [`renderGraph`, `visibleLayerPixels`, `layerDecoration`, `markProtected` and `composite`](../server/native.mjs) are the important seams. [`renderOutsideEffects`](../server/layer-effects.mjs) and the outline helper use original effective source alpha and mask coverage; they deliberately leave overall opacity to their caller. This is a good fit for a second content-only factor without another image plane.

Existing behavior is more specific than generic Photoshop styling: native shadow/glow/outline are outside-only; occupied pixels are identified from unfilled source alpha and mask coverage. At Fill zero, preserving that same occupied silhouette leaves a transparent body with outside decoration. It does not turn on inner effects, show a shadow through the former body, add knockout, or change Blend If. Those would be separate features.

## Proposed smallest complete pixel contract

Support the six existing content types: raster, solid, text, shape, path and gradient. Groups and global adjustment layers keep their current Opacity controls and reject the new Fill setter. Fill covers all rendered pixels of a shape, including its intrinsic vector stroke; it is distinct from a shape's paint color named `fill`.

Let `O` be overall opacity, `F` Fill and `M` the prepared additional-mask coverage. Both opacity values are finite Numbers in `[0,1]`; omitted Fill is exactly 1. Do not quantize stored values to percent integers or to alpha8.

1. Evaluate source RGB filters and their whole-stack effect mask, then retained geometry, exactly as today. Fill does not modify stored/source RGBA or filter candidates.
2. Generate existing outside decoration from the resulting source alpha and `M`, **without F**. Composite it with overall opacity `O`, the current layer blend mode and the current protection behavior.
3. Composite the content with `bodyOpacity = O * F` through the existing compositor. Its source amount is `(A / 255) * bodyOpacity * M`; use the existing blend and final byte-rounding order. Do not first round `A*F` into a new byte plane.
4. Preserve the literal legacy path when F is 1. F=0 skips only body contribution; O=0 or hidden visibility suppresses both body and decoration. Do not skip decoding/style generation merely because F=0 when outside effects are enabled.

This is a declared **native content-opacity policy** across the existing 27 layer blend modes. The blend function itself remains unchanged, including deterministic Dissolve after the effective source amount is formed. It makes no Adobe-specific Fill/blend numerical parity claim. Frozen discovery is `layerFillPolicy: 'content-alpha-outside-effects-v1'` and `layerFillContentTypes`. Root chose a typed known subset: only an advertised supported target type is enabled; duplicates, unknown/non-string entries and non-arrays reject, and an empty list enables none. The current native backend advertises all six types.

The first slice should require Fill=1 for every clipping-chain participant. [`blendClippingInterior`](../server/clipping.mjs) currently changes only base RGB, preserving base alpha, then applies base opacity/blending once to the entire chain. Multiplying base opacity by Fill would fade all clipped members; altering base alpha before member blending would erase the clip silhouette and effects. Neither is automatically “base pixels only.” Reject nonunit Fill on existing participants and reject creating a chain with nonunit Fill anywhere, including hidden members. A later clipping extension needs its own declared base/member rule and preview goldens. Do not silently pick one now.

## Protection, masks and content consumers

Changing Fill on protected content should require explicit unprotection, just like changing overall opacity. A saved layer may subsequently be protected with its current Fill. At exact F=0, its content contributes no protected footprint, while its nonzero outside decoration still does. At positive F, retain the current conservative positive-alpha protection policy; do not replace it with a new byte-rounded visibility test. Update both ordinary `markProtected` and original-context `protectedPixels`, so generated content, later adjustments and source-filter restoration agree. Existing ancestor opacity/isolation restrictions remain.

Additional geometric/RLE/alpha8/positioned masks keep their current place in content and effect-shape evaluation. Fill is not folded into a mask, mask density, alpha8 asset or source effect-mask LUT. Raw/effective mask inspection and selection loading from a mask therefore remain unchanged. `load_layer_selection(source:'content')` is explicitly a source-transparency operation that already ignores display opacity; it should also ignore Fill. Composite channel selection, histogram, eyedropper, all-layer retouch sampling and generation snapshots naturally see the rendered Fill result.

Do not conflate other similarly named consumers: layer-specific `select_subject` currently uses `visibleLayerPixels`, so it sees Fill, effects, masks and existing per-ancestor alpha rounding. `extract_subject` uses `sourcePixels`, so segmentation stays independent of Fill and the duplicated cutout preserves the wrapper. Clone/Heal Current samples raw rendered target pixels; All/Below samples a composite and therefore sees Fill. None needs a second Fill multiplication.

The source image, separate cutout alpha and all hidden RGB remain immutable. Source-filter Bake preserves Fill metadata rather than baking it into alpha. Pixel painting/refinement remains source editing and preserves the display setting. Content geometry remains editable and independent of Fill. Duplicate, extraction and copy paths must retain the setting; old ad hoc rasterization/placement constructors need explicit attention.

## Compatibility and commands

A plain additional `fillOpacity` field is unsafe as the sole persisted representation. Current [`validateGraph`](../server/native.mjs) accepts unknown layer fields, so an old reader could reopen it, ignore Fill and render a different image. A new policy string alongside that unknown field does not solve the problem.

Two existing fields provide a narrow old-reader refusal boundary. An incompatible wrapper in the already validated opacity field is straightforward:

```js
// Legacy storage remains literally unchanged when Fill is 1.
opacity: 0.8

// New storage only for nonunit Fill; strict own enumerable data fields.
opacity: { version: 1, overall: 0.8, fill: 0.25 }
```

Old native validation rejects that object where it requires a number, including retained history and portable graphs. It also creates a broad accessor migration: every overall-opacity comparison and multiplication in rendering, grouping, clipping, protection, arrangement, placement, setters and PSD paths must unwrap it.

The owner's selected proposal uses the existing strictly validated effects field:

```js
opacity: 0.8,
effects: { version: 1, fillOpacity: 0.25, styles: null }
// styles holds the legacy shadow/glow object when present.
```

Old `normalizeEffects` rejects the new keys, even with `styles:null`. This keeps overall opacity numeric and limits the migration to the smaller set of effects consumers plus the explicit body/protection readers. **The effects wrapper is the preferred proposal, subject to its complete accessor map.** It is storage framing, not a claim that Fill becomes part of saved outside-style presets. Do not also implement the compared opacity wrapper.

With this option, `set_layer_effects(null)` and saved-style replacement preserve Fill. Saved-style capture reads only the nested styles. `denseDecorationBytes` enumerates those styles so the blur/outline phase estimate is unchanged. The original-context predicate in `renderGraph` must test actual styles rather than wrapper truthiness: a Fill-only wrapper must not introduce protected-context reads. Preserve existing legacy empty-style behavior instead of using this migration to change its optimization policy. Placement/rasterization copy the complete wrapper, but placement's unfilled source extraction explicitly bypasses Fill. PSD preflight checks Fill separately before projecting style metadata.

New public documents project the ordinary legacy `effects`, numeric `opacity` and optional numeric `fillOpacity` (absence means 1); internal snapshots/bundles retain the chosen wrapper. Wrappers require Fill below 1; setting Fill to 1 unwraps to canonical legacy metadata. History containing a wrapper remains intentionally incompatible with an old reader. Reject public `fillOpacity` as a stored layer field, alone or alongside the wrapper, so a portable graph cannot silently ignore a projected/conflicting value. A project/bundle version upgrade is another valid route, but broader than this local framing.

Centralize strict read/update/project helpers. A public-document clone must never be used as a persisted graph and silently drop Fill. Malformed wrappers, extra keys, getters, custom prototypes, null, nonfinite values and wrappers on unsupported layer types reject before pixel I/O. Wrapper identity handling and exact optional-style canonicalization must be pinned before tests are written.

The final native design resolves that last point: persisted nested styles require complete normalized records, with null for no styles. Sparse `styles:{shadow:{}}` and empty `styles:{}` wrappers reject. Entering wrapped storage through the setter materializes accepted legacy style defaults into owned complete fields. This is necessary because numeric resource readers must see effective opacity/blur, not absent fields. Existing unwrapped sparse styles keep their previous accepted rendering semantics.

Recommend a new revision-pinned native `set_layer_fill {documentId, expectedRevision, layerId, fillOpacity}` mutation, transaction-capable and unavailable on the bridge without its own implementation. Existing `set_layer.opacity` edits only overall opacity and preserves Fill. There must be no implicit reset when changing blend, visibility, masks, styles or filters. Root has narrowed the first slice to direct/transactional editing; this command is not added to the recipe allowlist.

## Actual implementation touch points

| Seam | Required result |
| --- | --- |
| `native.mjs`: validation, `asDocument`, serialization/history | Strict stored wrapper; public numeric Fill/Opacity and ordinary-style projection; inactive/history records validate; exact legacy round-trip. |
| `renderGraph` and `composite` | Body uses O×F; decoration uses O; legacy Fill=1 has unchanged pixels and rounding. |
| `visibleLayerPixels`, layer preview and arrangement | Display materialization applies Fill to body; arrangement intentionally excludes styles and refuses a Fill=0 target for empty body bounds even when decoration is visible. Raw source reads remain independent. |
| `markProtected` / `protectedPixels` | Fill=0 content footprint disappears while outside decoration remains protected; original-context and ordinary render agree. |
| `clipping.mjs` and chain mutations | First-slice nonunit Fill refusal applies to existing bases/members and prospective links, including hidden entries. |
| `place_layer` | Measure unfilled source geometry and preserve Fill separately, analogous to its existing opacity-preserving path. Do not bake Fill into cutout alpha and then copy effects. A Fill=0 style-only source still has a recoverable unfilled silhouette. |
| `rasterize_layer`, extraction, duplicate and subtree copy | Preserve Fill while changing the source representation. Source Bake and paint keep it as display metadata. |
| Layer/style resource helpers | Read actual nested styles with the selected wrapper; do not discount source/filter/style resources at Fill=0. No added image plane/cache or asset quota. |
| PSD native/import/export | See explicit subset boundary below; prevent projected metadata from hiding Fill before preflight. |
| Shared/API/status/MCP/UI | Strict command, policy/type gates, numeric public fields, exact retained draft, protected/clipping explanations and owned preview installation. |
| Recipe capture/validation/execution | No Fill step or capture in the first slice. Existing effect-only recipes/presets and ordinary unrelated steps preserve Fill; unsupported authored Fill steps reject. |

The current saved layer-style format only stores outline/effects. Keep that boundary rather than silently changing every preset's meaning. Label that Fill is a layer setting. Root explicitly deferred Fill recipe capture/execution for the first slice: captured effects retain only outline/shadow/glow, and applying them preserves the target's Fill. This limitation must be clear wherever capture might imply a complete appearance transfer. Existing recipe validation, protection and clipping rules remain; a new unsupported Fill step is rejected instead of being ignored.

## PSD and resource scope

Current [`psd-import.mjs`](../server/psd-import.mjs) recognizes `iOpa` only when its one byte is 255; nonidentity Fill is already outside the accepted subset. Current [`psd-export.mjs`](../server/psd-export.mjs) writes only overall opacity, refuses styles/clipping/nonnormal blends and checks exact byte-representable opacity. Therefore the first Fill release should explicitly refuse layered PSD export for nonunit Fill, even with no styles. Do not multiply O×F into the existing opacity byte and describe the setting as preserved. Keep current import behavior. Flattened image export remains exact to the native composite; editable `.prism` transfer preserves the new representation.

No LUT, typed asset, spatial cache or additional full-frame buffer is required. Reuse the existing source/style phases and compositing arrays. Keep all old named resource gates, including Dense/LUT/Distort envelopes and deferred mask lifetimes. Fill=0 does not waive filter work, protected-context validation or malformed metadata checks. Runtime measurement only needs to confirm the scalar addition does not compromise existing responsiveness; this proposal needs no large benchmark to establish its memory shape.

## Minimum acceptance before release

- Legacy no-Fill and explicit Fill=1 bytes/serialization remain exact across all 27 blend modes, fractional overall opacity and alpha 0/1/128/255. Stored fractional Fill survives unrelated edits without decimal snapping.
- Independent body/effect fixtures distinguish O=0 from F=0 and O=0.5/F=0.5 from each alone. Outline+shadow+glow overlap and mask density/feather are evaluated from unfilled alpha, with no new intermediate alpha-byte quantization. Include deterministic Dissolve and nonnormal blends.
- A literal transparent-backdrop discriminator uses body A=1, O=0.5, F=0.5, M=1: direct compositing rounds final alpha to 0; incorrectly rounding A×F first yields 1. An opaque body under the same O/F rounds to alpha 64, while an opaque outside-effect pixel receives O only and rounds to 128.
- All six content types; source filters plus whole-stack mask before geometry; positioned/dense masks; global adjustments and generated layers above protected Fill=0/positive layers; isolated/pass-through ancestor groups.
- Clipping restrictions fail before source reads in both link and Fill commands. Protected Fill changes refuse; protection footprints include only the declared body/effect contributions.
- Display preview/arrangement differ correctly from raw content-alpha selection. Place/rasterize/extract/duplicate/Bake preserve the setting and immutable originals; Fill=0 styled placement does not lose its underlying silhouette.
- Canonical portable malformed negative fixtures include a valid control; old-reader validation demonstrably refuses nonunit persisted Fill. Undo/redo/restart and current-state bundle round-trip preserve both opacity values. Real persistence and late transaction failure leave no published change.
- PSD subset refusal precedes rendering; flattened export matches the native composite. Existing recipe hashes and effect-only capture remain unchanged, applying a style preserves Fill, and unsupported Fill recipe steps reject.
- UI retains precise drafts across supported inspection, disables mutation for protected/clipped/unsupported contexts, and prevents late responses/previews from installing after target, revision or policy changes.

## Comparison with linked Perspective gestures

Adobe's current transform documentation distinguishes free Distort and Perspective gestures. It describes an explicit commit/cancel transform workflow, but does not supply a native sampler or a formula that must be duplicated here. [Adobe Free Transform](https://helpx.adobe.com/photoshop/using/free-transformations-images-shapes-paths.html), [Adobe transform types, updated February 23, 2026](https://helpx.adobe.com/photoshop/desktop/crop-resize-transform/transform-manipulate-reshape/adjust-scale-rotation-and-perspective.html).

Prism already has editable historical `distort` stages, fixed frames, strict convex/stability admission, exact corner string drafts and trailing-stage handles in [`Distort.tsx`](../client/Distort.tsx) / [`distort-model.ts`](../client/distort-model.ts). A linked perspective mode could constrain paired corner edits before submitting the same four corners. It would need captured-baseline math, explicit axis/link rules, keyboard access and cancellation/ownership checks; it would need no new persisted geometry kind, asset format, renderer or resource policy. Historical nontrailing handles remain unavailable unless a separate mapping is designed.

Choose that gesture slice first only if the priority is a very small interaction improvement. For the next substantive compositing feature, choose the bounded Fill contract above. The final effects-wrapper and clipping decisions are clear; this review does not authorize a broad Photoshop blending/knockout/PSD-parity project.

## Independent fixture checkpoint

[`tests/fixtures/layer-fill/reference.mjs`](../tests/fixtures/layer-fill/reference.mjs) contains no production or owner-prototype imports. Its declared-order pixel/full-buffer reference covers Normal, Multiply, Screen, Difference, Overlay and Dissolve. A separate reduced-BigInt comparison checks algebra without claiming universal exact-real parity for the existing binary64 compositor. Twenty literal pixel cases and four mask-coverage cases pass standalone assertions and the maintained native audit, along with full-buffer input-immutability checks. They include the A=1 no-early-rounding discriminator, Fill=0 decoration retention, alpha 0/1/128/255, partial backdrops, continuous/dense density and strict Dissolve threshold equality. The [fixture README](../tests/fixtures/layer-fill/README.md) states its stage boundaries.

The final accessor audit also exposed a preexisting Dense resource defect for accepted unwrapped sparse styles. On a 4000×4000 raster with a raw alpha8 layer mask, `effects:{shadow:{}}` had charged 192,000,064 bytes with zero decoration; its effective default shadow requires a joined 337,256,176 bytes. The owner corrected decoration estimation to normalize accepted legacy defaults. A new maintained independent test pins sparse shadow/glow variants, disabled/empty positive controls, outline overlap and actual render refusal before intercepted image/mask/filesystem I/O. The complete Dense audit passes 15/15 after that correction. Root's resulting full baseline passed 1,177/1,177 in 22.797 seconds before Fill integration began; Dense also closed 88 browser workflows and build checks.

## Independent production acceptance

[`tests/layer-fill-audit.test.mjs`](../tests/layer-fill-audit.test.mjs) passes ten maintained native audits. They exercise owned canonical wrappers and legacy forms; complete native RGBA against the independent six-mode reference; masked outside-shadow/body separation; exact-zero and positive-subnormal protection, generated content and original-context restoration; all six content types; raw selections versus displayed segmentation, extraction, unfilled placement, rasterization and source-filter Bake with Distort; style/recipe/opacity/protection retention; metadata-first clipping/PSD/resource refusals; canonical malformed portable fixtures with a valid original-asset control and malformed retained-history refusal; and real ENOTDIR publication failure plus rollback after a real pixel asset write. Resource tests verify Fill=0 does not discount source/style phases, including Dense's effective legacy defaults. No test claims universal Adobe blend parity.

[`tests/layer-fill-client-audit.test.mjs`](../tests/layer-fill-client-audit.test.mjs) imports the actual TypeScript helper and dependencies through Vite and passes two audits. Saved arbitrary fractions and representable subnormals survive display and equivalent input; new lexical underflow and percent-division underflow reject; signed/scientific zero remains valid. Capability lists accept known supported subsets while rejecting malformed/unknown/duplicate lists, and eligibility includes hidden clipping participants. An independently found lexical-underflow gap was corrected by the UI owner before acceptance.

The final source read covers every server `.effects` consumer, body/decorative compositing, both protection paths, source/display reads, placement/rasterization, styles, clipping, resource estimation and PSD. Remaining direct effects copies deliberately retain the complete persisted wrapper; style-only reads use the accessor. Client response acknowledgement occurs before metadata publication, and target/capability epochs guard response and preview acceptance. A stale or failed response retains the draft; the owned refresh path never replays the mutation. UI owner evidence reports focused 8/8, including capability away/back during a held preview, plus all 59 adjacent workflows and the final build. Root's full regression passes 1,206/1,206 in 24.554 seconds after a test-only guide-audit loader correction retained its six existing assertions. No independent source blocker remains.

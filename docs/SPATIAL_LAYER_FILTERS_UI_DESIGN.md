# Source-layer Gaussian blur and RGB sharpen controls

Implemented and browser-verified, 2026-09-19. Resize UI acceptance is complete: focused8 + canvas4 + mask-position8 and build pass. This proposal follows the approved [native contract](SPATIAL_LAYER_FILTERS_DESIGN.md) and [independent arithmetic/resource review](SPATIAL_FILTER_REVIEW.md), against the current `LayerFilters`, scalar adjustments, recipes and Bake controls. The following approved contract is implemented in the bounded client seams described below.

## Controls and honest scope

Add two source-only definitions to the existing Layer filters editor; do not reuse or alter the global `SCALAR_ADJUSTMENTS` blur/sharpen definitions, validation, labels or pixels.

| Saved kind | Source-editor label | Authored value | New local default |
| --- | --- | --- | --- |
| `blur` | Gaussian Blur | Gaussian sigma, 0–50 source pixels | 3 |
| `sharpen` | Sharpen (RGB) | Gaussian sigma, 0–10 source pixels | 1 |

The field label is **Sigma, source px**. Preserve the existing accessible `Layer filter value` and `Layer filter amount` names for numeric/slider controls and expose the visible sigma label. Number input uses `step="any"`; a convenience slider can use 0.1 without imposing a step grid on saved/manual input. These source definitions must bypass `validAdjustmentValue`'s existing global step-grid check. Every finite numeric sigma within its range is accepted, including true tiny positive values. Do not clamp to 0.3, round to slider steps, silently truncate or copy the global Sharpen label.

Keep a separate string sigma draft inside the existing per-filter draft state. Blank/incomplete/NaN/infinite/out-of-range values disable Apply and issue no request. Parsing yields a numeric payload only on explicit Apply. A valid equivalent numeric spelling compares equal to the saved number; an untouched tiny or scientific-notation value must not become dirty simply by opening it. Kind/filter/layer/document/revision changes use the existing draft identity rules; number and slider edits update the same local sigma draft. Other scalar inputs need no refactor.

Place compact, always-visible guidance below the sigma controls:

- Both: “Changes RGB on source pixels before transforms. Alpha and the cutout silhouette stay unchanged; masks and layer opacity apply afterward.”
- Gaussian Blur: “Blends neighboring visible colors. Sigma 0 bypasses the effect; very small positive values may produce no visible change.”
- Sharpen (RGB): “RGB unsharp with fixed amount 1 and threshold 0. Sigma sets the neighborhood; filter opacity blends its result. This is separate from the global Sharpen adjustment.”
- Both: “Larger sigma values and source images use more work. A limit refusal keeps the existing stack unchanged.”

The source filter does not promise silhouette blur, feathering, Adobe Unsharp Mask/Smart Sharpen parity, a configurable Amount/Threshold, LAB sharpening or a live draft preview. Preview changes only after the existing saved mutation. Keep the exact alpha/hidden-RGB promises in public documentation/backend tests; UI wording can stay short. Update the shared stack introduction from “Median and mosaic sizes scale with the layer” to include source blur/sharpen sigma without implying masks are filtered.

Value0/tiny identity output still leaves an enabled positive-opacity entry in the saved stack. Its normal protection/source-paint/Bake rules remain structural. Existing disabled and 0%-opacity entries remain bypasses. Add a targeted note when sigma0 is selected: “Zero leaves pixels unchanged. This saved filter still belongs to the stack; Bake or Clear removes it before source editing.” Do not imply that zero enables source painting automatically.

## Capability and saved-stack boundaries

Add optional `Backend.layerFilterSpatialPolicy?: 'alpha-weighted-gaussian-rgb-v1'` and typed work/scratch limit fields only if needed for display/signature. Source spatial authoring requires all of:

1. matching native document/backend;
2. `layerFilterCoordinates === 'source'`;
3. the exact spatial policy marker;
4. the individual `blur` or `sharpen` entry in `layerFilterKinds`;
5. the applicable add/update command.

The full native list becomes24 source filters. Missing/unknown policy, absent source-coordinate marker or absent individual kind hides that new choice and disables Apply/toggle for a previously saved corresponding spatial entry. Show the saved value, label and a precise read-only explanation rather than substituting a global adjustment or dropping settings. Existing22 color/filter kinds retain their current capability behavior; a missing spatial marker must not disable them.

Keep Bake/Clear as independently advertised whole-stack operations. Their existing saved-stack semantics, protected-prefix checks, source-alpha disclosure and unsupported-editor-kind behavior remain unchanged. Reorder/delete retain their current metadata command gates. No new permission dialog or implicit Bake is introduced.

Include the policy and source-coordinate marker in the existing filter/stack capability identity so a changed algorithm advertisement cannot accept a stale add/update/toggle completion. Preserve the current document/layer/filter/kind capture, normal own-success new-filter selection and pre/post-preview App gates. No broader runner change is anticipated after the completed resize work. A revision conflict refreshes once and discards the rejected mutation without replay. A resource refusal surfaces the native message, leaves the submitted local sigma visible for an explicit edit, and never retries with a smaller value.

## Recipes and Bake

`recipe-capture.ts` already copies saved filter kind/value/enabled/opacity in order, so capture/import/export needs no new format or evaluator. Capture only saved settings; unapplied sigma drafts remain excluded. After companion restart, retrying the original revision stale-rejects and requires explicit reconciliation; there is no durable application receipt. Existing recipe validation/application owns range and cumulative resource admission and its same-session request-ID deduplication and explicit recovery behavior must stay untouched.

Implemented narrow UI capability check: for recipe steps with `command:'add_layer_filter'` and kind blur/sharpen, require the same spatial policy/coordinate/kind support before enabling Validate/Apply. Keep capture/import as definition-only actions even if execution is unavailable. A shared predicate avoids inconsistent filter-editor versus recipe claims. Only the existing `supported` predicate/context signature and its explanatory copy in `EditRecipes` changed; no recipe application/retry logic changes. Root approved this narrow seam before implementation.

Bake is tested end to end with a saved spatial+color stack, fractional opacity, separate source alpha and retained transforms. The exact displayed result must survive Bake and Undo while original/source and source-alpha assets stay exact. The existing cutout-edge sampling disclosure remains accurate: later revealing source-alpha-hidden pixels does not retroactively grade their hidden RGB. Never auto-bake during source painting, mask review, recipe application or PSD export.

## Eight bounded browser workflows

Use isolated native projects, synthetic alpha fixtures for exact assertions, and the unchanged NASA photograph for actual exports and screenshots. No provider, segmentation, key access, package installation or user-project changes.

1. **Discovery and draft precision:** all24 native choices with distinct source labels; correct range/defaults; blank/negative/overflow/infinite draft produces no write; true tiny positive and zero values persist exactly. Equivalent spelling is clean. Existing global blur/sharpen options/pixels remain a separate path.
2. **RGB/alpha and ordering:** create/edit both kinds, fractional opacity, enable/disable and reordered saved stack. Compare actual native exports against precomputed independent/backend oracle evidence where appropriate; browser owns command/state/alpha checks, not a second production implementation. Synthetic cutout fixture includes alpha0/1/128/255 and separately stored alpha; source preview/hidden bytes remain exact and the silhouette does not expand. Transform/mask edits do not rewrite sigma.
3. **Zero/tiny structural behavior and protection:** zero/tiny identity can leave pixels exact but still requires explicit stack removal before source editing; disabled/0%-opacity and protected target/prefix behavior stay consistent. Full operation uses one Undo; redo/reopen preserve exact saved sigma and order.
4. **Partial capabilities:** add-only/update-only, individual-kind subsets, missing/unknown policy and missing coordinates. Legacy22 remain usable; saved spatial entries are readable but not editable/toggleable; unrelated whole-stack Bake/Clear retain their independently advertised behavior. No unsupported spatial authoring command leaves the browser.
5. **Recipes:** capture saved spatial order including disabled/zero entries while a different local sigma draft exists; inspect/export/import preserved numeric values; bind another eligible raster, validate and apply once, then one Undo. Missing spatial policy disables execution through the narrow capability predicate. Existing same-session retry/recovery tests remain adjacent regressions.
6. **Bake and continuation:** photo or cutout spatial+color stack → explicit Bake → byte-exact composite and alpha → ordinary eligible source paint → separate Undo for paint and Bake. Clear visibly removes the grade. Source assets and geometry stay immutable; no implied silhouette or source-alpha repair change.
7. **Refusal and lifecycle:** native radius/work limit rejects without asset/history mutation or automatic sigma reduction; stale revision refreshes without replay; delayed Apply/toggle results cannot retarget after document/layer/filter/capability changes, including a pending status response withdrawing the policy. Accepted own add/update completes normally.
8. **Actual photo and compact UI:** save unchanged-photo, blur and RGB sharpen native PNG outputs with source asset hash; screenshot complete inspector at1440 and900 pixels with sigma, guidance, Apply and Bake visible/reachable, no horizontal overflow. Reopen/Undo/Redo, command revisions, browser errors and zero provider/key calls are checked.

Run build and adjacent layer-filter4, tonal8, recipes5 and Bake6 browser suites, updating the prior discovery assertion from22/excluded blur+sharpen to24/included only with the new policy. If shared UI changes expose a specific resize/mask regression risk, rerun its focused existing suite; no blanket unrelated test expansion is needed.

Primary production seams are `client/LayerFilters.tsx`, the API capability type, a small source-filter definition/support helper if useful, bounded filter CSS, and the explicitly approved recipe capability predicate. Root owns schemas/MCP/status/public guidance; native owner owns evaluation/resources; independent reviewer owns numerical oracles. The implementation followed root approval of this document.

## Implementation and acceptance evidence

Implemented a small source-only definition/support/precision helper in `client/source-spatial-filters.ts`, separate sigma string drafts and disclosures in `LayerFilters`, the API policy marker, and the approved recipe execution-capability/context predicate. Global scalar definitions and native/global algorithms were not changed by this UI work. Existing application request-ID/recovery code is unchanged. The generic layer-filter browser discovery check now expects24 kinds and both spatial options.

Validation:

- `npm run test:spatial-layer-filters-browser`: **8 workflows passed**.
- `npm run test:layer-filters-browser`: **4 workflows passed**.
- `npm run test:tonal-color-browser`: **8 workflows passed**.
- `npm run test:edit-recipes-browser`: **5 workflows passed**.
- `npm run test:filter-bake-browser`: **6 workflows passed**.
- `npm run build`: passed with existing bundle-size/lucide directive warnings.

The31 browser workflows used isolated temporary native projects and no provider, model or credential access. `test-results/spatial-layer-filters-browser-report.json` records zero provider calls, key reads and browser errors; its two deliberate refusals are the work-limit400 and stale-revision409. Source-asset bytes and existing global blur/sharpen output remain exact.

Focused evidence includes `Number.MIN_VALUE`/`0.001`/zero persistence, no step rounding or false dirty state, every synthetic alpha byte preserved, separate source-alpha and hidden working RGB retention, ordered fractional filters, exact spatial Bake appearance and independent paint/Bake Undo, strict partial capabilities, and stale filter/layer/document/preview/policy handling. Missing policy also invalidates an existing ready recipe report, and a new spatial choice losing support leaves the other22 filter choices usable. Native independent tests own the Gaussian/one-round-unsharp arithmetic oracle; this UI suite exercises actual command/state/pixel integration without reusing the production helper as an independent oracle.

Saved photographic artifacts are actual native exports:

- `test-results/spatial-photo-original.png`
- `test-results/spatial-photo-gaussian-blur3.png`
- `test-results/spatial-photo-rgb-sharpen1.png`
- `test-results/spatial-filters-1440.png`
- `test-results/spatial-filters-900-stack.png` (top of saved stack/Bake)
- `test-results/spatial-filters-900.png` (sigma/help and Apply)

The unchanged original NASA/scikit-image fixture retains SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5` and its existing provenance in `tests/fixtures/tonal-color/README.md`. The photograph preserves its original background and helmet; no generated replacement or segmentation ran.

Independent source review found no blocker in precision parsing, saved unsupported entry inspection, exact policy/coordinate/kind admission, captured filter/stack lifecycle or recipe-report invalidation. The normal inspector remains scrollable; compact acceptance checks actual viewport reachability, not only DOM visibility.

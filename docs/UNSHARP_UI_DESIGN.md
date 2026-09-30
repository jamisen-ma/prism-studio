# Source-only Unsharp Mask controls

Implemented and browser-verified, 2026-09-19. The approved design follows [the independent feasibility review](UNSHARP_REVIEW.md) and the existing accepted source spatial-filter UI. Root approved the backend policy, work and identity contract after its complete benchmark; root subsequently approved this UI design and its narrow recipe capture/capability seams. Root owns shared command schemas, MCP, status and public documentation. The implementation uses the finalized [backend contract](UNSHARP_MASK_DESIGN.md).

## A distinct source-filter editor

Expose **Unsharp Mask** only in the raster layer's saved filter stack. Its wire kind is `unsharp_mask`, scalar `value` is always0, and the editor sends a complete canonical parameter object:

```json
{"amount":100,"sigma":1,"threshold":0}
```

The source filter list becomes25 kinds; the global adjustment list stays24. Existing **Gaussian Blur**, **Sharpen (RGB)** and global **Sharpen** remain separate choices with their current pixels, ranges and controls. Do not add this kind to `SCALAR_ADJUSTMENTS`, global parameterized-kind lists, `ColorWorkbench`, adjustment-property editors or global recipe slots. Do not present the old fixed source Sharpen as an alias for the new three-control family.

| Visible field | Accessible name | Range and manual entry | Initial value |
| --- | --- | --- | --- |
| Amount, % | Unsharp amount percent | 0–500; canonical hundredths of one percent | 100 |
| Sigma, source px | Unsharp sigma source pixels | finite0–50; no floor or step rounding | 1 |
| Threshold, per RGB channel | Unsharp threshold | integer0–255 | 0 |

Use compact vertical rows at the existing inspector width. Each row contains a number input and optional convenience slider. The number input for sigma uses `step="any"`; amount uses0.01 and threshold1 as keyboard increments, with explicit parsing remaining authoritative. A coarser sigma slider may use0.1, but opening a saved tiny/manual sigma must never rewrite it to the slider's visual step. Keep **Filter opacity, %** as the separate existing stack blend control below these settings. **Reset Unsharp Mask** is a local draft operation that restores the three defaults and leaves the independent filter opacity untouched; it sends no mutation, including in add-only/update-only capability partitions.

Always show “Sharpens source RGB and preserves transparency.” and the applicable identity note. The following detailed guidance remains available in an accessible, initially collapsed **How Unsharp Mask works** details section; this keeps opacity and Apply closer to the three controls:

> Amount strengthens the RGB difference from an alpha-weighted Gaussian neighborhood. Filter opacity blends the finished result separately.
>
> Each RGB channel changes only when its difference is strictly greater than Threshold. Equal differences stay unchanged; channels can change independently.
>
> Sigma uses source pixels before transforms. Alpha and the cutout silhouette stay unchanged; layer masks and opacity apply afterward.

A short supplemental note can say: “Sigma0 or Amount0 leaves pixels unchanged. Very small positive sigma may also produce no visible change.” Threshold255 also leaves pixels unchanged and is included in this identity note. Enabled positive-opacity identity entries still belong to the saved stack and keep its protection/source-edit/Bake-prefix rules. Do not imply that identity pixels permit source painting or PSD export while a stack remains.

This UI describes native RGB thresholding, not luminance thresholding, Adobe radius equivalence, LAB sharpening, Smart Sharpen, high-bit-depth editing or a live unsaved preview. The operation may change hue because channels cross the threshold independently. Larger sigma/source images affect resource admission, and Amount0→positive can leave the identity path; all positive nonidentity amounts have the same work allowance; surface a native refusal without silently changing the settings.

## Separate source parameter types and canonical drafts

Introduce `UnsharpMaskParameters = { amount:number; sigma:number; threshold:number }` and `LayerFilterParameters = AdjustmentParameters | UnsharpMaskParameters`. Change only `LayerFilter.parameters` and source-filter editor helpers to use the wider family. `Layer.parameters` for a global adjustment and `AdjustmentParameters` remain unchanged. The existing source parameter normalizer dispatches the new family before passing any color parameter object to the old controls. No permissive generic cast should make the new object a valid global adjustment input.

Use an `UnsharpDraft` containing three strings, scoped through the existing filter draft identity. Empty, incomplete, nonfinite, out-of-range or invalid-precision values remain local strings; Apply is disabled and nothing is sent. Amount parsing must accept exactly the backend's canonical hundredth-percent representation and reject finer authored precision rather than silently rounding it. Use the exact canonical check `Math.round(amount*100)/100 === amount`, with no tolerance and no rounding of finer authored input. Sigma accepts true finite positive values, including `Number.MIN_VALUE`, plus0; threshold rejects fractions. Numeric-equivalent strings such as `100.00`, `1e2`, `1.0` and `0e0` compare equal to their effective saved numbers. Convert to canonical numeric fields only for comparison or explicit submission.

For validated persisted sparse metadata, derive effective values from complete defaults plus the supplied fields, then apply the backend's accepted canonical amount normalization for display/comparison. Missing parameters yields100/1/0; `{sigma:2}` yields100/2/0. Do not mutate the saved graph merely by opening it, mark such a row dirty, lose untouched current fields, or merge with settings from a previously selected filter. A normal command update uses complete canonical parameters and `value:0`, so changing one UI field preserves the other two effective fields and the filter ID. Native/MCP partial-update merging remains authoritative for external edits; the next metadata revision refreshes the effective UI values.

Dirty state compares the parsed complete parameter object, scalar0 and opacity against canonical effective saved values. Invalid drafts are never considered eligible to apply. Reset can legitimately make an existing nondefault filter dirty, but remains local. Add/edit selection, revision changes, undo/redo, sparse persisted reopen and capability changes follow the existing source-filter draft lifetime, with no stale draft inherited by a new target.

## Exact policy, capabilities and lifecycle

The finalized independent capability is `layerFilterUnsharpPolicy:'rgb-residual-threshold-v1'`. It declares the alpha-weighted Gaussian and exact per-channel residual threshold semantics completely; the old `layerFilterSpatialPolicy` marker is not an additional prerequisite for Unsharp. Require:

1. matching native document/backend;
2. `layerFilterCoordinates:'source'`;
3. the exact `layerFilterUnsharpPolicy:'rgb-residual-threshold-v1'` marker;
4. the individual `unsharp_mask` kind in `layerFilterKinds`;
5. the appropriate add/update command.

An unknown/missing marker, missing coordinate marker or absent kind removes only the new authoring choice. Saved Unsharp entries keep their label and effective parameters visible as read-only; their Apply/enabled toggle are disabled with a precise source-policy explanation. Do not substitute fixed Sharpen or erase the saved entry. The other24 kinds retain their existing independent policy behavior. A new Unsharp choice losing support must still allow the user to choose another available kind. Add-only/update-only companions keep local defaults/Reset usable where the form is otherwise supported, and only the corresponding commit action is enabled.

Extend the existing filter and whole-stack capability identities with the new marker. Preserve the current captured backend/document/revision/layer/filter/kind checks before installation and after the preview await. A selected-filter change, target switch, kind change, unmount or changed policy cannot let an obsolete add/update/toggle response install its old document or select its old filter. Normal successful add still selects the accepted new filter. Do not add modal permissions or a broad runner refactor.

A stale revision refreshes the same document and discards the rejected operation without replay. A work/resource refusal preserves the local three-field draft and current saved graph/assets so the user can choose a new value explicitly. No automatic amount/sigma reduction, threshold increase, Bake, retry or fallback to fixed Sharpen. The approved positive nonidentity work is source pixels × `(2K+40)`, uniformly across amount settings. Enabled positive-opacity amount0/sigma0/threshold255 identities cost one visit per source pixel with no ring; disabled/0%-opacity entries cost0. This admission detail stays backend-owned; the UI should not duplicate a heuristic pixel-limit estimator or imply a bigger budget for common amounts.

## Recipes, Bake and structural guards

Extend the shared source-kind support predicate and the already approved recipe Validate/Apply/context gate to Unsharp's exact policy. A capability change invalidates a previous ready recipe report; it must not leave Apply enabled on obsolete inspection. Capture/import remain definition-only actions. The same-session request-ID deduplication/recovery loop remains unchanged; there is no new durable application receipt or implicit rebase after companion restart.

The saved recipe step is `add_layer_filter` with kind `unsharp_mask`, `value:0`, complete canonical parameters, enabled state and opacity. `recipe-capture.ts` already captures saved filters in order; a narrow new-family materialization branch can make sparse source parameters complete in the capture preview before saving, matching native recipe normalization. This captures saved effective values, never the local draft. Imported sparse definitions receive their own canonical defaults on save, independent of eventual target-layer values. No global adjustment recipe family accepts Unsharp parameters or kind.

Keep independently advertised **Bake filters** and **Clear filters** behavior, including unsupported-editor-kind handling and protected-prefix checks. The new marker gates Unsharp authoring/recipe execution, not generic whole-stack Bake capability. Test actual Unsharp+color/spatial saved stacks at fractional opacity with separate source alpha, retained geometry and masks. Bake must preserve the current composite exactly, preserve original/source assets, leave source-alpha-hidden working RGB ungraded, and remove editable entries only by the explicit action. Ordinary eligible painting can then continue; its Undo is separate from Bake's Undo. Nonempty/identity/disabled stacks retain existing source-paint and PSD limitations. No UI change weakens protected target or lower protected-content behavior.

## Eight focused browser workflows

Use isolated native projects, synthetic alpha/threshold fixtures for exact assertions, and the unchanged NASA photograph for visual exports. No provider, generation, segmentation, key read or user-project mutation.

1. **Discovery, defaults and precision:**25 source/24 global kinds; distinct new label; default100/1/0 and wirevalue0; local Reset; blank/incomplete/nonfinite/range/finer-amount/fractional-threshold failures issue no write; canonical-equivalent amount strings stay clean; subnormal/tiny sigma persists without a floor. Both add and update serialize only the correct source parameter family.
2. **Sparse/current merging and lifetime:** persisted missing/partial parameters show effective complete defaults with no history/false dirty state; a one-field edit keeps other effective fields, ID and opacity; external partial update then refresh, filter/layer/document switches, undo/redo and reopen expose the correct target settings. Add-only/update-only Reset stays local and does not bypass command gates.
3. **Threshold and parity pixels:** actual native exports for an independent small fixture distinguish threshold equality from strictly greater, including one channel crossing while another does not. Amount100/threshold0 matches fixed source Sharpen for a shared sigma0–10; amount37/sigma.528474 and amount5/sigma.3977 exercise generic fractional/tie behavior against independent reviewed oracle bytes. Alpha0/1/128/255, hidden RGB and separate-alpha source previews stay exact. Browser assertions use independent fixture expectations or owner/reviewer evidence, not the production helper as an oracle.
4. **Ordered stack, identity and structural guards:** fractional filter opacity differs from changing Amount; order matters; enable/disable and0%-opacity bypass preserve pixels; sigma0/amount0/threshold255 are identities yet retain structural active/protection/Bake-prefix behavior. Selection and own/ancestor masks remain outside neighborhood sampling; retained transforms keep parameters in source coordinates. Existing source/global blur/sharpen pixels stay unchanged.
5. **Partial capabilities and late results:** missing/unknown policy, missing source coordinates, kind subsets, add-only/update-only and saved read-only entries; the other24 remain usable. Delayed add/update/toggle/preview and in-flight policy withdrawal cannot install or retarget obsolete state. A new unsupported draft can choose another kind. Normal own success remains valid.
6. **Recipes:** capture saved full/sparse effective parameters while a different local draft exists; definition export/import preserves complete defaults and disabled entries; bind another eligible raster, validate/apply once as one Undo. Policy withdrawal clears an earlier ready report and blocks execution. Existing same-session retry/restart-reconciliation regression remains unchanged.
7. **Bake, source continuation and resource refusal:** exact composite/source/alpha/mask/geometry before/after explicit Bake; paint afterward; separate paint/Bake Undo; Clear removes sharpening. Native work/radius/identity-to-active refusal leaves graph/assets/history unchanged and all three local fields visible, with no implicit adjustment or retry. A stale revision refreshes once without replay.
8. **Photograph and narrow inspector:** save original, conservative Unsharp and stronger thresholded photographic PNGs plus parameters; verify source hash/alpha and reopen/Undo/Redo. Inspect1440/900px screenshots with Amount/Sigma/Threshold, guidance, opacity, Apply and Bake reachable using real viewport checks/scrolling. Finish request-revision, browser-error and zero provider/key checks.

Run build and adjacent source-spatial8, layer-filter4, tonal8, recipe5 and Bake6 browser suites. Update discovery count assertions to25 while preserving old24-source regression meaning. Exact native arithmetic, metadata resource boundaries, malformed global/portable rejection and shared/MCP contracts stay with the native/root/reviewer owners; the UI suite covers their user-facing integration.

Expected production ownership after approval: `client/UnsharpMaskControls.tsx` (or a similarly small source-only helper/control), `LayerFilters`, API source parameter/policy types, the existing source-support helper, narrow recipe capability/context/capture materialization, focused browser fixtures/script and filter CSS. The approved implementation is recorded below.

## Implementation and acceptance evidence

Implemented source-only `UnsharpMaskControls.tsx` and pure `unsharp.ts` draft/default helpers; widened only source `LayerFilterParameters`; extended the independent policy predicate and existing filter/stack identities; materialized canonical Unsharp defaults in saved recipe capture; extended recipe execution/context gates without changing application/retry handling. Global `AdjustmentParameters`, global controls and global kind tables remain untouched.

Validation completed in isolated native projects:

- `npm run test:unsharp-browser`: **8 workflows passed**.
- `npm run test:spatial-layer-filters-browser`: **8 workflows passed**.
- `npm run test:layer-filters-browser`: **4 workflows passed**.
- `npm run test:tonal-color-browser`: **8 workflows passed**.
- `npm run test:edit-recipes-browser`: **5 workflows passed**.
- `npm run test:filter-bake-browser`: **6 workflows passed**.
- `npm run build`: passed, with existing bundle-size/lucide directive warnings.

All39 browser workflows passed. The new report, `test-results/unsharp-browser-report.json`, records zero provider calls, key reads and browser errors. Its deliberate refusals are an identity-to-active work-limit400 and stale-revision409, both through `update_layer_filter`; neither retries or changes draft settings automatically.

The focused suite compares actual full-size native exports to its independent full two-dimensional BigInt Gaussian/residual/threshold/rational-rounding oracle. It imports no production filter/kernel/rounding helper. A pinned strict-threshold pixel changes red/blue while its exact-equality green remains100; threshold10 preserves the whole constructed fixture. Default100%/threshold0 matches existing fixed source Sharpen at sigma0.75. Additional exports exercise the amount5/sigma0.3977 and amount37/sigma0.528474 half-tie cases. Native owner/reviewer tests separately cover larger random and resource-boundary matrices.

Validated UI behaviors include exact finer-amount rejection (including100.00000000000001), `Number.MIN_VALUE` sigma save/reopen, equivalent scientific notation without false dirty state, absent/partial saved defaults with no write, one-field/external partial merges, all three computational identities, independent Amount versus opacity, every alpha byte, immutable source/alpha assets and source previews, exact Bake/paint/Undo, independent marker support without the old Gaussian marker, captured late results, and sparse saved recipe defaults/transfer/report invalidation. Existing fixed source/global sharpening output remains byte-exact.

Artifacts:

- `test-results/unsharp-oracle-5percent.png` and `unsharp-oracle-37percent.png`
- `test-results/unsharp-photo-original.png`
- `test-results/unsharp-photo-100pct-sigma1-threshold3.png`
- `test-results/unsharp-photo-180pct-sigma1_5-threshold8.png`
- `test-results/unsharp-1440.png`, `unsharp-900-stack.png`, `unsharp-900.png`, and `unsharp-900-help.png`

The final control guidance was compacted into an accessible native details section at root review; focused8 and build were rerun after that copy/layout-only change. The900px controls screenshot was visually inspected and browser-checked for Amount/Sigma/Threshold/Apply viewport reachability; Bake is separately reachable in the normal scrolling inspector and shown in the stack capture. No horizontal overflow was observed. Photographic exports were rendered from the unchanged NASA fixture, SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`; its source provenance remains in `tests/fixtures/tonal-color/README.md`. The stronger output is an explicit parameter demonstration, not a recommended universal sharpening setting. No generated replacement or segmentation ran.

Independent client source review found no blocker in precision/default handling, policy admission, captured identity or saved-only recipe capture. No UI acceptance work remains.

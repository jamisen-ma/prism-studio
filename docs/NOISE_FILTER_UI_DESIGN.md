# Seeded source Add Noise controls

Implemented and browser-verified, 2026-09-19, against the approved [native design](NOISE_FILTER_DESIGN.md) and [independent review](NOISE_FILTER_REVIEW.md). Global adjustments remain 24; source filters are 26. The client uses source-only types and controls, strict capability discovery, local drafts and the existing captured result guards. Final acceptance evidence is recorded below.

## Accepted contract and editor

Expose **Add Noise** as a distinct source-only raster filter, kind `add_noise`, scalar `value:0`. The architecture owner's complete parameters are:

```json
{"amount":5,"distribution":"uniform","monochromatic":true,"seed":1}
```

| Control | Accessible name | Accepted contract |
| --- | --- | --- |
| Amount, % | Noise amount percent | finite0–400 in exact canonical0.01% increments; default5 |
| Distribution | Noise distribution | Uniform / Gaussian; defaultUniform |
| Monochromatic | Noise monochromatic | boolean; defaulttrue |
| Pattern seed | Noise pattern seed | integer0–4,294,967,295 inclusive; default1 |
| New pattern | New pattern | changes only the local seed draft |

Amount can use the existing compact numeric-plus-slider pattern. Distribution is a select and Monochromatic is a checkbox. Keep the numeric seed field visible rather than hiding reproducibility behind a randomize button. Place **New pattern** beside/below the seed with short copy: “Changes the seed draft. Apply to view the pattern.” A number input uses `step="1"`, min0, max4294967295; browser formatting must never convert maxuint32 to a signed integer or replace seed0 with a truthiness default.

The existing **Filter opacity, %**, Add/Apply action and saved-stack controls remain separate. A local **Reset Add Noise** restores the four defaults and preserves the independent opacity draft. Neither Reset nor New pattern creates history, calls a command, updates the committed preview or mutates the source. All control edits remain drafts until the normal explicit Add/Apply action. There is no hidden per-preview seed refresh, implicit Apply or animation.

## New pattern means a new draft seed

Call `crypto.getRandomValues(new Uint32Array(1))` only inside the explicit New pattern click handler, once per click. It does not participate in rendering, initial defaults, previews, filter evaluation or recipe replay. Retain the chosen number in local state and serialize it only when the user applies.

Guarantee the chosen draft seed differs from the current valid seed: if the sampled uint32 equals the current seed, use `(seed + 1) % 4294967296`, so maxuint32 wraps to0 without signed arithmetic. If entropy is unavailable or throws, use the same deterministic increment. For an invalid/incomplete seed draft, the explicit action starts from defaultseed1 and replaces only that seed field with a valid candidate (fallback2). Preserve all other drafts, including invalid Amount text. This is a convenience pattern choice, not a security feature or a promise that every resulting image changes: Amount0, invisible/zero-alpha content or clipping may still produce identical displayed pixels.

New pattern and Reset are disabled while busy or when the saved noise family is unsupported/protected. In supported add-only/update-only capability partitions they are local actions independent of which commit command exists; they never bypass a disabled Apply. A pending command keeps its captured numeric seed even if a synthetic queued local change occurs later. Ordinary React rerenders and a closed/reopened detail disclosure never choose another seed.

## Compact, truthful guidance

Always show: **“Adds repeatable grain to source RGB and keeps transparency.”** If Amount0 is the valid local value, show the existing compact identity note: “These settings leave pixels unchanged. After saving, an enabled filter still belongs to the stack. Bake or Clear removes it before source editing.”

Put the remaining explanation into a native, initially collapsed **How Add Noise works** details section from the outset:

- “The same source, settings and seed repeat the same pattern across previews and exports. New pattern changes a draft; Apply saves it.”
- “Uniform spreads samples across its range. Gaussian concentrates samples near zero with fixed, bounded tails. At equal Amount, their spreads differ.”
- “Monochromatic shares the same RGB offset. Channel clipping can still change hue; it does not convert the image to grayscale.”
- “Noise is anchored to source pixels before transforms. Alpha is preserved; the cutout silhouette stays unchanged. The active selection is ignored; masks and layer opacity apply afterward.”
- “Amount changes the noise before clipping and rounding. Filter opacity blends the finished result separately.”

The precise semantics belong in public documentation/contract: Uniform's scale is approximately its maximum absolute offset,255×amount/100; the defined4096-bin, Q8192 Gaussian table uses that quantity as its near-standard-deviation scale, with tails bounded near±3.668335σ. Do not claim equal spread/strength for the two distributions, an infinite continuous Gaussian, noise without post-clamp bias, film-grain emulation or Adobe byte equivalence. The table provenance/hash and arithmetic proof stay backend/reviewer-owned; the inspector need not expose table internals.

The ordinary layer-filter introduction already says selection is ignored, so the final noise detail wording must remain consistent: the active selection does not limit this source filter; the additional/ancestor masks and layer opacity apply later. Source cutout alpha participates in visibility preservation but skipping invisible pixels does not advance or shift the pattern for later pixels. Changing underlying working RGB can change clamping; a fixed seed guarantees stable samples, not identical final pixels after an unrelated edit.

## Source-only parameters and canonical drafts

Add `NoiseParameters = {amount:number; distribution:'uniform'|'gaussian'; monochromatic:boolean; seed:number}` only to the source `LayerFilterParameters` union. Global `AdjustmentParameters`, global `Layer.parameters`, `SCALAR_ADJUSTMENTS`, `ColorWorkbench` and adjustment recipe slots remain unchanged. Noise is neither a scalar global family nor an alias of Unsharp or Gaussian Blur.

Use a local `NoiseDraft` with string Amount/seed, enum distribution and boolean monochromatic. Amount follows the exact canonical test `Math.round(amount*100)/100 === amount`, with finite bounds and no tolerance/rounding of finer authored input. Seed requires a finite integer in the inclusive uint32 range. Blank/incomplete/nonfinite/fractional/negative/overflow input stays local, disables Apply and sends no request. Equivalent valid spellings such as `5.00`, `5e0`, `0001` and `0e0` compare equal to effective stored numbers; dirty state never depends on raw string spelling. Parse only for validation/comparison or explicit submission.

Read validated sparse metadata by merging complete defaults with supplied fields; preserve explicitfalse, amount0 and seed0. Examples:

- omitted parameters →5/uniform/true/1;
- `{seed:0,monochromatic:false}` →5/uniform/false/0;
- `{amount:0,distribution:'gaussian',seed:4294967295}` retains all three authored values and defaults monochromatictrue.

Opening these entries creates no write/false dirty state. Unknown/wrong-family data must not be silently converted into a valid global adjustment. The editor sends complete canonical noise parameters with scalar0, preserving the existing filter ID/enabled state and other fields when only one control changes. Native external partial updates remain authoritative; refreshed revisions merge against the effective current settings, not a previous filter's draft. Kind/filter/layer/document/revision changes use the established source-filter identity and draft lifetime.

## Independent capability and resource admission

The independent marker is `layerFilterNoisePolicy:'seeded-rgb-discrete-v1'`. Authoring/recipe execution requires the matching native backend, source coordinate marker, this exact noise marker, individual `add_noise` kind and applicable command. It must not depend on `layerFilterSpatialPolicy` or `layerFilterUnsharpPolicy`; those other families retain their own gates. Support is never inferred from the kind name alone.

Missing/unknown marker, missing source coordinates or missing kind hides only the new authoring option, preserves saved label/effective parameters as read-only, and disables its Apply/enabled toggle with a specific explanation. A new noise choice losing support still permits choosing another available kind. Other25 source kinds retain their existing independent support checks. Bake/Clear remain independently advertised whole-stack operations; no new implicit materialization or permission dialog is introduced.

Include the noise marker in filter/whole-stack identities and the recipe report context. Preserve captured backend/document/revision/layer/filter/kind/settings checks before response installation and after preview. Pending policy withdrawal, target/filter changes or unmount cannot install an obsolete result or retarget the newly selected layer. A normal accepted add selects its new filter. A late local New pattern/reset operation cannot rewrite the parameters already submitted.

The resource contract is positive Amount work8 per source pixel for both distributions and both color modes; Amount0 identity work1 with no sampling/candidate computation; disabled/0%-opacity entries cost0. Enabled positive-opacity Amount0 remains structurally active. The exact shared-table reservation, yielding and admission are backend-owned. Do not duplicate a client heuristic or promise all source sizes/stacks succeed. Surface refusals with the submitted drafts intact and no implicit amount reduction, distribution switch, seed replacement or retry. A stale revision refreshes the current target once and discards the rejected write without automatic replay.

## Recipes, history and Bake

Extend the existing shared source policy predicate and recipe Validate/Apply/context gate. A changed noise marker/kind invalidates an earlier ready recipe report. Capture/import remain definition-only. The same-session request-ID retry/recovery implementation remains untouched; after restart an old revision still requires explicit reconciliation rather than a new implicit application.

Capture the saved effective Amount/distribution/monochromatic/seed, including zero/maxseed and disabled entries, in stack order. Materialize complete noise defaults in the capture preview before save, as for Unsharp. A New pattern draft never leaks into capture until it is explicitly applied. Imported sparse definitions normalize independently of target content/settings; applying a recipe to another equal source with the same saved seed produces the same source pattern, independent of layer/project/filter IDs. Applying again appends another saved entry under the existing recipe rules; it is not a resample of an unspecified random pattern.

Repeated native previews and full exports must agree on the saved pattern; changing preview size must not resample the seed or anchor noise in preview coordinates. Reopen, Undo/Redo and portable transfer retain the same source-pattern inputs. Transforming the layer moves/scales its already sampled source result; it does not choose a new seed. Original/source-alpha assets and source previews stay unchanged.

Explicit Bake fixes the saved noise result into the working image and removes the editable entries. Test exact composite equality through Bake, original/source/alpha preservation, source-alpha-hidden working RGB retention, masks/geometry, and independent paint/Bake Undo. The existing source-edit, protected target/prefix, generated-content and PSD stack restrictions remain; amount0 or disabled entries do not silently bypass the documented structural rules. No seeded rendering call makes an external request.

## Eight focused browser workflows

Use isolated native projects and deterministic synthetic source fixtures for byte assertions, plus the unchanged NASA photograph for actual noise exports/screenshots. No provider, image generation, segmentation, key read or user-project write.

1. **Discovery and precise defaults:**26 source/24 global kinds; default5/uniform/true/1 and scalar0; canonical Amount and seed integer bounds including0/max; blank/incomplete/nonfinite/fractional/negative/overflow/finer-amount drafts issue no writes; equivalent strings stay clean. Local Reset restores four defaults while preserving opacity.
2. **New pattern stays local:** a stubbed once-per-click crypto sample (including0/max and a collision) changes only the seed draft, not Amount/distribution/mono/opacity, history, HTTP or committed preview. Verify collision wrap and entropy-failure increment fallback, invalid-seed recovery, explicit Apply storing the chosen numeric seed, normal rerenders and detail expansion doing no sampling, and add-only/update-only local actions. A tiny valid Amount can have identical pixels; tests distinguish changed seed from promised visual difference.
3. **Fixed-seed reproducibility and vectors:** actual Uniform/Gaussian monochromatic/color exports for seeds0/1/max match independent reviewed known vectors; repeated previews at different sizes, full export, reload, Undo/Redo and an independent equal-source target keep the same pattern. Synthetic alpha0/1/128/255 and source alpha prove skipped invisible pixels do not shift later samples. Native owner/reviewer audits own large statistical/correlation/table-proof matrices; the UI does not use the production noise helper as its oracle.
4. **Saved settings, order and identities:** missing/partial metadata shows effective defaults without writes/dirty state and preserves false/zero/max. One-field edits/external partial merge keep ID and other fields across filter/target switches. Amount differs from opacity after rounding/clipping, modes differ as declared, order matters, masks/selection/geometry keep their existing stage, and every alpha/source-preview byte stays exact. Amount0 is a pixel identity with normal structural protection/source-edit/Bake-prefix guards.
5. **Partial capabilities and late identity:** missing/unknown noise policy, missing source coordinates, kind subsets, absent old Gaussian/Unsharp markers, add-only/update-only, saved read-only entry and recoverable new-kind loss. Delayed Apply/toggle/preview and in-flight policy withdrawal cannot reinstall an obsolete filter/layer/document or replace its seed. Normal own completion remains valid. No unsupported noise command leaves the client.
6. **Recipe capture/transfer/replay:** while an unapplied New pattern exists, capture saved full/sparse defaults, mono=false, seeds0/max and disabled/order/opacity; export/import preserves them. Bind a compatible equal-source target, validate/apply once as one Undo, and compare exact saved-pattern pixels without depending on IDs. Policy withdrawal clears a ready report and blocks execution. Existing retry/restart-reconciliation suite stays unchanged.
7. **Bake and refusal behavior:** noise+color/spatial saved stack at fractional opacity → exact Bake composite/source/alpha/mask/geometry equality → paint continuation with separate Undo; Clear removes noise. A native cumulative work/resource refusal keeps graph/assets/history and all drafts including seed intact. A stale revision refreshes once without reseeding or replay. No render or test invokes a provider or credential loader.
8. **Photograph and compact inspector:** actual original, Uniform monochromatic, Gaussian monochromatic and color-noise PNG exports with recorded parameters/seed; preserve source hash and alpha. Inspect1440/900 screenshots with Amount/distribution/mono/seed/New pattern, compact help, opacity and Apply reachable; expand detail guidance explicitly, then collapse. Check no horizontal overflow, real viewport reachability, captured revisions, browser errors and zero provider/key calls.

Acceptance runs focused8, Unsharp8, source-spatial8, layer-filter4, tonal8, recipes5 and Bake6 plus build. Update discovery assertions to26 while retaining independent old policy behavior. Native/shared/MCP tests own schema/global-family rejection, exact algorithm/statistical/resource/portable boundaries; client tests own their concrete editing workflows and lifecycle.

Implemented bounded production seams: a small source-only noise helper/control, source parameter/policy API types, LayerFilters, the existing policy support predicate, narrow recipe capture/context gate, focused browser script/fixtures and scoped CSS. Do not broaden this into a random generator framework, live preview architecture, global filter family or recipe retry rewrite.

## Completed implementation and evidence

`client/noise.ts` owns complete effective defaults, finite string parsing, exact centipercent/uint32 validation and the explicit local seed action. `client/NoiseControls.tsx` provides the compact control group and initially collapsed explanation. `LayerFilters`, source-only API types, the policy predicate, recipe capture/report context and scoped CSS are integrated. No App result-guard or recipe retry implementation changed: the existing identities now include the independent noise policy.

The new `npm run test:noise-browser` passed all eight workflows in an isolated temporary companion. The frozen [independent vectors](../tests/fixtures/noise/final-map-goldens.json) contain the final counter premultiply, both distributions, shared/separate RGB samples, seeds 0/1/max and alpha 0/1/128/255. All twelve full exports and raw baked assets matched their expected bytes; separate source-alpha hiding did not shift later samples. The oracle imports no production noise helper. Test failures during authoring were fixture issues only: a copied locator label, then opening a cached fixture after an external native revision. Reloading that fixture before the intended work-limit test removed the unrelated stale conflict.

| Acceptance | Result |
| --- | --- |
| Focused Add Noise browser workflows | 8 passed |
| Unsharp Mask browser regressions | 8 passed |
| Source Gaussian Blur / RGB Sharpen browser regressions | 8 passed |
| Existing layer filters | 4 passed |
| Tonal color | 8 passed |
| Recipes, including existing response-loss/restart reconciliation | 5 passed |
| Explicit filter Bake | 6 passed |
| TypeScript and production build | passed |

The total is 47 browser workflows. Discovery assertions now expect 26 source kinds. Missing source coordinates still permits the original 22; independently withdrawing Gaussian, Unsharp or Noise policy affects only its own family. The reviewed native cases and shared schema/MCP checks are owned by their respective backend reviewers, not inferred from this browser result.

The focused [report](../test-results/noise-browser-report.json) records zero credential reads, provider calls and browser errors. Its only expected command failures are the real cumulative work rejection (HTTP 400) and stale revision rejection (HTTP 409). The work fixture uses an 18MP source: two computing entries plus one identity are admitted at 306M work; making the third compute would require 432M and is refused with the submitted amount/distribution/mono/seed draft, graph, assets and history unchanged. No automatic reduction, replacement seed or retry occurred.

Visual evidence reuses the unchanged NASA source documented in the [fixture provenance](../tests/fixtures/tonal-color/README.md), SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. Actual native PNG exports are:

- [Original](../test-results/noise-photo-original.png).
- [Uniform, monochromatic, 5%, seed 1](../test-results/noise-photo-uniform-mono-5pct-seed1.png).
- [Gaussian, monochromatic, 5%, seed 1](../test-results/noise-photo-gaussian-mono-5pct-seed1.png).
- [Gaussian, colored, 8%, seed 4294967295](../test-results/noise-photo-gaussian-color-8pct-seed4294967295.png).

The [1440px inspector](../test-results/noise-1440.png), [900px controls](../test-results/noise-900.png), [900px stack](../test-results/noise-900-stack.png) and [expanded help](../test-results/noise-900-help.png) were captured from the working application. The 900px controls and actual colored export were visually inspected; seed, New pattern, Amount, Distribution, Monochromatic, opacity and Apply are reachable without horizontal overflow. All original assets and alpha bytes remain exact. Noise sampling is repeatable; this is the explicitly defined native distribution, with no Adobe byte-equivalence claim.

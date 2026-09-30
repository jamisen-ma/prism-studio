# Color Balance and Black & White controls

Implemented, 2026-09-19, against the finalized [tonal-color contract](TONAL_COLOR_DESIGN.md). This document records the accepted design and the browser evidence below; it introduces no additional algorithm or renderer.

The milestone adds two editable photographic treatments in the existing adjustment and raster-filter workflows. Each treatment uses one shared control component in both places. A saved recipe captures the applied settings and can reproduce them on another explicitly chosen target. The main canvas shows actual committed native pixels; moving a draft slider does not pretend to render an uncommitted preview.

Adobe's Color Balance documentation establishes a useful three-tone, opposing-color control layout with optional brightness preservation. Its Black & White workflow uses hue-dependent gray controls and optional tint. Those concepts inform this interface; Prism's declared encoded-sRGB algorithms and supported settings remain the [native contract](TONAL_COLOR_DESIGN.md), without numerical Adobe parity. [Adobe Color Balance](https://helpx.adobe.com/ca/photoshop/using/applying-color-balance-adjustment.html), [Adobe Black & White](https://helpx.adobe.com/photoshop/desktop/adjust-color/color-effects-techniques/convert-a-color-image-to-black-and-white.html).

## Existing seams and bounded changes

| Current seam | Proposed change |
| --- | --- |
| `ProPanels.tsx` recognizes four parameterized kinds in workbench/editable-adjustment branches. | Recognize `color_balance` and `black_white`; retain Levels, Curves, Mixer and Gradient Map behavior. Present six kind buttons in the existing two-column grid. |
| `ColorMappingControls.tsx` supplies Mixer/Gradient Map controls and labels. | Extend the shared label lookup only as needed. Keep new tonal control/draft/default helpers in `TonalColorControls.tsx` to avoid enlarging old algorithms or input behavior. |
| `LayerFilters.tsx` has its own defaults and kind list. | Add both kinds through the shared new helpers. Call the same controls used by adjustment layers, preserving existing stack order, opacity and enable behavior. |
| `api.ts` has an adjustment-parameter union. | Add typed three-element balance rows, complete Color Balance parameters and complete Black & White parameters. Do not change any mask/selection types or finished mask logic. |
| Workbench is gated on histogram capability and its Apply lacks command-level props. | Gate creation/editing by the applicable mutation command plus advertised kind. Make histogram optional and skip its request when unavailable; a histogram is not a prerequisite for supported tonal edits. |
| Filters mount only when addition is supported; draft keys omit capability signatures. | Permit existing stacks to be inspected/edited with update-only capabilities. Gate each action by its command and each tonal editor by its advertised kind; incorporate the relevant capabilities in draft context. |
| Workbench/filter writes do not capture a target context. | Capture revision/document/target at submission and reject late result installation after context changes. Keep the separate recipe application/retry runner unchanged. |
| The quick preset says “Black & white” but sends saturation −100. | Preserve its existing behavior and rename it “Desaturate” so it cannot be confused with the new six-hue Black & White adjustment. |

Primary owned implementation files: `client/TonalColorControls.tsx`, its stylesheet, `client/api.ts`, `client/ProPanels.tsx`, `client/ColorMappingControls.tsx`, `client/LayerFilters.tsx`, narrowly scoped `client/App.tsx` integration, and `tests/tonal-color-browser.mjs`. Root owns schemas, capability forwarding, MCP descriptions, catalog/public-doc updates and package aliases. Backend owner owns normalization/rendering; independent reviewer owns exact arithmetic oracles. No broad inspector or recipe refactor is needed.

## Color Balance

Use a labeled `Color Balance` control group with **Shadows**, **Midtones** and **Highlights** tabs. Midtones is the initial tab. Tabs only choose which row is displayed; they do not modify, discard or apply another row. A small changed-row indicator can be omitted in this first version if it complicates accessibility.

Within the selected tone, show three rows. Each row has opposing endpoint labels, a range slider and an exact numeric field:

| Row order | Left / negative | Right / positive | Value |
| --- | --- | --- | --- |
| 0 | Cyan | Red | −100 to 100% |
| 1 | Magenta | Green | −100 to 100% |
| 2 | Yellow | Blue | −100 to 100% |

Both slider and numeric field use 0.01% increments. Accessible names include the tone and both colors, for example `Midtones cyan–red percent`; slider names add `slider` to distinguish them from number fields. Labels and signs convey direction without relying on colors. Sliders may use subtle opposing-color ramps as affordances, never as a computed image preview.

**Preserve luminosity** maps to `preserveLuminosity`, default true. Supporting text: “Preserves sRGB brightness; strong shifts may reduce color intensity near color limits.” Keep the underlying exact arithmetic in technical documentation. Turning preservation off retains every tonal row. Black/white preservation applies only to the enabled mode under the native contract.

**Reset tone** resets just the displayed row to `[0,0,0]`, retaining the other two rows and preservation flag. The workbench's **Reset Color Balance** resets all rows and preservation to defaults in the local draft. Filter editing gets the same explicitly local full-reset action. Neither Reset issues a command.

## Black & White

Use a `Black & White` group with six compact labeled rows in source-hue order: Reds, Yellows, Greens, Cyans, Blues, Magentas. Each has a slider, numeric percentage and small hue swatch. Labels remain sufficient without the swatches. The range is −200 to 300%, in exact 0.01% increments. Explain: “Adjust how each original color becomes gray.” Do not imply that these are saturation controls or that the coefficients must add to a fixed sum.

Show **Tint**, a color input labeled **Tint color**, and percentage slider/number field labeled **Tint strength**. They map to `tint`, `tintColor` and `tintAmount`. Tint strength is 0–100%, in 0.01% increments. The color input writes lowercase `#rrggbb` and uses the native default `#b98952`; the default strength is 100 and Tint starts off.

Keep color and strength visible and editable when Tint is off. Add “Tint settings are kept while Tint is off.” This allows preparing retained settings for recipes and correcting invalid drafts without a toggle trap. Tint off has no pixel effect regardless of retained settings. Zero strength and neutral tint obey the same native bypass behavior; do not invent a UI fallback color or amount. **Reset Black & White** changes only the local draft back to all six defaults, tint off, default color and 100% strength.

Creation uses **Add Color Balance layer** / **Add Black & White layer**. Editing uses **Update Color Balance** / **Update Black & White**. The existing filter footer keeps **Add layer filter** / **Apply filter changes** because the surrounding editor already identifies the kind. Explicit actions commit the draft; the existing canvas preview and Undo show actual results.

## Canonical parameters and incomplete drafts

Export immutable typed defaults from the shared helper:

```ts
type ColorBalanceRow = [number, number, number];
type ColorBalanceParameters = {
  shadows: ColorBalanceRow; midtones: ColorBalanceRow;
  highlights: ColorBalanceRow; preserveLuminosity: boolean;
};
type BlackWhiteParameters = {
  reds: number; yellows: number; greens: number;
  cyans: number; blues: number; magentas: number;
  tint: boolean; tintColor: string; tintAmount: number;
};
```

Default merging is kind-specific and produces a deep independent clone. Missing persisted rows/fields use the effective defaults. A supplied balance row replaces that whole row; it is never merged coefficient-by-coefficient. Do not mark an editor dirty merely because a sparse saved object differs structurally from its complete effective defaults. Opening an editor, switching tabs, reading histogram data or inspecting a sparse project must issue no write. Backend validation remains authoritative; the UI never normalizes malformed persisted data into an apparently valid replacement.

Use a distinct typed local draft with numeric strings for the new percentage fields. Keep canonical API types numeric. Shared `toTonalDraft`/`parseTonalDraft` helpers convert complete effective parameters to drafts and validate drafts into complete submission parameters. This is preferable to passing `NaN` through a controlled number input or coercing a blank string to zero. A parent may hold separate Color Balance/Black & White draft states in workbench; the filter draft holds the corresponding tonal draft only for these two kinds. There must be one authoritative draft, not a retained last-valid object that can accidentally submit while its displayed fields are invalid.

A submission requires finite numbers inside bounds with `Math.round(value * 100) / 100 === value`, complete rows, booleans and valid color. Blank, lone sign, fractional overprecision and out-of-range drafts remain visible with a concise validation message; Apply is disabled and no command is dispatched. Invalid values in an inactive tone row still block submission. Tab changes retain those fields so they can be corrected. Range thumbs use a safe display fallback while the text is incomplete, without changing the draft; moving the slider is an explicit replacement with a valid value. Do not clamp text inputs or quietly round precision.

Every successful tonal submission sends `value:0` and complete canonical parameters, including off-state tint settings and all three tone rows. Compare complete effective settings for dirty state, so equivalent values such as `40.00` do not create artificial edits. Reset remains a local draft operation until applied.

## Context, commands and capability boundaries

Key new editor drafts by backend, document ID/revision, target layer, selected filter ID/kind and relevant capabilities. Existing workbench context keys already cover most of this; filter draft keys need the capability signature. Switching document/layer/filter/backend, Undo/Redo, external edits or capability changes discards stale drafts synchronously. Switching a tone tab or toggling Tint does not change the context key.

Creation and update gates are independent. A supported kind with `add_adjustment` can be created without `update_adjustment`; a persisted adjustment with its advertised kind and `update_adjustment` can be edited without addition. Apply the same distinction to `add_layer_filter`/`update_layer_filter`; preservation/inspection of unsupported stored kinds is read-only, never converted to a scalar editor or another default kind. Histogram absence must not hide supported controls or trigger an unsupported read. New kinds stay hidden on the Photoshop bridge unless that backend independently advertises actual support; no native semantics are assumed merely from a command name.

Capture `captureGesture(document, selectedLayerId)` for creation as well as targeted edits, because the user can change the active context before completion. For filter edits, also keep the captured filter ID and a local latest-context check before selecting a newly created filter after the response. The app runner needs tonal/edit-specific conflict messages and before/after-preview acceptance gates for captured add/update adjustment/filter results. A late successful server commit must not reopen another document, overwrite a newer revision or select its new layer/filter in an unrelated view. Refresh current metadata on same-document revision conflict; never retry against a new revision automatically. Busy state prevents a second mutation.

The existing adjustment creation selection hint remains accurate: adding an adjustment captures the active selection as its mask. Updating preserves the existing mask, including density/positioned metadata. Raster filter addition ignores the active selection and stays in source coordinates. Protection and source-alpha handling remain native concerns; the UI retains the existing protected-filter controls and must not silently unprotect anything.

## Recipe capture and replay

`recipe-capture.ts` already deep-copies saved filter/adjustment parameters and records an adjustment slot's fixed `kind`. Its general capture path should need no special tonal branch. Server canonical recipe normalization supplies complete defaults for sparse persisted settings. Verify that its returned definition includes every new field, even when Tint is off, before reporting complete recipe support.

Capture only saved settings. A pending tonal draft is excluded exactly as current recipe copy explains. Save/inspect a recipe, bind a compatible target explicitly, validate and apply as one undo step. Raster recipes append new filter entries; adjustment recipes update an existing adjustment of the same kind. Incompatible kinds stay unselectable. Capture a disabled filter without losing its canonical parameters. Mutating the source layer, recipe library or resulting target later must not alias another object's arrays. Keep existing application identity, retry and outcome-reconciliation code unchanged; exercise it through the ordinary UI.

## Photographic preview and bounded validation

Use two fixture classes:

- A small deterministic RGBA diagnostic image with hue anchors, gray ramps and alpha 0/1/128/255. Its browser assertions inspect saved metadata, request fields, preserved alpha/masks and selected independent pixel probes. The numerical reviewer supplies full independent algorithm coverage; do not call production tonal math as a browser oracle.
- The root-approved 512×512 RGB photograph at `test-results/segmentation-public-fixture.png`, copied unchanged into a durable tonal fixture directory during implementation. It shows NASA astronaut Eileen Collins and retains the original held helmet and background; do not use an extracted cutout. The official [scikit-image astronaut documentation](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut) identifies NASA as the source and records its public-domain status. The inspected local file is a 512×512 8-bit RGB PNG with SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. Preserve that attribution/source/hash in the fixture README. Tests read it locally and never fetch it at runtime; no new generation, segmentation, resizing or package is required. Its skin, orange suit, colored insignia, deep shadows and bright helmet supply useful photographic evidence.

Capture and inspect actual native before/after PNGs of a restrained Color Balance grade, a six-hue monochrome mix and a tinted variant, plus editor screenshots at 1440px and 900px. The photo is visual evidence for usability and the intended treatment, not a proof of Adobe numerical equivalence. No image generation, segmentation, credentials, new package or live user project is needed.

The focused browser script should consolidate these eight workflows:

1. **Balance draft/creation:** all three tone rows, preservation toggle, local row/full reset, invalid/empty/precision guards, a single selection-masked creation with canonical `value:0`, actual image change, exact source bytes and one-step Undo.
2. **Adjustment editing:** Color Balance and Black & White retain IDs/masks/density; disabled tint settings survive off/on and reset; sparse saved parameters display effective defaults without any automatic write.
3. **Raster filters:** both shared editors add/update real stack entries; selection is ignored; opacity, order and enable remain functional; protected targets stay frozen; sparse effective defaults do not appear dirty.
4. **Draft lifecycle:** tone tabs preserve all rows; source/filter/document/revision changes reset drafts; stale revision rejection refreshes metadata without replay; delayed success does not switch document, target or selected filter.
5. **Recipe reuse:** capture persisted tonal adjustment and filter settings, including tint off and a disabled filter; inspect canonical definitions, bind a compatible second target, validate/apply, compare output to equivalent explicit operations, undo once, and prove source/recipe/target settings are independent.
6. **Capability partitions:** add-only/update-only, one kind missing, no histogram and unsupported Photoshop fixtures expose only truthful controls. Capability changes invalidate drafts and prevent unsupported requests.
7. **Photographic treatments:** import the local photograph, commit the three treatments, inspect exported actual pixels and visually review editor/result screenshots; verify Undo restores the original photo and no provider/key calls occur.
8. **Compact layout and persistence:** 900px width plus a short viewport retain reachable labels/sliders/tint controls/apply actions without horizontal overflow; reload restores canonical settings; `.prism`/native recipe persistence remains covered by the backend suite where appropriate.

Run build and adjacent `test:color-mixer-browser`, `test:layer-filters-browser`, `test:edit-recipes-browser` after implementation. The current filter browser fixture hardcodes 20 kinds; update that assertion to the finalized 22 only when both kinds are actually advertised. Root/reviewer handle exact native tests and aggregate inventory changes. Report precise coverage and any untested permutation rather than treating a screenshot as a numerical result.


## Implementation and validation evidence

The accepted shared controls are implemented in `client/TonalColorControls.tsx` and used by both `ProPanels.tsx` and `LayerFilters.tsx`. API parameters stay numeric and typed; only local incomplete percentage drafts use strings. Effective sparse parameters merge defaults without writes, and valid uppercase persisted tint colors canonicalize for display/dirty comparison. Reset tone/full Reset remain local in both add-only and update-only capability partitions. The existing recipe capture/application code is unchanged.

Captured UI context now includes a local, nonserialized identity callback for the workbench and filter editor. The stable outer workbench owns its callback across the revision-keyed inner editor's normal successful remount. The runner checks document, backend, revision, selected target and local context before graph installation and again after the preview await. Empty-document creation treats the normal first-layer selection as part of accepting its own result. Filter enabled toggles use the same captured identity as Apply, including when a different stack row is being toggled. A late server commit is retained server-side but cannot reopen another document or install/select an obsolete result in the current view; the next normal refresh reconciles current metadata.

Executed checks:

| Command | Result |
| --- | --- |
| `npm run build` | TypeScript and Vite passed; existing bundle-size/Lucide directive warnings remain. |
| `npm run test:tonal-color-browser` | Eight consolidated native browser workflows passed. |
| `npm run test:color-mixer-browser` | Four adjacent parameterized color workflows passed. |
| `npm run test:layer-filters-browser` | Four stack workflows passed; advertised filter count is 22. |
| `npm run test:edit-recipes-browser` | Five capture/application/recovery workflows passed. |
| `npm run test:mask-position-browser` | Eight adjacent mask/context/resize workflows passed. |

The tonal suite specifically includes no-selected-layer creation, sparse/uppercase settings with no false dirty state, independent diagnostic RGB/alpha expectations, one-step Undo/Redo, recipe capture excluding unapplied drafts, active-selection differences between adjustments and source filters, protected-filter controls, and source asset byte preservation. Adversarial cases cover a stale revision with exactly one intentional `409`, delayed filter Apply, delayed enabled toggle, document navigation before command installation and during its preview await, and a previously started status response changing capabilities while a creation response is pending. No automatic stale retry is issued. The report records zero unexpected browser errors, key reads or image-provider calls.

Capability fixtures cover add-only, update-only, missing kind and missing histogram cases. The Photoshop fixture is a local read-only mocked bridge with only four advertised scalar adjustments; it verifies the new native tonal controls stay hidden. This is UI capability evidence, not testing inside Photoshop. No Photoshop installation or provider is required by the suite. Switching from the mock bridge back to Native also verifies that a previous-backend document cannot briefly mount with the new backend’s capabilities and issue an unsupported histogram read. Tonal/filter panels require matching document/backend identity, and workbench capability checks require matching capability/document backends.

Durable source: [photographic fixture and provenance](../tests/fixtures/tonal-color/README.md). Browser entry point: [tonal-color-browser.mjs](../tests/tonal-color-browser.mjs). Machine-readable result: `test-results/tonal-color-browser-report.json`.

Actual native image artifacts are `test-results/tonal-photo-before.png`, `tonal-photo-color-balance.png`, `tonal-photo-black-white.png`, and `tonal-photo-tinted.png`. They were visually inspected: the full helmet/background remain present; the restrained balance changes color while preserving declared sRGB luma within the half-byte rounding bound; the monochrome image is gray; tint is restrained and distinct. The original photo pixels return byte-exactly after Undo. These files are native-rendered results, not generated imagery or simulated CSS previews.

Inspected UI artifacts are `test-results/tonal-color-balance-1440.png`, `tonal-black-white-1440.png`, `tonal-color-balance-900.png`, `tonal-black-white-controls-900.png` and `tonal-black-white-900.png`. The two compact Black & White views show both all six hue/tint controls and the reachable Apply/footer area at 900×820. The inspector scrolls vertically without horizontal page or inspector overflow. Photographic visual evidence does not establish numerical parity with Adobe; full independent algorithm coverage remains in the native review/tests.

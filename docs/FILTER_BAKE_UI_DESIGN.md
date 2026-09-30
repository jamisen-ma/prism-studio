# Bake editable filters into working pixels

Implemented, 2026-09-19. This document records the accepted UI design following the [source-filter bake design](FILTER_BAKE_DESIGN.md) and [independent review](FILTER_BAKE_REVIEW.md), the implemented `planFilterBake`, and the current `LayerFilters`, canvas brush, fill and cutout interfaces. The bounded UI implementation and browser evidence are recorded below. Root owns protocol/capabilities; the native owner owns pixels/publication; UI changes stay within the existing filter workflow.

## Two explicit actions

Keep **New filter** as the composition action. For a nonempty raster stack, place a separate compact action row beneath the saved stack containing **Bake filters** and **Clear filters**. Neither action is inside the selected filter's editable fieldset. They operate on the whole saved stack, including disabled entries, independently of which filter is selected. Both remain reachable in the 250px inspector and at 900px viewport width. Use text labels, not icon-only or color-only distinctions.

Visible copy immediately above/below that row:

> Bake keeps the current filter result as pixels and removes editable filter entries. Clear removes the entries and their effect. Undo restores the stack.

Also state:

> Uses the saved stack above. Apply a pending draft first to include it.

Do not apply a pending filter draft as part of Bake or Clear. A saved stack is the exact renderer input and the backend operation's revision-bound target. A selected dirty/new-filter draft does not disable these stack actions; the nearby copy explains that it is excluded. After a successful action, the removed entries disappear and the ordinary new-filter editor replaces the selected-entry editor. No success handler may automatically add a replacement filter.

An inactive-only stack needs different copy:

> Every filter is disabled or at 0% opacity. Bake and Clear both remove these entries without changing pixels; no image is evaluated.

Keep the action labels stable. There is no claim that inactive settings were applied to pixels. An empty stack has no Bake/Clear row. The native `NO_FILTERS` guard remains authoritative for a race. Neither action adds a permission dialog; the visible consequence and ordinary explicit click are sufficient for this undoable operation.

## Capability and eligibility

Add typed `Backend.layerFilterBaking?: 'source-rgb'` and optional `limits.maxFilterBakeWorkingBytes` / `maxFilterBakeAssetBytes`. Require a matching native document/backend, advertised `bake_layer_filters` command, and exact `layerFilterBaking:'source-rgb'` marker before exposing Bake. Do not infer source-space semantics from another rasterize command or a command-only/unknown capability marker. Existing stacks must still be inspectable when no add/update command exists; the current mount condition already admits a nonempty stack.

Clear remains independent and follows `clear_layer_filters`; Bake does not require add/update/clear capability. A clear-only companion retains Clear and a brief explanation that it cannot bake filters. A bake-only companion retains Bake with Clear disabled or absent. Both missing means inspectable saved entries with neither unsupported action dispatched. A missing or contradictory marker follows the clear-only fallback. Photoshop gets no native baking assumption.

For known native source-RGB semantics, derive these states from persisted metadata:

| State | Bake behavior |
| --- | --- |
| Nonraster / no saved entries | Hide the bake action. |
| Busy, protected target, backend mismatch | Disable; retain the existing protection explanation. |
| At least one entry has `enabled && opacity > 0` | Active stack; evaluate the protected-prefix guard. |
| Every entry disabled or opacity zero | Inactive metadata removal; prefix protection does not block it. Target protection still does. |
| Active identity-valued entry | Still active for admission; do not try to predict pixel identity in the browser. |
| Entry kind absent from UI's editable kind list | Keep the saved kind read-only. Explicit source-RGB baking capability may still act on the server-validated saved stack; no local coercion or replacement parameters. |

Mirror the native `planFilterBake` prefix predicate exactly using **canonical `document.layers` order**, not reversed `displayLayers`/collapsed rows: find the target's index, then the first earlier `protected` content entry whose type is neither `group` nor `adjustment`. Visibility, opacity, masks, overlap, group isolation and collapsed state do not weaken this guard. Hidden/nested earlier content therefore still blocks an active bake; a later protected subject does not. React text renders the layer name safely.

Blocked copy:

> Baking is unavailable while earlier content “Layer name” is protected. Keep the editable filters, or review layer order and protection explicitly.

Do not offer automatic unprotection, reorder layers, disable entries, calculate overlap or rasterize a document preview to bypass it. The server rechecks this rule and all work/asset limits at the captured revision. The browser does not estimate encoded asset sizes or promise admission from canvas dimensions; those are source/working-buffer constraints.

## What stays editable and what becomes fixed

In the active Bake area, keep a short disclosure visible:

> Original image, geometry and masks are kept. Baking fixes filter colors in the working image. Pixels hidden by source alpha stay ungraded if you reveal them later; spatial filters keep their current cutout-edge sampling.

“Source alpha” means working-image/separate cutout transparency, not the additional layer mask. The additional layer mask, positioned mask, density and ancestor masks are applied later and remain editable. Do not call this “flatten layer,” “rasterize document,” or imply that an original-source preview becomes graded. The output is current working RGB; the archived original remains unchanged. A separate cutout's alpha is retained and recombined once by the backend.

The operation clears filter entries only. Existing restrictions for painting, clone/heal sampling, transformed source-cutout repair, clipping chains, isolated/partially transparent ancestors, protected pixels, hidden targets and model availability still apply. Bake does not automatically switch tools, begin a stroke, install a model, place a layer or change protection.

Update the filter warning and touched brush/fill/cutout messages to guide the user to the layer's filter controls. Where baking is advertised:

> Review Bake filters or Clear filters in Layers before painting. Disabled entries also count. A separate paint layer or additional layer mask remains editable.

Where it is absent, retain truthful remove/clear wording. The brush toolbar can say “Resolve the filter stack in Layers, or use a paint layer.” Pass a small capability boolean/helper to copy-only callers if needed; do not duplicate protected-prefix rules in every tool or add a global command interception/refactor. In cross-document placement copy, explicitly refer to the **source document's** Layers panel. Existing blocking conditions are unchanged until the saved stack is actually empty.

## Submission identity and completion

Capture `document.backend`, document ID, positive `expectedRevision`, target layer ID and a stable whole-stack capability/context identity at click. Disable both stack actions while the mutation is busy. Add `bake_layer_filters` and the now-captured Clear action to the runner's narrow guarded result path. Keep recipe execution/retry code unchanged; baking is not a metadata recipe step.

Use a separate whole-stack context callback in `LayerFilters`. The existing per-filter callback contains selected filter ID/kind and therefore **must not be reused unchanged**: a successful bake removes that selected entry itself and would invalidate its own completion. The stack callback includes alive state, document/backend/layer and relevant capabilities; it excludes revision (checked separately by the runner), selected filter identity and stack contents. Choosing another filter row while Bake waits does not change the whole-stack target. Selecting another layer/document/backend, losing baking capability or unmounting the inspector does invalidate its result installation.

Before graph installation, require the captured document/backend/layer and revision to still match. After the preview await, require the accepted result revision and the same local stack context. Successful removal normally leaves the same layer selected; it must not pick a filter or another layer. Late successful server commits remain saved server-side but cannot reopen another document, overwrite a newer view or select an unrelated target. A normal refresh can reconcile the currently displayed document later.

On `REVISION_CONFLICT`, refresh the same document when still current, retain the server's current stack and show: “The document changed before filters were baked. Review the current stack and try again.” Never retry with a new revision automatically. `FILTER_BAKE_PROTECTED_CONTEXT` / `PROTECTED_LAYER` should refresh same-document metadata so the actual blocker is visible, then show the native actionable message. `NO_FILTERS` should refresh and report that the stack is already empty. Limits, invalid source and cleanup errors are shown without claiming success; no reduced-quality or hidden Clear fallback is attempted. A transport failure gets the ordinary error/refresh workflow, not automatic redispatch under a new request ID.

## Bounded browser acceptance

Use isolated temporary native fixtures, synthetic RGBA/alpha and the existing local photographic fixture. No Photoshop process, provider/model request, secret, package or live user project is needed. A new focused browser script can consolidate six workflows:

1. **Bake versus Clear:** an actual mixed ordered active/disabled tonal stack; visible loss-of-editability and saved-draft copy; Bake keeps the exact native composite and empties the stack with one undo; Clear changes pixels by removing the grade; each undoes exactly. Unapplied drafts are never silently included.
2. **Resume pixel work:** Bake then an ordinary brush/fill command succeeds on an otherwise eligible raster, preserves archived source bytes, and Undo first removes the stroke then restores the editable stack. Additional masks/source alpha/geometry are unchanged; the original preview remains original. Verify remaining transformed-cutout or clipping guard rather than promising every tool is unlocked.
3. **Protection/activity:** protected target frozen; active stack above earlier hidden/nested protected content blocked before a command; below a later protected subject allowed; inactive-only above earlier protection allowed with no-pixel copy. Active identity remains blocked. Backend suites prove zero I/O and exact resource/ownership behavior.
4. **Partial capabilities:** bake-only, clear-only, absent marker/unknown marker, absent command, empty stack and unsupported editable kind. No unsupported action/read; backend/document switching does not borrow another backend's capabilities.
5. **Lifecycle:** external revision rejection refreshes without retry; late successful response after layer/document/capability change is ignored; navigation during preview await stays current; selecting another filter during a pending whole-stack Bake remains a valid same-layer completion. Guard own successful disappearance of the selected entry.
6. **Persistence/layout:** reload/Undo/Redo restores canonical stack/working pixels; real photograph before/baked equality and 900px screenshot; disclosure/action labels reachable without horizontal overflow, busy prevents duplicate sends, source assets/provider/key/browser checks clean.

Run build plus the focused suite and adjacent tonal/filter/recipe browser checks. Native/reviewer/root suites cover spatial-filter arithmetic, complete protected footprints, source-alpha repair, exact geometry/groups/clipping, bounded I/O and whole-transaction rollback. The UI report must distinguish that backend evidence from its own browser coverage.


## Implementation and browser evidence

Implemented in `client/filter-bake.ts`, `client/LayerFilters.tsx`, its existing stylesheet, typed backend fields in `client/api.ts`, and the narrow `App.tsx` runner/mount paths. Brush, fill and cutout messages use the shared capability-aware guidance; legacy companions retain Clear/remove wording. No filter algorithm, saved draft, document geometry or recipe execution code is changed by the client.

The whole-stack context is separate from per-filter editing context. It survives its own filter removal and ignores selected-filter-only changes, while checking document/backend/layer, relevant capabilities and alive state. Panels remain mounted after emptying a stack on bake-only and clear-only companions, so their own successful result cannot invalidate its completion callback. Clear now uses the same captured revision/result gates as Bake. The runner refreshes same-document revision/protection/empty-stack refusals without automatically reissuing the mutation.

Executed checks:

| Command | Result |
| --- | --- |
| `npm run build` | TypeScript and Vite passed; existing bundle-size/Lucide warnings remain. |
| `npm run test:filter-bake-browser` | Six consolidated workflows passed. |
| `npm run test:tonal-color-browser` | Eight adjacent adjustment/filter/recipe/capability workflows passed. |
| `npm run test:layer-filters-browser` | Four stack/protection/painting-guard workflows passed. |
| `npm run test:edit-recipes-browser` | Five capture/application/recovery workflows passed. |

The bake browser suite proves exact native composite equality for a mixed saved stack with working/source alpha, an additional positioned feathered mask and density, and retained geometry. An unapplied draft is excluded. Clear changes the grade; each action undoes in one step. Baking then performing an actual pointer brush stroke changes pixels, preserves the archived original, and undoes independently. Source-cutout repair stays disabled for the retained transformed source; restoring the editable stack blocks strokes before HTTP with actionable guidance.

Admission coverage includes protected targets, active identity settings above hidden/nested earlier protection, inactive-only metadata clearing and a later protected subject. Partial capability fixtures include bake-only, true clear-only without add/update, missing/unknown marker, no action commands and an unadvertised editable filter kind. The suite does not claim that browser metadata predicts native resource admission or proves no source I/O; native/reviewer tests own those properties.

Lifecycle coverage includes one intentional stale `409` with a current-settings refresh and no retry; a filter-row change during a pending whole-stack action; successful disappearance of that selected entry; late layer selection, navigation during preview completion and in-flight capability loss. Every Bake/Clear request carries a positive revision. The machine-readable report records zero unexpected browser errors, key reads or provider calls.

Entry point: [filter-bake-browser.mjs](../tests/filter-bake-browser.mjs). Report: `test-results/filter-bake-browser-report.json`. The durable photographic fixture remains the unchanged [NASA/scikit-image original](../tests/fixtures/tonal-color/README.md).

Actual native photographic previews are `test-results/filter-bake-photo-before.png` and `test-results/filter-bake-photo-after.png`. Both have SHA-256 `e1dc7b139e78f9ba4c31dbdb2f81fcf34e2343e63b7b0654c9d00af7f4a60a73`, in addition to independent decoded-pixel equality checks. They contain the applied working grade; the archived input photo keeps its original fixture hash. No generated replacement or simulated CSS preview is used.

Visually inspected `test-results/filter-bake-1440.png` and `filter-bake-900.png` show the saved Color Balance entry, distinct Bake/Clear actions, draft exclusion and source-alpha consequences beside the actual photograph. At 900×820 the action group and disclosure are reachable together, with no horizontal page or inspector overflow. Reload and Undo/Redo preserve both the stack and resulting pixels. No additional permission dialog is introduced.

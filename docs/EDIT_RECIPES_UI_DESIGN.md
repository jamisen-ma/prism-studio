# Typed edit recipes: UI design

Status: implemented and verified, 2026-09-19. This UI follows [EDIT_RECIPES_DESIGN.md](EDIT_RECIPES_DESIGN.md). Native/schema implementation remains owned by that team. [Independent design review](EDIT_RECIPES_DESIGN_REVIEW.md) agrees that selected-layer capture is a useful first authoring path; a general multi-slot step editor remains deferred. Browser verification uses isolated synthetic projects, without live project edits, credentials or provider calls.

## Entry point and working layout

Add a small **Recipes** action in the Layers toolbar, next to the existing document-level layer actions. It opens a separate `EditRecipes` dialog; do not add another inspector tab or place a complete recipe editor inside every selected-layer inspector. Gate the entry on native recipe version 1 and the required advertised commands. Recipes belong to the current document and travel in its `.prism` project.

The dialog contains a library selector, a readable ordered step list, a target-binding section, a validation result and the primary action. A secondary **Save selected layer settings** view provides UI authoring. Rename/Delete belong beside the library selector; Import/Export definition can sit in a secondary transfer row. At 900px, use one column with a bounded scrolling body and a visible action footer. Do not squeeze three panes into the 245px inspector. Normal close/Escape and focus restoration follow the existing modal implementation.

There is no automatic action recording. The library contains explicitly authored settings, not a reconstruction of history. Saving/importing/inspecting never applies the steps. Existing **Saved layer styles** remains the simpler choice for outside decoration alone.

## Library inspection

Use `get_edit_recipe` for the selected record with explicit document ID/revision; retain its canonical definition and informational hash for the displayed inspection context. Show the recipe name, step count, slot labels/types and a short scope description. Render names and values as text, never HTML. Bindings, saved layer IDs, current selection and prior application results are not part of a definition.

Every ordered step gets a human-readable summary and expandable exact values:

| Step family | Summary and necessary disclosure |
| --- | --- |
| Add layer filter | `Photo → Append Curves · enabled · 100%`. Show complete parameters or curve points and actual source-pixel units for radius/block filters. **Appends** to existing filters; it does not replace the stack. |
| Update existing adjustment | `Grade → Set Channel Mixer`. Name the required adjustment kind and show the complete canonical parameter configuration. The recipe sets that configuration, retaining the target adjustment's mask, density, opacity, visibility and position. |
| Style existing text | `Title → Fraunces, 72 px, tracking 40, Auto leading`. Show only supplied fields. Omitted settings are retained; explicit tracking zero and Auto leading are reset instructions. Text content, position and geometry remain the target's own. |
| Set outside effects | Show shadow/glow settings, including opacity, blur and offsets in canvas pixels. The effects slot is replaced: a missing shadow/glow in a supplied object clears that effect; `null` clears both. Outline is independent. |
| Set outline | Width/color in canvas pixels; zero means clear outline. Shadow/glow remains independent. |

Before Apply, state **“Runs N steps on M chosen layers as one undo step.”** If filters are appended, also state **“Applying again adds these filters again.”** Native values are literal: there is no proportional resizing of a recipe when it is used on a differently sized photograph. Source-pixel text/filter settings and canvas-pixel decorations must be labeled accordingly.

Do not promise equal pixels across differently composed documents or a visible result from every valid recipe. Hidden layers, masks, clipping, adjustment scope and protected content keep their existing rendering rules. Validation checks metadata and limits; it does not render a pixel preview, test source decoding or reserve disk space.

## One-slot authoring without JSON

**Save selected layer settings** reads the persisted selected layer at one captured document/revision/ID. It never reads unapplied input drafts from other inspectors. Show the source name/type, editable recipe name, a friendly target-slot label, and checkboxes for applicable setting families. Use one fixed safe slot key such as `target`; do not derive a slot key from an arbitrary layer name.

| Source and choice | Recipe construction |
| --- | --- |
| Raster with a nonempty filter stack: **Filters (N)** | One `add_layer_filter` step per existing entry in its stored order, with kind/value/parameters/enabled/opacity. Include disabled entries and say so. Omit filter IDs. Type is `raster`, even if outside styles are also captured. |
| Editable text: **Typography** | One `update_text` styling step with current typeface, size, color, weight, style, alignment, tracking and leading. Capture current defaults explicitly where needed: tracking `0`, leading `null` for Auto, and current default family/weight/style/alignment. Never include text, x/y, width/height or transforms. Type is `text`. |
| Adjustment: **Adjustment settings** | One `update_adjustment` with current value/parameters; slot type `adjustment` and exact current kind. The canonical save response supplies complete normalized parameters. Never capture the mask or density. |
| Content with shadow/glow: **Outside effects** | One `set_layer_effects` with a detached copy of actual current settings. Native normalization resolves legal omitted effect defaults; the inspector must not mistake `{shadow:{}}` for a disabled effect. |
| Content with an outline: **Outline** | One `set_layer_outline` using actual width/color. Native fills its legal default color. |

Available nonempty setting families may be checked initially, but show the resulting exact step list before Save. When only outside styles are chosen, a `content` slot permits reuse on all six content types. A raster/text-specific choice narrows the slot appropriately. Groups have no capturable recipe settings in this slice. An otherwise eligible hidden or protected source can supply settings, because capture is a read; target protection is checked later when binding/application would write it.

Absent effects and outlines are not captured implicitly. Provide explicit unchecked **Clear shadow/glow on target** and **Clear outline on target** choices if clearing is needed; these produce `effects:null` and `width:0`. Make clear vs copy mutually exclusive for each slot. This avoids a text recipe unexpectedly removing decoration merely because its source had none. At least one step must remain selected. Limits and advertised step support disable unavailable choices, rather than silently dropping them.

Saving calls `save_edit_recipe` with name/slots/steps and the captured document revision. **Save new recipe** adds a new record. **Replace selected recipe** explicitly replaces that definition while retaining its ID, including at capacity; applied layer settings are independent and do not change. The canonical saved response becomes the inspected recipe. Saving does not bind or apply it automatically.

Any source/document/revision change makes a pending capture stale. Keep the draft name if useful, but require explicit **Recapture current settings** before saving a refreshed snapshot; do not combine old filters with a newly selected layer's type or new parameters. A failed save preserves the inspectable local draft and exposes the native reason. Neither source protection nor missing compatible targets in the current document should prevent saving a statically valid reusable definition.

This first UI intentionally does not provide arbitrary add/remove/reorder step editing across several slots. MCP can author those recipes; the UI can inspect, transfer, bind, validate and apply them. A general typed step editor is a separate extension, not a capability claimed by capture.

## Explicit target binding

Each declared slot gets a labeled dropdown with an empty **Choose a layer** option. List current-document layers with distinguishable name, type and group path; use stable IDs as values. Where duplicate names and paths still occur, a short ID suffix disambiguates them. Do not automatically bind by name, stacking index, previous document, or the first compatible result. A separate **Use selected layer** button per slot is an explicit shortcut when the selected layer fits.

- `raster` matches raster only; `text` matches editable text; `content` matches raster/solid/text/shape/path/gradient; `adjustment` requires the declared kind exactly.
- Distinct slots must choose distinct layer IDs. Already assigned choices can be disabled with **Used by <slot>**. Multiple operations on one layer use the same slot repeatedly.
- Show wrong-type/kind options disabled or omit them with a useful no-compatible-target explanation. Protected and clipped targets may be listed with their status: protection is not a blanket exclusion, because outside-only decoration can be legal. Native validation supplies exact step-specific restrictions.
- A target that vanishes becomes unbound; never substitute its neighbor. A same-ID target that changes kind/type invalidates validation and shows incompatibility.
- Slot assignments remain independent of the general Layers inspector selection. Changing the selected layer elsewhere does not retarget explicit bindings. Cross-document/backend changes clear all bindings, even for `.prism` copies that retain layer IDs.

The active selection is ignored by all five allowed steps and stays unchanged. Existing masks and source cutout alpha remain distinct from recipe targets. Do not offer implicit rasterization, unprotection, mask removal or automatic creation to repair an invalid binding.

## Validate and Apply

The UI uses an explicit **Validate recipe** action after every slot has a distinct valid local binding. `validate_edit_recipe` receives document ID, current expected revision, recipe ID and the exact map. This is a read-only command outside the global mutation path; local loading/error state must not advertise it as a saved edit.

Capture backend/document/revision, recipe ID/version/hash, canonical bindings and a request sequence before validating. A report is current only if its document ID/revision/recipe ID/version agree, its informational hash agrees with the inspected definition, and its returned bindings/ordered valid changes agree with the captured map and step list. The approved report includes canonical `bindings`; compare it with the captured map, and compare each valid change's target/layer ID with that same map. Render `issuesOmitted` when diagnostics are bounded. Do not use hash as a secret authorization token or send an unapproved hash argument to Apply.

For `valid:false`, show bounded issues with human step number, slot label, target name, code and message. Later steps are not declared safe after a staging failure. Missing document/recipe or stale revision are normal errors with **Refresh and validate again**. Do not hide native limit failures behind generic “invalid recipe” text. Expected metadata checks include cumulative filters, protected targets, wrong adjustment kinds and enabled decorations on clipped members.

For `valid:true`, show **“Ready at revision N · metadata checks passed.”** Enable **Apply recipe** only while this exact local report remains current. Applying calls `apply_edit_recipe` with recipe ID, bindings and its validated expected revision. The backend intentionally permits applying without prior validation, but this UI workflow requires a current report so the user can review a concrete target mapping. This is an editing control, not an additional assistant permission request.

Any graph revision, selected definition, binding, supported-capability or document/backend change immediately disables Apply before effects run. Rename/overwrite/delete/undo also change the document revision and invalidate the report. Binding drafts may remain for the same document if their IDs are still valid; no automatic application or validation rerun follows a change. Explicit Refresh obtains current metadata and the current canonical definition, then a new Validate is required.

On success, show the actual applied step count and update the same active document from freshly reconciled metadata. Keep selection and bindings stable when their IDs remain. Clear the validation report; a second intentional Apply requires a new validation and a new invocation ID. One Undo reverses every applied step. Renaming/deleting the saved recipe does not undo prior applications.

## Mutation identity and lost-response recovery

`client/api.ts` creates a new request ID on every ordinary `command()` call. Recipe application uses `commandWithRequestId()` to retain one request ID and the entire original body for an unresolved invocation. Retry never supplies a fresh UUID or rebuilds expected revision from the latest document.

While applying, freeze the chosen recipe/revision/bindings and prevent another Apply. A connection error may follow a successful commit; keep the original invocation available as **Retry same application** and **Inspect current document**. Inspection is read-only and does not authorize rebasing. Keep recovery state outside a disposable modal child so closing/reopening the dialog cannot accidentally turn a lost response into a fresh apply. A page reload cannot be represented as durable exactly-once recovery unless a bounded pending envelope is deliberately persisted; durable persistence is not assumed by this design.

The service request cache returns its original successful result, which may be older than the current graph after another edit or Undo. Therefore successful retry must fetch **current** metadata before updating App. Never replace revision 12 on screen with an original cached revision 10. A reconciliation read failure remains a recovery state; a cached success is not permission to show an older graph. If the backend/document has changed, reconcile that document in the background without switching the active workspace, selection or binding draft.

There are no durable recipe receipts in v1. After companion restart, retrying the old body may return a stale-revision error. Show that the prior outcome needs inspection, retain the original request for context, and do not automatically issue a fresh revision/request ID. After inspecting history/layers, the user can deliberately abandon recovery and start a new checked application. An intentional repeat appends filters again; it is not an upsert. A validation read can be aborted on context changes, but aborting an apply request does not prove publication was cancelled.

The command response alone does not justify changing unrelated live context. Captured recipe application is keyed by document and all explicit bindings, not by the incidental selected layer in the inspector. Avoid reusing a single-target gesture guard in a way that silently retargets several slots or incorrectly makes them follow that selection.

## Definition transfer

The approved **Import recipe** / **Export recipe** path sits alongside capture, so a treatment can move between independently imported image documents without raw-JSON-only authoring. Its definition-only envelope does not require image/file backend endpoints.

A `.prism-recipe.json` file contains `{format:'prism-edit-recipe',version:1,name,slots,steps}` only. Exclude saved recipe UUID, current bindings, invocation IDs, document IDs, history and image assets. Export is a local Blob download. Before reading an import, enforce a 64 KiB transfer-size limit; the canonical saved recipe still must fit its advertised 32 KiB bound. Reject unsupported versions and unknown envelope fields; never evaluate code or interpolate strings.

Import opens an inspectable local draft. It does not execute or overwrite a library record. **Save imported recipe** goes through the native strict schema and creates a fresh recipe ID; replacing an existing record is a separate explicit choice. Canonical limit/schema errors stay attached to the draft. A formatting-heavy file can fail the transfer bound even if its canonical definition might be smaller; expose that limit honestly.

Definition-file transfer is verified across three independently imported fixture documents. Full multi-slot step editing remains deferred. `.prism` preserves the document's saved definitions under the native bundle contract.

## Advertised capabilities and component boundary

The agreed fields are `editRecipeVersion:1`, `editRecipeCommands` containing the five supported step commands, `editRecipeSlotTypes:['raster','text','content','adjustment']`; limits `maxEditRecipes:16`, `maxEditRecipeSteps:30`, `maxEditRecipeSlots:16`, `maxEditRecipeBytes:32768`, `maxEditRecipeLibraryBytes:262144`. Public documents expose `editRecipes:[]` for legacy documents. Command names are `save_edit_recipe`, `get_edit_recipe`, `rename_edit_recipe`, `delete_edit_recipe`, `validate_edit_recipe`, and `apply_edit_recipe`.

Gate library reading, capture/rename/delete, validation and Apply independently on their actual commands. An unsupported saved step or recipe version must produce a clear inspection limitation, never be silently omitted from the ordered list. Missing capability fields keep recipe actions out of the optional Photoshop path. Display advertised library/step bounds rather than hardcoding a larger capacity.

Implementation files: `client/EditRecipes.tsx` contains the dialog/library, typed summaries, binding/report views and lifecycle hook; `client/recipe-capture.ts` contains allowlisted capture and definition-file validation; `client/edit-recipes.css` scopes the layout. App supplies an entry point and guarded current-document reconciliation callbacks. Types and stable invocation transport live in `client/api.ts`. No global automatic replay, provider tool, history recorder or generic script runner is introduced.

## Acceptance criteria

Use small synthetic projects, a real isolated companion and Chrome, with no real credentials/provider calls. Core/native and official MCP owners cover the same allowlist, staged validation and resource atomicity.

1. Capture a filtered raster, styled editable text and an existing adjustment through UI controls without JSON. Save only checked persisted settings, include disabled filter state and zero/Auto resets, exclude absent style clears by default, and prove Save does not modify layer pixels/metadata. Rename/delete/undo and overwrite-at-cap retain correct recipe identity. Protection does not forbid read-only capture.
2. Inspect an MCP-authored recipe spanning a photo, a fixed-kind adjustment, a title and a protected outlined subject. Choose explicit distinct IDs, Validate, Apply and Undo through UI. Assert original assets, masks, selection, content text, geometry and unrelated layers unchanged; filters/text/grade/outside effects equal explicit native commands. Check one revision/history step and actual rendered pixels.
3. Missing/duplicate bindings, wrong adjustment kind, protected filter/text targets, clipped-member decorations and cumulative filter overflow yield named validation issues without mutation. Native partial-capability reports disable the appropriate controls; unrelated current selection never influences the recipe outcome.
4. Delay validation and switch recipe/bindings/document/revision before it completes. No stale Ready/Apply state survives. Change a target after successful validation, then Apply: exact old expected revision rejects, no automatic retry occurs, and explicit refresh/revalidate succeeds. Same IDs in a second imported `.prism` document do not preserve another document's bindings.
5. Drop an apply response after a real commit. Retry the identical ID/body and prove no duplicate filter append; after Undo or an external edit, reconciliation shows the newest graph instead of the cached original response. Restart the companion and retry the original body: stale rejection does not rebase or apply again. Closing/reopening the dialog retains unresolved invocation identity.
6. If transfer is approved, export the definition and import/save it into three independent fixture documents with different layer IDs; bindings remain empty until chosen. Oversized/unsupported/forbidden imported drafts never mutate the library or run steps. Portable project roundtrip preserves inert definitions, not invocation state.
7. At 900px, inspect all ordered steps, slot choices, issues, reset/replace semantics and the action footer without horizontal overflow. Keyboard focus, Escape and context switching work, and no browser/provider/key errors occur. Save a clearly synthetic screenshot such as `test-results/edit-recipes-controls.png`.

## Completed verification

`npm run build` passes. `tests/edit-recipes-browser.mjs` passes five real-Chrome workflows, and the existing `tests/browser.mjs` baseline passes. The focused suite verifies:

- Persisted raster/filter, typography and adjustment capture; disabled filter state; explicit typography resets; unchanged pixels when saving; rename/delete/Undo; protected filter-target validation.
- Delayed canonical inspection with early binding, distinct typed bindings, a five-step application matching direct-command pixels, one Undo, and unchanged originals, text content, masks and selection.
- Definition export/import into three independently imported documents with fresh recipe IDs and empty bindings; forbidden imported commands rejected without saving or execution.
- Captured-revision rejection without partial edits or rebasing, explicit recovery, and stale validation discarded after binding changes.
- Lost-response recovery across dialog close/document switches, same-ID cached success after Undo reconciled with fresh metadata, and companion-restart stale rejection without duplicate filter appends.

The final 900px screenshots were inspected: [bindings and validation](../test-results/edit-recipes-controls.png), [ordered definition and explicit reset values](../test-results/edit-recipes-definition.png). The suite reports no unexpected browser errors, horizontal overflow, key reads or provider calls. Broader native/MCP coverage owns capacity, portable-library and structural atomicity cases; this browser result does not claim a general typed step editor or exhaustive coverage of every acceptance variation above.

# Reusable edit recipes

Available through the native editor and MCP. Native, independent, schema and official MCP checks pass, together with five browser workflows and the baseline browser regression.

A recipe saves an ordered set of edits for reuse on explicitly chosen layers. It can append photo filters, update an existing adjustment, style editable text and apply outside effects or outlines. Applied edits remain normal editable layer settings. Recipes do not change the original image files or create a live dependency on the saved definition.

Open **Recipes** from Layers. Capture selected settings from the currently saved layer, or import a recipe definition. Capture uses persisted values, not unapplied inspector drafts. It excludes text content, positions, transforms, masks and protection settings. A one-layer capture creates one named target slot; an assistant can author a recipe with several slots through MCP.

If a raster stack has a [filter effect mask](FILTER_EFFECT_MASKS.md), capturing its Filters refuses explicitly because a recipe cannot retain that source coverage. This includes disabled or fully white effect masks. Uncheck Filters to intentionally capture other eligible settings. Applying an existing filter recipe to a supported masked target appends entries under that target's saved effect mask; the mask is retained, so the added treatment has the same scope. Validation checks the required mask policy before application.

Inspect the ordered steps and choose a layer for every target slot. **Validate** checks those choices and the complete prospective document before **Apply** commits the recipe as one undo step. Validation checks metadata and limits without rendering pixels or reading source images. Changing the document, recipe or bindings invalidates the old report.

## What each step does

| Step | Behavior |
| --- | --- |
| Add layer filter | Appends an editable filter to the bound raster. Existing entries remain. Repeated intentional application appends more entries. |
| Update adjustment | Changes an existing adjustment of the declared kind, using a complete saved parameter configuration. Retains its mask, density, opacity and position. |
| Style text | Updates only the specified font, size, color, alignment or spacing settings. Retains text content, source position and geometry. Tracking 0 and Auto leading can be explicit reset instructions. |
| Outside effects | Replaces the shadow/glow settings as one slot. Outline is separate. |
| Outside outline | Sets its width and color; width 0 clears the visible outline. |

Targets have type Raster, Text, Content or a specific Adjustment kind. Each slot binds to a distinct current-document layer. Reuse one slot in several steps to edit the same layer repeatedly. Names, the current selection and similarly named layers in other documents are never used to guess a target.

The normal protection and compositing rules still apply. Protected raster filters and protected text edits reject. Outside-only decorations remain available on protected content. Clipping restrictions and cumulative filter/memory limits are checked across the entire staged result. An invalid later step prevents every step from being published.

Recipes have no painting, masks, geometry, layer creation, protection toggles, scripts, model calls or nested transactions. Adjustment creation is excluded because its existing command can capture the live selection. Use a filter step for a reusable photo grade, or bind an existing adjustment layer. Active selections remain unchanged.

## MCP example

Call `prism_save_edit_recipe` with the current document and this definition:

```json
{
  "name": "Warm editorial type",
  "slots": [
    { "key": "photo", "label": "Main photograph", "type": "raster" },
    { "key": "title", "label": "Cover title", "type": "text" }
  ],
  "steps": [
    { "command": "add_layer_filter", "target": "photo", "args": { "kind": "temperature", "value": 12 } },
    { "command": "update_text", "target": "title", "args": { "fontFamily": "Fraunces", "color": "#593c2c", "tracking": 25, "leading": null } }
  ]
}
```

Save returns a `recipeId`; supply that ID to overwrite its definition, or omit it to create a separate recipe. Use `prism_get_edit_recipe` to inspect the canonical definition and informational hash. Rename/delete change only the saved definition and are undoable.

For `prism_validate_edit_recipe` and `prism_apply_edit_recipe`, pass `recipeId` and explicit bindings such as `{ "photo": "RASTER_LAYER_ID", "title": "TEXT_LAYER_ID" }`. Apply requires a positive `expectedRevision`, pinning both the saved recipe and target state. It repeats validation even if a prior report succeeded. These six recipe commands are standalone; do not place them inside `prism_apply_transaction`.

Use a stable application `requestId` when recovering an uncertain response, with the exact same body and revision. Request deduplication lasts for the companion session. After restart, an already successful application rejects the original revision as stale; inspect the current document to reconcile it. Do not automatically retry at a fresh revision, because that would intentionally append another set of filters. The UI retains a pending application's identity and fetches current state before accepting a recovered response.

## Storage and limits

Each document holds up to 16 recipes, each with 1–30 steps and 1–16 used target slots. The canonical limits are 32 KiB per recipe and 256 KiB for the library, within the existing 16 MiB project/history limit. Saving over an existing recipe remains available at capacity.

Editable `.prism` projects retain the library. Definition-only import/export uses the versioned `prism-edit-recipe` JSON envelope and excludes layer IDs, bindings and application receipts. PSD and raster exports omit recipe metadata; merely saving a library changes no exported pixels. Applied edits must still satisfy the selected output format's ordinary compatibility rules.

This is a typed subset of reusable edits, without interaction recording, Adobe action-file compatibility or automatic batch processing. See [the command contract](EDIT_RECIPES_DESIGN.md) and [independent review](EDIT_RECIPES_DESIGN_REVIEW.md).

Verification covers independent pixel comparisons, replay in three documents, one-step Undo, portable definitions, protection and history-size rejection, stale revisions, and lost-response recovery after Undo or companion restart. The complete Node suite at this milestone passed 678 tests; the production build passes. The background-and-title demonstration also contains a saved **Cozy autumn title** recipe, without changing its generated background pixels.

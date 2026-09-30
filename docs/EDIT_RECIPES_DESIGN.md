# Reusable typed edit recipes

Status: implemented and verified in the native backend, 2026-09-19. The coordinator and independent reviewer approved this contract. Browser/whole-application release evidence remains maintained by its owners.

## Useful first scope

A recipe repeats a photo treatment, typography and outside styles on explicitly chosen layers. For example, append Temperature and Curves filters to a photo, apply Fraunces tracking/leading to an existing title, and give that title an outside shadow. This exceeds a saved outside-style preset while preserving the original photo and editable text.

Adobe actions record command sequences for replay. Prism's first recipe format instead stores a small typed sequence authored explicitly by the assistant or user. It does not record arbitrary interaction, import Adobe action files, execute scripts, or replay every editor command. [Adobe: record an action](https://helpx.adobe.com/photoshop/desktop/automate-tasks/create-record-actions/record-an-action.html).

Five operations are allowed: `add_layer_filter`, `update_adjustment`, styling-only `update_text`, `set_layer_effects`, and `set_layer_outline`. Each is a metadata mutation without image decoding, rendering, segmentation, model calls or asset writes. A later image preview evaluates the resulting ordinary graph using the existing renderer.

`add_adjustment` is intentionally absent. Its current native command captures the live selection when a mask is omitted and appends a root layer; a recipe must not accidentally capture unrelated selection state. A bound existing adjustment supplies that workflow without implicit selection or placement. `add_layer_filter` already supplies a grade on a new photograph. No creation of layers, references to newly created objects, filter replacement/clear, geometry, masks, selection operations, protection toggles, nested recipes/transactions, provider jobs, imports, exports or filesystem paths are allowed.

## Persisted format

`graph.editRecipes` is optional. Legacy graphs retain absence, while public documents expose `editRecipes: []`. A recipe is strict JSON:

```json
{
  "id": "43ad404d-e2d7-49a7-9d74-4c69ecb041ea",
  "version": 1,
  "name": "Warm editorial cover",
  "slots": [
    { "key": "photo", "label": "Main photo", "type": "raster" },
    { "key": "title", "label": "Cover title", "type": "text" }
  ],
  "steps": [
    { "command": "add_layer_filter", "target": "photo", "args": { "kind": "temperature", "value": 12, "enabled": true, "opacity": 1 } },
    { "command": "update_text", "target": "title", "args": { "fontFamily": "Fraunces", "tracking": 40, "leading": null, "color": "#fff4dd" } },
    { "command": "set_layer_effects", "target": "title", "args": { "effects": { "shadow": { "color": "#302319", "opacity": 0.35, "blur": 8, "x": 4, "y": 6 } } } }
  ]
}
```

Recipe IDs are unique lowercase UUIDs within the library. Version is exactly `1`; unsupported versions reject rather than being interpreted approximately. Names trim to 1–200 characters. Optional slot labels trim to 1–80 characters. Names and labels reject C0/DEL controls. Slot keys match `^[a-z][a-z0-9_]{0,31}$` and exclude `constructor`, `prototype`, and `__proto__`. Slots preserve their authored order and keys are unique. Every slot must be used by at least one step, and every step must refer to a declared slot.

| Slot type | Matching current layer | Allowed steps |
| --- | --- | --- |
| `raster` | Exactly raster | Add filter, outside effects, outline |
| `text` | Exactly editable text | Text styling, outside effects, outline |
| `content` | Raster, solid, text, shape, path or gradient | Outside effects, outline |
| `adjustment` | Exactly adjustment, with the declared kind | Update adjustment |

An adjustment slot additionally requires `kind`, one of the current 22 adjustment kinds. Other slot types forbid `kind`. This gives a value/parameter contract independent of whichever target will later be bound. No layer ID, name lookup, source hash or document ID is retained in a slot or step. Bindings are a separate apply-time object such as `{ "photo": "<layer UUID>", "title": "<layer UUID>" }`.

Bindings must contain exactly the declared keys and each value must resolve to an existing current-document layer of the slot's type/kind. Bindings must use distinct layer IDs; a layer that needs several operations uses the same slot in multiple steps. No default selected-layer binding, name matching, cross-document lookup, aliasing between slots or references to outputs created by earlier steps exist.

## Step arguments and canonicalization

Every step has exactly `command`, `target`, and `args`. No generic `layerId`, `filterId`, document/revision fields or additional command fields are legal in `args`. A pure shared recipe schema validates strict fields and cross-field kinds on save, reopen, portable import, validate and apply. Native normalization then produces independent canonical copies; it never retains caller objects.

| Command | Exact allowed arguments | Semantics |
| --- | --- | --- |
| `add_layer_filter` | Required `kind`, `value`; optional `parameters`, `enabled`, `opacity` | Existing 20 filter kinds and numeric rules. Save canonical defaults `enabled: true`, `opacity: 1`, plus fully normalized kind parameters. Append to the bound raster's existing stack in recipe order. Existing entries stay unchanged. New filter IDs are internal; subsequent steps cannot name them. |
| `update_adjustment` | Required `value`; optional `parameters` | Validate against the adjustment slot's fixed kind. Store a complete normalized parameter configuration for parameterized kinds, including defaults when omitted; scalar kinds forbid parameters. Applying supplies these complete parameters, retaining the adjustment's kind, name, mask/density, opacity, visibility and position. This deliberately avoids partial parameter rows inheriting a different treatment from the destination. |
| `update_text` | At least one of `fontSize`, `color`, `fontFamily`, `fontWeight`, `fontStyle`, `align`, `tracking`, `leading` | Existing typography ranges/families. Preserve omitted settings, actual text, source position/dimensions and transforms. Explicit `tracking: 0` and `leading: null` remain in the recipe as reset instructions; the applied text layer uses existing canonical deletion rules. Do not normalize these instructions away when saving. |
| `set_layer_effects` | Required `effects: null` or current strict shadow/glow object | Replace the effects slot exactly as the current command does; omitted shadow/glow settings use current fixed defaults, normalized at save. Empty effects normalize to `null`. This does not replace outline settings. |
| `set_layer_outline` | Required integer `width` 0–64; optional `color` | Default white, canonical lowercase six-digit hex. Width zero clears the visible outline using existing command semantics. This does not replace effects. |

All colors normalize to lowercase. Value ranges, integer/odd median rules, canonical hundredth-percent Channel Mixer values, increasing Curves/Gradient Map stops, parameterized value zero, and opacity bounds match the underlying operations. Unknown keys reject recursively, including otherwise ignored parameter keys. No source mask data, paths, image bytes, script strings or arbitrary metadata are accepted.

Text/style operations can be partial by design: omission means retain that target's property. A recipe is deterministic for a particular validated graph and bindings; it does not promise identical final pixels on differently composed documents. Repeated intentional applications append more filters until existing stack limits are reached. It is not an upsert or a linked recipe instance.

## Commands and responses

| Command | Additional arguments beyond document identity | Result and history |
| --- | --- | --- |
| `save_edit_recipe` | `expectedRevision?`, `recipeId?`, required `name`, `slots`, `steps` | Full replacement of a named recipe's definition or a new UUID. Returns `{document, recipeId}`. One history step; overwrite retains ID and works at library capacity. Version 1 is supplied by the implementation. |
| `get_edit_recipe` | `expectedRevision?`, `recipeId` | `{documentId, revision, recipe, recipeHash}`; independent canonical copy, no history/cache/write. Full libraries are also readable from `get_document`. |
| `rename_edit_recipe` | `expectedRevision?`, `recipeId`, `name` | `{document}`; one history step. Changes neither slots nor steps. |
| `delete_edit_recipe` | `expectedRevision?`, `recipeId` | `{document}`; one history step. Already applied edits remain ordinary independent content. |
| `validate_edit_recipe` | `expectedRevision?`, `recipeId`, `bindings` | Metadata-only report described below; no history, assets or rendering. |
| `apply_edit_recipe` | **Required positive `expectedRevision`**, `recipeId`, `bindings` | Re-resolves bindings and stages every step again; commits once and returns `{document, recipeId, appliedSteps}`. One undo step. Prior validation is useful but not mandatory. |

These are standalone commands in v1. They are **not** admitted as steps inside public `apply_transaction`; recipes themselves are already bounded atomic sequences. Save/rename/delete/apply use normal companion request IDs, while get/validate are read commands and excluded from mutation activity. The native queue serializes validation reads and application with ordinary edits/generation installation. The companion's existing authorization and transport apply; no new permission flow is added.

Recipe hashes are informational SHA-256 over canonical JSON of the saved recipe including ID/name/version/slots/steps. Object keys sort recursively, arrays retain order. No created filter ID or target binding enters this hash. `apply_edit_recipe` needs no redundant hash argument because required document revision and recipe ID already pin the saved definition and targets. Validation is not a durable authorization token and must not replace application checks.

## Metadata-only validation and atomic application

Resolve the recipe and all bindings first. Validate the original graph, then create one private graph copy and compile each typed step to its existing native command with the bound `layerId`. Run the same mutation/normalization/protection logic used by application. Validate the complete staged graph after each step and at completion; this includes hidden nodes, clipping restrictions, group/filter/effect scratch, per-layer/document filter counts and weighted filter work.

No allowed command renders, reads images, writes assets, installs fonts, changes selection or changes layer geometry. Temporary random filter UUIDs on the private validation graph are harmless implementation details; they are not returned, persisted, cached or reused by apply. Avoid a separate mutation interpreter whose protection behavior can drift. No deterministic reserved-ID namespace is necessary.

Preflight the same post-commit project envelope that a real application would persist: preserve redo-truncation and the 100-state history policy, append one prospective graph/history record, and enforce the existing 16 MiB project metadata ceiling. A shared metadata-only commit-builder can avoid duplicating this logic. The validation report is valid only for its returned revision; it cannot guarantee future disk availability or source decode/render success.

Report:

```json
{
  "documentId": "<UUID>",
  "revision": 7,
  "recipeId": "<UUID>",
  "recipeVersion": 1,
  "recipeHash": "<64 lowercase hex>",
  "bindings": { "photo": "<layer UUID>", "title": "<layer UUID>" },
  "validation": "metadata-only",
  "valid": true,
  "stepCount": 3,
  "issues": [],
  "changes": [
    { "stepIndex": 0, "command": "add_layer_filter", "target": "photo", "layerId": "<UUID>" }
  ]
}
```

`bindings` echoes an independent key-sorted copy of the structurally valid input map so clients can compare it with their captured choices. Binding input must be a plain bounded object with at most 16 valid slot keys and lowercase layer UUID values; malformed input is a normal argument error. Missing or extra valid keys are semantic binding issues. `changes` contains one entry per step only when valid. It describes intended typed edits, not measured pixel differences or generated IDs. A predictable missing binding, incompatible/protected target or resource error produces `valid: false`, `changes: []`, and a bounded issue `{code,message,target?,stepIndex?}`. Mapping errors report at most 16 issues, with `issuesOmitted` counting any remainder; a mutation error reports the first failing step because later steps depend on that candidate state. Missing document/recipe and stale requested revision remain normal coded command errors. Unexpected programming failures must not be converted into a misleading successful validation report.

Application follows the identical staging path and publishes only the fully valid graph. Existing source bytes, layer IDs/order/parents/clipping links, dimensions/transforms, masks/density, selections and protection settings remain unchanged, except for explicitly allowed style/filter/adjustment/text metadata. No asset rollback is needed because this strict allowlist cannot write assets; tests must spy those seams. Widening this list to an asset-producing operation requires full mutation-to-publication rollback equivalent to repair transactions before that operation can be admitted.

## Protection and contextual behavior

Appending a filter rejects a protected raster even if the new entry is disabled, matching the existing command. Text styling rejects protected text, including explicit no-op values. Outside-only styles remain available on protected content because their renderer excludes every effective nonzero source pixel. Enabled styles on clipping members still reject through graph validation; clearing them remains legal.

Existing adjustment changes retain their mask/density and affect their established group scope. The renderer's protected-pixel exclusions continue to apply. Source filters keep their current lower-protected-footprint substitution and generated-layer context; recipes do not bake or bypass those rules. Global selection is ignored and unchanged by all five recipe step types. A validate pass makes no claim that a target is visibly exposed or that the edit will alter a nonzero number of pixels.

## Bounds, persistence and retry policy

Explicit limits:

- 16 recipes per document; overwrite can occur at capacity.
- 1–30 ordered steps and 1–16 declared/used slots per recipe.
- 32 KiB UTF-8 canonical JSON per recipe, including ID/version/name; 256 KiB for the full canonical library.
- At most 12 nested JSON levels and 8192 visited JSON values per recipe during bounded validation; no nonfinite numbers, functions, symbols, BigInts, sparse arrays, cycles, custom prototypes, accessor properties or dangerous object keys. Plain JSON data properties only; reject unknown fields before recursively accepting data. Native direct inputs receive the same checks as transport JSON.
- The existing 64-layer, 8-filter-per-layer, 64-filter-per-document, 384-million weighted filter work, combined 256 MiB rendering scratch and 16 MiB whole persisted project limits remain authoritative. Library limits do not guarantee that 100 maximal recipe-bearing history snapshots fit in 16 MiB.

The bounded definition and a private graph copy are the only new working data; no pixel-buffer memory allowance is claimed. Source image codecs and raster rendering do not run during save/get/validate/apply. Canonical normalization occurs on independent copies; later caller edits, definition replacement, or target edits cannot mutate an already saved or applied object by aliasing.

Saving, renaming and deleting are undoable. Recipes are inert metadata in `.prism` current-state bundles and retain stable IDs on new-document import. Bundle and graph validators must reject malformed definitions before reading any raster assets. Older projects without the field open as an empty library. Unknown recipe versions reject instead of being dropped. Cropping/resizing/canvas operations leave authored recipe values unchanged: these are reusable source-pixel/canvas-pixel settings, not geometry attached to an existing layer.

To reuse a definition on another existing photograph/project, read it with `get_edit_recipe` from the source document and save its `name`, `slots` and `steps` into the destination document. The destination receives a new independent recipe ID and explicit local bindings. This read-then-save workflow is suitable for MCP and a UI copy action; it introduces neither cross-document references nor automatic batch application. Whole `.prism` transfer instead preserves the library's existing IDs with its graph.

Raster/PSD output never serializes executable recipes or changes pixels merely because a library exists. Strict PSD compatibility ignores valid inert recipe metadata and its omission warning names recipes. Applying recipe steps may of course create an ordinary filter/style/text state outside the existing PSD subset. PSD archives remain exact, with no new source-asset role.

Normal session request-ID deduplication coalesces and replays the same accepted application. There are no new durable recipe receipts. If the process restarts after an ambiguous success, retrying the **same body and revision** safely returns a stale-revision error rather than appending filters again. The UI/assistant must inspect/reconcile current state and must not automatically retry with a fresh revision or new request ID. An in-session replay may return the original successful document snapshot even after Undo or another edit advanced the current document; reconcile with a fresh document read instead of replacing current state with that old response. A deliberate subsequent apply uses the new inspected revision and intentionally repeats the recipe. Undo does not silently trigger recipe replay.

## Capabilities and implementation ownership

Capabilities: `editRecipeVersion: 1`, `editRecipeCommands: ['add_layer_filter','update_adjustment','update_text','set_layer_effects','set_layer_outline']`, `editRecipeSlotTypes: ['raster','text','content','adjustment']`, plus limits `maxEditRecipes:16`, `maxEditRecipeSteps:30`, `maxEditRecipeSlots:16`, `maxEditRecipeBytes:32768`, `maxEditRecipeLibraryBytes:262144`.

Root owns pure shared schemas, public command/MCP/status wiring, transport checks and public documentation. `shared/edit-recipes.mjs` builds strict recipe schemas from the ordinary command shapes; `shared/commands.mjs` exposes definition, record and binding validators plus cross-kind checks. `server/edit-recipes.mjs` owns canonical defaults/copies, hashing, library bounds, binding diagnostics and private-graph staging. Native integration uses `buildCommit` and `serializeProject` to preflight the exact existing history/metadata envelope; ordinary persistence and history semantics remain unchanged. `server/project-bundle.mjs` admits and validates inert definitions before assets.

Recipe arguments are validated and copied at direct-native `execute` entry, before waiting on the queue; caller mutation during a pending operation cannot rewrite its intended definition or bindings. The backend owner maintains these modules and native tests. UI owns a document-local recipe list, typed capture/JSON editing, per-slot bindings, validation, apply/rename/delete and captured retry state. Independent review maintains adversarial definitions, pixel/source/protection oracles and fault-injected publication tests.

## Acceptance gate

1. One saved recipe binds to three independent documents with different layer IDs, applying photo filters, existing adjustment parameters, typography and outside styles while retaining source bytes, content text, masks/density, geometry, selection and order. It produces the same pixels as the equivalent explicit underlying commands.
2. Dry validation and repeated reports are stable, with no render/model/font/source/asset/cache/history/project writes and no leaked transient IDs. Invalid final metadata/project size and hidden filter/group work reject before publication.
3. Target typing, adjustment-kind mismatch, missing/extra/duplicate bindings, unused/duplicate slots, disallowed commands/fields, protected targets and clipping styles fail predictably. Partial text fields preserve prior values and explicit spacing resets survive save/reopen/apply.
4. A late failing step and real persistence failure preserve the committed project, history, cache and every existing asset. Successful multi-step apply creates exactly one undo step; retry deduplication and restart stale rejection prevent accidental double append.
5. Caller input mutations, recipe overwrite and duplicate application never create object aliases. Capacity overwrite, rename/delete/undo and old-project defaults behave correctly. Hostile native/portable JSON, unknown versions, oversized libraries and prototype/cycle/NaN/sparse-array input reject before image access.
6. `.prism` preserves inert recipes; unchanged recipes alone leave previews, generation inputs, source archives and PSD image output byte-equivalent. Original PSD archive downloads remain identical.
7. Official MCP and real browser workflows expose the same typed arguments, limits, binding choices, revision failures and one-undo results, including compact UI and target/revision changes between validation and apply.

## Native verification

The combined owner, independent audit, schema and official MCP suites pass **25/25** cases: 12 owner, eight independent, four shared-schema and one MCP workflow. Evidence includes three unrelated documents against explicit-command pixels, full parameter defaults and text reset markers, no-image-I/O validation/application spies, exact prospective 16 MiB history checks, protected/clipping failures, real `ENOTDIR` publication rollback, portable hostile input before assets, one-undo application and restart stale-retry protection. A valid 32,329-byte raw definition expands beyond 32 KiB after defaults and rejects; eight approximately 30 KiB recipes fit while a ninth correctly exceeds the separate 256 KiB library limit. Subsequent UI and full regression results should be recorded separately rather than inferred from these backend checks.

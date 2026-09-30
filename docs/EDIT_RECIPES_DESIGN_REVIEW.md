# Independent review: typed edit recipes

Status: independent native audit **8/8 passed**, September 19, 2026. The five-command contract is implemented; UI/transport acceptance is separately owned. Reviewed against shared schemas, native mutation and persistence paths, bundle validation, and the existing request cache. The authoritative JSON/API contract is [EDIT_RECIPES_DESIGN.md](EDIT_RECIPES_DESIGN.md); this review records its reasoning and acceptance evidence. No production files were edited by this audit.

## Recommendation and comparison

Proceed with document-local, explicitly bound recipes containing at most **30 typed steps**. Reuse the native editing commands and their guards. This is useful beyond saved outside styles: one recipe can append a color treatment to a photograph, adjust an existing grade, style a title, and decorate a protected cutout, each on a named target slot.

Adobe actions record operations for later playback and can optionally include tool operations. That is a workflow reference, not a claim of `.atn` compatibility, full action recording or identical Photoshop output. This review checked Adobe's page dated February 23, 2026. [Adobe: Record an action](https://helpx.adobe.com/photoshop/desktop/automate-tasks/create-record-actions/record-an-action.html).

The [earlier feature proposal](NEXT_FEATURE_REVIEW.md) suggested 32 steps. The actual public `apply_transaction` schema accepts 30, while direct native dispatch currently accepts 50. Use **30 consistently for recipes**; do not expand the public transaction limit or silently split one recipe into several commits.

## Small first command set

Architecture and independent review agree on these five commands, with narrower recipe argument schemas than the general editor API:

| Command | Recipe fields | Target and important behavior |
| --- | --- | --- |
| `add_layer_filter` | `kind`, `value`, optional typed `parameters`, `enabled`, `opacity` | Raster slot. Appends one existing native filter; source pixels remain immutable. Existing eight-per-layer, 64-per-document, work and render-scratch bounds apply cumulatively. Any protected raster rejects, including a disabled new filter if the normal native guard rejects it. |
| `update_adjustment` | Required `value`, complete normalized typed `parameters` when applicable | Adjustment slot with a required expected `kind`. Does not replace the mask, density, name, opacity or position. Parameter defaults are completed when the recipe is saved, so a reusable grade does not inherit different partial mixer rows or map settings from each target. |
| `update_text` | `fontSize`, `color`, `fontFamily`, `fontWeight`, `fontStyle`, `align`, `tracking`, `leading` | Text slot. Exclude text content, x/y and renaming. Preserve source-space font/leading units, zero-tracking canonicalization and `leading:null` Auto reset. Protected text rejects. |
| `set_layer_effects` | `effects` | Content slot. Replaces the outside shadow/glow settings; explicit null clears them. Existing protection and clipping-member restrictions remain authoritative. Does not change outline. |
| `set_layer_outline` | `width`, optional `color` | Content slot. Existing outside-only behavior and protected-content support; clipping members still reject enabled decoration. Does not change shadow/glow. |

Require at least one actual setting for partial text updates. Use the existing complete value ranges, parameter-family validation, defaults and native normalization rather than copying a simplified approximation. The recipe definition deliberately stores complete adjustment/filter configurations, including defaults, while text styling stays partial. State this difference from the general editor's partial adjustment update API: an omitted mixer row in a newly authored recipe resolves to its declared default at save time, not the future bound layer's current row. Preserve explicit text reset markers through normalization.

`add_adjustment` is excluded: its omitted mask captures the active selection, and its current shared schema cannot specify `mask:null`. A recipe must not inherit that hidden dependency. Existing adjustment slots avoid it without changing the general command. Creating layers, repair layers, groups, selections, guides or masks is also outside this first slice.

No step can refer to a filter or layer created earlier in the recipe. Appended filters receive normal new IDs internally, but those IDs are not recipe references. Do not introduce strings such as `$last`, positional layer indexes, previous-step outputs, name lookup or executable interpolation. Repeated application intentionally appends filters again unless the same invocation is being recovered; disclose this in the report and UI.

Explicitly exclude source painting/fill, extraction/segmentation, source-alpha edits, rasterization, transforms/canvas changes, protection toggles, deleting/reordering content, provider generation, file/network operations, imports/exports, history commands, arbitrary scripts, nested transactions and nested recipes. Saved style IDs, selection IDs, filter IDs and generation job IDs are not portable recipe operands.

## Definition, target slots and document binding

Recommended definition shape:

```json
{
  "version": 1,
  "name": "Warm cover treatment",
  "slots": [
    { "key": "photo", "type": "raster" },
    { "key": "title", "type": "text" },
    { "key": "subject", "type": "content" }
  ],
  "steps": [
    { "command": "add_layer_filter", "target": "photo", "args": { "kind": "temperature", "value": 12 } },
    { "command": "add_layer_filter", "target": "photo", "args": { "kind": "contrast", "value": 8 } },
    { "command": "update_text", "target": "title", "args": { "fontFamily": "Fraunces", "tracking": 80, "leading": null, "color": "#855f44" } },
    { "command": "set_layer_outline", "target": "subject", "args": { "width": 3, "color": "#ffffff" } }
  ]
}
```

Persisted library records additionally have a stable recipe UUID. The backend proposal pins 16 recipes, 1–16 unique slots, 1–30 steps, 32 KiB canonical UTF-8 per record including ID/version/name and 256 KiB for the whole current library. It also limits nesting to 12 and visited JSON values to 8192. These are metadata bounds, not permission to exceed the existing 16 MiB project/history envelope.

Slot keys should be short canonical ASCII identifiers, for example `[a-z][a-z0-9_]{0,31}`. Types are `raster`, `text`, `content`, and `adjustment`; an adjustment slot must also declare the exact supported adjustment kind. Every declared slot must be used, every step must name a declared slot, and each command's target type must be compatible with that slot. `content` excludes groups and adjustment layers. A command requiring a raster cannot rely on a broad `content` slot.

Invocation bindings map the exact set of slot keys to **existing layer IDs in the explicitly named current document**. Reject extra/missing bindings, missing layers and two distinct slots bound to the same layer. Repeated steps on the same slot are supported. Never automatically pick the active layer, first compatible layer, a matching name or an ID from another open document. Binding values are invocation data, not persisted recipe fields.

All recipe parameters are concrete typed values. Pixels remain the current native units: filter radii and text metrics are source pixels; outside decoration sizes follow their existing document-space renderer. Do not silently scale settings between different image dimensions. The report should disclose those units and target source/canvas sizes. Proportional layout recipes are a separate future design.

## Read-only validation and execution

The backend proposes `save_edit_recipe`, `get_edit_recipe`, `rename_edit_recipe`, `delete_edit_recipe`, `validate_edit_recipe`, and `apply_edit_recipe`, all standalone. A detached JSON definition is statically validated before saving; saving or importing a definition never executes it. Target-bound validation uses a saved recipe ID in this first slice. Client drafts can be statically checked locally, and save performs authoritative strict validation before publication. No recipe command is an outer transaction step.

Validation requires the document and explicit bindings; callers should supply its optional expected revision to reject stale reads. Apply requires that revision. Normalize the definition, resolve bindings, and execute all allowed steps in order on **one detached graph**, reusing the same native mutations and graph validators as Apply. Validate each staged candidate and the prospective persistence size without calling persistence, including redo truncation and the current 100-state history limit. This detects cumulative filter limits and dependent parameter changes; checking each step against the original graph independently is insufficient.

Invoking the existing metadata mutations may allocate ephemeral random filter IDs. This is acceptable: no IDs or candidate graph escape, no assets are written, and equivalent repeated reports stay identical. A special deterministic temporary-ID namespace is unnecessary. Apply repeats validation against the captured current revision and creates its actual IDs then. A validation result is not a promise that later file persistence or preview rendering will succeed.

Return a bounded report with `valid`, `validation:'metadata-only'`, definition version/hash, document ID/revision, normalized bindings and ordered step summaries. The backend proposal returns `changes:[]` on failure and an issue with precise step index/target when known; stop at the first staging failure rather than declaring later dependent steps safe. If binding diagnostics are capped, report their omitted count. Slot types, parameter values, affected fields and units can be displayed from the captured canonical recipe and target metadata, without duplicating its entire payload in the report. Unexpected internal failures remain coded command errors. No PNG preview, original RGB, path or asset bytes are needed.

Read-only validation must not render, open source files, call a model/provider, store assets, mutate the live graph, create history, invalidate previews or appear as a completed edit in activity. Enforce the allowlist before calling a mutation; do not route arbitrary input through `execute`. Register its command in both `readCommands` and activity exclusions. Tests should instrument those side-effect seams.

Apply requires explicit bindings and `expectedRevision`. Apply a detached snapshot of the saved definition, recheck every native guard and limit, then publish **one revision and one undo step**. The whole-document revision already pins the saved recipe and target state: an overwrite increments that revision too. The report's canonical hash is informational, not a mandatory preflight token. If the document changed, reject rather than silently validating and replaying against the new revision. No auto-resume from a failed middle step and no automatic rebase.

## Atomicity, originals and retry identity

All five proposed operations mutate metadata only. A successful application changes neither working/source/alpha asset bytes nor the active/saved selections, archive, mask settings, groups, clipping links or library unless a separate explicit library command was requested. Existing render protection remains operative: color/filter work cannot bypass protected lower people, text content guards remain, and outside styles remain outside effective source coverage.

The five-command slice has no asset-producing path, so its rollback is the existing detached-graph plus atomic project publication, with tests proving zero asset I/O. A later staged failure, resource failure or real persistence failure must preserve the old graph/history/cache. Validation cannot create temporary blobs and delete them afterward. If a future command writes pixels, admitting it requires ownership-based asset cleanup spanning staged mutations **through outer commit**, equivalent to repair transactions: only successful fresh `fs.link` publications are owned, and preexisting shared or unrelated blobs must survive. A helper-only cleanup is insufficient. This is a dependency for expanding the allowlist, not a claim that ordinary asset-producing transactions have gained new rollback behavior now.

The current command-service request cache is in memory, capped/evicted, and keyed by backend/request ID; it is not durable exactly-once storage. This matters because repeated filter steps append entries. The approved scope keeps this existing session dedupe and requires an original expected revision. UI/MCP submissions should retain a stable request ID across ambiguous retries. Replaying the old revision after restart must fail, never rebase and append again.

Durable receipts are explicitly deferred. After a lost response and restart, stale rejection means the client must inspect the current document/history before the user deliberately starts a new invocation; it cannot prove from the error alone whether the earlier application succeeded. Do not imply durable recovery because concurrent HTTP deduplication succeeds. Retrying the original body after Undo must not reapply: the monotonic document revision remains stale. The existing session cache can return an old successful result for the same request ID, so clients must not replace a newer document view with that older revision during recovery. No new receipt metadata belongs in graph, project envelope or `.prism` in this slice.

## Library, transfer and format boundaries

Add an optional `graph.editRecipes` collection, with an empty public default for old projects. Validate every record on save, reopen and portable import: exact fields and version; unique IDs; strict finite parameters; bounded strings/counts/depth; no prototype/accessor/cyclic non-JSON objects on direct calls; no foreign document/layer/file IDs embedded in args. A saved recipe can be valid even if no current layer fits its slots: static validity and target-bound applicability are different checks.

Saving/overwriting, renaming and deleting a definition are ordinary document metadata edits with revision guards and undo/redo. Overwrite retains the chosen recipe ID even at the library cap; apply snapshots a definition and has no live link to later library edits. Geometry edits preserve recipe constants unchanged, because units are literal and future binding is explicit.

Portable `.prism` projects retain definitions and omit invocation bindings/receipts. Add the collection to the codec's explicit graph-field allowlist and use its strict canonical JSON checks. Malformed recipes must reject before importing any assets. They introduce no asset references or archive roles. Current PNG/JPEG/WebP/TIFF exports contain only the rendered result. PSD export must explicitly list recipes among omitted native metadata; this milestone adds no Photoshop Actions or `.atn` import/export.

A lightweight `.prism-recipe.json` transfer file should contain only the versioned definition plus a fixed format marker, without saved UUID, bindings, invocation ID or project data. Use an explicit file-size bound before reading/parsing; imported content remains a draft until Save. A fresh saved UUID avoids document-local collisions. Library overwrite is an explicit choice and must not happen because an imported file carries an ID.

## Minimum useful UI and AI handoff

The approved first UI can provide a Recipes panel with a library list, visible ordered steps and slot declarations, single-slot capture from the selected layer's current settings, name/save/overwrite/rename/delete, bounded JSON import/export, explicit layer pickers for all slots, Validate and Apply. Capture lets users choose current filter, text/adjustment or outside-style settings without writing JSON. Invalid drafts remain local and do not create history. Show exact target names/types and operation count before Apply.

The AI can author a typed definition after a successful edit, save it through MCP, and give the client a ready recipe. The client can import the same JSON without asking the user to recreate every step. This is deliberate authoring, not hidden recording of every previous action: current history does not store a portable typed operation log, and arbitrary histories include unsupported tools and transient IDs.

Single-slot capture plus MCP-authored/imported multislot definitions is a practical authoring path for this first slice. A general five-family add/remove/reorder step builder may follow separately; do not claim it is already provided. Existing saved outside styles remain the simpler tool for shadow/glow/outline alone. A recipe's added value is its ordered combination of color, existing adjustment and text styling across explicit targets.

Capture document/backend/revision/definition hash/bindings at validation and Apply. Editing any of those invalidates the report. Discard delayed reports after context change, and preserve an ambiguous Apply invocation ID rather than creating a new one automatically. A recovered application must say when the displayed current document has since changed, including Undo; it is not a new edit.

## Acceptance fixtures and implementation sequence

1. One four-step photo/title/protected-subject recipe binds to three independently imported documents with unrelated IDs. Only bound fields change; originals, masks and selections remain exact. A global/existing adjustment step preserves its own mask/density and retains native protection behavior.
2. Read-only validation twice yields equal reports despite ephemeral filter IDs. Instrument assets, render, provider, segmentation, persistence, cache and activity; all remain untouched. Library imports/saves also never execute steps.
3. Reject wrong kind, group instead of content, missing/extra/aliased bindings, a protected text/filter target, enabled styles on clipping members, forbidden IDs/fields/commands, nonfinite/fractional-invalid parameters, unsupported versions and the 31st step. Check late cumulative filter overflow before publication.
4. Channel Mixer/Gradient Map/levels/curves configurations normalize completely at save and override target parameter configurations while preserving mask/density. Tracking zero and Auto leading resets behave identically to direct commands. A missing current selection and an explicit empty selection produce the same recipe result because neither is consulted.
5. One Apply gives one revision/history entry. Inject late validation and real persistence failures; assert graph/cache/project/assets unchanged. Instrument all asset writes and source/render calls to prove the metadata-only contract in both validation and Apply.
6. Concurrent same-ID requests coalesce. Lost response plus restart rejects the old revision; it never appends twice. Different payload under the same retained ID rejects. Retrying after Undo does not reapply or replace a newer displayed document with an old cached response. Fresh IDs intentionally append again within caps.
7. Overwrite at cap, rename/delete, undo/redo, reopen and `.prism` transfer preserve independent definitions. Invalid portable recipes reject before asset writes; imported documents have no execution receipts. PSD reports their metadata omission.
8. Browser and official MCP workflows agree on typed author/import, slot binding, invalid drafts, report invalidation, one-step Apply, recovery, source hashes and 900-pixel layout. No providers or real user images are needed.

Implement the strict definition/slot normalizer and staged validator first, then native atomic publication and portable metadata validation, then shared schemas/MCP and the capture/binding UI. Keep the proposed command set frozen while those acceptance fixtures land. Broader action recording, batching, created-object references and coordinate-dependent recipes can follow as separate contracts.

## Independent implementation evidence

`node --test tests/edit-recipes-audit.test.mjs` passes **8 tests**. The suite uses isolated native projects and synthetic PNGs, with no live projects, provider calls or credentials.

- All four parameterized grade kinds save complete, independently enumerated defaults. Existing levels/curves public schemas accept omitted parameters or complete objects; Mixer/Gradient Map also accept partial inputs. Applying the recipe replaces old target parameters and preserves adjustment masks/density, position and opacity. Partial text styling preserves actual text and source coordinates while explicit tracking zero and Auto leading reset survive canonicalization. Mutating submitted/returned definitions cannot change saved objects.
- A recipe combining all five command families binds three documents with unrelated layer IDs. Graph settings and rendered bytes match separately issued underlying commands. Original source files remain exact; a protected opaque subject retains its original pixels. Null, empty and small active selections remain untouched. Each application adds one revision/history entry, and Undo restores prior layers.
- Validation twice returns identical reports and binding identity with no leaked filter IDs. Instrumented native source/render/asset/model paths and filesystem reads/writes are never called. This includes text font changes and a deliberately unavailable original PNG. Apply also stays out of source/render/asset paths; only project metadata publication occurs.
- Missing, extra, aliased and absent-layer bindings produce failed reports without partial edits. A protected target on the second step, cumulative ninth filter, and enabled decoration on a clipping member all reject atomically. A hidden 24 MP source rejects excessive median work on the correct staged step without opening its nonexistent image asset.
- Missing/stale application revisions and a real `ENOTDIR` publication failure preserve project bytes, graph, history, cache and immutable files. A later successful application works normally.
- Valid portable recipes remain inert through export/import and reopen. Seven canonical malformed variants—including unsupported version/command, embedded layer ID, undeclared/unused slot, 31 steps and invalid mixer precision—reject before asset decoding or filesystem access.
- A legal library plus accumulated history is persisted immediately below the actual 16 MiB envelope limit. Read-only validation correctly rejects the prospective next commit, and failed Apply leaves the exact project bytes and current history intact. This tests the real size boundary rather than only an injected limit failure.

Read-only client inspection found two concrete lifecycle issues. Changing a binding while initial recipe inspection was pending aborted a shared controller without restarting inspection, leaving its hash unavailable and Validate disabled. A pending request from another document could also be marked inspected after the App correctly refused to display that document. The owner separated inspection/validation controllers and gated outcome review to the original native document before and after asynchronous reconciliation. The fixes were confirmed by source inspection; targeted browser regressions remain with the UI owner and are not implied by the eight native tests above.

# Filter effect mask controls

Implemented and browser-verified, 2026-09-19. This follows the approved [native contract](FILTER_MASK_DESIGN.md), [independent review](FILTER_MASK_REVIEW.md), and root's decisions to retain an explicit enabled flag and to permit style-only recipe capture after Filters is explicitly unchecked. Source/global kind counts remain27/24. The eight focused workflows and42 adjacent browser workflows pass, and the production build passes. The [focused report](../test-results/filter-mask-browser-report.json) records exact pixel, capability, lifecycle, portable-project, recipe and photographic evidence; [900px controls](../test-results/filter-mask-900.png) and [selective photographic output](../test-results/filter-mask-photo-ellipse85-feather20.png) show the completed interface and effect. No key or provider calls occurred.

## Meaning and placement

Add a compact **Filter effect mask** section to the whole-stack area of Layers → Layer filters, after the ordered entries and before Bake/Clear. It must not appear to belong to the selected filter row. The single mask controls the finished result of every entry, including filters appended later.

Always-visible help: **“Controls where the full filter stack changes colors. Layer transparency stays unchanged.”** A collapsed **How the effect mask works** explains that black restores the input before filters, white reveals the completed stack and gray partially reveals it; filtering still samples its full source neighborhood. The ordinary **Layer mask**, source cutout alpha and layer opacity stay separate. Selection affects this mask only through explicit capture.

Use a collapsed section with a short summary such as **“Filter effect mask · Ellipse · enabled”** or **“Filter effect mask · none.”** Existing masks remain discoverable even if their mutation capability is unavailable. Show the retained source size, e.g. **“512 ×512 source pixels, before transforms.”** Do not use the current canvas dimensions for these controls. An absent mask with no filter entries shows only “Add a filter before creating an effect mask”; creation requires a nonempty raster stack. Bitmap masks show their type and settings without dumping RLE into the interface.

The expanded section contains creation/replacement or refinement controls, an independent **Inspect effect coverage** action and explicit removal. Keep shape coordinates and replacement choices in their own disclosure so the ordinary density/feather workflow stays compact at900px. Do not add a new canvas brush target, drag handle, per-filter icon, automatic mask creation or permission dialog.

## Public shape and commands

The client continues reading `layer.filters` as an array and adds a distinct read-only type:

```ts
type FilterMask = {
  sourceWidth: number;
  sourceHeight: number;
  coverage: SourceFilterMask; // rectangle, ellipse or bitmap only
  density: number;
  enabled: boolean;
};
// Layer.filterMask?: FilterMask
```

`SourceFilterMask` is separate from `AdditionalMask`: no positioned wrapper, clip, polygon descriptor or layer-owned density field. The UI never writes the internal versioned filters wrapper or echoes a public layer/document projection into storage. Source dimensions must match the raster working frame. The backend alone owns mask arithmetic and geometry capture.

| User action | Captured command and behavior |
| --- | --- |
| **Reveal all** | `set_layer_filter_mask {layerId,source:'all'}` creates full effect coverage. |
| **Hide all effects** | `set_layer_filter_mask {layerId,source:'none'}` creates an explicit empty source mask. The layer remains visible. |
| **Current selection** | `set_layer_filter_mask {layerId,source:'selection'}` captures saved selection coverage at the captured document revision. No selection is an unavailable action; an explicit empty selection is valid and hides effects. |
| **Source rectangle / Source ellipse** | `set_layer_filter_mask {layerId,source:'mask',mask:{shape,x,y,width,height,feather:0,invert:false}}`, from an explicitly applied shape form. Defaults are the full retained source frame. |
| **Apply effect mask settings** | `modify_layer_filter_mask {layerId,...changedFields}`. Only changed supported fields are sent: `density`, `feather`, `invert`, `enabled`. There is no hidden replacement. |
| **Remove effect mask** | `clear_layer_filter_mask {layerId}` removes only the mask. The unchanged filters become fully applied. |
| **Inspect effect coverage** | Opens `get_mask_preview` with `source:'filter-mask'`, layerId, captured revision and raw/effective mode. It reads the saved mask, never a pending draft. |

Each mutation receives captured document/backend/layer/positive revision through the existing runner. Set is an explicit replacement: enabled becomes true and density becomes1; selection/all/none start with feather0 and invertfalse. Direct shape creation also starts with feather0/invertfalse in this UI. Explain before **Replace effect mask**: **“Replaces saved coverage and resets Density to100%, Feather to0, Invert off and Use effect mask on. Undo restores the previous mask.”** Selection feather/inversion are already baked into its captured alpha8 coverage and must not be applied twice.

Use controlled string drafts for X/Y/width/height, density and feather. Source X/Y/width/height use `step="1"` and `Number.isInteger` validation; density and feather use `step="any"`. Keep blank/incomplete/nonfinite/out-of-range values visible and disable only the dependent submission. Never clamp while typing. Source rectangles/ellipses require nonnegative integer X/Y and positive integer width/height, and must fit inside the source frame; no document-space percentage or inverse geometry is inferred. Shape changes and resets are local until the explicit Add/Replace action.

Existing-mask controls are **Use effect mask**, **Invert coverage**, **Density,%**, **Feather,source px**, local **Reset changes** and **Apply effect mask settings**. Use effect mask and Invert are draft checkboxes, committed with Apply. Disabling the mask retains its coverage/density/feather/inversion and reveals the full filter result. Density0 also reveals the full result; it is not “0% filter strength.” Density100 means full mask attenuation. Feather is0–100 source pixels and stays editable while the mask is disabled. A short visible note under an unchecked Use effect mask says **“Mask disabled: the full filter stack is shown. Saved coverage and settings are retained.”**

### Exact density drafts

The backend retains arbitrary finite binary64 density in[0,1]. Reuse the exact decimal exponent-shift percentage formatting approach already used for filter opacity, not `Math.round`, `toFixed` or a multiply-then-round display. Preserve the stored number separately. An untouched density or an equivalent numeric spelling of its canonical displayed percent stays clean; a feather/invert/enabled-only edit must omit density completely. Reset restores its exact original value.

When the user actually authors a different valid percentage, convert that percentage to density once for the command. For an equivalent displayed percentage, retain the original stored density rather than round-tripping through multiplication/division. No centipercent constraint applies. This is especially important for neighboring densities such as0.49999999999999994 and0.5000000000000001, and for subnormal values. Do not reuse the current additional-layer `MaskDensity` component unchanged: it initializes from `stored*100` and always derives a new density from that text.

The UI describes raw and effective coverage, not implementation arithmetic. Exact tests follow the selected native byte expression: raw black at stored density0.1 becomes230; .5 becomes128; .5000000000000001 becomes127. This is neither the superseded exact-rational density proposal nor a promise of continuous additional-mask coverage parity. RGB interpolation then uses the native exact alpha8 whole-stack policy. Alpha is never multiplied by this mask.

## Selection capture and geometry

The client may provide an early metadata-only eligibility reason using the same declared structural predicate as native: source frame and transform metadata must be valid; every retained stage is an integer crop, integer canvas offset or exact byte-copy affine with scale1/1, rotation0, no flips, integer translation and unchanged dimensions. Reject every resize/resample and other affine, even if net geometry seems identity. The server remains authoritative; the UI does not rasterize, approximate, allocate mask bytes or calculate the surviving coverage.

When ineligible, retain the Current selection choice as visibly unavailable with **“This source has resampled or non-integer geometry. Create the mask before those transforms, or choose a source rectangle/ellipse.”** Direct source-shape creation, Reveal all/Hide all and existing-mask refinement remain available. Do not offer an automatic undo, rasterization, inverse map or layer-mask fallback.

Capture is a snapshot, not a live link. Short help explains that it records the current selection in surviving source pixels; clipped source areas stay excluded even after later padding. Active selection opacity/feather/inversion are captured once; source alpha, visibility, layer/ancestor masks and clipping do not alter the captured values. A later edit to the selection does not update the mask. Users can draw/paint/refine a selection using existing selection tools and explicitly capture again; the existing **mask brush** still edits only the additional layer mask.

Polygon selections are capture inputs, not direct source polygon masks. Their distinct backend work limit and bitmap preparation remain backend responsibilities. The current draft advertises `limits.maxFilterMaskCaptureWork:384000000`, independently of retained filter-render admission; a geometry check alone cannot predict admission. On `LIMIT_EXCEEDED`, preserve the selection, mask, entries, assets, history and form draft; show the native bounded-work explanation without substituting a simpler shape or retrying. The UI must not claim all geometrically eligible selections are within resource limits.

## Capabilities and unsupported saved masks

Authoring requires matching native backend, `layerFilterMaskPolicy:'source-stack-alpha8-v1'` and `layerFilterMaskCoordinates:'source'`, plus the individual command and applicable source/shape/property. Selection capture additionally requires `layerFilterMaskCaptureGeometry:'integer-copy-v1'` and the `selection` source. New mask operations do not depend on the old Gaussian/High Pass/Unsharp/Noise markers. Individual filter edits still obey their own kind/blend policies.

Source/shape/property lists are strict arrays of strings. Malformed mixed values fail that feature closed; recognized subsets expose only those controls, and unknown future strings do not enable operations. No missing-list legacy fallback is appropriate for this new feature. Support set-only, modify-only, clear-only and preview-only companions independently. A missing modify property disables that field rather than inventing support through the command alone. Read-only saved values remain visible.

For an existing masked target, exact mask policy/source coordinates also gate filter add/update/toggle/reorder and recipe execution against that target. Unmasked stacks retain their existing legacy gates. No policy loss silently clears the mask, changes density, chooses another source shape or turns it into a transparency mask. Retain numeric and replacement drafts across capability changes and show the precise unsupported action.

As root approved, **Delete filter**, **Clear filters** and independently advertised **source-rgb Bake** retain their existing command/protection rules even when mask authoring semantics are unavailable. These are explicit removal/materialization paths. Mask-only Remove needs its own new command and recognized policy. Inspection needs its own command/source/mode/policy gates. A disabled mask or density0 does not relax source-edit, protected-prefix or filter work restrictions.

## Source-frame coverage inspection

Extend the existing `MaskInspection` target union with `'filter-mask'`; keep selection/additional-mask requests and dimensions unchanged. For this source, validate response `coordinates:'source'`, document/revision/layer/source/mode/maxEdge, retained source dimensions and exact nearest-center preview dimensions against `filterMask.sourceWidth/sourceHeight` and layer width/height. Source dimensions can differ from the canvas after crop/resize; never accept a canvas-sized response by coincidence or trust response dimensions alone. Preserve transfer-size and MIME checks.

Title: **“Filter effect coverage.”** Modes: **“Effective effect coverage”** and **“Raw mask before density/enable.”** The raw preview includes saved feather/inversion; effective includes the density byte mapping and enabled state. Disabled or density0 effective coverage is white, while raw still displays retained coverage. Show exact saved density without a rounded three-decimal caption. Legend: **Black: original colors · Gray: partial filter effect · White: full filter effect.** State that this is the retained source frame before transforms and contains no source alpha or layer transparency.

The preview uses saved metadata only and must not render RGB, read source files, modify selection or write history. Preview request identity includes backend/document/layer/revision, source dimensions, selected coverage mode/edge and its capability signature, including exact mask policy/coordinates, preview source/mode lists, preview command and edge/byte/working limits. Abort/discard delayed reads on context or capability change, including a mode disappearing while its PNG is in flight. Clear obsolete imagery rather than showing it under new labels. A revision change marks coverage stale until explicit Refresh; missing mask or layer shows its removal state. A retry button retries only the read.

Keep the existing close-on-document/backend/selected-layer navigation behavior. If the source or command/policy disappears, cancel the read and close inspection or show an explicit unavailable state without stale imagery. Mode-only withdrawal preserves the choice as unavailable until the user picks an advertised mode. Raw-only/effective-only and preview-only companions must work. Existing canvas-based inspection retains its labels and behavior.

## Draft and completion identity

Place mask edit submission identity in the stable `LayerFilters` owner or an equally stable sibling. It includes backend/document/layer and all applicable mask/filter/bake capability fields, explicitly including `layerFilterMaskPolicy`, `layerFilterMaskCoordinates`, `layerFilterMaskSources`, `layerFilterMaskShapes`, `layerFilterMaskProperties`, `layerFilterMaskCaptureGeometry` and applicable work limits/commands. It excludes selected filter ID, mask presence/contents, filter entries and revision: selecting another entry does not retarget a whole-stack mask, and own mask creation/removal/final-filter deletion/Bake must not invalidate its completion. App still checks the captured expected revision and the result revision.

Keep local mask drafts keyed by document/layer/revision, separately from capability identity. Capability changes retain drafts; canonical revision changes, Undo/Redo or target navigation restore the saved values. Do not derive the mask operation's liveness from a conditionally mounted child that disappears on its own successful removal. No automatic selection or dialog reopening follows a late success.

Add the three new mutations to narrow App guarded-result handling with mask-specific notices. Check target/capabilities before send, before installing a command result and after preview completion. For new filter-mask edits and edits to a masked stack, also pass the existing `updateDocument` preview-acceptance callback so capability loss during the preview await cannot install that stale PNG; an after-await return by itself is too late to protect the image. Do not couple whole-stack mask operations to the selected entry or to a draft that their own result resets.

`REVISION_CONFLICT` refreshes the same current document once, shows canonical settings and never replays. `NO_FILTERS`, `NO_FILTER_MASK`, protection and capture-geometry refusals may refresh relevant current metadata, preserving unrelated targets. A resource failure retains the unsaved draft. Never issue a second request to replace scope, enable a mask or simplify geometry automatically. Existing recipe request-ID recovery remains untouched.

## Stack actions, recipes and portability

Update existing Bake text narrowly: **“Bake fixes the current masked filter result into pixels and removes the editable filters and their effect mask. Clear removes both and their effect. Undo restores them.”** Original image, source alpha, additional layer mask and geometry remain; do not keep the current blanket “masks are kept” wording. For inactive stacks, both actions clear entries and effect mask without evaluating images. Explain near Remove: **“Removing only this mask keeps every filter and reveals the full stack.”** Near the final entry deletion control, make mask consumption discoverable through accessible help/visible summary. No extra confirmation dialog is required.

Capture Filters from a masked layer must fail explicitly even when the mask is disabled, white, density0 or all entries inactive. Keep the Filters choice selected by default, show **“Filter recipes cannot include this source effect mask. Uncheck Filters to capture other settings, or remove the mask explicitly before capturing filters.”**, and disable Save/Replace while that choice is selected. Do not silently omit the choice or mask. If the user unchecks it, existing style-only capture may proceed with clear exclusion disclosure. The pure capture helper must reject selected masked filters too, rather than relying solely on a disabled button.

Existing filter-only recipes may append to a supported masked target. Show beside that binding **“New filters will use this target's existing effect mask.”** Validation/Apply must require the recognized mask policy for every bound target receiving filter entries; capability loss clears the ready report. Appending preserves the exact mask and remains one Undo. Definition import/export and recovery do not gain mask serialization or a new recipe command.

Native project export/import retains mask metadata and pixels through the strict internal wrapper; UI never reconstructs the bundle from public arrays. Portable acceptance verifies reopen/import preserves effect/source size/density/enabled and independent edits on a duplicate. Existing strict PSD behavior still rejects editable filters, including masked disabled stacks; it must not imply this mask becomes a PSD transparency mask. Existing explicit Bake/Clear guidance remains the route to that limited PSD export.

## Eight focused browser workflows

1. **Creation, replacement and exact drafts.** Reveal/Hide, rectangle/ellipse source forms and explicit selection capture; no implicit capture when adding a filter. Invalid/blank shape, feather and density drafts send nothing. Defaults/reset/partial update, numeric equivalents, neighboring binary64 densities, subnormal density, and enabled toggling retain exact stored metadata. Replacing coverage visibly resets enabled/density/refinement once; alpha and additional mask do not change.
2. **Independent whole-stack pixels.** Exact raw/effective byte fixtures and final RGB mixes, every alpha class/hidden RGB, double-invert discrimination, ordered nonnormal filters, no masked blur-neighbor exclusion, density0/disabled/full/empty endpoints. Assert actual exports and raw Bake pixels against independent expectations, including raw black at density0.1→230 and neighboring .5 values.
3. **Capture geometry and source frames.** Identity, integer translation, crop→padding lost-domain `[0,255,255,0]`, empty selection and selection feather/invert snapshot. Rotated/fractional/resize/resample streams reject without replacement; direct source shapes remain available. Existing masks persist through later crop/resize/canvas and preview keeps source dimensions. A real polygon/bitmap capture limit fails without assets/history changes.
4. **Capabilities and structural guards.** Missing/unknown policy, coordinates, malformed/subset lists and set/modify/clear/preview-only partitions. Saved values/drafts remain readable, unmasked legacy filters work, masked mutations/reorder/recipe execution are blocked as specified, and explicit Delete/Clear/Bake keep independent gates. Protected targets/prefix and source-edit guards remain active under black/disabled/density0 masks.
5. **Inspection and delayed lifecycle.** Exact source-sized raw/effective PNGs with no image reads, alpha multiplication or history; current document/layer/mode/edge/capability identity guards. Delayed writes and delayed composite previews cannot retarget or install obsolete state. Selected-entry-only changes accept whole-stack mask success; own create/remove/final-delete completions survive. Stale revision refreshes once without replay and resource refusal retains drafts.
6. **Entries, Bake and source continuation.** Add/update/reorder/delete preserve the one mask until final deletion. Clear/Bake consume it with one Undo; masked Bake matches the composite and retains original source/source alpha/additional mask/geometry/hidden RGB. Painting is blocked before clearing the stack and works afterward with separate Undo. Inactive-only Bake clears metadata without source reads.
7. **Recipes, history and native bundles.** Masked filter capture explicitly blocks even when inactive; unchecking Filters permits intentional style-only capture. Existing recipe append retains target scope and matches equivalent pixels in one Undo; policy withdrawal invalidates readiness. Duplicate/reopen/export/import preserves source metadata and pixels independently, and no public projection is persisted as a maskless array.
8. **Photograph and compact layout.** Reuse the original NASA photograph, an ordinary source grade/High Pass stack and selective coverage. Export before/full/masked/disabled/baked PNGs, retain original fixture SHA and inspect900/1440px controls plus raw/effective source preview. No horizontal overflow, all explicit actions reachable, terminology distinct from Layer mask, zero provider/key/model calls and no unexpected browser errors.

Targeted regressions: original filters4, High Pass8, Blend8, Bake6, recipes5, mask inspection4, native bundle4 and additional-mask density3, then build. Run more only if implementation changes their shared seams. Backend/root acceptance separately owns wrapper validation before I/O, arithmetic/resource/scheduling limits, protection/compositing, strict portable/PSD behavior, SDK/schema and rollback matrices. UI tests must not claim those broader proofs from a few screenshots.

Owned implementation seams, after approval: `FilterMaskControls.tsx` plus a small draft/capability helper, public client types, `LayerFilters` lifecycle/copy/mount gates, narrow App guarded preview wiring, `MaskInspection` source branch, recipe capture/binding support, scoped styles and focused browser script. No source renderer, mask math, shared command schema, MCP, provider or generation changes belong to this UI slice.

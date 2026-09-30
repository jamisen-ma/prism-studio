# Independent resize-resampler review

Design and implementation review, 2026-09-19. Reviewed the implemented `resize_document` mutation and `server/resampling.mjs`, geometry renderer, masks, positioned masks, guides, filter/resource validators, layer-selection estimator, PSD preparation and portable-project validation against [RESIZE_RESAMPLING_DESIGN.md](RESIZE_RESAMPLING_DESIGN.md). The eight independent production tests in `tests/resize-resampling-audit.test.mjs` pass. No production correctness defect was found in this bounded audit.

## Recommendation

Offer a bounded native image-resampling choice while keeping omitted/default Lanczos3 exactly on the existing path. The proposed methods are `nearest`, `cubic`, `mitchell` and `lanczos3`. Nearest should be an explicitly native pixel-center byte-copy algorithm. Other methods retain the installed Sharp/libvips behavior. This is useful native control, not Photoshop numerical parity or a smart enlargement model.

Sharp documents its kernel names as reduction choices; enlargement uses nearest, linear or cubic interpolation, with other kernels mapping to cubic. Its pipeline accepts only one resize per evaluation, so retain the existing separately evaluated transform stages rather than merging a transform history into one Sharp chain. [Sharp resize documentation](https://sharp.pixelplumbing.com/api-resize/)

The upstream libvips implementation first reduces shrinking axes using the selected kernel, then enlarges growing axes with the inferred interpolator. Thus Mitchell, cubic and Lanczos3 may produce identical pure enlargement while remaining distinct for reduction or mixed-axis scaling. User copy should state this explicitly; calling the output “Lanczos enlargement” would overstate the algorithm. [libvips resize implementation](https://raw.githubusercontent.com/libvips/libvips/master/libvips/resample/resize.c)

A local synthetic RGBA fixture confirmed this in the installed backend: cubic/Mitchell/Lanczos3 were byte-identical for 3×4→9×11. Pairwise differences were 71–74 bytes for 13×11→5×4, 183–209 bytes for 13×4→5×11, and 54–77 bytes for 4×13→11×5. These small probes establish actual branch behavior, not comparative visual quality.

Adobe exposes additional specialized choices, including automatic selection and Preserve Details. A native kernel menu does not implement those algorithms. Use the actual native method names rather than Adobe's Bicubic Sharper/Smoother labels. [Adobe resampling options](https://helpx.adobe.com/photoshop/desktop/crop-resize-transform/resize-adjust-resolution/resampling-options.html)

## Verified nearest trap

The installed versions are Sharp 0.35.4 and libvips 8.18.6. A direct raw-RGBA probe resized four pixels to eight:

| Sample RGBA | Sharp nearest result |
| --- | --- |
| `[240,7,9,0]` | `[0,0,0,0]` |
| `[4,121,230,1]` | `[0,0,0,1]` |
| `[11,23,117,128]` | `[9,21,115,128]` |
| `[20,40,60,255]` | unchanged |

Local `node_modules/sharp/src/pipeline.cc` confirms that resize premultiplies alpha, casts back to the input format, then unpremultiplies and casts again. Therefore simply passing `kernel:'nearest'` does not guarantee sampled RGBA identity. This finding was sent to root and the backend owner; root approved a separate byte-copy nearest branch.

Sampling coordinates also require an explicit contract. Sharp's opaque 3→5 enlargement selected source columns `[0,0,1,1,2]`; the existing mask pixel-center policy selects `[0,0,1,2,2]`. Use the latter policy for the new native nearest branch:

`sx = floor(((2*x + 1) * oldWidth) / (2*newWidth))`

Use the corresponding Y expression, copy all four sampled bytes literally, and yield after at most 65,536 output pixels. The integer numerator is safely exact within 8192-pixel axis limits. This deliberately differs from Sharp nearest; it aligns image nearest sampling with the existing bitmap-mask rule. Same-size input is byte-identical. Root approved these semantics, and production fixtures below now verify them.

## Persistence must reject unsupported semantics

Current readers accept extra fields on a `type:'resize'` transform and always render it with Lanczos3. Adding a `kernel` field to that record would silently render differently in an old reader. The proposed representation avoids that:

- Omitted or explicit default: preserve `{type:'resize',width,height}` exactly.
- Nondefault: strict `{type:'resample',width,height,kernel:'nearest'|'cubic'|'mitchell'}`.

Old native validation rejects the new transform type. New validation must reject unknown kernels, missing fields and contradictory kernel/resample metadata attached to legacy transforms. Validate before any project-import asset reads or writes. Avoid broad unrelated changes to existing crop/affine validation in this milestone. Nondefault methods must survive Undo, duplicate, save/reopen and portable export/import without rewriting source assets.

## Distinct alpha and mask contracts

| Data | Required behavior |
| --- | --- |
| Working RGB and working alpha | Decode at source dimensions, then follow the chosen content geometry stage. |
| Separate source cutout alpha | Combine with working alpha once, using the existing byte rule, before source filters and geometry. Never resize the two alphas independently and multiply afterward. |
| Source filters | Remain before geometry, with unchanged source-unit radii and source-pixel work accounting. Downscaling the canvas does not reduce the stored source filter budget. |
| Additional bitmap masks, active and saved bitmap selections | Keep existing pixel-center nearest resize, inversion and feather-scaling rules regardless of image method. Do not silently bake feather or density. |
| Geometric masks/selections | Scale existing geometry, polygon points, clip rectangle and feather using the legacy helper. Do not rasterize because an image kernel was selected. |
| Positioned additional masks | Keep the existing refusal for dimension-changing image resize until explicitly rasterized. A zero-offset wrapper can still retain a domain; do not infer that zero offsets make it safe. |
| Group/adjustment masks | Transform once through the same existing document-mask path; groups acquire no content transform. |
| Guides | Preserve existing integer rounding and IDs. No image sampling method changes guide placement. |

Pass a separate legacy resize descriptor to mask and guide helpers: `transformMask`, `transformPositionedMask` and `transformGuides` currently branch specifically on `type:'resize'`. Passing the new persisted `resample` record directly would select incorrect branches or reject.

Density remains after raw additional-mask coverage. Protected footprints are derived from the actually resampled source alpha and current masks; generated exclusion, filter RGB restoration and outside decorations must use those footprints. New nearest preserves sampled hidden RGB, but composition and non-nearest resampling retain their existing transparency behavior. Original/source previews remain raw; content-alpha selection and current-layer previews use actual transformed pixels.

## Protection, resource and output constraints

Keep the existing proportional-resize guard for every protected content leaf, including hidden or fully masked leaves. The half-pixel integer-dimension tolerance stays unchanged. Every new method must follow that guard; an image kernel is not an unprotect operation. Preserve original and working asset bytes, separate source alpha, filter entries, editable text/vector source coordinates, styles and provenance. Current outside-style dimensions remain in document pixels; this feature adds no automatic Scale Styles option.

Nearest needs one output RGBA buffer and no extra full image. If an index lookup table is added, account for its bounded allocation or avoid it. Existing retained source/previous/next geometry and filter/group/clipping/positioned-mask budgets still apply. Audit `validateLayerFilterResources`, `estimateLayerSelectionBytes` and PSD preparation: their non-affine dimension transitions should include the new type without omitting intermediate surfaces. This is named-buffer accounting, not an overall RSS or runtime limit. The existing 500-transform history limit and 24-MP/8192-axis limits remain.

One kernel applies to the rendered content of all leaf types, including text and vector layers rasterized at their existing source size. It does not change their source font size or rerender them at new source resolution. Layers in clipping chains keep their links and are resampled separately before chain assembly. A direct resize is therefore not defined as resizing one already-flattened composite.

PNG/JPEG/WebP/TIFF previews and exports, protected generation snapshots, PSD layer rasterization and image edits must all consume the same geometry path. PSD stores the resulting raster layer pixels, not an editable native resampler record. Full editable transform semantics remain in `.prism`. Optional legacy-host commands must reject unsupported explicit options instead of ignoring them; absent capability data retains existing default resize behavior.

## Independent production evidence

`node --test tests/resize-resampling-audit.test.mjs` passes all eight checks:

1. Eighty-seven dimensions/ratio fixtures compare every output byte to a separately implemented BigInt pixel-center oracle, including all 256 alpha values, hidden RGB, identity, integer enlargement, odd and mixed dimensions, and one-pixel axes. Output is separately owned and inputs remain unchanged. An 8192-wide fixture yields to an independently scheduled callback before completing and still matches every byte.
2. Omitted and explicit Lanczos3 commands retain the exact legacy descriptor and match three separately evaluated old Sharp geometry stages byte-for-byte. Stages are not fused or reordered.
3. Actual cutout alpha is multiplied before filtering/resampling using an integer reference. Exact nearest and contextual original-RGB restoration match independent buffers; a photo-method fixture matches resize of the already combined alpha. Source/working/alpha assets stay unchanged.
4. All four image methods produce identical established mask metadata for hidden group masks, adjustment polygon/clip/feather masks, density, saved selections, an empty active bitmap and guides. Bitmap bytes match a separate BigInt nearest oracle; geometric coordinates preserve the existing floating operation order.
5. Hidden fully masked protected content still rejects incompatible proportions before image access. Proportional nearest resize succeeds. Positioned masks on content/groups/adjustments reject actual scaling even when hidden, density zero and offset zero; identity resize retains the wrapper/domain exactly.
6. Missing/unknown/surplus new transform fields and both reserved legacy `kernel`/`resample` fields reject. Invalid portable graphs fail before image validation/publication. A captured old transform allowlist rejects the new type. All four explicit kernels remain readable in strict new-format records.
7. A 20-MP source with intermediate 24-MP stages and a 1-pixel final canvas still contributes its original/current/next surfaces to selection and filter budgets. PSD preparation refuses its oversized retained geometry before source rendering. A 500-stage document refuses a 501st resize atomically.
8. Actual filesystem `ENOTDIR` publication failure and a later transaction error discard all staged transforms and mask/selection changes. Assets, project/history/revision and preview-cache state remain identical.

Owner and root suites separately cover broader content/group/clipping integration, official SDK capability/retry, exports, portable reopen and restart. Their results should be reported separately from these eight independent checks. No model, provider or credential access occurred.

## Remaining integration acceptance

Require old-pixel goldens for omitted/default Lanczos3; independent nearest all-byte tests at alpha 0/1/128/255 and odd up/down/mixed dimensions; every nondefault persistence/refusal path; source alpha combined before geometry; full layer/filter/group/clipping and generated-protection integration; unchanged mask/selections/guides semantics; positioned-mask refusal; hidden protected proportional guards; no asset writes; stale and actual persistence rollback. Mixed-axis Sharp cases should be checked against the actual installed backend rather than assuming one algorithm applies identically on both axes.

The separate Bake UI source was also read during this review. Its canonical protection guard, independent capability checks, whole-stack response identity and bake-only/clear-only mount retention match the accepted design. No source blocker was found. Its owner reports six focused browser workflows, eight tonal, four filter and five recipe workflows plus a clean build; these are separately owned UI results. Resize UI acceptance is still a separate milestone.

The new Resize UI source has now been independently reviewed in `ResizePanel.tsx`, `resize-methods.ts`, `gesture.ts` and the narrow App runner paths. No blocker was found. Document-scoped installation correctly permits selected-layer changes and closure of the old modal; a stable App capability signature, source/result dimensions and revisions guard both the command response and preview continuation. A separate modal session token, local alive flag and submitted draft identity prevent an older completion from closing a new dialog. Absent, empty, subset and withdrawn method capabilities preserve the documented distinctions; positioned-mask review retains string dimension drafts and method without automatically resizing.

The UI owner subsequently reports all eight focused resize workflows, four existing canvas workflows, eight mask-position workflows and build passing. `test-results/resize-resampling-browser-report.json` records delayed command/preview and newer-modal cases, accepted same-document layer changes/old-modal closure, pending capability withdrawal, document/backend navigation and a bounded mock legacy-host omission-only request. It records no unexpected browser/provider/key errors and one intentional revision conflict. Root accepted those artifacts. These are owner-run browser results, separate from the independent source review and eight native audit checks above.

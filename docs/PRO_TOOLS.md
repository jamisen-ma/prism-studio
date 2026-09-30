# Professional native tools and UI contract

Prism is a standalone editor; Photoshop installation is not required. Native tools use the document, transaction and revision APIs through both the UI and MCP. The optional legacy bridge advertises its own supported subset. UI controls are gated by current backend capabilities.

The exact validated fields live in [`shared/commands.mjs`](../shared/commands.mjs); implementation and rendering limits live in [`server/native.mjs`](../server/native.mjs). This document describes the implemented workflows rather than a complete Photoshop parity claim. See [feature parity](FEATURE_PARITY.md) for missing families and [verification status](IMPLEMENTATION_STATUS.md) for evidence.

## New/editable commands

Mutation args include documentId and generally optional expectedRevision; baking and recipe application require a positive revision. Mutations return `{document}`. Dimensions pixels. Existing layer metadata remains.

1. `add_paint_layer {name?}`: transparent raster layer canvas-sized; type raster, may carry role:'paint'.
2. `paint_stroke {layerId?, tool:'brush'|'pencil'|'eraser'|'clone'|'heal'|'dodge'|'burn'|'blur'|'sharpen'|'smudge'|'sponge'|'red_eye'|'color_replace', points:[{x,y,pressure?:0..1}], size:1..512, hardness:0..1, opacity:0..1, color?:'#RRGGBB', source?:{x,y},sampleMode?:'current'|'current-and-below'|'all',ignoreAdjustments?:boolean}`. Max 2000 points. One stroke = one undo step, pressure affects tip coverage/radius. brush without layerId creates a new paint layer. Other tools require editable target raster layer; source required clone/heal. Clone/heal sampling freezes the selected scope before the stroke, offset from its first point; no recursive smearing. All layers is the default. Current samples transformed working pixels/source alpha; Current & below requires an unclipped root raster. Adjustment skipping affects standalone adjustment layers only. Eraser reduces target alpha, retaining original source asset and prior history. Rasterize an existing target's geometry into a new working asset before brush writes; do not overwrite original assets. Explicitly reject text/adjustment/solid targets and explain add a paint layer or rasterize. Selection restricts every tool. No changes outside brush/selection coverage. Do not claim healing is content-aware generation.
3. `rasterize_layer {layerId}` converts solid/text/shape/path/gradient content to raster at current canvas size; preserves group membership, editable outside effects and undo. Groups and adjustment layers are unsupported targets.
4. `update_adjustment {layerId, value?:number, parameters?:object, mask?:Mask|null}` updates an existing adjustment without stacking duplicates. null mask removes it, omitted mask preserves it.
5. `update_text {layerId,text?,x?,y?,fontSize?,color?,fontFamily?:'sans-serif'|'serif'|'monospace'|'Fraunces',fontWeight?:'normal'|'bold',fontStyle?:'normal'|'italic',align?:'left'|'center'|'right',tracking?:integer(-1000..1000),leading?:number(1..2000)|null}` updates editable text. `add_text` accepts the same optional font settings. Tracking uses thousandths-em; explicit leading uses source pixels and null resets Auto. Omitted update fields preserve current values. See [editable text spacing](TEXT_SPACING.md).
6. `set_layer_mask {layerId,mask:Mask|null}` applies geometric masks to content, adjustment and group layers. null removes. Mask in current document coordinates; preserve through canvas crop/resize.
7. `select_region {shape:'rectangle'|'ellipse'|'polygon',x?,y?,width?,height?,points?:[{x,y}],feather?:0..100,invert?:boolean}`. Rectangle/ellipse require bounds, polygon 3..256 points. Selection stored as full Mask with polygon bounding box for UI. Existing select_rectangle remains compatible.
8. `modify_selection {feather?:0..100,invert?:boolean}` updates actual existing selection; error if none.
9. `transform_layer {layerId,x:number,y:number,scaleX?:0.05..8,scaleY?:0.05..8,rotation?:-180..180,flipX?:boolean,flipY?:boolean}`. Translation from current top-left, scale/rotate about canvas center, clipped to document canvas, undoable. Applies an append-only affine operation to content layers. Groups and adjustment layers are unsupported; protected content rejects nonuniform scaling. Alignment and distribution use the dedicated integer-translation commands described below.
10. `get_histogram {documentId}` -> `{red:number[256],green:number[256],blue:number[256],luminance:number[256],pixelCount:number}`. Read-only actual composite; ignore fully transparent pixels.

## Professional color

Extend add_adjustment kinds with `vibrance` (-100..100), `hue` (-180..180 degrees), `highlights` (-100..100), `shadows` (-100..100), `levels`, `curves`. Retain value required (0 for levels/curves) to preserve existing schema shape. Add optional parameters:
- levels `{black:0..254,white:1..255,gamma:0.1..10,outputBlack:0..255,outputWhite:0..255}`; black<white and outputBlack<=outputWhite.
- curves `{points?:[{x:0..255,y:0..255}],channel?:'rgb'|'red'|'green'|'blue',interpolation?:'linear'|'smooth'}`; 2..16 effective points, x strictly increasing with endpoints0,255. Linear remains the default. Smooth requires its independent native capability and uses a shape-preserving 256-byte lookup. Sparse updates preserve omitted settings; explicit Linear resets Smooth. Numeric drafts retain close fractional points and graph gestures preserve untouched axes. See [controls, precision and scope](SMOOTH_CURVES.md).
- selective_color `{method?:'relative'|'absolute',reds?,yellows?,greens?,cyans?,blues?,magentas?,whites?,neutrals?,blacks?}` uses value0 and four-value CMYK-style rows, each −100..100 in exact0.01% increments. Defaults are Relative with all zeros. Source/global controls retain every row while switching ranges; supplied MCP rows replace complete tuples. Support requires the native policy and complete method/range lists independently of kind/command. See [Selective Color controls and limits](SELECTIVE_COLOR.md).
- curves banks `{mode:'banks',banks:{master?,red?,green?,blue?}}` retains four independently editable point sets and interpolation modes. Master maps to bytes before the component curves; the completed candidate has one blend/opacity stage. Explicit upgrades preserve a legacy curve by placing it in the matching bank. Explicit back-conversion discards the other banks; no old-style partial update may do this implicitly. Require the independent bank policy/name capabilities and Smooth capability for any Smooth bank. See [bank controls, transitions, recipes and MCP](CURVES_BANKS.md).
- hue_saturation `{master?,reds?,yellows?,greens?,cyans?,blues?,magentas?}` uses value0 and three-value `[Hue,Saturation,Lightness]` rows. Hue is ±180 degrees; Saturation/Lightness are ±100 percent, in exact0.01 increments. Defaults are all zero; partial updates replace whole supplied rows and retain the rest. The native policy and complete range capability are independently required. See [targeted controls and native behavior](TARGETED_HSL.md).
Color transforms preserve alpha and pixels outside mask exactly. Adjustment updates validate kind-specific params. Neutral/default curves and levels no-op. Avoid zero-value short-circuit for non-scalar operations.

## Four-corner Distort

The Distort inspector maps an image, solid, text, shape, path or gradient to four independently editable corners. Saved stages can be revisited or removed; appended and final stages also have canvas handles. Numeric fields retain fractional coordinates in the selected stage’s own frame. The guide shows a draft, and Apply commits one Undo step. Sources stay immutable; protected layers, groups and adjustments reject. Existing source-filter masks remain in source coordinates, while additional masks, selections and guides stay in document coordinates. See [controls, MCP commands, sampling and limits](DISTORT.md).

[Linked Perspective](LINKED_PERSPECTIVE.md) adds horizontal and vertical paired-corner drags and an exact numeric Move pair action. Each gesture starts from one captured quad; the other six coordinates and independent fields stay intact. Historical stages support numeric pairing, and Apply uses the existing Distort command and sampler.

## Editable raster layer filters

The **Layers** inspector has a **Layer filters** section for raster layers. Filters run in numbered order on the working source pixels, before placement or geometry; median and mosaic sizes therefore scale with the layer. This is an editable native filter stack, not a Photoshop Smart Object. Adding a filter does not capture the active selection. The separate **Filter effect mask** can explicitly capture compatible selection coverage or use a source rectangle/ellipse to mix the completed treatment with its original working colors. The additional layer mask still controls visibility afterward. **Original** and source-alpha previews remain unfiltered. See [effect-mask coverage, coordinates and inspection](FILTER_EFFECT_MASKS.md).

All 32 supported kinds appear only when advertised by `layerFilterKinds`: exposure, brightness, contrast, saturation, temperature, vibrance, hue, highlights, shadows, levels, curves, invert, grayscale, sepia, posterize, threshold, median, mosaic, Channel Mixer, Gradient Map, Color Balance, Black & White, source Gaussian Blur, source RGB Sharpen, Unsharp Mask, repeatable Add Noise, High Pass, Local Shadows / Highlights, Selective Color, targeted Hue / Saturation, imported Color Lookup and Photo Filter. Source blur/fixed-sharpen require the matching `layerFilterSpatialPolicy` marker and preserve alpha/hidden RGB with their own source-pixel algorithm; the existing global adjustment versions remain unchanged. Unsharp Mask has independent Amount/sigma/per-channel Threshold controls under its separate `layerFilterUnsharpPolicy` marker. Add Noise has Uniform/Gaussian, monochromatic/color and saved-seed controls under its independent `layerFilterNoisePolicy` marker. High Pass has scalar source sigma under its independent `layerFilterHighPassPolicy` marker; zero produces gray 128 instead of bypassing the candidate. Local Shadows / Highlights has separate Amounts, Tonal widths and source sigma under its independent `layerFilterLocalTonePolicy` marker. It preserves alpha, uses the complete source neighborhood before the stack effect mask, and keeps Amount, blend and opacity as separate stages. See [Local Shadows / Highlights](LOCAL_SHADOWS_HIGHLIGHTS.md). See [fixed source spatial filters](SOURCE_SPATIAL_FILTERS.md), [Unsharp Mask](UNSHARP_MASK.md), [repeatable Add Noise](ADD_NOISE.md) and [High Pass](HIGH_PASS.md).

Imported [Color Lookup](COLOR_LOOKUP.md) uses a dedicated atomic file import/replacement action with an explicit encoded-sRGB interpretation. It accepts strict 3D `.cube` grids2–33, retains original files in portable projects and preserves existing IDs/settings/masks during replacement. Generic Add requires an existing verified complete descriptor. New global lookup layers adopt the selection; source entries run before transforms and the completed-stack effect mask. Lookup dependencies cannot currently be captured in recipes.

[Photo Filter](PHOTO_FILTER.md) provides a custom RGB color, precise0–100% Density and Preserve Luminosity in global and source scopes. Its default warm treatment uses25% density. Apply preserves transparency, original assets and editable settings; source blending, completed-stack masks, recipes and explicit Bake remain available. The local Reset button changes the three draft filter settings without dispatching an edit or resetting blend/opacity.

Each source entry also has independent [Filter blend](FILTER_BLENDING.md) controls. The 26 RGB modes exclude Dissolve, retain alpha, preserve legacy Normal and run before per-filter opacity. Nonnormal modes require their own capability policy and add 40 weighted source visits per pixel. Fractional opacity such as 37.5% remains visible and saved exactly.

- `add_layer_filter {layerId,kind,value,parameters?,blendMode?,enabled?,opacity?}` creates an entry; levels/curves use value 0 and their existing parameters.
- `update_layer_filter {layerId,filterId,value?,parameters?,blendMode?,enabled?,opacity?}` edits the same stable entry. Inspector drafts commit only through **Apply filter changes**.
- `reorder_layer_filter {layerId,filterId,index}` changes execution order; the UI labels earlier/later movement.
- `delete_layer_filter {layerId,filterId}` and `clear_layer_filters {layerId}` remove entries without replacing source assets.
- `bake_layer_filters {layerId,expectedRevision}` fixes the saved filter result into working RGB, retains original and separate alpha assets, and removes the stack. Requires a positive revision, including on the enclosing transaction when grouped with other edits. See [Bake filters](FILTER_BAKING.md).

Public `layer.filters` contains `{id,kind,value,parameters?,blendMode?,enabled,opacity}` with separate read-only `filterMask` metadata when present. Persisted masked stacks use a strict versioned wrapper. Normal blend is canonically omitted. Limits are eight per layer and 64 per document. Per-filter opacity blends the RGB result once; alpha is preserved, and disabled/zero-opacity entries are exact bypasses. Order affects output. The effect mask mixes the finished stack once, after all entries. Stacks and their masks remain editable through duplication, transforms, additional layer masks, outside effects, undo/reopen and portable project transfer.

Protected layers reject every stack edit. To enable pixel protection, first disable all active filters or set their opacity to zero. Any nonempty stack, including disabled entries, blocks painting, filling, extraction, cross-document placement and source-alpha repair. The UI explains this and keeps ordinary layer-mask editing available. Use explicit Bake to keep the current treatment or Clear to remove it before eligible pixel edits. An active bake rejects any earlier protected content in canonical layer order, including hidden content; inactive-only stacks can be removed without image I/O. Neither action includes an unapplied inspector draft. No operation silently removes protection or bakes filters.

## Composite-channel selections

**Select → From composite channel** measures the final visible image as Red, Green, Blue, Encoded luma or Alpha coverage. Preview is read-only and shows the candidate before combination; Load measures full resolution and applies Replace/Add/Subtract/Intersect in one Undo step. Save a result explicitly to reuse it. Invert also selects transparent pixels, so preview first around cutouts or an expanded canvas.

Photographic detail uses exact run-length or framed alpha8 storage without thresholding or downsampling. The native preview overlay and mask inspector read actual coverage. MCP exposes `get_channel_preview` and revision-pinned `load_channel_selection`; original image bytes, protected writes, history and portable asset retention keep their existing guarantees. See [coverage math, commands and limits](DENSE_MASKS.md).

## Selection and layer-mask edges

Use **Select → Selection edges** for the active selection, or **Layers → Layer mask edges** for an existing selected layer mask. Choose an operation and an integer radius from 1 to 100 source-independent document pixels, then Apply. The controls are gated by the native `morphologyOperations` capability and never create an implicit target mask.

`morph_selection {operation,radius}` and `morph_layer_mask {layerId,operation,radius}` support:

- **Expand:** square-neighborhood maximum coverage.
- **Contract:** square-neighborhood minimum coverage, treating outside-canvas pixels as zero.
- **Border:** outer maximum minus inner minimum, producing a band on both sides of the edge.
- **Smooth:** opening followed by closing; removes narrow features and fills small gaps rather than feathering/blurring the edge.

Current feather, inversion and clip are converted to effective alpha once before the operation. Results are editable bitmap masks. Protected-layer masks remain eligible because source RGB is unchanged. Active, layer and saved masks stay independent; each edit is one undo step. The canvas displays the resulting selection or masked image immediately.

## Public geometric mask input

`Mask={shape?:'rectangle'|'ellipse'|'polygon', x,y,width,height, points?:[{x,y}], feather?:number,invert?:boolean}`. Default rectangle; persisted old masks lacking shape must reopen. Polygon points in document coordinates; full Mask includes computed bounds. Mask coverage function shared by adjustment, layer compositing, and stroke tools, with inward feathering and inversion. Crop/resize must transform points and bounds consistently. Raw graphs may have mask bounds outside canvas after cropping; validation must handle this without corrupting saved projects.

## Retouch module exact interface

`export function applyStroke({pixels,width,height,tool,points,size,hardness,opacity,color,source,composite,coverage})` -> new Buffer RGBA8. pixels target layer buffer, composite frozen visible composite buffer (same dimensions), coverage optional function(x,y)=>0..1 for current selection. Return copy; never mutate input buffers. Validate bounds/resource work to avoid unbounded operations. Clone/heal treat outside sample neighbors as transparent; a partially overlapping border sample can still contribute coverage. Brush interpolation should avoid gaps without excessive work for long diagonals. Radius and opacity honor pen pressure. Color argument hex. Root will validate command schemas; module also validates since direct backend commands/tests bypass service.

## UX

Add real brush/eraser/clone/heal/dodge/burn tool controls: size/hardness/opacity, foreground color, cursor outline, live stroke overlay while pointer down, commit on pointerup with pointer capture; Alt-click source for clone/heal, obvious source marker. Keyboard B/E/S/J/O, bracket size. Preserve canvas zoom coordinate mapping and pointercancel recovery. Add ellipse/lasso selection and feather/invert. Add curves/levels controls plus real histogram and update selected adjustment/text controls. Layer mask controls and transform modal. Disable unsupported tools on Photoshop. Always show error when unsupported target requires a paint layer/rasterize. No fake AI outcomes.


## Expanded toolbar implementation

The source of truth for exact validated fields is `shared/commands.mjs`. All mutations below participate in revision checks, auto-save, transactions, undo and redo. Their MCP names have the `prism_` prefix. Capabilities distinguish native and Photoshop support.

- `paint_stroke`: 13 tools: brush, pencil, eraser, clone, heal, dodge, burn, blur, sharpen, smudge, sponge, red_eye, color_replace. `strength` defaults to50; range0..100 except signed sponge -100..100. `tolerance` defaults48 for color replacement. Pencil and color replacement require color; non-brush tools require raster layerId. Clone/heal require a source.
- `add_shape` / `update_shape`: rectangle, ellipse, triangle, polygon, star and line; editable geometry, nullable fill/stroke, strokeWidth, corner radius, sides, innerRadius. Settings live under `layer.vector`.
- `add_path` / `update_path`: nodes with x/y and optional absolute incoming/outgoing Bezier controls, closure, fill/stroke/width. Settings live under `layer.vector`. Replacing nodes edits anchors without flattening.
- `add_gradient` / `update_gradient`: kind linear/radial/angle/reflected/diamond, start/end and ordered color/alpha stops spanning offsets0..1. Settings live under `layer.gradient`.
- `select_color`: x/y seed, tolerance0..255, contiguous flag. Samples rendered composite. Four-connected flood or global match produces bitmap coverage.
- `fill_area`: raster layerId, color or erase mode, opacity; optional x/y and tolerance/contiguous scope a flood region. Intersects active selection. Omit coordinates to fill the selection or full canvas.
- `sample_color`: read-only composite RGBA/hex sampling; optional radius0..50 computes an alpha-weighted square average.

The Eyedropper keeps the latest click or manual foreground choice when earlier color reads finish late. Changing documents, tools, radius, available sampling support or the displayed document revision invalidates an older read, including a change away and back. Current failures remain visible; obsolete replies do not change the foreground or produce stale error messages. Sampling changes no image pixels or history.
- `paint_selection`: brush points/size/hardness/opacity and add/subtract/replace mode. Produces actual selection alpha.
- `paint_mask`: same fields plus layerId. Absent mask starts empty for add/replace, full coverage for subtract. Adjustment masks provide local, editable color painting.
- `mask_from_selection`: copies the active geometric or bitmap selection to a layer mask.
- `modify_layer_mask`: changes feather/inversion on an existing mask while retaining geometry, including transformed or bitmap masks.

Bitmap masks are internal document objects with shape `bitmap`, canvas dimensions, and flat runs `[start,length,alphaByte,...]`. At most200,000 runs; graph metadata limits still apply. Crop preserves existing feathered coverage exactly by baking it into retained alpha; resize uses nearest-neighbor and scales feathering. Feathering uses inward chamfer-distance approximation. Invalid runs or canvas mismatches are rejected on save/reopen. Public geometric mask inputs do not accept arbitrary bitmap runs; use the dedicated selection/mask commands.

Twenty-seven native blend modes are declared in `shared/blend-modes.mjs`. Dissolve uses repeatable spatial noise so preview/export/undo agree. The four nonseparable modes follow W3C compositing formulas. Adjustment layers continue to require normal blend mode.

Coordinates of editable text/vector/gradient settings belong to their source canvas. Layer transforms render after those settings. Canvas anchor manipulation is restricted when earlier layer transforms would make source and display coordinates differ; numeric source-coordinate editing remains available.


## Named selection library

Open the native **Select** inspector tab, or choose **Saved selections** in the selection options bar. Save the active selection with an optional name; the library holds up to 16 entries per document. Loading makes an independent editable copy. Refine that active copy on the canvas, then choose **Update from active selection** to replace the saved mask without changing its ID. Rename and delete operate on the selected library entry. All changes are undoable and preserve revision guards.

| Command | Arguments beyond document/revision | Behavior |
| --- | --- | --- |
| `save_selection` | `name?`, `selectionId?` | Requires an active selection. Omit the ID to create an entry; supply it to replace an existing mask, retaining its name unless provided. Overwriting remains available at the 16-entry limit. |
| `load_selection` | `selectionId`, `mode?:'replace'\|'add'\|'subtract'\|'intersect'` | Default replace. Add uses maximum coverage; intersect/subtract use multiplied alpha coverage. Subtract/intersect require an existing active selection. |
| `rename_selection` | `selectionId`, `name` | Changes the saved name without changing mask coverage. |
| `delete_selection` | `selectionId` | Removes the library entry without clearing the active selection. |

`document.savedSelections` contains `{id,name,mask}` entries. Crop, resize and canvas-bound changes transform saved masks with the document. Saved selections persist through history, reopening and portable project transfer. They are reusable masks, not editable color/spot channels or a claim of Photoshop-identical selection math.

## Align and distribute layers

In **Layers**, choose **Select layers** and check content layers. Arrangement permits nonadjacent layers and neutral nested leaves; the separate **Group selected** action still requires consecutive direct siblings.

- `align_layers {layerIds,axis:'horizontal'|'vertical',alignment:'start'|'center'|'end',relativeTo?:'canvas'|'layers'}`: canvas is the default and supports one or more layers. Selected-layer bounds require at least two. The six UI actions are Left/Center/Right and Top/Middle/Bottom.
- `distribute_layers {layerIds,axis:'horizontal'|'vertical',spacing?:'gaps'|'centers'}`: requires at least three layers; equal gaps is the default. Sorting uses center position with document order for ties. The outer layers remain fixed.

Eligible targets are visible, nonempty content leaves without an additional layer mask. Parent groups must be pass-through, visible, fully opaque and unmasked. Groups and adjustments are unsupported targets. Protected content and intrinsic source-alpha cutouts remain eligible. The UI explains rejected target classes; the native engine validates actual alpha bounds and rejects unsafe results atomically.

Bounds come from the isolated current content alpha after geometry and layer opacity, excluding decorations and occlusion by other layers. Operations translate by integer pixels without stretching or rasterizing editable content. Center alignment rounds within half a pixel; equal-gap intervals can differ by one pixel. Negative gaps or moved content bounds outside the canvas reject. Decorations can still clip at canvas edges. Each operation is one undo step and is also available inside a transaction.

## Portable editable projects

Use **File → Download project**, or **Export → Editable project**, to download a `.prism` file. **File → Open project** imports it as a new native document; dropping a `.prism` file on the workspace also opens it. **Save locally** / ⌘S retains the existing local-save action.

The project choice explicitly lists current editable layers, groups, masks, saved selections, and original/working/alpha image assets. Undo history, generation jobs and credentials are omitted. Import preserves internal layer/selection IDs but assigns a new document ID, revision 1 and one fresh history entry. Existing projects remain intact. This is Prism's native interchange format; [bounded PSD import](PSD_IMPORT.md) and [limited PSD export](PSD_EXPORT.md) accept declared raster subsets. General PSD/PSB interchange and layered TIFF remain unsupported.

The UI appears only when the native backend advertises `projectFormats:['prism']`. Binary transfer uses the existing authenticated companion session:

- `GET /api/projects/:documentId/export?expectedRevision=N` downloads `application/x-prism-project` with an attachment filename. It leaves the editable project and history unchanged.
- `POST /api/projects/import` sends the raw file with that MIME type and a stable `X-Prism-Request-Id`. Optional query `name` renames the imported document. The response contains `{document,historyIncluded:false}`.

A failed browser import offers **Retry project import**, retaining the exact File and request ID. A lost successful response therefore recovers the same imported document within the companion session. Selecting a file again starts a new import. Current limits are 256 MiB per bundle, 128 MiB per asset and 16 MiB metadata; these are admission bounds, not measured transfer performance targets. Invalid input or incomplete transfer leaves existing projects unchanged.

## Verification

The earlier 141-test professional increment is a historical baseline, not the current full-suite count. Feature results are tracked separately in [implementation status](IMPLEMENTATION_STATUS.md).

| Browser suite | Verified scope |
| --- | --- |
| `npm run test:browser` | Import, editable adjustments/text, undo, selection recovery, local save, image export, compact layout and optional connection UI. |
| `npm run test:browser:pro` | Eight real tool journeys, including paint pixels, masks, raster tools, editable vectors/gradients, levels/curves and capability gating. |
| `npm run test:saved-selection-browser` | Three selection-library workflows; exact add/subtract/intersect mask pixels, copied masks, update/rename/delete, undo and reopen. |
| `npm run test:project-bundle-browser` | Four actual binary-transfer workflows; editable graph/assets/pixels, independent edits, fresh history, lost-response recovery and invalid-file preservation. |
| `node tests/arrangement-browser.mjs` | Four arrangement workflows; six alignments, both spacing modes/axes, exact source content including alpha 1/128, eligibility, undo, reopen and compact layout. |
| `node tests/layer-filters-browser.mjs` | Four filter workflows; execution-order pixels, exact alpha, editable values/curves/levels, protection and asset-operation guards, undo, duplicate, source preservation and reopen. |
| `node tests/morphology-browser.mjs` | Three edge-editing workflows; all four operations on selection/protected layer masks match an independent pixel oracle, with unchanged RGB/source assets, saved-mask independence, undo and reopen. |

`npm run build` passes. These browser fixtures use isolated companion directories and actual UI gestures. They make no paid provider requests; feature reports and inspected screenshots are in `test-results/`. Simulated optional bridge checks do not establish live Photoshop-host behavior, and host validation is not a dependency for native development.

## Move selected content

Press **V**, select a visible content layer, and drag on the canvas. The guide shows integer translation bounds; the rendered image updates after release as one undoable transform. Original pixels, filters and protected status remain intact. Additional layer masks remain anchored to the document. Groups, adjustments and empty visible content cannot be dragged. Escape, pointer cancellation or changing the document/layer/tool cancels the gesture. A stale document revision rejects the edit; inspect the refreshed state before dragging again.

Browser checks cover exact alpha-1/128 pixels, undo, cancellation, delayed bounds reads, revision conflicts and compact layout through `npm run test:move-browser`.

## Layer Fill

Content layers expose separate Overall Opacity and Fill percentages in the Layers panel. Fill uses a precise local draft with explicit Apply/Enter, local Reset to 100%, and Reload saved Fill after conflicting document changes. Fill fades the body; overall Opacity also fades outside styles. Protected layers and clipping participants explain why their saved value is read-only. Source images remain editable and unchanged. See [Fill controls, source/display semantics, reuse and MCP](LAYER_FILL.md); full acceptance is tracked there.

## Reusable outside styles

The Layers panel library saves up to 32 document-local outline/shadow/glow combinations, with overwrite, rename, delete and atomic application to selected content layers. Missing preset settings clear the corresponding target settings. Presets remain independent after application and travel with `.prism` projects. See [controls, copy semantics and MCP commands](LAYER_STYLES.md).

## Isolated group blending

Select a group and choose Group compositing: Pass through or an isolated blend. Isolation confines internal adjustments to the group content, then applies its blend, opacity and mask to the completed result. Protected descendants guard changes to mode and isolation context. See [group behavior, restrictions and MCP](GROUP_COMPOSITING.md).


## Rulers, guides and snapping

Open **Layout** in the canvas footer to add, move or delete horizontal and vertical document guides. Pixel rulers and guide lines are view overlays. Optional Move snapping uses a six-screen-pixel threshold at any zoom, with Alt/Option bypass and whole-pixel placement. Undo and project transfer retain guide edits; rendered exports and AI inputs contain no guide pixels. See [guide controls, geometry behavior and restrictions](GUIDES.md).


## Editable clipping chains

Check consecutive content layers in Layers: the lowest becomes the base, and the upper layers fill its silhouette. Text, shapes, masks and source filters stay editable; soft base alpha applies once. Release from any selected participant to restore ordinary stacking. Protected participants, generated bases and upper outside styles are unsupported. Whole-chain groups can move or duplicate; partial structural edits require release. See [clipping controls and MCP](CLIPPING.md).


## Reuse layer transparency and masks

In **Select → From a layer**, choose Content transparency or an existing Layer mask. Mask coverage can include or ignore density while retaining feather/inversion. Replace/add/subtract/intersect and source inversion preserve soft coverage. This works without segmentation and leaves source pixels untouched. Empty results remain active empty selections. See [the source and combination contract](LAYER_SELECTIONS.md).


## Inspect mask coverage

Use **Inspect coverage** beside an active selection or existing additional layer mask to open its grayscale image. White is full coverage, black none, gray partial. The read includes feather/inversion/clipping and optionally density, with no source-image reads or editing. Revision-bound previews and explicit Refresh prevent stale images from following another target. See [mask inspection controls and MCP](MASK_INSPECTION.md).

## Separate repair layers

Clone and healing brushes expose Current layer, Current & below and All layers sampling, plus adjustment-layer skipping. **Create repair layer** inserts above the selected root raster and selects the disclosed Current & below/ignore preset after success. It preserves source filters and original assets. Scope changes, source reset, view changes and stale revisions cancel unfinished strokes. Five browser workflows plus capture/gesture regressions pass. See [controls, MCP and limits](RETOUCH_SAMPLING.md).

**Aligned** retains the source-minus-first-destination offset across accepted Clone/Heal strokes. It defaults off, preserving restart sampling. A moving source crosshair uses the actual captured coordinates without clamping; off-canvas centers may still partially sample border pixels. The session survives its own accepted revisions and resets after unrelated edits or context changes. Eight independent native/session tests and 25 browser workflows cover pixels, cancellation, delayed results, failures and source preservation. See [Aligned controls and explicit MCP source points](CLONE_ALIGNMENT.md).

## Reusable edit recipes

Open **Recipes** from Layers to save current layer settings, import/export definitions, choose explicit targets and validate an ordered edit before applying it as one undo step. Supported steps append raster filters, update existing adjustments, style text and replace outside effects/outlines. No text content, positions, masks or protection settings are captured. Definitions remain independent of applied edits and travel with `.prism` files. Five browser workflows cover exact pixels, three-document transfer, revision changes and lost-response recovery. See [controls and MCP](EDIT_RECIPES.md).

## Independent mask position

Set X/Y in the layer-mask inspector to move its coverage while image pixels stay fixed. The retained mask frame preserves off-canvas coverage across position-only moves. **Rasterize mask position** explicitly converts current coverage to an8-bit canvas mask; density remains editable and Undo restores the frame. Painting/reshaping perform that conversion as part of their edit. Resize offers a per-layer review list and preserves entered dimensions until you explicitly finish. Eight focused browser workflows and four adjacent suites pass. See [geometry, precision and MCP](MASK_POSITION.md).


## Color Balance and Black & White

The Color workbench and Layer filters share typed controls for the three Color Balance tone ranges and six Black & White hue mixes, with retained tint settings. Draft resets do not write until Apply; invalid numeric drafts cannot be submitted. Both kinds use scalar `value:0` and complete canonical parameters in saved recipes. Source files, alpha and protected pixels retain ordinary editor guarantees. See [the controls, exact ranges and workload limits](TONAL_COLOR.md).


## Image resampling

**Image → Scale image** supports Nearest neighbor, Cubic, Mitchell and Lanczos 3. The native default is unchanged. `resize_document {width,height,resample?}` adds the chosen image-geometry stage without rewriting originals; omitted or explicit `lanczos3` keeps the legacy record. Nearest copies pixel-center RGBA exactly at its stage. The three photographic methods use their named reduction kernels and cubic enlargement. Additional masks and selections keep their established independent resize rules.

The UI keeps dimension text and method choice while reviewing positioned masks. A missing capability list preserves the legacy omission-only request; withdrawn or malformed support never silently replaces a choice. Canvas bounds remains separate and never sends `resample`. A valid resize can finish on the same document after its dialog closes, but an old response cannot close a newer dialog or overwrite another document. See [method semantics, protection and limits](RESAMPLING.md).

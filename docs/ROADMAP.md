# Standalone Photoshop-class editor

The target is a complete independent editor, with AI assistance through MCP. Photoshop installation, Adobe licensing and the optional legacy bridge are not prerequisites or roadmap gates. Feature parity means implementing and testing editing behavior in Prism's own engine. The [feature-family matrix](FEATURE_PARITY.md) covers substantially more than the 71 toolbar references.

## Working foundation

Prism already has a native layer graph, immutable original assets, autosave, reversible history, atomic transactions, revision checks, image import/export, editable text, vector shapes and paths, gradients, masks, selections, 27 blend modes, 13 painting/retouching tools, editable color adjustments, levels/curves and histograms. Browser controls and MCP share schema-validated commands.

The AI workflow includes local alpha-only extraction, protected subjects, proportional placement, outside outlines, brush/selection repairs, original and mask inspection, exact canvas expansion, and durable image-generation/edit jobs with local hard masks. A real MCP/local-model run verifies extraction, preservation, inspection, undo and export. Default generation returns an image made with this Codex conversation's built-in tool through a durable handoff; one actual generated background has completed that round trip. The optional API route has separate billing and quota; ordinary editing and local extraction work independently.

Editable outside shadows/glows, additional adjustment operations, pass-through/isolated nested groups, saved selections, integer alignment/distribution and portable editable project files have been implemented and tested. Editable per-raster filter stacks, selection/mask morphology, the bounded preview cache, selected-layer Move gestures reusable outside-style presets, pixel rulers/guides and Move snapping are also verified. Channel Mixer, Gradient Map and additional layer-mask density have native, MCP, independent pixel and browser verification. Bounded editable clipping chains preserve soft alpha, support content bases/members and retain original source assets. A strict layered PSD export subset has native/MCP and independent decoder verification; three browser workflows pass. Bounded PSD import now accepts RGB8 flat raster layers and simple masks, retains the original archive through portable transfers and verifies raw/PackBits files from an independent producer. Five import browser workflows and project/export regressions pass. Selections from content transparency and additional masks now pass native, MCP, independent pixel and browser checks, including density, empty results and unchanged source assets. Their acceptance gates include source retention, protected pixels, transforms, opacity, undo and project reopening.

Read-only grayscale mask inspection and whole-layer tracking/leading also have native, independent pixel, MCP and browser verification. Independent additional-mask positioning now retains source coverage across position-only moves, supports exact crop and explicit canvas rasterization, and passes23 new backend/schema/MCP checks and22 browser workflows. Source-sized buffer preflight covers retained masks after crop, intermediate transactions and PSD preparation. A separate autumn title project demonstrates editable typography on the generated background, with source bytes and untouched background pixels retained.

Color Balance and Black & White/tint extend the photographic controls through the same adjustment, filter and recipe paths. Their native encoded-sRGB algorithms retain source alpha and protected pixels; [precision and workload limits](TONAL_COLOR.md) are explicit.

Explicit [filter baking](FILTER_BAKING.md) now connects editable treatments to ordinary pixel editing. Bake preserves the current composite and original source files; Clear removes the treatment. Native/MCP rollback and pixel checks plus six focused browser workflows verify the distinction.

Selectable [image resampling](RESAMPLING.md) now includes exact pixel-center Nearest neighbor and three photographic reduction methods, with legacy default compatibility and unchanged mask/selection/protection rules. Twenty-one backend/schema/MCP checks, eight focused browser workflows and twelve adjacent canvas/mask workflows pass.

[Source Gaussian Blur and RGB Sharpen](SOURCE_SPATIAL_FILTERS.md) extend editable stacks to 24 kinds. Alpha-weighted source neighborhoods preserve cutout silhouettes, and their cache/work admission also covers explicit baking. Twenty-one backend/schema/MCP checks, eight focused browser workflows and 23 adjacent filter/tonal/recipe/bake workflows pass.

The distinct [Unsharp Mask](UNSHARP_MASK.md) brought the stack to25 kinds, adding Amount, sigma and strict per-RGB-channel Threshold controls with exact rounding and preserved transparency. Another21 backend/schema/MCP checks and39 browser workflows pass; that milestone passed814 tests. Its compact controls, saved recipes and explicit baking retain the same source-protection and history guarantees.

[Repeatable Add Noise](ADD_NOISE.md) brings source stacks to 26 kinds with Uniform/Gaussian, monochromatic/color and saved pattern seeds. Another 21 backend/schema/MCP checks and 47 browser workflows pass; the full suite now has 835 passing tests. Alpha, original assets and recipe/reopen repeatability are independently verified.

[Individual filter blending](FILTER_BLENDING.md) adds 26 RGB choices across the existing source families, exact rational boundaries, canonical Normal compatibility and precise fractional opacity display. Twenty-one backend/schema/MCP checks and 55 browser workflows pass; full regression reached 856 tests. A subsequent strict MCP input correction brings the suite to 857, with unsupported options rejected before side effects.

[Editable High Pass](HIGH_PASS.md) extends source discovery to 27 kinds. Its gray-centered detail map, explicit Overlay/Soft Light blending, exact residual and zero-sigma behavior have 21 new backend/schema/MCP checks and 63 passing browser workflows. That milestone passed 878 tests.

[Local Shadows / Highlights](LOCAL_SHADOWS_HIGHLIGHTS.md) extends source discovery to 28 kinds while retaining 24 global adjustment kinds. Its independent Amounts, Tonal widths and neighborhood sigma preserve alpha and feed the existing blending, effect-mask and Bake pipeline. Twenty focused backend/schema/MCP checks and 79 browser workflows pass. Acceptance also found and fixed an execution-dependent legacy Shadows/Highlights dispatch defect; three additional regression tests bring the full checkpoint to 933 tests.

[Filter effect masks](FILTER_EFFECT_MASKS.md) add source-space coverage over a complete filter stack without changing layer transparency. Native/schema/MCP verification adds 24 checks; full regression passes 902 tests and the UI passes 50 focused/adjacent browser workflows. Exact integer-copy selection capture, source-frame inspection, scoped recipe append, masked Bake and portable persistence are verified.

[Aligned Clone/Heal](CLONE_ALIGNMENT.md) now keeps sampling offsets across accepted strokes without changing the native pixel API. Eight independent native/session checks and 25 browser workflows cover exact source mapping, cancellation, delayed results, protected writes and actual photo edits. The adjacent Eyedropper ownership fix passes five focused and eight professional-tool browser workflows. Full regression reaches 910 tests.

[Four-corner Distort](DISTORT.md) adds editable fixed-frame projective geometry for all six content types, historical-stage edits and numeric/canvas controls. Twenty-four new native/schema/MCP checks bring the full regression to 957 tests; 59 focused/adjacent browser workflows and the build pass. Combined preread resource admission, masks, protected content, portable state and PSD fallback are independently verified. Linked Perspective is now implemented in the milestone below; mesh Warp and Liquify remain future work.

[Smooth Curves](SMOOTH_CURVES.md) adds an explicit native interpolation option to existing global/source Curves without changing default Linear pixels or records. Twenty-two native/schema/MCP checks, three pure-client checks and59 browser workflows pass. Two separate global-yield tests verify responsive batches and ordered exports; the integrated full suite reaches984 tests. Keyboard point insertion and the final Distort accessibility follow-up pass16 focused browser workflows. The subsequent Selective Color milestone is complete.

## 1. Complete the compositing foundation

Build on pass-through/isolated groups, alignment/distribution and reusable styles and content clipping chains with clipped groups/adjustments, linked layers, lock controls and richer layer effects. Introduce explicit graph invariants before exposing new relationships. Migrate older projects automatically without changing rendered pixels.

Acceptance: nested-opacity/blend fixtures match documented math; group edits undo atomically; child IDs survive regrouping; clipping remains correct after reordering; source preservation and generation protection remain true throughout the hierarchy.

## 2. Nondestructive documents and advanced tools

Implement embedded/linked document objects, extend editable filter stacks with additional raster filters and individual-entry masks, and add advanced selection refinement, pen/path operations, linked perspective gestures and mesh/warp transforms, brush presets/textures, paragraph/mixed-style typography and reusable layout tools. Explicit clone/heal sampling and a repair-layer action are now verified, retaining legacy sampling and protected writes. Develop restoration and object removal as separately evaluated local/model-backed features.

Acceptance: changing a source updates dependent instances without flattening; filters remain reorderable and reversible; transforms are bounded and reproduce saved output; damaged/missing links have explicit recovery states. Never claim Adobe-specific algorithm identity.

## 3. Professional color and large documents

Replace full-frame rendering with tiled surfaces, multiresolution previews, caches and bounded disk-backed memory. Add 16/32-bit working data, explicit ICC transforms, channels, soft proofing, HDR and CMYK as supported workflows. Build RAW development, lens correction and camera-profile support on evaluated libraries and fixtures.

Acceptance: measured memory ceilings on large documents; preview/export color matching; documented precision errors; meaningful high-depth and gamut tests; responsive cancellation and recovery under memory pressure.

## 4. File compatibility

Extend the implemented narrow PSD import/export subsets toward staged PSD/PSB interchange, retaining original files and identifying unsupported features. The implemented `.prism` portable format already retains current editable layers and exact assets; extend its versioned migration as the graph grows. Define which blend modes, masks, text, effects and embedded documents survive external-format round trips, and use explicit rendered fallbacks where structure cannot be preserved.

Acceptance: documented import/export fixtures from independent editors, lossless original retention, safe handling of malformed files and large dimensions, and transparent compatibility reports. A flattened preview alone is not a successful layered round trip.

## 5. Automation and professional workflow

Reusable edit recipes now save typed filter, adjustment, typography and outside-style steps with explicit bindings, metadata validation and atomic replay. Definitions can move between documents; five browser workflows verify recovery and one-step Undo. See [the supported recipe subset](EDIT_RECIPES.md). Next add recordable actions, parameter overrides, batch processing, workspace customization, plugin APIs, asset management and export recipes. Keep the assistant connected to real document observations and typed operations. Long-running native work should use inspectable cancellable jobs, as generation already does.

Acceptance: a recorded workflow can replay on fixtures through both UI and MCP; retries do not duplicate destructive work; failures identify completed steps; batch operations preserve originals and produce auditable outputs.

## Shared release gates

1. Every advertised feature has a real native implementation and observable result.
2. Unsupported options fail explicitly before changing saved document state.
3. Protected source RGB and untouched mask regions remain unchanged.
4. Edits and grouped plans undo/redo reliably and survive reopening.
5. Manual UI edits invalidate stale assistant revisions.
6. Renderer limits, color precision and performance are measured on documented fixtures.
7. UI and MCP exercise the same supported operations.
8. Real-model quality and real-provider success are reported separately from injected tests.

## Parallel implementation roles

Five specialist roles work in overlapping waves: native rendering/compositing; filters and pixel algorithms; interface and interaction; MCP/workflow integration; independent research and correctness review. The primary agent integrates shared contracts and cross-feature tests. The environment allows three worker agents alongside the primary, so tasks rotate through those slots without concurrent ownership of the same files.


[Selective Color](SELECTIVE_COLOR.md) adds nine retained CMYK-style ranges and Relative/Absolute correction to global adjustments and source filters, bringing discovery to25/29 kinds. Thirty native/independent/schema/MCP checks, two client helper checks and67 browser workflows pass; full regression reaches1016 tests. Precise hidden drafts, read-only inspection, recipes, scoped Bake and original-source retention are verified.

[Targeted Hue / Saturation](TARGETED_HSL.md) now adds seven retained ranges to global and source editing, bringing discovery to26/30 kinds. Thirty new integrated checks and75 browser workflows pass; full regression reaches1046. Independent native-order photo references, exact drafts, source masks/Bake, recipes and stale-response handling are verified.

[Independent Curves banks](CURVES_BANKS.md) are complete. Four editable curves share one entry, with explicit representation transitions, Master-byte/component-byte composition and bounded private table storage. Thirty new integrated checks and 83 browser workflows pass; the full regression reaches 1,076 tests. Kind/command counts remain unchanged.

The [next-workflow reassessment](NEXT_PRO_WORKFLOW_REASSESSMENT.md) recommended bounded imported 3D LUTs with original typed assets, serial asynchronous preparation and explicit recipe-dependency limits; that feature is now completed below. General continuous channel selections first need a storage redesign: the [measured channel evaluation](CHANNEL_WORKFLOW_EVALUATION.md) exceeds the current exact run-length limit even on a modest photograph. Existing budgets remain unchanged.


[Imported Color Lookup](COLOR_LOOKUP.md) is complete with strict 3D `.cube` import/replacement in global and source scopes, immutable original typed assets, explicit encoded-sRGB interpretation and bounded native trilinear evaluation. Thirty-three new integrated checks bring the full regression to1,109;91 browser workflows and the build pass. Discovery reaches100 native commands,27 global and31 source kinds. Lookup recipes remain explicitly unsupported while ordinary recipes can retain existing lookups.

[Photo Filter](PHOTO_FILTER.md) is implemented with custom color, density and optional encoded-luma preservation using independently verified exact byte arithmetic. Its full1,140-test checkpoint,99 focused/adjacent browser workflows and the production build pass. Discovery is28 global and32 source kinds, with100 commands.

[Detailed masks and composite-channel selections](DENSE_MASKS.md) are complete. Exact framed alpha8 storage retains photographic coverage beyond the old run-length ceiling; Red/Green/Blue/luma/Alpha preview and loading use the final visible composite. All mask consumers, history, rollback, typed ownership and joint resource admission are integrated. Thirty-seven new checks bring full regression to1,177;88 focused/adjacent browser workflows and the build pass. Discovery reaches102 commands, with unchanged28 global/32 source kinds. Layer Fill followed this milestone and is recorded below.


[Layer Fill](LAYER_FILL.md) is complete. Independent content opacity retains outside decoration, raw source data and precise values across all six content types, with explicit protected/clipping/PSD boundaries. Twenty-nine new checks bring full regression to1,206;67 focused/adjacent browser workflows and the build pass. Discovery reaches103 commands, with unchanged28 global/32 source kinds. Linked horizontal/vertical Perspective authoring followed this milestone.


[Linked Perspective](LINKED_PERSPECTIVE.md) is complete. Horizontal/vertical paired drags and numeric deltas reuse existing Distort stages, commands and sampling. Twelve new helper/native/independent/client/MCP checks bring the full regression to1,218;67 focused/adjacent browser workflows and the production build pass. Source and browser review cover exact captured baselines, historical stages, pending-delta recovery and asynchronous ownership. Discovery remains103 commands and28 global/32 source kinds. Color Range selection is now implemented for manual testing; final browser and full integrated acceptance remain pending.

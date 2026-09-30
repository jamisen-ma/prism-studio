import { PHOTO_FILTER_POLICY, normalizePhotoFilterParameters, mergePhotoFilterParameters } from './photo-filter.mjs';
import { COLOR_LOOKUP_POLICY, COLOR_LOOKUP_FORMATS, COLOR_LOOKUP_INPUT_SPACES, COLOR_LOOKUP_LIMITS, normalizeColorLookupParameters, mergeColorLookupParameters, colorLookupBase64Bytes } from '../shared/color-lookup.mjs';
import { parseColorLookupBytes, validateColorLookupBytes, prepareColorLookup } from './color-lookup.mjs';
import { projectAssetUses, validateColorLookupHistory, denseMaskHistoryAssets, hasColorLookup } from './lookup-assets.mjs';
import { DENSE_MASK_POLICY, DENSE_MASK_LIMITS, CHANNEL_SELECTION_POLICY, CHANNEL_SELECTION_CHANNELS, CHANNEL_PREVIEW_LIMITS, normalizeDenseMaskDescriptor } from '../shared/dense-mask.mjs';
import { combineMaskAlpha, prepareMaskCoverage, prepareLayerMaskCoverage, prepareRawLayerMaskCoverage, withMaskPreparationBudget, validateDenseMaskFrame, encodeMaskAlpha, materializeMaskAlpha, isByteMask, isDenseMask } from './dense-mask.mjs';
import { hasDenseMasks, validateDenseMaskResources, validateDenseMaskOperation, assertDenseMaskBudget, maskBufferBytes, maskPreparationWork, protectedMaskPreparationWork, additionalMaskWork } from './dense-mask-resources.mjs';
import { COLOR_RANGE_POLICY, COLOR_RANGE_LIMITS, COLOR_RANGE_PREVIEW_LIMITS, normalizeColorRangeSettings } from '../shared/color-range.mjs';
import { materializeColorRangeSelection, renderColorRangePreview, colorRangeComparisonWork } from './color-range.mjs';
import { materializeChannelSelection, renderChannelPreview, normalizeChannelOptions, materializeSavedCombination, materializeMorphology, materializePaintMask, materializeTransformedByteMask } from './mask-operations.mjs';
import { validateColorLookupResources, validateColorLookupGlobalBytes } from './color-lookup-resources.mjs';
import fs from 'node:fs/promises';
import { constants as FS_CONSTANTS } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import sharp from 'sharp';
import { CURVES_INTERPOLATION_POLICY, CURVES_INTERPOLATION_MODES } from '../shared/smooth-curves.mjs';
import { CURVES_BANKS_POLICY, CURVES_BANK_NAMES } from '../shared/curves-banks.mjs';
import { ADJUSTMENTS, PARAMETERIZED_ADJUSTMENTS, COLOR_MAPPING_KINDS, normalizeParameters, mergeCurvesParameters, adjustmentTransform, colorTransformYieldRows } from './color.mjs';
import { normalizeMask, maskCoverage, transformMask, bitmapMask } from './masks.mjs';
import { layerMaskCoverage, rawLayerMaskCoverage, validateAdditionalLayerMask, layerMaskSource, positionedLayerMask, layerMaskStorageBytes, setLayerMaskPosition, transformPositionedMask, sampleLayerMaskAlpha, LAYER_MASK_PROPERTIES, LAYER_MASK_POSITION_COMMANDS, LAYER_MASK_POSITION_OPERATIONS, LAYER_MASK_POSITION_LIMITS } from './layer-mask.mjs';
import { loadLayerSelection, encodeSelectionAlpha, LAYER_SELECTION_SOURCES, LAYER_SELECTION_MASK_MODES, LAYER_SELECTION_CONTENT_TYPES, LAYER_SELECTION_LIMITS } from './layer-selection.mjs';
import { renderMaskPreview, maskPreviewDimensions, MASK_PREVIEW_SOURCES, MASK_PREVIEW_MASK_MODES, MASK_PREVIEW_LIMITS } from './mask-preview.mjs';
import { applyStroke } from './retouch.mjs';
import { RETOUCH_SAMPLE_MODES, RETOUCH_SAMPLING_TOOLS, normalizeRetouchSampling, retouchRoot, frozenRetouchSample } from './retouch-sampling.mjs';
import { normalizeShape, normalizePath, normalizeGradient, vectorSvg, gradientPixels } from './vector.mjs';
import { selectColor, selectColorAlpha, fillPixels, sampleColor, paintSelection } from './raster-ops.mjs';
import { BLEND_MODES as BLENDS, blendRGB, dissolveAlpha } from './blend.mjs';
import { combineAlpha, alphaBounds, outsideOutline } from './cutout-pixels.mjs';
import { FONT_FAMILIES } from '../shared/fonts.mjs';
import { normalizeTextSpacing, textLineBaseline, textTrackingAttribute, TEXT_SPACING_PROPERTIES, TEXT_TRACKING_UNITS, TEXT_LEADING_UNITS } from './text-spacing.mjs';
import { ensureBundledFonts } from './fonts.mjs';
import { canvasTransform, resizeCanvasPixels, resizeCanvasMask } from './canvas.mjs';
import { DOCUMENT_RESIZE_METHODS, DOCUMENT_RESIZE_DEFAULT, normalizeDocumentResizeMethod, normalizeResampleTransform, resamplePixels } from './resampling.mjs';
import { DISTORT_POLICY, DISTORT_COORDINATES, DISTORT_CONTENT_TYPES, DISTORT_COMMANDS, DISTORT_LIMITS, normalizeDistortCorners, normalizeDistort, createDistort, distortPixels } from './distort.mjs';
import { hasDistort, validateDistortResources } from './distort-resources.mjs';
import { normalizeEffects, renderOutsideEffects } from './layer-effects.mjs';
import { LAYER_FILL_POLICY, LAYER_FILL_CONTENT_TYPES, normalizeLayerFillOpacity, layerFillOpacity, layerOutsideEffects, setLayerFillOpacity, setLayerOutsideEffects, projectLayerFill } from './layer-fill.mjs';
import { spatialAdjustment } from './adjustment-filters.mjs';
import { layerTree, subtree, ancestors, flattenTree, containsProtected, protectedIsolationScopes, assertProtectedIsolationUnchanged, validateGroupResources, mixGroup, MAX_GROUP_DEPTH, MAX_GROUP_SCRATCH_BYTES } from './groups.mjs';
import { SAVED_SELECTION_COMMANDS, MAX_SAVED_SELECTIONS, validateSavedSelections, mutateSavedSelection } from './saved-selections.mjs';
import { LAYER_STYLE_COMMANDS, LAYER_STYLE_PROPERTIES, MAX_LAYER_STYLES, validateLayerStyles, updatedLayerStyles } from './layer-styles.mjs';
import { GUIDE_COMMANDS, GUIDE_AXES, MAX_GUIDES, validateGuides, updatedGuides, transformGuides } from './guides.mjs';
import { CLIPPING_LAYER_TYPES, CLIPPING_BLEND_POLICY, clippingIndex, changedClippingLayers, assertNoClipping, blendClippingInterior, clipMemberContribution } from './clipping.mjs';
import { encodeProjectBundle, decodeProjectBundle, PROJECT_BUNDLE_LIMITS } from './project-bundle.mjs';
import { planAlignment, planDistribution } from './arrangement.mjs';
import { MORPHOLOGY_COMMANDS, MORPHOLOGY_OPERATIONS, mutateMorphology } from './morphology-commands.mjs';
import { PreviewCache, PREVIEW_CACHE_LIMITS } from './preview-cache.mjs';
import { inspectNativePsd, exportNativePsd } from './psd-native.mjs';
import { PSD_EXPORT_LIMITS } from './psd-export.mjs';
import { PsdImportPool } from './psd-import-pool.mjs';
import { PSD_IMPORT_LIMITS } from './psd-import.mjs';
import { safePsdFilename, validateSourceDocument, validateSourceDocumentBytes } from './source-document.mjs';
import { PSD_IMPORT_VERSION, PSD_IMPORT_SUBSET, PSD_ARCHIVE_MIME, psdImportFingerprint } from '../shared/psd-import.mjs';
import { LAYER_FILTER_KINDS, LAYER_FILTER_COMMANDS, MAX_FILTERS_PER_LAYER, MAX_FILTERS_PER_DOCUMENT, MAX_FILTER_WORK, hasActiveFilters, editedFilterStack, validateLayerFilterResources, applyLayerFilters } from './layer-filters.mjs';
import { LAYER_FILTER_BLEND_MODES, LAYER_FILTER_BLEND_POLICY } from './filter-blend.mjs';
import { FILTER_BAKE_LIMITS, planFilterBake, bakeFilterSource } from './filter-bake.mjs';
import { FILTER_MASK_POLICY, FILTER_MASK_COMMANDS, FILTER_MASK_SOURCES, FILTER_MASK_SHAPES, FILTER_MASK_PROPERTIES, FILTER_MASK_CAPTURE_GEOMETRY, FILTER_MASK_LIMITS, filterEntries, storedFilterMask, editedFilterMask, captureFilterMask } from './filter-mask.mjs';
import { SOURCE_SPATIAL_POLICY, SOURCE_HIGH_PASS_POLICY } from './source-spatial-filters.mjs';
import { UNSHARP_MASK_POLICY } from './unsharp-mask.mjs';
import { SOURCE_NOISE_POLICY } from './source-noise-filters.mjs';
import { LOCAL_TONE_POLICY } from './local-tone.mjs';
import { SELECTIVE_COLOR_POLICY, SELECTIVE_COLOR_METHODS, SELECTIVE_COLOR_RANGES } from './selective-color.mjs';
import { HUE_SATURATION_POLICY, HUE_SATURATION_RANGES } from './hue-saturation.mjs';
import { openBoundedFile, readBoundedHandle } from './bounded-file.mjs';
import { validateCommand, checkColorRangeCommandArguments } from '../shared/commands.mjs';
import { EDIT_RECIPE_APIS, EDIT_RECIPE_LIBRARY_COMMANDS, EDIT_RECIPE_COMMANDS, EDIT_RECIPE_SLOT_TYPES, EDIT_RECIPE_LIMITS, normalizeEditRecipes, validateEditRecipes, findEditRecipe, editRecipeHash, updatedEditRecipes, stageEditRecipe } from './edit-recipes.mjs';

const MAX_AXIS = 8192;
const MAX_PIXELS = 24_000_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
const MAX_LAYERS = 64;
const MAX_HISTORY = 100;
const ID = /^[a-f0-9-]{36}$/;
const CACHE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const NEW_LAYER_UUID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const HASH = /^[a-f0-9]{64}$/;
const MUTATIONS = ['add_adjustment', 'set_layer', 'duplicate_layer', 'delete_layer', 'reorder_layer', 'add_text', 'crop_document', 'resize_document', 'select_rectangle', 'clear_selection', 'add_paint_layer', 'paint_stroke', 'rasterize_layer', 'update_adjustment', 'update_text', 'set_layer_mask', 'select_region', 'modify_selection', 'transform_layer', 'add_shape', 'update_shape', 'add_path', 'update_path', 'add_gradient', 'update_gradient', 'select_color', 'fill_area', 'mask_from_selection', 'paint_selection', 'paint_mask'];
MUTATIONS.push('modify_layer_mask');
MUTATIONS.push(...FILTER_MASK_COMMANDS);
MUTATIONS.push(...DISTORT_COMMANDS);
MUTATIONS.push(...LAYER_MASK_POSITION_COMMANDS);
MUTATIONS.push('load_layer_selection', 'load_channel_selection', 'load_color_range_selection');
MUTATIONS.push('resize_canvas');
MUTATIONS.push('extract_subject', 'select_subject', 'place_layer', 'set_layer_outline', 'set_layer_protection', 'paint_cutout_mask');
MUTATIONS.push('refine_cutout_from_selection');
MUTATIONS.push('set_layer_effects', 'set_layer_fill');
MUTATIONS.push('create_group', 'group_layers', 'ungroup_layer', 'move_layer');
MUTATIONS.push('set_group_compositing');
MUTATIONS.push(...SAVED_SELECTION_COMMANDS);
MUTATIONS.push('align_layers', 'distribute_layers');
MUTATIONS.push(...MORPHOLOGY_COMMANDS);
MUTATIONS.push(...LAYER_FILTER_COMMANDS);
MUTATIONS.push(...LAYER_STYLE_COMMANDS);
MUTATIONS.push(...GUIDE_COMMANDS);
MUTATIONS.push('set_clipping_chain');
MUTATIONS.push('create_repair_layer');
MUTATIONS.push('bake_layer_filters', 'import_color_lookup');
const LOOKUP_SNAPSHOT_COMMANDS = ['import_color_lookup', 'add_adjustment', 'update_adjustment', 'add_layer_filter', 'update_layer_filter'];
const containsChannelLoad = (command, args) => command === 'load_channel_selection' || command === 'apply_transaction' && args?.operations?.some(operation => operation?.command === 'load_channel_selection');
const containsLayerFillEdit = (command, args) => command === 'set_layer_fill' || command === 'apply_transaction' && args?.operations?.some(operation => operation?.command === 'set_layer_fill');
function checkDenseMaskArguments(command, args) {
  for (const operation of command === 'apply_transaction' && Array.isArray(args?.operations) ? args.operations : [{ command, args }]) {
    if (operation?.command !== 'set_layer_filter_mask' || !operation.args) continue;
    const property = Object.getOwnPropertyDescriptor(operation.args, 'mask');
    if (!property) continue;
    assert(property.enumerable && Object.hasOwn(property, 'value'), 'Source masks require an ordinary data property.');
    const mask = property.value;
    if (mask) assert(typeof mask === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(mask)), 'Source masks require a plain object.');
    const shape = mask && Object.getOwnPropertyDescriptor(mask, 'shape');
    if (shape) assert(shape.enumerable && Object.hasOwn(shape, 'value'), 'Source mask shape requires an ordinary data property.');
    if (shape?.value === 'alpha8') normalizeDenseMaskDescriptor(mask);
  }
}
// Public JSON cannot contain getters. Direct JS callers can, including inside
// a transaction whose Bake/mask step triggers an earlier Zod snapshot. Check
// this new kind before that snapshot can read or erase its property shape.
function checkPhotoFilterArgumentParameters(command, args, projects) {
  const operations = command === 'apply_transaction' ? args?.operations : [{ command, args }];
  if (!Array.isArray(operations)) return;
  for (const operation of operations) {
    if (!['add_adjustment', 'update_adjustment', 'add_layer_filter', 'update_layer_filter'].includes(operation?.command)) continue;
    const options = operation.args;
    if (!options || typeof options !== 'object') continue;
    let kind = options.kind;
    if (operation.command === 'update_adjustment' || operation.command === 'update_layer_filter') {
      const project = projects?.get(options.documentId ?? args?.documentId), graph = project?.states[project.cursor]?.graph;
      const layer = graph?.layers.find(item => item.id === options.layerId);
      kind = operation.command === 'update_adjustment' ? layer?.kind : layer && filterEntries(layer.filters).find(entry => entry.id === options.filterId)?.kind;
    }
    if (kind !== 'photo_filter') continue;
    const property = Object.getOwnPropertyDescriptor(options, 'parameters');
    if (!property) continue;
    assert(property.enumerable && Object.hasOwn(property, 'value'), 'Photo Filter parameters require an ordinary data property.');
    normalizePhotoFilterParameters(property.value);
  }
}
function containsColorLookupEdit(command, args, projects) {
  const operations = command === 'apply_transaction' ? args?.operations : [{ command, args }];
  return Array.isArray(operations) && operations.some(operation => {
    if (!LOOKUP_SNAPSHOT_COMMANDS.includes(operation?.command)) return false;
    if (operation.command === 'import_color_lookup') return true;
    const options = operation.args ?? {}, parameters = Object.getOwnPropertyDescriptor(options, 'parameters')?.value;
    if (options.kind === 'color_lookup' || parameters && typeof parameters === 'object' && ['asset', 'bytes', 'gridSize', 'inputSpace', 'sourceName', 'title'].some(key => Object.hasOwn(parameters, key))) return true;
    const project = projects?.get(options.documentId ?? args?.documentId), graph = project?.states[project.cursor]?.graph;
    const layer = graph?.layers.find(item => item.id === options.layerId);
    return layer?.kind === 'color_lookup' || operation.command === 'update_layer_filter' && layer && filterEntries(layer.filters).some(entry => entry.id === options.filterId && entry.kind === 'color_lookup');
  });
}
const containsColorLookupImport = (command, args) => command === 'import_color_lookup' || command === 'apply_transaction' && args.operations?.some(operation => operation?.command === 'import_color_lookup');
function checkLookupArgumentParameters(command, args) {
  const operations = command === 'apply_transaction' ? args.operations : [{ command, args }];
  for (const operation of operations ?? []) if (LOOKUP_SNAPSHOT_COMMANDS.includes(operation?.command)) {
    const property = Object.getOwnPropertyDescriptor(operation.args ?? {}, 'parameters');
    if (!property) continue;
    assert(property.enumerable && Object.hasOwn(property, 'value'), 'Adjustment parameters require an ordinary data property.');
    const parameters = property.value;
    if (parameters && typeof parameters === 'object' && ['asset', 'bytes', 'gridSize', 'inputSpace', 'sourceName', 'title'].some(key => Object.hasOwn(parameters, key))) normalizeColorLookupParameters(parameters);
  }
}
function validateLookupUploads(command, args) {
  const operations = command === 'apply_transaction' ? args.operations : [{ command, args }];
  let bytes = 0;
  for (const operation of operations ?? []) if (operation.command === 'import_color_lookup') bytes += colorLookupBase64Bytes(operation.args?.data);
  assert(bytes <= COLOR_LOOKUP_LIMITS.maxTransactionBytes, 'A transaction may import at most 4 MiB of Color Lookup files.', 'LIMIT_EXCEEDED');
}
const containsFilterBake = (command, args) => command === 'bake_layer_filters' || (command === 'apply_transaction' && Array.isArray(args?.operations) && args.operations.some(operation => operation?.command === 'bake_layer_filters'));
const containsFilterMaskEdit = (command, args) => FILTER_MASK_COMMANDS.includes(command) || (command === 'apply_transaction' && Array.isArray(args?.operations) && args.operations.some(operation => FILTER_MASK_COMMANDS.includes(operation?.command)));
const containsDistortEdit = (command, args) => DISTORT_COMMANDS.includes(command) || (command === 'apply_transaction' && Array.isArray(args?.operations) && args.operations.some(operation => DISTORT_COMMANDS.includes(operation?.command)));
function checkDistortArgumentCorners(command, args) {
  const operations = command === 'apply_transaction' ? args.operations : [{ command, args }];
  for (const operation of operations ?? []) if (['add_layer_distort', 'update_layer_distort'].includes(operation?.command)) {
    const descriptor = Object.getOwnPropertyDescriptor(operation.args ?? {}, 'corners');
    assert(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), 'Distort corners must be an ordinary array value.');
    normalizeDistortCorners(descriptor.value);
  }
}
const COMMANDS = ['capabilities', 'list_documents', 'get_document', 'create_document', 'import_image', 'get_preview', 'get_layer_preview', 'get_mask_preview', 'get_channel_preview', 'get_color_range_preview', 'get_histogram', 'sample_color', ...MUTATIONS, ...EDIT_RECIPE_APIS, 'apply_transaction', 'undo', 'redo', 'save_document', 'export_document'];
const LIMITATIONS = [
  'Layer Fill changes content opacity while outside outline, shadow and glow retain overall opacity and the unfilled silhouette. It supports six content types; clipping participants require Fill 100%. Existing partial Fill can be protected, then changes require explicit unprotection. Native projects retain Fill; the strict PSD subset refuses nonunit Fill. Saved styles and edit recipes preserve target Fill without capturing it. No Photoshop-specific Fill blending is claimed.',
  'Color Lookup imports original 3D .cube files (grids 2–33, at most 4 MiB) atomically into a global adjustment or source filter. Choose encoded-sRGB input/output explicitly; no log/HDR conversion or Adobe-exact interpolation is claimed. Strict Float64 red-first trilinear evaluation preserves alpha and hidden RGB, prepares each active entry without a persistent cache, and charges 32 source visits per pixel before blend/mask work. Active lookup graphs also admit combined decoded content, root/group/clipping surfaces, tables and masks within 256 MiB, excluding encoded image/codec/style internals and RSS. Per-pass preparation is limited to 32 MiB; retained history to 128 unique LUT assets and 64 MiB. Original assets transfer in Prism projects; asset-bearing edit recipes are unsupported.',
  'Local Shadows / Highlights classifies alpha-weighted source neighborhoods and applies a bounded RGB gain curve with fixed black and white endpoints. It is independent of the legacy pointwise adjustments, is not edge-aware recovery, and can produce halos. Sigma zero still performs pointwise treatment; only both amounts zero produce an identity candidate, which non-Normal blending can still change. Its Normal work weights are 16 at sigma zero, 2*(2*ceil(3*sigma)+1)+20 at positive sigma, and 1 for dual-zero amounts; non-Normal blending adds 40. The source-filter work limit remains 384 million, with separately bounded 512-entry table setup yielding every 64 entries.',
  'Four-corner Distort is an editable fixed-frame projective stage in historical pixel-edge coordinates. Clockwise convex bounded quads use native alpha-weighted bilinear sampling; exact integer moves copy RGBA. Source filters run before geometry, additional masks stay canvas-anchored, and source-mask selection capture rejects Distort. Every stage costs 16 weighted pixels, including copies, under a separate 384-million limit. Graphs containing Distort also require combined decoded source/candidate/geometry frames, root/group/clipping surfaces, bitmap callbacks and the shared noise table to fit 256 MiB, including hidden and legacy sibling content. Encoded buffers, codecs, effects and total process memory are outside that named limit. No area-prefiltering or Photoshop-exact sampling is claimed; the native project retains stages while PSD rasterizes them.',
  'Document image resize offers native pixel-center nearest RGBA copying, cubic, Mitchell and default Lanczos3. Photo reduction kernels use the installed Sharp behavior and map to cubic for enlargement. Omitted/default resize retains legacy pixels; masks, selections and guides keep their existing independent resize rules. Resizing replays each retained geometry stage, does not reflow text or scale outside-style settings, and preserves source files. New nondefault transforms require a current native reader.',
  'Bake filters fixes the current source-space RGB grade while retaining original files, separate cutout alpha, geometry and layer controls. Protected targets reject; active stacks above any earlier protected content, including hidden content, reject. Previously zero-effective-alpha pixels retain ungraded RGB if revealed later. Disabled-only stacks clear without image I/O. Baking has a 256 MiB named-buffer limit and bounded 128 MiB source inputs; temporary PNG files are checked before reading, not a total RSS or temporary-disk guarantee. Baking and enclosing transactions require an expected revision.',
  'Additional masks support independent integer positioning with retained source coverage; image content and cutout alpha remain separate. Crop translates the frame exactly; canvas-bounds edits preserve zero new padding by clipping the retained domain. Painting, morphology and Rasterize mask position convert current raw coverage to a canvas-sized alpha8 mask and discard off-canvas coverage, preserving density and Undo. Rasterize positioned masks before image resize. Retained mask callbacks join the group/clipping/filter 256 MiB named-buffer budget; this is not total process memory.',
  'Native editing and export use 8-bit sRGB; imported originals are preserved byte-for-byte. No 16-bit, HDR, CMYK or RAW editing.',
  'Dense masks use immutable framed alpha8 assets when exact coverage exceeds 200000 nonzero runs. Every native mask consumer prepares verified coverage serially; retained history permits 256 unique raw masks and 3 GiB of framed bytes, not a total disk quota. Channel selection samples the final composite with byte-alpha weighting and encoded-luma double rounding; inversion follows coverage. Named dense rendering/operation buffers are capped at 256 MiB and preparation at 384 million weighted visits. PSD import retains its existing run cap; portable current-state limits remain unchanged.',
  'PNG, JPEG, WebP and single-page TIFF import and flattened export. Strict PSD v1 export supports flat normal raster/solid layers, exact alpha8 masks/opacity and an opaque merged composite. Geometry is rasterized in the exported copy; Prism protection, originals and history remain native. Inspect the compatibility report; groups, effects, filters, text/vectors, generated clipping, fractional mask coverage and transparent final images reject. Bounded PSD v1 import supports flat normal RGB8 raster layers and simple masks with raw/PackBits channels; inspect the exact file first. PSB and broader Photoshop records are unsupported.',
  'Portable .prism bundles preserve the current editable graph and exact source/working/alpha asset bytes, but exclude undo history and generation credentials/jobs. Import creates a new document with one fresh history entry. Bundles are limited to 256 MiB total and 128 MiB per image asset; decoded images retain the native dimension and pixel limits.',
  'PSD import requires complete inspection of a file up to 64 MiB and known sRGB or an explicit untagged sRGB assumption. It accepts 1–64 flat normal RGB8 raster layers, raw/PackBits data and simple independent user masks; unsupported records, profiles, merged transparency and parameterized masks reject. An inert original PSD archive remains byte-exact through native edits and .prism transfer. Imported source rectangles remain preserved, but initial canvas clipping prevents later moves from revealing pixels originally outside the canvas. The worker has a 30-second deadline and a conservative 256 MiB accounted working-buffer cap, not a whole-process memory guarantee.',
  'Maximum 8192 pixels per axis, 24 megapixels, 32 MiB imports, 64 layers, 100 retained history states, and 16 MiB of project metadata including history.',
  'This initial renderer processes full images in memory; it is not a tiled professional rendering engine.',
  'Clipping chains contain consecutive unprotected content siblings and use grouped-base blending: members change interior color while base alpha, mask, opacity and blending apply once. Generated bases, groups/adjustments and enabled upper-member styles are unsupported. Release a chain before protecting, arranging, placing, extracting or individually moving/reordering/deleting/duplicating a participant. Complete containing groups can move or duplicate. Geometry, masks, source edits and rasterization remain editable; source-oriented subject selection excludes clipping. Base previews show the assembled chain; member previews show isolated clipped contributions without the base colors or blend backdrop. Hidden selected participants and their base/ancestors are revealed only for inspection. Chain scratch conservatively adds five bytes per canvas pixel to the shared 256 MiB group/filter budget, including hidden chains.',
  'Repeated composite PNG previews reuse a revision-and-width cache with at most 32 entries and 64 MiB of accounted encoded payload. Successful document writes invalidate that document’s entries. Exports and individual layer/source/mask previews always render or read their source independently. The cache budget is additional to rendering memory, not a whole-process memory guarantee.',
  'Nested groups support pass-through and isolated compositing, up to eight group ancestors and 64 total layer/group nodes. Isolated groups render children on transparency, scope internal adjustments, then use one of 27 blend modes with group opacity/mask applied once. Group transforms, effects, rasterization and placement are unsupported. Nonempty groups must use pass-through, be visible, unmasked and fully opaque before ungrouping.',
  'Protected descendants require fully opaque, normal-blended ancestors. Explicitly unprotect them before changing an ancestor’s compositing mode or moving them across isolated-group boundaries, including hidden descendants. Isolated, masked and translucent groups each retain five bytes per canvas pixel per ancestor, shared with editable-filter accounting under a 256 MiB scratch limit.',
  'Placing or arranging grouped content requires pass-through ancestors; placement also requires full opacity and no masks, and arrangement requires visibility. Move the layer outside an isolated group or explicitly switch its compositing before these operations. Explicit layer inspection and subject selection reveal the selected layer even when it or an ancestor is hidden.',
  'Explicit layer subject selection samples that individual unfiltered layer with its own outside styles/mask and staged ancestor opacity/masks; it excludes backdrop, sibling content and group blend context. Composite subject selection samples the actual rendered document. Layer previews render group compositing context on transparency; original/source-alpha previews remain unchanged.',
  'Up to 16 named selections retain independent editable mask copies and follow canvas geometry. Combining selections uses 8-bit alpha: maximum for add, multiplication for intersection and multiplication by the inverse for subtraction; feathering and inversion are baked into the combined bitmap.',
  'Loading a layer selection reads transformed working content alpha before additional masks, opacity, visibility, styles, filters, ancestors, clipping and display protection; groups/adjustments instead support their own additional-mask source. Raw mask loading includes feather/inversion/clipping; effective loading also includes density. Optional inversion complements quantized alpha across the whole canvas. Source sampling and combination have a conservative 256 MiB explicit-buffer cap, separate from native codec/cache/RSS; sampling, adaptive encoding and byte-mask feather preparation yield; existing affine geometry remains bounded synchronous work.',
  'Mask inspection returns opaque grayscale for an active selection or additional layer/group/adjustment mask, independently of source content and display protection. It uses nearest pixel-center sampling, never enlarges, and bounds the longest edge to 2400 pixels (700 by default). Reduced previews can miss narrow details. Raw/effective additional-mask modes control density only; source cutout alpha remains a separate layer-preview view. Each read is fresh, with an 8 MiB PNG cap and conservative 256 MiB explicit-buffer/transfer accounting, not total process RSS.',
  'Up to 64 horizontal/vertical document guides use whole-pixel positions including canvas edges. Guides follow crop, image resize and canvas offsets; out-of-bounds guides are removed reversibly. Coincident guides retain their IDs. Guides, rulers and snapping are view metadata and never enter rendered pixels, AI inputs or image/PSD exports; editable .prism projects retain guides.',
  'Selection and existing layer-mask expand, contract, border and smooth use square neighborhoods with radius 1–100 document pixels and zero outside the canvas. They retain grayscale coverage and bake existing feather/inversion/clipping into the resulting bitmap. Border spans both sides; smooth is opening then closing, which can remove narrow details. These are deterministic shape operations, not semantic edge reconstruction.',
  'Alignment/distribution moves visible content leaves by integer pixels using isolated alpha bounds after geometry and opacity, excluding outside styles and other layers’ occlusion. Canvas-anchored layer/group masks and hidden or non-unit-opacity ancestors must be removed/reset first; source cutout alpha and protected layers are supported. Distribution fixes center-sorted endpoints; integer rounding can vary spacing by one pixel. Equal gaps reject insufficient span, and all arrangements reject content clipping.',
  'Rectangle, ellipse and polygon masks support inward feathering and inversion. Ellipse feather uses normalized radial distance. Subject segmentation uses a separately installed local model; AI generation and edits run through the separate generation-job API.',
  'Additional layer, group and adjustment masks support density from zero to one after raw feather, inversion and internal clipping. Zero disables the whole additional mask, including old canvas clipping; source alpha and hard AI protection remain intact. Raw mask painting/morphology retain density, while full replacement or removal resets it. Active/saved selections and source cutout alpha have no density. Strict PSD export materializes effective mask coverage only when every alpha8 value is exact.',
  'Isolated generated-layer previews retain original-document lower protection for source and outside styles. Ordinary styled previews exclude decoration over lower protected content while leaving their source RGB independently inspectable. Original/source-alpha views remain unchanged.',
  'Image, text, shape, path and gradient layers support 27 blend modes including deterministic dissolve and hue/saturation/color/luminosity. Adjustment layers support normal blending only.',
  'Text supports editable sans-serif, serif, monospace and bundled Fraunces families with bold, italic, alignment, whole-layer tracking from -1000 to 1000 thousandths of an em, and optional line leading from 1 to 2000 source pixels. Auto leading retains the existing 1.2× font-size layout. Tracking and leading act before layer geometry; paragraph wrapping, mixed styles, pair kerning and Photoshop-equivalent shaping are unsupported.',
  'Highlights, shadows, vibrance and healing use local deterministic approximations, not Photoshop-equivalent algorithms or generative content-aware healing.',
  'Photo Filter applies an authored RGB8 filter color with density 0–100 in 0.01 increments. Its encoded-RGB transmission preserves black; optional luminosity preservation restores unrounded encoded Rec.709 luma and fits gamut through a shared reduction in chroma. Byte rounding may change that weighted luma by up to half a byte. It is not linear-light, spectral or Adobe pixel equivalence. Zero transmission with preservation returns the original RGB; density zero, white filters, and gray filters with preservation are exact identity candidates, but nonnormal source blending still applies. Source work is 16 visits per computing pixel or 1 for these identities, before blend/mask costs; no table or image cache is added. Alpha and hidden RGB remain unchanged.',
  'Hue / Saturation retains Master and six overlapping hue-family rows. Hue and Saturation target the original hue; named Lightness fades with original RGB chroma, preserving neutral colors. Saturation changes proportionally: +100 doubles and clamps it, while -100 removes it at full range influence. Master Lightness is unattenuated. The fixed native binary64 HSL conversion can differ from exact-real rounding at half ties; it is not Adobe pixel parity. Source work costs 32 visits per computing pixel or 1 for all-zero controls, before blend/mask costs: one Normal computing source fits 12 MP, or 9.6 MP with a filter-stack mask, before other limits. Alpha and hidden RGB stay unchanged; Colorize and editable range handles are not included.',
  'Selective Color uses nine exact encoded-RGB range weights with additive virtual Cyan/Magenta/Yellow/Black controls. Relative scales existing complementary RGB amounts and leaves pure white unchanged; Absolute changes percentage points. All ranges use the same original RGB and one final half-up byte rounding. This is not physical CMYK or Adobe/FFmpeg pixel parity. Source work costs 12 visits per pixel for computing settings, or 1 for all-zero controls, before blend/mask costs; nonzero cancellations retain the computing charge. Source and global paths preserve alpha and hidden RGB, with bounded pixel batches. Defaults are Relative and nine zero rows.',
  'Layer transforms use bilinear sampling, scale and rotate around the canvas center, then translate and clip to the canvas. Layer masks remain in document coordinates; canvas crop/resize transforms masks.',
  'Brush strokes are bounded to 2000 points and a finite processing budget. Raster edits create new working assets and preserve imported originals and undo history.',
  'Clone/heal defaults to a frozen all-layer sample. Current samples transformed working content and cutout alpha before display settings; Current & Below requires an unlinked root raster and includes it plus complete lower roots. Ignoring adjustments skips adjustment layers only, not source filter stacks. Full-document protection still gates every write. Repair layers insert above an explicit unlinked root raster and inherit no source settings. Existing brush/render bounds apply; the 256 MiB group/filter scratch limit is not a total retouch memory cap.',
  'Editable shape/path/gradient coordinates belong to their source canvas before layer transforms. Paths use up to 256 anchors with absolute cubic Bezier controls; no font outlines, path boolean operations or variable-width strokes.',
  'Magic Wand and bucket fill use visible-composite color tolerance and optional four-connected regions. Color Range separately measures one to eight authored RGB swatches with encoded-RGB distance, soft falloff, composite alpha and final inversion. It supports bounded grayscale preview and exact adaptive selection storage; it does not recognize semantic objects or alter the existing Magic Wand algorithm.',
  'Subject extraction changes alpha only and preserves source RGB/assets. Placement contains the complete visible alpha bounds proportionally. Outlines are outside-only render effects, clipped at canvas edges.',
  'Editable drop shadows and outer glows use masked layer alpha, bounded Gaussian blur and offsets in canvas pixels. They render outside subject pixels only, behind outlines, and clip at the canvas edge. Inner styles, bevels and Photoshop-exact layer-style parity are not implemented.',
  'Up to 32 document-local named styles save outside outline, shadow and glow settings. Applying a preset replaces both style slots on all selected content layers in one undo step; missing slots clear previous settings. Presets are independent copies, use canvas-pixel units and never copy opacity, blending, masks, filters, protection or source pixels. Saved values do not scale with document geometry.',
  'Up to 16 saved typed recipes apply at most 30 metadata edits to explicitly bound current layer IDs in one undo step: append raster filters, update a fixed-kind existing adjustment, style existing text, or set outside effects/outline. Validation is metadata-only and cannot guarantee later rendering or disk availability. Recipes never capture live selection or rewrite source assets. Applying requires the inspected document revision; intentional repeat application appends filters again. Session request retries deduplicate, while retries after restart must retain the old revision and reconcile stale results. Recipes remain native/.prism metadata, not Photoshop Actions.',
  'A shared source filter mask mixes the finished stack with original working RGB before geometry; it does not change alpha or the additional layer mask. It supports enabled, density, feather and invert, source rectangle/ellipse/bitmap authoring or verified framed alpha8 reuse and exact integer-copy selection capture. Raw/effective inspection uses retained source dimensions. Active enabled masks with positive density add eight source visits per pixel and require complete-source as well as combined renderer admission before reads. Capture has a separate 384-million work and 256 MiB buffer limit; resampled or noncopy affine selection capture is unsupported. Deleting the last filter, clearing or baking removes the shared mask; mask inspection and edits do not read RGB assets.',
  'Raster filter stacks run in listed order after source alpha and before geometry. They support 32 RGB kinds with eight entries per layer and 64 per document. Source Gaussian blur and RGB sharpen use normalized integer Gaussian sampling with exact original alpha/hidden RGB; authored sigma is in source pixels, tiny positive sigmas can quantize to identity, and sharpen is fixed amount 1/threshold 0 with entry opacity applied afterward. Source-only Unsharp Mask adds amount 0–500 percent in 0.01 increments, true sigma 0–50 and a strict per-channel threshold 0–255; its rounded candidate is mixed by entry opacity. Source-only Add Noise uses a retained unsigned32-bit seed, amount 0–400 percent in 0.01 increments, uniform or finite discrete Gaussian deviates, and optional shared RGB noise; alpha and hidden RGB stay exact. Source-only High Pass uses sigma 0–50 source pixels and rounds 128 plus the exact alpha-weighted Gaussian residual once; zero sigma produces gray 128 at positive alpha, not an identity. Its positive-sigma work/cache matches source blur, with zero sigma costing 1 and no Gaussian cache. Flat gray 128 preserves every byte under Overlay and Soft Light after rounding, while other modes can shift values. Global adjustment blur/sharpen remain legacy operations. Spatial sizes are source pixels; alpha and invisible RGB remain unchanged. Each filter supports 26 alpha-preserving RGB blend modes, excluding Dissolve, applied to its byte candidate before entry opacity. Normal keeps the existing pixel path; all other modes add 40 weighted visits per source pixel, including identity candidates (41 total, at most 9,365,853 source pixels). Identity candidates still blend and may change RGB. Nonnormal RGB loops yield within 16,384 source pixels. Entry masks are unsupported. Bake or clear any stack explicitly before paint/fill, placement, extraction or source-alpha refinement; disabled entries also block those operations. Active filters must be disabled or cleared before protecting a layer. Combined filter/group/chain scratch is limited to 256 MiB and filter work to 384 million weighted source-pixel visits, including hidden layers. Positive source blur/sharpen costs 2*(2*ceil(3*sigma)+1)+8 visits (zero costs 1), so one sigma 3 filter allows at most 8,347,826 source pixels and sigma 50 blur at most 629,508 before other limits. Unsharp Mask costs 2*(2*ceil(3*sigma)+1)+40 visits, admitting at most 7,111,111 source pixels at sigma 1 before other limits; amount 0, sigma 0 or threshold 255 costs 1 without a Gaussian cache but remains structurally active. Positive Add Noise costs 8 visits per source pixel, or 1 at amount zero. Its computing Gaussian mode reserves one shared 4 KiB table after the graph scratch peak and in every bake phase, separately from sequential spatial rings. Spatial cache joins the phase-based rendering and baking budgets. Color Balance costs 40 visits with luminosity preservation (one filter at most 9.6 MP) or 10 without; Black & White costs 7. Global adjustment layers retain the existing canvas limits.',
  'Explicit Curves banks retain independent Master, Red, Green and Blue settings. Master byte lookup runs before the component byte lookup, followed by one entry blend/opacity. Upgrade or replacement is explicit; old single records stay unchanged. Banked records require a current native reader and are not Adobe byte parity.',
  'Curves defaults to the original linear interpolation and unchanged saved metadata. Explicit Smooth uses a shape-preserving native PCHIP byte lookup with exact identity and authored integer knots, including endpoints; it is not Adobe or exact-real half-tie parity. Arbitrary finite strictly ordered point spacing is retained. Source curves preserve hidden RGB while global curves keep their established hidden-RGB grading and protection/mask rules. Smooth records require a current native reader.',
  'Channel Mixer uses independent RGB output rows or a retained monochrome row, each with red/green/blue/constant percentages from -200% to +200% in exact 0.01% increments. Integer sums clamp once after mixing. Gradient Map uses 2–16 strictly ordered RGB stops, unquantized Rec.709 tone and encoded-sRGB interpolation, with reversible direction and no opacity stops or dithering. Both parameterized kinds require value zero and preserve alpha/invisible RGB; they are native algorithms, not Photoshop-exact color transforms.',
  'Cutout alpha brushes restore or hide original pixels on an extracted source before placement or geometry transforms. Refine the source, then place it again; regular layer masks can additionally constrain any cutout.',
  'Protected layers block direct paint/fill/content edits, opacity changes and nonuniform scaling, and exclude their visible alpha footprints from later adjustments and AI application. Translation, rotation, proportional scaling, visibility, mask refinement and canvas bounds changes remain available.',
  'Document resizing preserves protected layer proportions even when those layers are hidden or fully masked. Integer dimensions may round the non-driving dimension by at most half an output pixel; explicitly unprotect layers to stretch them.',
  'JPEG export flattens transparency onto white. Exports strip source metadata and include the sRGB color profile.',
];

function error(code, message) { return Object.assign(new Error(message), { code }); }
function assert(condition, message, code = 'INVALID_ARGUMENT') { if (!condition) throw error(code, message); }
function number(value, label, min, max, integer = false) {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)), `${label} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  return value;
}
function dimensions(width, height) {
  number(width, 'width', 1, MAX_AXIS, true); number(height, 'height', 1, MAX_AXIS, true);
  assert(width * height <= MAX_PIXELS, 'Image exceeds the native 24-megapixel limit.', 'LIMIT_EXCEEDED');
}
const INTEGER_ADJUSTMENTS = new Set(['posterize', 'threshold', 'median', 'mosaic']);
function adjustmentValue(kind, value) {
  number(value, kind, ...ADJUSTMENTS[kind], INTEGER_ADJUSTMENTS.has(kind));
  assert(kind !== 'median' || value % 2 === 1, 'Median size must be an odd integer.');
  return value;
}
function name(value, fallback = 'Untitled') {
  const result = value === undefined ? fallback : value;
  assert(typeof result === 'string' && result.trim().length > 0 && result.length <= 200, 'name must contain 1–200 characters.');
  return result.trim();
}
function color(value) { assert(typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value), 'color must be #RRGGBB.'); return value; }
function rectangle(args, graph, { mask = false } = {}) {
  number(args.x, 'x', 0, graph.width - 1); number(args.y, 'y', 0, graph.height - 1);
  number(args.width, 'width', 1, graph.width); number(args.height, 'height', 1, graph.height);
  assert(args.x + args.width <= graph.width && args.y + args.height <= graph.height, 'Rectangle must fit within the canvas.');
  if (!mask) for (const field of ['x', 'y', 'width', 'height']) number(args[field], field, 0, MAX_AXIS, true);
  const result = { x: args.x, y: args.y, width: args.width, height: args.height };
  if (mask) {
    result.feather = number(args.feather ?? 0, 'feather', 0, Math.max(graph.width, graph.height));
    assert(args.invert === undefined || typeof args.invert === 'boolean', 'invert must be a boolean.');
    result.invert = args.invert ?? false;
  }
  return result;
}
function layerBase(layerName, type) { return { id: randomUUID(), name: layerName, type, visible: true, opacity: 1, blendMode: 'normal' }; }
function historyEntry(label) { return { id: randomUUID(), label, timestamp: new Date().toISOString() }; }
function graphOf(project) { return project.states[project.cursor].graph; }
function contentLayer(layer) { return layer.type !== 'adjustment' && layer.type !== 'group'; }
function imageSignature(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 8 && ((bytes[0] === 73 && bytes[1] === 73 && [42, 43].includes(bytes[2]) && bytes[3] === 0) || (bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && [42, 43].includes(bytes[3])))) return 'tiff';
  return null;
}
function asDocument(project) {
  const graph = graphOf(project);
  const layers = graph.layers.map(layer => {
    const projected = projectLayerFill(layer);
    return storedFilterMask(layer.filters) ? { ...projected, filters: filterEntries(layer.filters), filterMask: storedFilterMask(layer.filters) } : projected;
  });
  return structuredClone({ id: project.id, ...graph, layers, savedSelections: graph.savedSelections ?? [], layerStyles: graph.layerStyles ?? [], guides: graph.guides ?? [], editRecipes: normalizeEditRecipes(graph.editRecipes), revision: project.revision, backend: 'native', bitDepth: 8, colorSpace: 'sRGB', layerOrder: 'bottom-to-top',
    history: project.states.map((state, index) => ({ ...state.history, active: index === project.cursor, future: index > project.cursor })),
    canUndo: project.cursor > 0, canRedo: project.cursor < project.states.length - 1,
  });
}
function rawImage(buffer, width, height) { return sharp(buffer, { raw: { width, height, channels: 4 }, limitInputPixels: MAX_PIXELS }); }
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const xml = (v) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const FONT_OPTIONS = { fontFamily: FONT_FAMILIES, fontWeight: ['normal', 'bold'], fontStyle: ['normal', 'italic'], align: ['left', 'center', 'right'] };
function textOptions(input) {
  const output = {};
  for (const [key, values] of Object.entries(FONT_OPTIONS)) if (input[key] !== undefined) {
    assert(values.includes(input[key]), `Unsupported ${key}.`); output[key] = input[key];
  }
  return output;
}
function affineOptions(args, width, height) {
  number(args.x, 'x', -MAX_AXIS * 2, MAX_AXIS * 2); number(args.y, 'y', -MAX_AXIS * 2, MAX_AXIS * 2);
  const result = { type: 'affine', width, height, x: args.x, y: args.y, scaleX: number(args.scaleX ?? 1, 'scaleX', 0.05, 8), scaleY: number(args.scaleY ?? 1, 'scaleY', 0.05, 8), rotation: number(args.rotation ?? 0, 'rotation', -180, 180) };
  for (const field of ['flipX', 'flipY']) { assert(args[field] === undefined || typeof args[field] === 'boolean', `${field} must be boolean.`); result[field] = args[field] ?? false; }
  return result;
}

export class NativeBackend {
  constructor({ dataDir, segmentSubject }) {
    assert(typeof dataDir === 'string' && dataDir.length > 0, 'dataDir is required.');
    this.dataDir = path.resolve(dataDir);
    this.projectsDir = path.join(this.dataDir, 'projects');
    this.assetsDir = path.join(this.dataDir, 'assets');
    this.projects = new Map();
    this.loadWarnings = [];
    this.queue = Promise.resolve();
    this.assetWriteScope = new AsyncLocalStorage();
    this.previewCache = new PreviewCache();
    this.psdImports = new PsdImportPool();
    assert(segmentSubject === undefined || typeof segmentSubject === 'function', 'segmentSubject must be a function.');
    this.segmentSubject = segmentSubject;
  }

  async init() {
    this.previewCache.clear();
    await fs.mkdir(this.projectsDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.assetsDir, { recursive: true, mode: 0o700 });
    const psdReceipts = new Set();
    for (const entry of await fs.readdir(this.projectsDir)) {
      if (!entry.endsWith('.json') || !ID.test(entry.slice(0, -5))) continue;
      try {
        const stat = await fs.stat(path.join(this.projectsDir, entry));
        assert(stat.size <= MAX_PROJECT_BYTES, 'Project file is too large.');
        const project = JSON.parse(await fs.readFile(path.join(this.projectsDir, entry), 'utf8'));
        assert(project.version === 1 && project.id === entry.slice(0, -5) && Number.isSafeInteger(project.revision) && project.revision >= 1, 'Invalid persisted project.');
        assert(Array.isArray(project.states) && project.states.length > 0 && project.states.length <= MAX_HISTORY, 'Invalid project history.');
        number(project.cursor, 'history cursor', 0, project.states.length - 1, true);
        const archives = new Map(), lookups = validateColorLookupHistory(project.states);
        for (const state of project.states) { this.validateGraph(state.graph); if (state.graph.sourceDocument) archives.set(state.graph.sourceDocument.asset, state.graph.sourceDocument); }
        for (const descriptor of lookups.values()) await this.verifyColorLookup(descriptor);
        for (const descriptor of denseMaskHistoryAssets(project.states).values()) await this.readDenseMask(descriptor);
        for (const source of archives.values()) validateSourceDocumentBytes(await this.readProjectAsset(source.asset, { maxBytes: source.bytes }), source);
        if (project.psdImportReceipt !== undefined) {
          const receipt = project.psdImportReceipt;
          assert(receipt && typeof receipt === 'object' && Object.keys(receipt).length === 2 && typeof receipt.requestId === 'string' && receipt.requestId.length >= 1 && receipt.requestId.length <= 160 && !/[\u0000-\u001f\u007f]/.test(receipt.requestId) && HASH.test(receipt.fingerprint) && !psdReceipts.has(receipt.requestId), 'Invalid or duplicate PSD import receipt.');
          psdReceipts.add(receipt.requestId);
        }
        this.projects.set(project.id, project);
      } catch { this.loadWarnings.push(`Could not load project ${entry}; its file was left untouched.`); }
    }
    return this;
  }

  // Keep direct callers safe too. The companion also serializes its own requests.
  execute(command, args = {}) {
    let colorRange;
    try { colorRange = checkColorRangeCommandArguments(command, args); checkPhotoFilterArgumentParameters(command, args, this.projects); checkDenseMaskArguments(command, args); }
    catch (cause) { return Promise.reject(cause); }
    if (colorRange || EDIT_RECIPE_APIS.includes(command) || containsLayerFillEdit(command, args) || containsChannelLoad(command, args) || containsFilterBake(command, args) || containsFilterMaskEdit(command, args) || containsDistortEdit(command, args) || containsColorLookupEdit(command, args, this.projects)) {
      // Capture JSON arguments at call time, including while another edit owns
      // the queue. Recipe validation returns independent plain data copies.
      try { if (containsDistortEdit(command, args)) checkDistortArgumentCorners(command, args); if (containsColorLookupEdit(command, args, this.projects)) checkLookupArgumentParameters(command, args); args = validateCommand(command, args); validateLookupUploads(command, args); }
      catch (cause) { return Promise.reject(cause); }
    }
    return this.enqueue(() => this.dispatch(command, args));
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async close() { await this.psdImports.close(); }

  // Hosted accounts free quota by deleting a whole document and its history.
  // Afterwards only content-addressed blobs that no remaining project mentions
  // are removed; an unrecognized reference keeps its file.
  deleteDocument(documentId) {
    return this.enqueue(async () => {
      assert(typeof documentId === 'string' && ID.test(documentId) && this.projects.has(documentId), 'Document not found.', 'DOCUMENT_NOT_FOUND');
      await fs.unlink(path.join(this.projectsDir, `${documentId}.json`));
      this.projects.delete(documentId); this.previewCache.clear();
      const referenced = new Set();
      for (const project of this.projects.values()) for (const hash of JSON.stringify(project).match(/[a-f0-9]{64}/g) || []) referenced.add(hash);
      let removedAssets = 0;
      for (const entry of await fs.readdir(this.assetsDir)) {
        if (!HASH.test(entry) || referenced.has(entry)) continue;
        try { await fs.unlink(path.join(this.assetsDir, entry)); removedAssets++; } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      }
      return { deleted: true, documentId, removedAssets };
    });
  }

  async verifyColorLookup(parameters) {
    const descriptor = normalizeColorLookupParameters(parameters);
    return validateColorLookupBytes(await this.readProjectAsset(descriptor.asset, { maxBytes: descriptor.bytes }), descriptor);
  }

  async prepareColorLookup(parameters) {
    return prepareColorLookup(parameters, (hash, options) => this.readProjectAsset(hash, options));
  }

  async readDenseMask(input) {
    const mask = normalizeDenseMaskDescriptor(input, { persisted: true });
    const file = await openBoundedFile(path.join(this.assetsDir, mask.asset), { maxBytes: mask.bytes, exactBytes: mask.bytes, code: 'CORRUPT_ASSET', message: 'The immutable alpha8 mask is missing or corrupt.' });
    try {
      const { data } = await readBoundedHandle(file.handle, { bytes: file.bytes, expectedHash: mask.asset, code: 'CORRUPT_ASSET', message: 'The immutable alpha8 mask is missing or corrupt.' });
      await validateDenseMaskFrame(data, mask, { verifiedHash: true });
      return data;
    } finally { await file.handle.close(); }
  }
  prepareMaskCoverage(mask) { return prepareMaskCoverage(mask, descriptor => this.readDenseMask(descriptor)); }
  prepareLayerMaskCoverage(layer) { return prepareLayerMaskCoverage(layer, descriptor => this.readDenseMask(descriptor)); }
  prepareRawLayerMaskCoverage(layer) { return prepareRawLayerMaskCoverage(layer, descriptor => this.readDenseMask(descriptor)); }

  async publishMaskAlpha(graph, alpha, width, height, assign, args, context, overrides = {}) {
    assertDenseMaskBudget(3 * width * height + 64);
    const { descriptor, frame } = await encodeMaskAlpha(alpha, width, height);
    Object.assign(descriptor, overrides);
    assign(descriptor);
    if (frame) {
      const project = this.project(args.documentId), states = [...project.states.slice(0, project.cursor + 1), { graph }].slice(-MAX_HISTORY);
      validateColorLookupHistory(states);
      assert(Buffer.byteLength(JSON.stringify({ ...project, states })) <= MAX_PROJECT_BYTES, 'The mask would exceed native project metadata limits.', 'LIMIT_EXCEEDED');
      if (!context?.deferMaskGraphValidation) {
        this.validateGraph(graph);
        if (context?.validateCommit) context.validateCommit(graph);
      }
      await this.storeAsset(frame);
    }
    return descriptor;
  }

  async transformEditingMask(graph, mask, transform, assign, args, context) {
    const { width, height } = graph;
    if (positionedLayerMask(mask)) { assign(transformPositionedMask(mask, transform, width, height)); return; }
    if (!isByteMask(mask)) { assign(transform.type === 'canvas' ? resizeCanvasMask(mask, width, height, transform) : transformMask(mask, transform, width, height)); return; }
    const outputPixels = transform.width * transform.height;
    assertDenseMaskBudget(Math.max(maskBufferBytes(mask) + outputPixels, 3 * outputPixels + 64), maskPreparationWork(mask));
    const { alpha, feather, invert } = await materializeTransformedByteMask(mask, width, height, transform, descriptor => this.readDenseMask(descriptor));
    await this.publishMaskAlpha(graph, alpha, transform.width, transform.height, assign, args, { ...context, deferMaskGraphValidation: true }, { feather, invert });
  }

  preflightMaskCanvas(graph, transform, contentTransform = transform) {
    const projection = structuredClone(graph), outputPixels = transform.width * transform.height;
    let work = 0, peak = 3 * outputPixels + 64;
    const projectMask = mask => {
      if (!mask) return mask;
      if (positionedLayerMask(mask)) return transformPositionedMask(mask, transform, graph.width, graph.height);
      if (!isByteMask(mask)) return transform.type === 'canvas' ? resizeCanvasMask(mask, graph.width, graph.height, transform) : transformMask(mask, transform, graph.width, graph.height);
      const bake = transform.type === 'canvas' || transform.type === 'crop' && mask.feather > 0;
      const preparation = { ...mask, feather: bake ? mask.feather : 0 };
      work += maskPreparationWork(preparation); peak = Math.max(peak, maskBufferBytes(preparation) + outputPixels);
      return { shape: 'alpha8', asset: '0'.repeat(64), bytes: outputPixels + 32, width: transform.width, height: transform.height, x: 0, y: 0,
        feather: bake ? 0 : (mask.feather ?? 0) * (transform.type === 'resize' ? Math.min(transform.width / graph.width, transform.height / graph.height) : 1), invert: transform.type === 'canvas' ? false : mask.invert ?? false };
    };
    for (const layer of projection.layers) { if (contentLayer(layer)) layer.transforms.push(contentTransform); if (layer.mask) layer.mask = projectMask(layer.mask); }
    if (projection.selection) projection.selection = projectMask(projection.selection);
    for (const saved of projection.savedSelections ?? []) saved.mask = projectMask(saved.mask);
    if (projection.guides !== undefined) projection.guides = transformGuides(projection.guides, transform, graph.width, graph.height);
    projection.width = transform.width; projection.height = transform.height;
    assertDenseMaskBudget(peak, work);
    this.validateGraph(projection);
  }

  async subjectSelectionAlpha(graph, args) {
    let pixels;
    if (args.layerId !== undefined) {
      const target = graph.layers.find(item => item.id === args.layerId);
      assert(target && contentLayer(target), 'Select an individual content layer for subject selection.', 'INVALID_TARGET');
      pixels = await this.visibleLayerPixels(graph, target, { filters: false });
    } else pixels = await this.renderGraph(graph);
    const segmented = await this.segmentPixels(pixels, graph.width, graph.height);
    for (let i = 0; i < segmented.alpha.length; i++) { segmented.alpha[i] = clamp(segmented.alpha[i] * pixels[i * 4 + 3] / 255); if ((i + 1) % 65536 === 0) await yieldEventLoop(); }
    return segmented.alpha;
  }

  async importColorLookupMutation(graph, args, context) {
    assert(typeof context?.validateCommit === 'function', 'Color Lookup import requires a revision-bound publication context.', 'INVALID_ARGUMENTS');
    this.validateGraph(graph);
    const layer = args.layerId === undefined ? null : graph.layers.find(item => item.id === args.layerId);
    if (args.layerId !== undefined) assert(layer, 'Layer was not found.', 'NOT_FOUND');
    assert(args.target === 'adjustment' || args.target === 'layer-filter', 'Choose a Color Lookup target.');
    if (args.target === 'adjustment') {
      assert(args.filterId === undefined, 'Adjustment lookup imports do not accept a filterId.');
      if (layer) assert(layer.type === 'adjustment' && layer.kind === 'color_lookup', 'Replace an existing Color Lookup adjustment.', 'INVALID_TARGET');
      else assert(graph.layers.length < MAX_LAYERS, 'Native documents support up to 64 layers.', 'LIMIT_EXCEEDED');
    } else {
      assert(layer?.type === 'raster', 'Source Color Lookup requires a raster layer.', 'INVALID_TARGET');
      assert(!layer.protected, 'Unprotect this layer explicitly before editing its filters.', 'PROTECTED_LAYER');
      if (args.filterId !== undefined) {
        const entry = filterEntries(layer.filters).find(item => item.id === args.filterId);
        assert(entry, 'Layer filter was not found.', 'NOT_FOUND');
        assert(entry.kind === 'color_lookup', 'Replace an existing Color Lookup filter.', 'INVALID_TARGET');
      } else assert(filterEntries(layer.filters).length < MAX_FILTERS_PER_LAYER, 'A raster layer supports at most eight editable filters.', 'LIMIT_EXCEEDED');
    }
    colorLookupBase64Bytes(args.data);
    const data = Buffer.from(args.data, 'base64');
    const { gridSize, title } = await parseColorLookupBytes(data);
    const parameters = normalizeColorLookupParameters({ asset: createHash('sha256').update(data).digest('hex'), bytes: data.length, gridSize, inputSpace: args.inputSpace, sourceName: args.sourceName, ...(title === undefined ? {} : { title }) });
    let changed, filterId;
    if (args.target === 'adjustment') {
      changed = layer ? { ...layer, parameters } : { ...layerBase(name(args.sourceName), 'adjustment'), kind: 'color_lookup', value: 0,
        parameters, mask: graph.selection ? normalizeMask(graph.selection, graph.width, graph.height, { persisted: true }) : null };
    } else {
      const filters = editedFilterStack(layer.filters, args.filterId === undefined ? 'add_layer_filter' : 'update_layer_filter',
        args.filterId === undefined ? { kind: 'color_lookup', value: 0, parameters } : { filterId: args.filterId, parameters });
      filterId = args.filterId ?? filterEntries(filters).at(-1).id;
      changed = { ...layer, filters };
    }
    const candidate = { ...graph, layers: layer ? graph.layers.map(item => item === layer ? changed : item) : [...graph.layers, changed] };
    this.validateGraph(candidate);
    context.validateCommit(candidate);
    await this.storeAsset(data);
    graph.layers = candidate.layers;
    return { label: layer && args.target === 'adjustment' || args.filterId ? 'Replace Color Lookup' : 'Import Color Lookup', layerId: changed.id, ...(filterId ? { filterId } : {}) };
  }

  async readProjectAsset(hash, { maxBytes = PROJECT_BUNDLE_LIMITS.maxAssetBytes } = {}) {
    assert(HASH.test(hash), 'Invalid project asset reference.', 'INVALID_PROJECT_BUNDLE');
    let handle;
    try {
      handle = await fs.open(path.join(this.assetsDir, hash), FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW | FS_CONSTANTS.O_NONBLOCK);
      const stat = await handle.stat();
      assert(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, 'Project asset exceeds its bounded file size.', 'LIMIT_EXCEEDED');
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        assert(result.bytesRead > 0, 'A project asset is truncated.', 'INVALID_PROJECT_BUNDLE'); offset += result.bytesRead;
      }
      assert((await handle.stat()).size === bytes.length && createHash('sha256').update(bytes).digest('hex') === hash, 'A project asset no longer matches its immutable identifier.', 'INVALID_PROJECT_BUNDLE');
      return bytes;
    } catch (cause) {
      if (cause.code === 'LIMIT_EXCEEDED') throw cause;
      throw error('INVALID_PROJECT_BUNDLE', 'A referenced project image is missing, corrupt or unreadable.');
    } finally { if (handle) await handle.close().catch(() => {}); }
  }

  async validateProjectAsset(data, uses) {
    if (uses[0]?.type === 'alpha8') { await validateDenseMaskFrame(data, uses[0].mask); return; }
    assert(Buffer.isBuffer(data) && data.length > 0 && data.length <= PROJECT_BUNDLE_LIMITS.maxAssetBytes, 'Project asset exceeds the 128 MiB file limit.', 'LIMIT_EXCEEDED');
    if (uses[0]?.type === 'color-lookup') {
      assert(uses.every(use => use.type === 'color-lookup'), 'A Color Lookup cannot also be an image or archive.', 'INVALID_PROJECT_BUNDLE');
      await validateColorLookupBytes(data, uses[0].parameters); return;
    }
    if (uses.some(use => use.field === 'sourceDocument')) {
      assert(uses.length === 1 && uses[0].field === 'sourceDocument', 'A source archive cannot also be a raster image.', 'INVALID_PROJECT_BUNDLE');
      validateSourceDocumentBytes(data, uses[0].sourceDocument); return;
    }
    // Reject SVG/other active formats before asking the image decoder to parse
    // them. Every supported raster format has a bounded, recognizable header.
    const format = imageSignature(data);
    assert(format, 'Project assets must contain PNG, JPEG, WebP or TIFF raster images.', 'INVALID_PROJECT_BUNDLE');
    let metadata;
    try { metadata = await sharp(data, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata(); }
    catch { throw error('INVALID_PROJECT_BUNDLE', 'A bundled raster image could not be decoded.'); }
    assert(metadata.format === format && (metadata.pages ?? 1) === 1, 'Animated, multipage or mismatched project images are unsupported.', 'INVALID_PROJECT_BUNDLE');
    dimensions(metadata.width, metadata.height);
    for (const { layer, field } of uses) {
      if (field === 'sourceAsset') assert(layer.sourceFormat === undefined || layer.sourceFormat === format, 'A preserved source format does not match its image bytes.', 'INVALID_PROJECT_BUNDLE');
      else assert(format === 'png' && metadata.width === layer.width && metadata.height === layer.height, 'Working and alpha assets must be PNG images matching the layer’s source dimensions.', 'INVALID_PROJECT_BUNDLE');
    }
    try {
      // Reading only metadata is insufficient for truncated IDAT/TIFF data.
      // Full bounded RGBA8 decoding verifies every referenced image before any
      // imported asset is published; the original encoded bytes remain exact.
      await sharp(data, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer();
    } catch { throw error('INVALID_PROJECT_BUNDLE', 'A bundled raster image is incomplete or could not be decoded.'); }
  }

  exportProject({ documentId, expectedRevision } = {}) {
    return this.enqueue(async () => {
      const project = this.project(documentId, expectedRevision), graph = structuredClone(graphOf(project)), uses = projectAssetUses(graph);
      const data = await encodeProjectBundle({ graph, validateGraph: this.validateGraph.bind(this), readAsset: async (hash) => {
        const source = uses.get(hash)?.find(use => use.field === 'sourceDocument')?.sourceDocument ?? uses.get(hash)?.find(use => use.type === 'color-lookup')?.parameters ?? uses.get(hash)?.find(use => use.type === 'alpha8')?.mask;
        const bytes = await this.readProjectAsset(hash, source ? { maxBytes: source.bytes } : undefined); await this.validateProjectAsset(bytes, uses.get(hash)); return bytes;
      } });
      const filename = `${graph.name.replace(/[^a-zA-Z0-9 _.-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'project'}.prism`;
      return { data, filename, mimeType: 'application/x-prism-project', documentId: project.id, revision: project.revision, historyIncluded: false };
    });
  }

  inspectPsdExport({ documentId, expectedRevision } = {}) {
    return this.enqueue(() => { const project = this.project(documentId, expectedRevision); return withMaskPreparationBudget(hasDenseMasks(graphOf(project)), () => inspectNativePsd(this, project)); });
  }

  exportPsd({ documentId, expectedRevision } = {}) {
    return this.enqueue(() => { const project = this.project(documentId, expectedRevision); return withMaskPreparationBudget(hasDenseMasks(graphOf(project)), () => exportNativePsd(this, project)); });
  }

  psdImportOptions(args) {
    const { assumeSrgb = false, sourceName = 'Original.psd', name: documentName, signal } = args;
    assert(typeof assumeSrgb === 'boolean', 'assumeSrgb must be boolean.');
    for (const value of [sourceName, ...(documentName === undefined ? [] : [documentName])]) assert(typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value), 'PSD names require 1–200 characters without control characters.');
    assert(signal === undefined || (signal && typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function'), 'Invalid PSD cancellation signal.');
    return { assumeSrgb, sourceName, ...(documentName === undefined ? {} : { name: documentName }), signal };
  }

  async checkedPsdResult(result, isCancelled) {
    const report = result?.report;
    assert(report && report.importerVersion === PSD_IMPORT_VERSION && report.subsetId === PSD_IMPORT_SUBSET && HASH.test(report.input?.sha256) && Number.isSafeInteger(report.input.bytes) && report.input.bytes > 0 && report.input.bytes <= PSD_IMPORT_LIMITS.maxBytes && Array.isArray(report.issues) && report.issues.length <= 128 && Array.isArray(report.warnings) && report.warnings.length <= 128 && report.supported === false && report.validation === 'rejected' && typeof report.requiresSrgbAssumption === 'boolean', 'PSD worker returned an invalid report.', 'PSD_IMPORT_FAILED');
    for (const item of [...report.issues, ...report.warnings]) assert(item && typeof item.code === 'string' && item.code.length <= 100 && typeof item.message === 'string' && item.message.length <= 1000, 'PSD worker returned an invalid compatibility issue.', 'PSD_IMPORT_FAILED');
    if (report.issues.length) return result;
    assert(result.graph && Array.isArray(result.assets) && result.assets.length <= MAX_LAYERS && result.input instanceof ArrayBuffer, 'PSD worker returned invalid project data.', 'PSD_IMPORT_FAILED');
    const graph = result.graph; this.validateGraph(graph);
    assert(graph.sourceDocument && report.input.sha256 === graph.sourceDocument.asset && report.input.bytes === graph.sourceDocument.bytes && report.input.bytes === result.input.byteLength && report.document?.width === graph.width && report.document?.height === graph.height && report.document?.layerCount === graph.layers.length && graph.layers.length >= 1 && report.document.bitsPerChannel === 8 && report.document.colorMode === 'RGB' && report.document.mergedChannels === 3 && Array.isArray(report.layers) && report.layers.length === graph.layers.length && result.assets.length === graph.layers.length, 'PSD report does not describe its decoded project.', 'PSD_IMPORT_FAILED');
    assert(['known-srgb', 'assumed-srgb'].includes(report.color?.policy) && typeof report.options?.assumeSrgb === 'boolean', 'PSD worker returned an invalid color interpretation.', 'PSD_IMPORT_FAILED');
    for (const [index, layer] of graph.layers.entries()) {
      const described = report.layers[index];
      assert(layer.type === 'raster' && layer.blendMode === 'normal' && layer.asset === layer.sourceAsset && layer.alphaAsset === undefined && layer.provenance?.sourceFormat === 'psd' && layer.provenance?.colorPolicy === report.color.policy && !layer.provenance?.jobId && !layer.parentId && !layer.clipBaseId && !layer.protected && !layer.filters && !layer.effects && !layer.outline && described?.name === layer.name && described.visible === layer.visible && described.opacity === layer.opacity && described.bounds?.width === layer.width && described.bounds?.height === layer.height, 'PSD worker returned inconsistent raster metadata.', 'PSD_IMPORT_FAILED');
    }
    assert(Buffer.byteLength(JSON.stringify(graph)) + 4096 <= MAX_PROJECT_BYTES, 'PSD metadata exceeds the native project limit.', 'LIMIT_EXCEEDED');
    const assets = new Map();
    for (const asset of result.assets) {
      assert(HASH.test(asset.hash) && asset.data instanceof Uint8Array && asset.data.byteLength <= PROJECT_BUNDLE_LIMITS.maxAssetBytes, 'PSD worker returned an invalid raster asset.', 'PSD_IMPORT_FAILED');
      const bytes = Buffer.from(asset.data.buffer, asset.data.byteOffset, asset.data.byteLength);
      assert(createHash('sha256').update(bytes).digest('hex') === asset.hash, 'PSD raster bytes do not match their identifier.', 'PSD_IMPORT_FAILED'); assets.set(asset.hash, bytes);
    }
    const original = Buffer.from(result.input); validateSourceDocumentBytes(original, graph.sourceDocument); assets.set(graph.sourceDocument.asset, original);
    const uses = projectAssetUses(graph); assert(uses.size === assets.size, 'PSD asset references are incomplete.', 'PSD_IMPORT_FAILED');
    let bytesTotal = Buffer.byteLength(JSON.stringify(graph));
    for (const [hash, references] of uses) {
      assert(!isCancelled(), 'PSD processing was cancelled before publication.', 'PSD_IMPORT_CANCELLED');
      assert(assets.has(hash), 'PSD raster asset is missing.', 'PSD_IMPORT_FAILED'); bytesTotal += assets.get(hash).length;
      await this.validateProjectAsset(assets.get(hash), references);
    }
    assert(bytesTotal <= PROJECT_BUNDLE_LIMITS.maxBundleBytes - 65536, 'PSD project assets exceed the portable project limit.', 'LIMIT_EXCEEDED');
    assert(!isCancelled(), 'PSD processing was cancelled before publication.', 'PSD_IMPORT_CANCELLED');
    report.supported = true; report.validation = 'complete'; return { ...result, graph, assets };
  }

  inspectPsdImport(args = {}) {
    const options = this.psdImportOptions(args);
    return this.psdImports.run(args.data, { ...options, sourceName: safePsdFilename(options.sourceName) }, async (result, cancelled) => (await this.checkedPsdResult(result, cancelled)).report);
  }

  importPsd(args = {}) {
    const options = this.psdImportOptions(args), { expectedSha256, importerVersion, requestId } = args;
    assert(typeof expectedSha256 === 'string' && HASH.test(expectedSha256), 'Use the SHA-256 from PSD inspection.');
    assert(importerVersion === PSD_IMPORT_VERSION, 'The PSD importer version changed. Inspect the file again.', 'INSPECTION_STALE');
    assert(typeof requestId === 'string' && requestId.length >= 1 && requestId.length <= 160 && !/[\u0000-\u001f\u007f]/.test(requestId), 'Use a stable PSD import request ID containing 1–160 characters.');
    assert(Buffer.isBuffer(args.data) && args.data.length > 0 && args.data.length <= PSD_IMPORT_LIMITS.maxBytes, 'PSD import requires a nonempty file of at most 64 MiB.', 'LIMIT_EXCEEDED');
    assert(createHash('sha256').update(args.data).digest('hex') === expectedSha256, 'The PSD bytes differ from the inspected file.', 'INSPECTION_STALE');
    const fingerprint = psdImportFingerprint({ sha256: expectedSha256, ...options, importerVersion });
    const checkReceiptConflict = () => { for (const existing of this.projects.values()) if (existing.psdImportReceipt?.requestId === requestId) assert(existing.psdImportReceipt.fingerprint === fingerprint, 'This request ID was already used for a different PSD import.', 'REQUEST_CONFLICT'); };
    checkReceiptConflict();
    return this.psdImports.run(args.data, { ...options, sourceName: safePsdFilename(options.sourceName), expectedSha256 }, async (output, cancelled) => {
      // A concurrent import may have committed while this worker waited. Its
      // receipt takes precedence over a changed interpretation's refusal.
      await this.enqueue(checkReceiptConflict);
      const result = await this.checkedPsdResult(output, cancelled), { report } = result;
      if (!report.supported) throw Object.assign(error('PSD_UNSUPPORTED', 'This PSD is outside the supported editable subset. Inspect its compatibility report.'), { report });
      return this.enqueue(async () => {
        assert(!cancelled(), 'PSD import was cancelled before publication.', 'PSD_IMPORT_CANCELLED');
        for (const existing of this.projects.values()) if (existing.psdImportReceipt?.requestId === requestId) {
          assert(existing.psdImportReceipt.fingerprint === fingerprint, 'This request ID was already used for a different PSD import.', 'REQUEST_CONFLICT');
          return { document: asDocument(existing), report, historyIncluded: false };
        }
        const { graph, assets } = result;
        const project = { version: 1, id: randomUUID(), revision: 1, cursor: 0, psdImportReceipt: { requestId, fingerprint }, states: [{ graph, history: historyEntry('Import PSD (history reset)') }] };
        this.validateGraph(graph);
        assert(Buffer.byteLength(JSON.stringify(project)) <= MAX_PROJECT_BYTES, 'PSD project metadata exceeds 16 MiB.', 'LIMIT_EXCEEDED');
        const createdAssets = new Set();
        try {
          for (const bytes of assets.values()) { assert(!cancelled(), 'PSD import was cancelled before publication.', 'PSD_IMPORT_CANCELLED'); await this.storeAsset(bytes, { createdAssets }); }
          assert(!cancelled(), 'PSD import was cancelled before publication.', 'PSD_IMPORT_CANCELLED');
          await this.persist(project);
        } catch (cause) {
          this.projects.delete(project.id); let cleanupFailed = false;
          try { await fs.unlink(path.join(this.projectsDir, `${project.id}.json`)); } catch (cleanup) { if (cleanup.code !== 'ENOENT') cleanupFailed = true; }
          if (!cleanupFailed) for (const hash of createdAssets) try { await fs.unlink(path.join(this.assetsDir, hash)); } catch (cleanup) { if (cleanup.code !== 'ENOENT') cleanupFailed = true; }
          if (cleanupFailed) throw error('PSD_IMPORT_FAILED', 'PSD import failed; cleanup of newly created files could not be completed. Existing projects were preserved.');
          if (['PSD_IMPORT_CANCELLED', 'CORRUPT_ASSET', 'LIMIT_EXCEEDED'].includes(cause?.code)) throw cause;
          throw error('PSD_IMPORT_FAILED', 'PSD import could not be saved. Newly created files were removed and existing projects were preserved.');
        }
        return { document: asDocument(project), report, historyIncluded: false };
      });
    });
  }

  exportOriginalPsd({ documentId, expectedRevision } = {}) {
    return this.enqueue(async () => {
      const project = this.project(documentId, expectedRevision), source = graphOf(project).sourceDocument;
      assert(source, 'This project has no preserved original PSD document.', 'NO_SOURCE_DOCUMENT');
      validateSourceDocument(graphOf(project));
      const data = await this.readProjectAsset(source.asset, { maxBytes: source.bytes }); validateSourceDocumentBytes(data, source);
      return { data, filename: source.name, mimeType: PSD_ARCHIVE_MIME, documentId, revision: project.revision, sha256: source.asset, bytes: data.length };
    });
  }

  async importProject({ data, name: documentName } = {}) {
    assert(Buffer.isBuffer(data) && data.length > 0, 'Project import requires binary .prism bundle bytes.', 'INVALID_PROJECT_BUNDLE');
    assert(data.length <= PROJECT_BUNDLE_LIMITS.maxBundleBytes, 'Project bundle exceeds the 256 MiB file limit.', 'LIMIT_EXCEEDED');
    // Own the caller's bytes immediately, including while another edit holds
    // the native queue. The codec separately owns its decoded asset views.
    const snapshot = Buffer.from(data);
    return this.enqueue(async () => {
      const { graph, assets } = decodeProjectBundle(snapshot, { validateGraph: this.validateGraph.bind(this) });
      if (documentName !== undefined) graph.name = name(documentName);
      for (const layer of graph.layers) if (layer.role === 'generated' || layer.provenance?.jobId) layer.provenance = { ...layer.provenance, imported: true };
      this.validateGraph(graph);
      const project = { version: 1, id: randomUUID(), revision: 1, cursor: 0, states: [{ graph, history: historyEntry('Import editable project (history reset)') }] };
      assert(Buffer.byteLength(JSON.stringify(project), 'utf8') <= MAX_PROJECT_BYTES, 'Imported project metadata exceeds the native 16 MiB limit.', 'LIMIT_EXCEEDED');
      const document = asDocument(project), uses = projectAssetUses(graph);
      for (const [hash, references] of uses) {
        assert(assets.has(hash), 'A referenced project asset is missing.', 'INVALID_PROJECT_BUNDLE');
        await this.validateProjectAsset(assets.get(hash), references);
      }
      const createdAssets = new Set();
      try {
        for (const bytes of assets.values()) await this.storeAsset(bytes, { createdAssets });
        await this.persist(project);
      } catch (cause) {
        this.projects.delete(project.id);
        let cleanupFailed = false;
        try { await fs.unlink(path.join(this.projectsDir, `${project.id}.json`)); } catch (cleanup) { if (cleanup.code !== 'ENOENT') cleanupFailed = true; }
        if (!cleanupFailed) for (const hash of createdAssets) {
          try { await fs.unlink(path.join(this.assetsDir, hash)); } catch (cleanup) { if (cleanup.code !== 'ENOENT') cleanupFailed = true; }
        }
        if (cleanupFailed) throw error('PROJECT_IMPORT_FAILED', 'Project import failed and cleanup of new files could not be completed. Existing projects were preserved.');
        if (cause?.code === 'CORRUPT_ASSET' || cause?.code === 'LIMIT_EXCEEDED') throw cause;
        throw error('PROJECT_IMPORT_FAILED', 'Project import could not be saved. Newly created files were removed and existing projects were preserved.');
      }
      return { document, historyIncluded: false };
    });
  }

  snapshotForGeneration(args) {
    return this.enqueue(() => withMaskPreparationBudget(hasDenseMasks(graphOf(this.project(args.documentId, args.expectedRevision))), () => this.snapshotForGenerationPrepared(args)));
  }

  async snapshotForGenerationPrepared(args) {
      const project = this.project(args.documentId, args.expectedRevision);
      const graph = graphOf(project);
      if (args.scope === 'selection') assert(graph.selection, 'Create a selection before requesting a selected-area AI edit.', 'NO_SELECTION');
      const dense = hasDenseMasks(graph), count = graph.width * graph.height;
      if (dense) validateDenseMaskOperation(graph, { phases: [5 * count + maskBufferBytes(args.scope === 'selection' ? graph.selection : null)], additionalWork: protectedMaskPreparationWork(graph) + maskPreparationWork(args.scope === 'selection' ? graph.selection : null) });
      const image = await rawImage(await this.renderGraph(graph), graph.width, graph.height).withIccProfile('srgb').png().toBuffer();
      // The actual encoded image remains owned through protection/mask work.
      if (dense) validateDenseMaskOperation(graph, { retainedBytes: image.length, phases: [image.length + 5 * count + maskBufferBytes(args.scope === 'selection' ? graph.selection : null)], additionalWork: protectedMaskPreparationWork(graph) + maskPreparationWork(args.scope === 'selection' ? graph.selection : null) });
      let mask;
      const protectedPixels = await this.protectedPixels(graph);
      if (args.scope === 'selection' || protectedPixels.some((value) => value > 0)) {
        if (args.scope === 'selection') assert(graph.selection, 'Create a selection before requesting a selected-area AI edit.', 'NO_SELECTION');
        const coverage = await this.prepareMaskCoverage(args.scope === 'selection' ? graph.selection : null), pixels = Buffer.alloc(graph.width * graph.height * 4, 255);
        let editable = false;
        for (let y = 0; y < graph.height; y++) for (let x = 0; x < graph.width; x++) {
          const value = protectedPixels[y * graph.width + x] ? 255 : clamp(255 * (1 - coverage(x, y)));
          pixels[(y * graph.width + x) * 4 + 3] = value;
          if (value < 255) editable = true;
          if (dense && (y * graph.width + x + 1) % 65536 === 0) await yieldEventLoop();
        }
        assert(editable, 'No editable pixels remain outside the protected layers and current edit scope.', 'EMPTY_SELECTION');
        mask = await rawImage(pixels, graph.width, graph.height).png().toBuffer();
      }
      return { documentId: project.id, revision: project.revision, width: graph.width, height: graph.height, image, ...(mask ? { mask } : {}) };
  }

  installGeneratedImage({ data, name: layerName, documentId, expectedRevision, mask, provenance = {}, signal }) {
    return this.enqueue(async () => {
      const checkCancelled = () => assert(!signal?.aborted, 'Image application was cancelled.', 'AI_CANCELLED');
      checkCancelled();
      assert(Buffer.isBuffer(data) && data.length > 0 && data.length <= MAX_BYTES, 'Generated image exceeds the native 32 MiB limit.', 'LIMIT_EXCEEDED');
      assert(provenance && typeof provenance === 'object' && !Array.isArray(provenance), 'Invalid image provenance.');
      if (provenance.jobId !== undefined) assert(ID.test(provenance.jobId), 'Invalid generation job identifier.');
      assert(provenance.fit === undefined || ['contain', 'cover'].includes(provenance.fit), 'Generation fit must be contain or cover.');
      const project = documentId ? this.project(documentId) : null;
      // A crash after native persistence but before the job receipt is written
      // must never apply the same paid result a second time.
      if (provenance.jobId) for (const candidate of project ? [project] : this.projects.values()) {
        const existing = graphOf(candidate).layers.find((layer) => !layer.provenance?.imported && layer.provenance?.jobId === provenance.jobId);
        if (existing) return { document: asDocument(candidate), layerId: existing.id };
      }
      if (project) this.project(project.id, expectedRevision);
      const graph = project ? structuredClone(graphOf(project)) : null;
      if (graph) assert(graph.layers.length < MAX_LAYERS, 'Native documents support up to 64 layers.', 'LIMIT_EXCEEDED');
      let metadata;
      try { metadata = await sharp(data, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata(); }
      catch { throw error('INVALID_IMAGE', 'The generated image could not be decoded.'); }
      assert(['png', 'jpeg', 'webp'].includes(metadata.format), 'Generated images must be PNG, JPEG or WebP.', 'INVALID_IMAGE');
      dimensions(metadata.width, metadata.height);
      assert((metadata.pages ?? 1) === 1, 'Animated generated images are unsupported.', 'INVALID_IMAGE');
      const width = graph?.width ?? metadata.width, height = graph?.height ?? metadata.height;
      let image = sharp(data, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).rotate().toColourspace('srgb').ensureAlpha();
      if (graph) image = image.resize(width, height, { fit: provenance.mode === 'edit' ? 'cover' : provenance.fit ?? 'contain', position: 'centre', background: { r: 0, g: 0, b: 0, alpha: 0 } });
      const pixels = await image.raw().toBuffer();
      if (mask) {
        assert(Buffer.isBuffer(mask) && mask.length <= MAX_BYTES, 'Invalid generation mask.', 'INVALID_ARGUMENT');
        const maskMetadata = await sharp(mask, { limitInputPixels: MAX_PIXELS }).metadata();
        assert(maskMetadata.format === 'png' && maskMetadata.hasAlpha, 'A generation mask must be a PNG with alpha.', 'INVALID_ARGUMENT');
        assert(maskMetadata.width === width && maskMetadata.height === height, 'The canvas dimensions changed after this selection was captured. Restore the original dimensions before applying this result.', 'SNAPSHOT_DIMENSIONS_CHANGED');
        const maskPixels = await sharp(mask, { limitInputPixels: MAX_PIXELS }).ensureAlpha().raw().toBuffer();
        for (let i = 3; i < pixels.length; i += 4) pixels[i] = clamp(pixels[i] * (1 - maskPixels[i] / 255));
      }
      if (graph) {
        const protectedPixels = await this.protectedPixels(graph);
        for (let i = 0; i < protectedPixels.length; i++) if (protectedPixels[i]) pixels[i * 4 + 3] = 0;
      }
      checkCancelled();
      const sourceAsset = await this.storeAsset(data), asset = await this.storeAsset(await rawImage(pixels, width, height).png().toBuffer());
      const safeProvenance = {};
      for (const field of ['jobId', 'mode', 'model', 'quality', 'size', 'scope', 'fit', 'createdAt']) if (typeof provenance[field] === 'string') safeProvenance[field] = provenance[field].slice(0, 200);
      const layer = { ...layerBase(name(layerName, provenance.mode === 'edit' ? 'AI edit' : 'AI generated image'), 'raster'), role: 'generated', asset, sourceAsset, sourceFormat: metadata.format, width, height, transforms: [], provenance: safeProvenance };
      checkCancelled();
      if (graph) {
        graph.layers.push(layer);
        const result = await this.commit(project, graph, provenance.mode === 'edit' ? 'Apply AI edit' : 'Add AI generated image');
        return { ...result, layerId: layer.id };
      }
      const result = await this.newProject({ name: name(layerName, 'AI generated image'), width, height, selection: null, layers: [layer] }, 'Generate image');
      return { ...result, layerId: layer.id };
    });
  }

  validateGraph(graph) {
    assert(graph && typeof graph === 'object', 'Invalid project graph.');
    dimensions(graph.width, graph.height); name(graph.name);
    assert(Array.isArray(graph.layers) && graph.layers.length <= MAX_LAYERS, 'Invalid layer list.');
    validateSourceDocument(graph);
    const validateMask = (mask) => {
      const normalized = normalizeMask(mask, graph.width, graph.height, { persisted: true });
      if (['bitmap', 'alpha8'].includes(normalized.shape)) assert(normalized.width === graph.width && normalized.height === graph.height, 'Byte-mask dimensions must match the current canvas.');
    };
    if (graph.selection) validateMask(graph.selection);
    validateSavedSelections(graph);
    validateLayerStyles(graph);
    validateGuides(graph);
    validateEditRecipes(graph);
    const tree = layerTree(graph.layers);
    const seen = new Set();
    for (const layer of graph.layers) {
      assert(ID.test(layer.id) && !seen.has(layer.id), 'Invalid layer identifier.'); seen.add(layer.id);
      assert(layer.parentId === undefined || layer.parentId === null || (typeof layer.parentId === 'string' && ID.test(layer.parentId)), 'Invalid parent layer identifier.');
      name(layer.name); assert(typeof layer.visible === 'boolean', 'Invalid layer visibility.'); number(layer.opacity, 'opacity', 0, 1);
      const fill = layerFillOpacity(layer), outsideEffects = layerOutsideEffects(layer);
      assert(fill === 1 || LAYER_FILL_CONTENT_TYPES.includes(layer.type), 'Layer Fill requires an individual content layer.', 'INVALID_TARGET');
      assert(layer.protected === undefined || typeof layer.protected === 'boolean', 'Invalid layer protection.');
      validateAdditionalLayerMask(layer, graph.width, graph.height);
      if (layer.provenance !== undefined) {
        assert(layer.provenance && typeof layer.provenance === 'object' && !Array.isArray(layer.provenance), 'Invalid layer provenance.');
        if (layer.provenance.jobId !== undefined) assert(typeof layer.provenance.jobId === 'string' && ID.test(layer.provenance.jobId), 'Invalid source generation job identifier.');
        assert(layer.provenance.imported === undefined || typeof layer.provenance.imported === 'boolean', 'Invalid imported provenance marker.');
      }
      if (layer.outline) { number(layer.outline.width, 'outline width', 0, 64); color(layer.outline.color); }
      assert(BLENDS.includes(layer.blendMode), 'Unsupported blend mode.', 'UNSUPPORTED');
      assert(['raster', 'solid', 'text', 'adjustment', 'shape', 'path', 'gradient', 'group'].includes(layer.type), 'Invalid layer type.');
      assert(layer.type === 'text' || (!Object.hasOwn(layer, 'tracking') && !Object.hasOwn(layer, 'leading')), 'Tracking and leading belong only to text layers.', 'INVALID_TARGET');
      if (layer.effects !== undefined) {
        assert(contentLayer(layer), 'Layer effects require a content layer.', 'INVALID_TARGET');
        const effects = normalizeEffects(outsideEffects);
        for (const effect of Object.values(effects ?? {})) if (effect.blur >= 0.3 && effect.opacity > 0) {
          const padding = Math.ceil(effect.blur * Math.sqrt(-2 * Math.log(0.01))) + 1;
          assert((graph.width + padding * 2) * (graph.height + padding * 2) <= 32_000_000, 'Effect working image exceeds its bounded pixel budget. Reduce the blur or canvas dimensions.', 'LIMIT_EXCEEDED');
        }
      }
      if (layer.type === 'group') {
        assert(['pass-through', 'isolated'].includes(layer.mode) && (layer.mode === 'isolated' || layer.blendMode === 'normal'), 'Pass-through groups require normal blending; isolated groups support native blend modes.', 'UNSUPPORTED');
        assert(!layer.protected && !layer.outline && ['transforms', 'asset', 'alphaAsset', 'sourceAsset', 'width', 'height'].every((field) => layer[field] === undefined), 'Groups cannot have protection, outlines, pixel assets, dimensions or geometry transforms.', 'INVALID_TARGET');
      } else if (layer.type === 'adjustment') {
        assert(Object.hasOwn(ADJUSTMENTS, layer.kind), 'Unsupported adjustment.', 'UNSUPPORTED');
        adjustmentValue(layer.kind, layer.value);
        normalizeParameters(layer.kind, layer.parameters);
        assert(layer.blendMode === 'normal', 'Adjustment layers support normal blending only.', 'UNSUPPORTED');
      } else {
        dimensions(layer.width, layer.height);
        assert(Array.isArray(layer.transforms) && layer.transforms.length <= 500, 'Too many geometry transforms.');
        let width = layer.width, height = layer.height;
        for (const transform of layer.transforms) {
          assert(['crop', 'resize', 'resample', 'affine', 'canvas', 'distort'].includes(transform.type), 'Invalid geometry transform.');
          if (transform.type === 'distort') normalizeDistort(transform, width, height);
          if (transform.type === 'resample') normalizeResampleTransform(transform);
          if (transform.type === 'resize') assert(!Object.hasOwn(transform, 'kernel') && !Object.hasOwn(transform, 'resample'), 'Legacy resize records cannot contain a kernel or resample field. Use a resample transform.');
          dimensions(transform.width, transform.height);
          if (transform.type === 'crop') rectangle(transform, { width, height });
          if (transform.type === 'canvas') { number(transform.x, 'canvas x offset', -MAX_AXIS, MAX_AXIS, true); number(transform.y, 'canvas y offset', -MAX_AXIS, MAX_AXIS, true); }
          if (transform.type === 'affine') {
            assert(transform.width === width && transform.height === height, 'Affine transform must retain canvas dimensions.');
            affineOptions(transform, width, height);
          }
          width = transform.width; height = transform.height;
        }
        assert(width === graph.width && height === graph.height, 'Layer geometry does not match the canvas.');
        if (layer.type === 'raster') {
          assert(HASH.test(layer.asset) && HASH.test(layer.sourceAsset), 'Invalid raster asset reference.');
          if (layer.alphaAsset !== undefined) assert(HASH.test(layer.alphaAsset), 'Invalid source alpha asset reference.');
        } else if (layer.type === 'solid') color(layer.color);
        else if (layer.type === 'shape') normalizeShape(layer.vector);
        else if (layer.type === 'path') normalizePath(layer.vector);
        else if (layer.type === 'gradient') normalizeGradient(layer.gradient);
        else {
          assert(typeof layer.text === 'string' && layer.text.trim().length > 0 && layer.text.length <= 2000, 'Text must contain 1–2000 characters.');
          assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(layer.text), 'Text contains unsupported control characters.');
          number(layer.x, 'text x', 0, layer.width); number(layer.y, 'text y', 0, layer.height);
          number(layer.fontSize, 'fontSize', 1, 1000); color(layer.color);
          textOptions(layer);
          normalizeTextSpacing(layer);
        }
      }
    }
    validateGroupResources(tree, graph.width, graph.height);
    validateLayerFilterResources(graph, tree);
    validateDistortResources(graph, tree);
    validateColorLookupHistory([graph]);
    validateColorLookupResources(graph, tree);
    validateDenseMaskResources(graph);
  }

  project(documentId, expectedRevision) {
    assert(typeof documentId === 'string' && ID.test(documentId), 'Invalid documentId.');
    const project = this.projects.get(documentId);
    assert(project, 'Document was not found.', 'NOT_FOUND');
    if (expectedRevision !== undefined) assert(expectedRevision === project.revision, `Document changed: expected revision ${expectedRevision}, current revision is ${project.revision}.`, 'REVISION_CONFLICT');
    return project;
  }

  serializeProject(project) {
    validateColorLookupHistory(project.states);
    const serialized = JSON.stringify(project);
    assert(Buffer.byteLength(serialized, 'utf8') <= MAX_PROJECT_BYTES,
      'This edit would exceed the native 16 MiB project metadata limit. The previous project and history were left unchanged.', 'LIMIT_EXCEEDED');
    return serialized;
  }

  async persist(project) {
    const serialized = this.serializeProject(project);
    const file = path.join(this.projectsDir, `${project.id}.json`);
    const temporary = path.join(this.projectsDir, `.${project.id}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, file);
    } finally {
      if (handle) await handle.close();
      await fs.unlink(temporary).catch(() => {});
    }
    this.projects.set(project.id, project);
    if (CACHE_ID.test(project.id)) this.previewCache.invalidateDocument(project.id);
  }

  async storeAsset(buffer, { createdAssets } = {}) {
    const hash = createHash('sha256').update(buffer).digest('hex');
    const finalPath = path.join(this.assetsDir, hash);
    const temporary = path.join(this.assetsDir, `.${hash}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(buffer); await handle.sync(); await handle.close(); handle = null;
      // Link publishes the complete blob atomically without ever replacing an original.
      try { await fs.link(temporary, finalPath); createdAssets?.add(hash); this.assetWriteScope.getStore()?.add(hash); }
      catch (cause) {
        if (cause.code !== 'EEXIST') throw cause;
        // An existing corrupt or replaced hash path must not turn deduplication
        // into an unbounded allocation. Admit exact size on one no-follow fd.
        const options = { code: 'CORRUPT_ASSET', message: 'A stored image asset is corrupt; the original was left untouched.' };
        const existing = await openBoundedFile(finalPath, { maxBytes: buffer.length, exactBytes: buffer.length, ...options });
        try { await readBoundedHandle(existing.handle, { bytes: existing.bytes, expectedHash: hash, ...options }); }
        finally { await existing.handle.close(); }
      }
    } finally {
      if (handle) await handle.close();
      await fs.unlink(temporary).catch(() => {});
    }
    return hash;
  }

  async newProject(graph, label) {
    this.validateGraph(graph);
    const project = { version: 1, id: randomUUID(), revision: 1, cursor: 0, states: [{ graph, history: historyEntry(label) }] };
    await this.persist(project);
    return { document: asDocument(project) };
  }

  buildCommit(project, graph, label) {
    this.validateGraph(graph);
    let states = project.states.slice(0, project.cursor + 1);
    states.push({ graph, history: historyEntry(label) });
    if (states.length > MAX_HISTORY) states = states.slice(-MAX_HISTORY);
    validateColorLookupHistory(states);
    return { ...project, states, cursor: states.length - 1, revision: project.revision + 1 };
  }

  async commit(project, graph, label) {
    const next = this.buildCommit(project, graph, label);
    await this.persist(next);
    return { document: asDocument(next) };
  }

  async withRepairAssets(project, operation, { bake = false } = {}) {
    const createdAssets = new Set();
    return this.assetWriteScope.run(createdAssets, async () => {
      try { return await operation(); }
      catch (cause) {
        // Real persist failures happen before publication. If an extension
        // throws after publishing, never remove blobs referenced by that state.
        if (this.projects.get(project.id) !== project) throw cause;
        let cleanupFailed = false;
        for (const hash of createdAssets) {
          try { await fs.unlink(path.join(this.assetsDir, hash)); }
          catch (cleanup) { if (cleanup.code !== 'ENOENT') cleanupFailed = true; }
        }
        if (cleanupFailed) throw error(bake ? 'FILTER_BAKE_ROLLBACK_FAILED' : 'REPAIR_ROLLBACK_FAILED', `${bake ? 'Filter bake' : 'Repair'} publication failed and cleanup of newly created image assets could not be completed. Existing project state and source assets were preserved.`);
        throw cause;
      }
    });
  }

  dispatch(command, args) {
    let colorRange;
    try { colorRange = checkColorRangeCommandArguments(command, args); } catch (cause) { return Promise.reject(cause); }
    const project = this.projects.get(args?.documentId), graph = project && graphOf(project);
    return withMaskPreparationBudget(command !== 'apply_transaction' && (colorRange || command === 'load_channel_selection' || command === 'get_channel_preview' || graph && hasDenseMasks(graph)), () => this.dispatchPrepared(command, args));
  }

  async dispatchPrepared(command, args) {
    const colorRange = checkColorRangeCommandArguments(command, args);
    assert(COMMANDS.includes(command), `Native backend does not support ${command}.`, 'UNSUPPORTED');
    assert(args && typeof args === 'object' && !Array.isArray(args), 'args must be an object.');
    checkPhotoFilterArgumentParameters(command, args, this.projects);
    checkDenseMaskArguments(command, args);
    if (containsDistortEdit(command, args)) checkDistortArgumentCorners(command, args);
    if (containsColorLookupEdit(command, args, this.projects)) checkLookupArgumentParameters(command, args);
    if (colorRange || EDIT_RECIPE_APIS.includes(command) || containsLayerFillEdit(command, args) || containsChannelLoad(command, args) || containsFilterBake(command, args) || containsFilterMaskEdit(command, args) || containsDistortEdit(command, args) || containsColorLookupEdit(command, args, this.projects)) args = validateCommand(command, args);
    if (command === 'capabilities') return { backend: 'native', commands: COMMANDS.filter((item) => this.segmentSubject || !['extract_subject', 'select_subject'].includes(item)), limitations: [...LIMITATIONS, ...this.loadWarnings], adjustmentKinds: Object.keys(ADJUSTMENTS), colorRangePolicy: COLOR_RANGE_POLICY, colorRangeLimits: COLOR_RANGE_LIMITS, colorRangePreviewLimits: COLOR_RANGE_PREVIEW_LIMITS, layerFillPolicy: LAYER_FILL_POLICY, layerFillContentTypes: LAYER_FILL_CONTENT_TYPES, denseMaskPolicy: DENSE_MASK_POLICY, denseMaskLimits: DENSE_MASK_LIMITS, channelSelectionPolicy: CHANNEL_SELECTION_POLICY, channelSelectionChannels: CHANNEL_SELECTION_CHANNELS, channelPreviewLimits: CHANNEL_PREVIEW_LIMITS, curvesInterpolationPolicy: CURVES_INTERPOLATION_POLICY, curvesInterpolationModes: CURVES_INTERPOLATION_MODES, curvesBanksPolicy: CURVES_BANKS_POLICY, curvesBankNames: CURVES_BANK_NAMES, selectiveColorPolicy: SELECTIVE_COLOR_POLICY, selectiveColorMethods: SELECTIVE_COLOR_METHODS, selectiveColorRanges: SELECTIVE_COLOR_RANGES, photoFilterPolicy: PHOTO_FILTER_POLICY, hueSaturationPolicy: HUE_SATURATION_POLICY, hueSaturationRanges: HUE_SATURATION_RANGES, colorLookupPolicy: COLOR_LOOKUP_POLICY, colorLookupFormats: COLOR_LOOKUP_FORMATS, colorLookupInputSpaces: COLOR_LOOKUP_INPUT_SPACES, colorLookupLimits: COLOR_LOOKUP_LIMITS, blendModes: BLENDS, groupModes: ['pass-through', 'isolated'], groupBlendModes: BLENDS, documentResizeMethods: DOCUMENT_RESIZE_METHODS, documentResizeDefault: DOCUMENT_RESIZE_DEFAULT, layerDistortPolicy: DISTORT_POLICY, layerDistortCoordinates: DISTORT_COORDINATES, layerDistortContentTypes: DISTORT_CONTENT_TYPES, layerFilterKinds: LAYER_FILTER_KINDS, layerFilterCoordinates: 'source', layerFilterMaskPolicy: FILTER_MASK_POLICY, layerFilterMaskCoordinates: 'source', layerFilterMaskSources: FILTER_MASK_SOURCES, layerFilterMaskShapes: FILTER_MASK_SHAPES, layerFilterMaskProperties: FILTER_MASK_PROPERTIES, layerFilterMaskCaptureGeometry: FILTER_MASK_CAPTURE_GEOMETRY, layerFilterSpatialPolicy: SOURCE_SPATIAL_POLICY, layerFilterHighPassPolicy: SOURCE_HIGH_PASS_POLICY, layerFilterLocalTonePolicy: LOCAL_TONE_POLICY, layerFilterUnsharpPolicy: UNSHARP_MASK_POLICY, layerFilterNoisePolicy: SOURCE_NOISE_POLICY, layerFilterBlendPolicy: LAYER_FILTER_BLEND_POLICY, layerFilterBlendModes: LAYER_FILTER_BLEND_MODES, layerFilterBaking: 'source-rgb', layerStyleProperties: LAYER_STYLE_PROPERTIES, layerMaskProperties: LAYER_MASK_PROPERTIES, layerMaskPositioning: 'independent-translation', layerMaskPositionUnits: 'document-pixels', layerMaskPositionOperations: LAYER_MASK_POSITION_OPERATIONS, layerSelectionSources: LAYER_SELECTION_SOURCES, layerSelectionMaskModes: LAYER_SELECTION_MASK_MODES, layerSelectionContentTypes: LAYER_SELECTION_CONTENT_TYPES, maskPreviewSources: MASK_PREVIEW_SOURCES, maskPreviewMaskModes: MASK_PREVIEW_MASK_MODES, textSpacingProperties: TEXT_SPACING_PROPERTIES, textTrackingUnits: TEXT_TRACKING_UNITS, textLeadingUnits: TEXT_LEADING_UNITS, retouchSampleModes: RETOUCH_SAMPLE_MODES, retouchSamplingTools: RETOUCH_SAMPLING_TOOLS, retouchIgnoreAdjustments: true, retouchCurrentAndBelowScope: 'root-target', repairLayerPlacement: 'above-root-raster', editRecipeVersion: 1, editRecipeCommands: EDIT_RECIPE_COMMANDS, editRecipeSlotTypes: EDIT_RECIPE_SLOT_TYPES, guideAxes: GUIDE_AXES, guideCoordinates: 'document-pixels', clippingLayerTypes: CLIPPING_LAYER_TYPES, clippingBlendPolicy: CLIPPING_BLEND_POLICY, morphologyOperations: MORPHOLOGY_OPERATIONS, layeredImportFormats: ['psd'], psdImporterVersion: PSD_IMPORT_VERSION, psdImportPolicy: PSD_IMPORT_SUBSET, layeredExportFormats: ['psd'], projectFormats: ['prism'], projectBundleVersion: 1, exportFormats:['png','jpeg','webp','tiff'],exportOptions:['density','jpegMatte','webpLossless'],exportDensityFormats:['png','jpeg','tiff'], limits: { maxDistortCorner: DISTORT_LIMITS.maxCorner, maxDistortWork: DISTORT_LIMITS.maxWork, maxDistortWorkingBytes: DISTORT_LIMITS.maxWorkingBytes, maxFilterMaskWorkingBytes: FILTER_MASK_LIMITS.maxWorkingBytes, maxFilterMaskCaptureWork: FILTER_MASK_LIMITS.maxCaptureWork, maxDimension: MAX_AXIS, maxPixels: MAX_PIXELS, maxImportBytes: MAX_BYTES, maxProjectBytes: MAX_PROJECT_BYTES, maxLayers: MAX_LAYERS, maxGroupDepth: MAX_GROUP_DEPTH, maxGroupScratchBytes: MAX_GROUP_SCRATCH_BYTES, maxFiltersPerLayer: MAX_FILTERS_PER_LAYER, maxFiltersPerDocument: MAX_FILTERS_PER_DOCUMENT, maxFilterWork: MAX_FILTER_WORK, maxFilterBakeWorkingBytes: FILTER_BAKE_LIMITS.maxWorkingBytes, maxFilterBakeAssetBytes: FILTER_BAKE_LIMITS.maxAssetBytes, maxRenderScratchBytes: MAX_GROUP_SCRATCH_BYTES, maxSavedSelections: MAX_SAVED_SELECTIONS, maxLayerStyles: MAX_LAYER_STYLES, maxEditRecipes: EDIT_RECIPE_LIMITS.maxRecipes, maxEditRecipeSteps: EDIT_RECIPE_LIMITS.maxSteps, maxEditRecipeSlots: EDIT_RECIPE_LIMITS.maxSlots, maxEditRecipeBytes: EDIT_RECIPE_LIMITS.maxRecipeBytes, maxEditRecipeLibraryBytes: EDIT_RECIPE_LIMITS.maxLibraryBytes, maxGuides: MAX_GUIDES, maxMorphologyRadius: 100, maxLayerMaskPosition: LAYER_MASK_POSITION_LIMITS.maxPosition, maxLayerMaskSourcePixels: LAYER_MASK_POSITION_LIMITS.maxSourcePixels, maxLayerSelectionWorkingBytes: LAYER_SELECTION_LIMITS.maxWorkingBytes, maxMaskPreviewEdge: MASK_PREVIEW_LIMITS.maxEdge, maxMaskPreviewBytes: MASK_PREVIEW_LIMITS.maxBytes, maxMaskPreviewWorkingBytes: MASK_PREVIEW_LIMITS.maxWorkingBytes, maxPreviewCacheBytes: PREVIEW_CACHE_LIMITS.maxBytes, maxPreviewCacheEntries: PREVIEW_CACHE_LIMITS.maxEntries, maxPsdImportBytes: PSD_IMPORT_LIMITS.maxBytes, maxPsdImportWorkingBytes: PSD_IMPORT_LIMITS.maxWorkingBytes, maxPsdExportBytes: PSD_EXPORT_LIMITS.maxOutputBytes, maxPsdWorkingBytes: PSD_EXPORT_LIMITS.maxWorkingBytes, maxProjectBundleBytes: PROJECT_BUNDLE_LIMITS.maxBundleBytes } };
    if (command === 'list_documents') return { documents: [...this.projects.values()].map(asDocument) };
    if (command === 'create_document') {
      dimensions(args.width, args.height);
      const background = color(args.background ?? '#ffffff');
      return this.newProject({ name: name(args.name), width: args.width, height: args.height, selection: null, layers: [{ ...layerBase('Background', 'solid'), color: background, width: args.width, height: args.height, transforms: [] }] }, 'Create document');
    }
    if (command === 'import_image') return this.importImage(args);
    const project = this.project(args.documentId, args.expectedRevision);
    if (EDIT_RECIPE_APIS.includes(command)) {
      const graph = graphOf(project);
      this.validateGraph(graph);
      if (EDIT_RECIPE_LIBRARY_COMMANDS.includes(command)) {
        const updated = updatedEditRecipes(graph, command, args);
        const result = await this.commit(project, { ...structuredClone(graph), editRecipes: updated.recipes }, updated.label);
        return command === 'save_edit_recipe' ? { ...result, recipeId: updated.recipeId } : result;
      }
      const recipe = findEditRecipe(graph, args.recipeId);
      if (command === 'get_edit_recipe') return { documentId: project.id, revision: project.revision, recipe, recipeHash: editRecipeHash(recipe) };
      const staged = await stageEditRecipe({ graph, recipe, bindings: args.bindings, documentId: project.id, revision: project.revision,
        mutate: (candidate, step, options) => this.mutate(candidate, step, options), validateGraph: candidate => this.validateGraph(candidate),
        validateCommit: (candidate, label) => this.serializeProject(this.buildCommit(project, candidate, label)) });
      if (command === 'validate_edit_recipe') return staged.report;
      if (!staged.report.valid) {
        const issue = staged.report.issues[0];
        throw Object.assign(error(issue.code, issue.message), { report: staged.report });
      }
      return { ...await this.commit(project, staged.graph, staged.label), recipeId: recipe.id, appliedSteps: recipe.steps.length };
    }
    if (command === 'get_document') return { document: asDocument(project) };
    if (command === 'get_layer_preview') return this.layerPreview(project, args);
    if (command === 'get_mask_preview') {
      const graph = graphOf(project);
      this.validateGraph(graph);
      const preview = await renderMaskPreview(graph, args, { resolveAlpha8: mask => this.readDenseMask(mask) });
      return { ...preview, data: preview.data.toString('base64'), documentId: project.id, revision: project.revision };
    }
    if (command === 'get_color_range_preview') {
      const graph = graphOf(project); this.validateGraph(graph);
      const settings = normalizeColorRangeSettings({ colors: args.colors, tolerance: args.tolerance, falloff: args.falloff, invert: args.invert });
      const { width, height } = maskPreviewDimensions(graph.width, graph.height, args.maxEdge), p = width * height;
      colorRangeComparisonWork(p, settings.colors.length);
      const encoded = COLOR_RANGE_PREVIEW_LIMITS.maxBytes, transfer = 5 * 4 * Math.ceil(encoded / 3);
      validateDenseMaskOperation(graph, { phases: [4 * graph.width * graph.height + p + 280, 5 * p + encoded + transfer] });
      const preview = await renderColorRangePreview(graph, args, value => this.renderGraph(value));
      return { ...preview, data: preview.data.toString('base64'), documentId: project.id, revision: project.revision };
    }
    if (command === 'get_channel_preview') {
      const graph = graphOf(project); this.validateGraph(graph);
      normalizeChannelOptions(args, { preview: true });
      const { width, height } = maskPreviewDimensions(graph.width, graph.height, args.maxEdge ?? CHANNEL_PREVIEW_LIMITS.defaultMaxEdge), p = width * height;
      const encoded = CHANNEL_PREVIEW_LIMITS.maxBytes, transfer = 5 * 4 * Math.ceil(encoded / 3);
      validateDenseMaskOperation(graph, { phases: [4 * graph.width * graph.height + p, 5 * p + encoded + transfer] });
      const preview = await renderChannelPreview(graph, args, value => this.renderGraph(value));
      return { ...preview, data: preview.data.toString('base64'), documentId: project.id, revision: project.revision };
    }
    if (command === 'get_histogram') return this.histogram(graphOf(project));
    if (command === 'sample_color') {
      const graph = graphOf(project);
      return sampleColor({ ...args, pixels: await this.renderGraph(graph), width: graph.width, height: graph.height });
    }
    if (command === 'save_document') { await this.persist(project); return { document: asDocument(project), saved: true }; }
    if (command === 'get_preview') return this.cachedPreview(project, args);
    if (command === 'export_document') return this.output(project, command, args);
    if (command === 'undo' || command === 'redo') {
      const cursor = project.cursor + (command === 'undo' ? -1 : 1);
      assert(cursor >= 0 && cursor < project.states.length, `Nothing to ${command}.`, 'NO_HISTORY');
      const next = { ...project, cursor, revision: project.revision + 1 };
      await this.persist(next); return { document: asDocument(next) };
    }
    const graph = structuredClone(graphOf(project));
    if (command === 'apply_transaction') {
      assert(Array.isArray(args.operations) && args.operations.length > 0 && args.operations.length <= 50, 'A transaction requires 1–50 operations.');
      const baking = containsFilterBake(command, args);
      const importingLookup = containsColorLookupImport(command, args);
      validateLookupUploads(command, args);
      const bakeContext = { validateCommit: candidate => this.serializeProject(this.buildCommit(project, candidate, name(args.label, 'Edit transaction'))) };
      const transaction = async () => {
        for (const operation of args.operations) {
          assert(operation && MUTATIONS.includes(operation.command), 'Transactions accept document edits only; nesting and history operations are unsupported.');
          const options = operation.args ?? {};
          assert(options && typeof options === 'object' && !Array.isArray(options), 'Operation args must be an object.');
          assert(options.documentId === undefined || options.documentId === project.id, 'A transaction cannot switch documents.');
          assert(options.expectedRevision === undefined || options.expectedRevision === project.revision, 'Transaction operation revision mismatch.', 'REVISION_CONFLICT');
          const retainedMasks = hasDenseMasks(graph) || hasColorLookup(graph) || hasDistort(graph) || graph.layers.some(layer => positionedLayerMask(layer.mask) || storedFilterMask(layer.filters));
          await this.mutate(graph, operation.command, { ...options, documentId: project.id }, bakeContext);
          // Later transaction steps may render, segment or write assets. A
          // retained-frame resource failure must stop at its metadata step.
          if (retainedMasks || hasDenseMasks(graph) || hasColorLookup(graph) || hasDistort(graph) || graph.layers.some(layer => positionedLayerMask(layer.mask) || storedFilterMask(layer.filters))) this.validateGraph(graph);
        }
        return this.commit(project, graph, name(args.label, 'Edit transaction'));
      };
      return this.withRepairAssets(project, transaction, { bake: baking });
    }
    if (command === 'import_color_lookup') return this.withRepairAssets(project, async () => {
      const result = await this.mutate(graph, command, args, { validateCommit: candidate => this.serializeProject(this.buildCommit(project, candidate, 'Import Color Lookup')) });
      return { ...await this.commit(project, graph, result.label), layerId: result.layerId, ...(result.filterId ? { filterId: result.filterId } : {}) };
    });
    if (command === 'bake_layer_filters') return this.withRepairAssets(project, async () => {
      const label = await this.mutate(graph, command, args, { validateCommit: candidate => this.serializeProject(this.buildCommit(project, candidate, 'Bake layer filters')) });
      return this.commit(project, graph, label);
    }, { bake: true });
    if (command === 'create_repair_layer') return this.withRepairAssets(project, async () => {
      const created = await this.mutate(graph, command, args);
      return { ...await this.commit(project, graph, created.label), layerId: created.layerId };
    });
    return this.withRepairAssets(project, async () => {
      const label = await this.mutate(graph, command, args, { validateCommit: candidate => this.serializeProject(this.buildCommit(project, candidate, 'Edit document')) });
      return this.commit(project, graph, label);
    });
  }

  async importImage(args) {
    const formats = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/tiff': 'tiff' };
    assert(Object.hasOwn(formats, args.mimeType), 'Native imports support PNG, JPEG, WebP and TIFF only.', 'UNSUPPORTED');
    assert(typeof args.data === 'string' && args.data.length > 0 && args.data.length <= Math.ceil(MAX_BYTES / 3) * 4, 'Image must be base64 data no larger than 32 MiB.', 'LIMIT_EXCEEDED');
    assert(args.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(args.data), 'Invalid base64 image data.'); // non-backtracking: the grouped form overflowed the regex stack on ~6MB+ images
    const original = Buffer.from(args.data, 'base64');
    assert(original.length <= MAX_BYTES, 'Image exceeds the 32 MiB import limit.', 'LIMIT_EXCEEDED');
    let metadata, normalized;
    try {
      metadata = await sharp(original, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata();
      assert(metadata.format === formats[args.mimeType], 'Image content does not match its declared MIME type.');
      dimensions(metadata.width, metadata.height);
      assert((metadata.pages ?? 1) === 1, 'Animated or multipage files are not supported.', 'UNSUPPORTED');
      normalized = await sharp(original, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).rotate().toColourspace('srgb').ensureAlpha().png().toBuffer({ resolveWithObject: true });
    } catch (cause) {
      if (cause.code) throw cause;
      throw error('INVALID_IMAGE', `Image could not be decoded: ${cause.message}`);
    }
    dimensions(normalized.info.width, normalized.info.height);
    const sourceAsset = await this.storeAsset(original);
    const asset = await this.storeAsset(normalized.data);
    const graph = { name: name(args.name, 'Imported image'), width: normalized.info.width, height: normalized.info.height, selection: null,
      layers: [{ ...layerBase('Original', 'raster'), asset, sourceAsset, sourceFormat: metadata.format, sourceBitDepth: metadata.depth ?? 'unknown', width: normalized.info.width, height: normalized.info.height, transforms: [] }] };
    return this.newProject(graph, 'Import image');
  }

  mutateStructure(graph, command, args) {
    const tree = layerTree(graph.layers), node = tree.nodes.get(args.layerId);
    const clipping = clippingIndex(tree);
    if (['move_layer', 'reorder_layer', 'delete_layer', 'duplicate_layer'].includes(command)) assertNoClipping(clipping, args.layerId, 'changing its position, deleting it or duplicating it individually');
    const protectedScopes = protectedIsolationScopes(tree);
    const siblingsOf = (item) => item.parent ? item.parent.children : tree.roots;
    let label;
    if (command === 'create_group') {
      const parent = args.parentId == null ? null : tree.nodes.get(args.parentId);
      assert(args.parentId == null || parent?.layer.type === 'group', 'The destination parent must be an existing group.', 'INVALID_TARGET');
      const siblings = parent ? parent.children : tree.roots;
      const index = number(args.index ?? siblings.length, 'index', 0, siblings.length, true);
      const group = { ...layerBase(name(args.name, 'Group'), 'group'), mode: 'pass-through' };
      siblings.splice(index, 0, { layer: group, children: [], parent });
      label = 'Create layer group';
    } else if (command === 'group_layers') {
      assert(Array.isArray(args.layerIds) && args.layerIds.length > 0 && args.layerIds.length <= MAX_LAYERS && new Set(args.layerIds).size === args.layerIds.length, 'Choose one or more unique sibling layers to group.');
      const selected = args.layerIds.map((id) => tree.nodes.get(id));
      assert(selected.every(Boolean), 'A selected layer was not found.', 'NOT_FOUND');
      const parent = selected[0].parent;
      assert(selected.every((item) => item.parent === parent), 'Grouping requires layers with the same parent.');
      const siblings = parent ? parent.children : tree.roots, indices = selected.map((item) => siblings.indexOf(item)).sort((a, b) => a - b);
      assert(indices.at(-1) - indices[0] + 1 === selected.length, 'Choose contiguous sibling layers to preserve their stacking order.');
      const children = siblings.slice(indices[0], indices[0] + selected.length);
      siblings.splice(indices[0], selected.length, { layer: { ...layerBase(name(args.name, 'Group'), 'group'), mode: 'pass-through' }, children, parent });
      label = 'Group layers';
    } else {
      assert(node, 'Layer was not found.', 'NOT_FOUND');
      const siblings = siblingsOf(node), index = siblings.indexOf(node);
      if (command === 'ungroup_layer') {
        assert(node.layer.type === 'group', 'Choose a group to ungroup.', 'INVALID_TARGET');
        assert(!node.children.length || node.layer.mode === 'pass-through', 'Switch this group to pass-through explicitly before ungrouping its contents; isolation controls their adjustment and blending scope.', 'INVALID_TARGET');
        assert(!node.children.length || (node.layer.visible && node.layer.opacity === 1 && !node.layer.mask), 'Reset this group to visible, fully opaque and unmasked before ungrouping so its appearance is preserved.', 'INVALID_TARGET');
        siblings.splice(index, 1, ...node.children); label = `Ungroup ${node.layer.name}`;
      } else if (command === 'delete_layer') {
        assert(!containsProtected(node), 'Unprotect this layer and every protected descendant explicitly before deleting them.', 'PROTECTED_LAYER');
        siblings.splice(index, 1); label = `Delete ${node.layer.name}`;
      } else if (command === 'duplicate_layer') {
        assert(graph.layers.length + subtree(node).length <= MAX_LAYERS, 'Native documents support up to 64 total layer and group nodes.', 'LIMIT_EXCEEDED');
        const ids = new Map(subtree(node).map(({ layer }) => [layer.id, randomUUID()]));
        const clone = (source) => {
          const layer = { ...structuredClone(source.layer), id: ids.get(source.layer.id) };
          if (layer.clipBaseId !== undefined) layer.clipBaseId = ids.get(layer.clipBaseId);
          return { layer, children: source.children.map(clone), parent: null };
        };
        const copy = clone(node); copy.layer.name = `${node.layer.name.slice(0, 194)} copy`;
        siblings.splice(index + 1, 0, copy); label = `Duplicate ${node.layer.name}`;
      } else {
        let destination = siblings;
        if (command === 'move_layer') {
          assert(args.parentId === null || (typeof args.parentId === 'string' && ID.test(args.parentId)), 'parentId must be a group identifier or null for the document root.');
          const parent = args.parentId === null ? null : tree.nodes.get(args.parentId);
          assert(args.parentId === null || parent?.layer.type === 'group', 'The destination parent must be an existing group.', 'INVALID_TARGET');
          assert(!parent || !subtree(node).includes(parent), 'A layer group cannot be moved inside its own subtree.');
          destination = parent ? parent.children : tree.roots;
        } else number(args.index, 'index', 0, siblings.length - 1, true);
        siblings.splice(index, 1);
        const target = number(args.index ?? destination.length, 'index', 0, destination.length, true);
        destination.splice(target, 0, node); label = `${command === 'move_layer' ? 'Move' : 'Reorder'} ${node.layer.name}`;
      }
    }
    graph.layers = flattenTree(tree.roots);
    assertProtectedIsolationUnchanged(protectedScopes, layerTree(graph.layers));
    assert(graph.layers.length <= MAX_LAYERS, 'Native documents support up to 64 total layer and group nodes.', 'LIMIT_EXCEEDED');
    this.validateGraph(graph);
    return label;
  }

  mutate(graph, command, args, context) {
    return withMaskPreparationBudget(command === 'load_channel_selection' || command === 'load_color_range_selection' || hasDenseMasks(graph), () => this.mutatePrepared(graph, command, args, context));
  }

  async mutatePrepared(graph, command, args, context) {
    if (command === 'load_color_range_selection') {
      this.validateGraph(graph);
      const settings = normalizeColorRangeSettings({ colors: args.colors, tolerance: args.tolerance, falloff: args.falloff, invert: args.invert });
      const mode = args.mode ?? 'replace', n = graph.width * graph.height;
      assert(graph.selection || !['subtract', 'intersect'].includes(mode), 'Create a selection before combining.', 'NO_SELECTION');
      colorRangeComparisonWork(n, settings.colors.length);
      validateDenseMaskOperation(graph, { phases: [5 * n + 280, 2 * n + (mode === 'replace' ? 0 : maskBufferBytes(graph.selection)), 3 * n + 64], additionalWork: mode === 'replace' ? 0 : maskPreparationWork(graph.selection) });
      const alpha = await materializeColorRangeSelection(graph, args, value => this.renderGraph(value), mask => this.readDenseMask(mask));
      await this.publishMaskAlpha(graph, alpha, graph.width, graph.height, descriptor => { graph.selection = descriptor; }, args, context);
      return 'Load Color Range selection';
    }
    if (command === 'load_channel_selection') {
      const { mode } = normalizeChannelOptions(args), n = graph.width * graph.height;
      assert(graph.selection || !['subtract', 'intersect'].includes(mode), 'Create a selection before combining.', 'NO_SELECTION');
      validateDenseMaskOperation(graph, { phases: [5 * n, 2 * n + (mode === 'replace' ? 0 : maskBufferBytes(graph.selection)), 3 * n + 64], additionalWork: mode === 'replace' ? 0 : maskPreparationWork(graph.selection) });
      const alpha = await materializeChannelSelection(graph, args, value => this.renderGraph(value), mask => this.readDenseMask(mask));
      await this.publishMaskAlpha(graph, alpha, graph.width, graph.height, descriptor => { graph.selection = descriptor; }, args, context);
      return `Load ${args.channel ?? 'luma'} composite channel selection`;
    }
    if (command === 'import_color_lookup') return this.importColorLookupMutation(graph, args, context);
    if (FILTER_MASK_COMMANDS.includes(command)) {
      const layer = graph.layers.find(item => item.id === args.layerId);
      assert(layer, 'Layer was not found.', 'NOT_FOUND');
      assert(layer.type === 'raster', 'Shared filter masks require a raster layer.', 'INVALID_TARGET');
      assert(!layer.protected, 'Unprotect this layer explicitly before editing its filter mask.', 'PROTECTED_LAYER');
      this.validateGraph(graph);
      const filters = await editedFilterMask(layer, graph, command, args, {
        resolveAlpha8: mask => this.readDenseMask(mask),
        captureSelection: async () => {
          const alpha = await captureFilterMask(layer, graph, { resolveAlpha8: mask => this.readDenseMask(mask), returnAlpha: true });
          let coverage;
          await this.publishMaskAlpha(graph, alpha, layer.width, layer.height, descriptor => {
            coverage = descriptor;
            layer.filters = { version: 1, entries: structuredClone(filterEntries(layer.filters)), mask: { sourceWidth: layer.width, sourceHeight: layer.height, coverage: descriptor, density: 1, enabled: true } };
          }, args, context);
          return coverage;
        },
      });
      this.validateGraph({ ...graph, layers: graph.layers.map(item => item === layer ? { ...item, filters } : item) });
      const sourceMask = storedFilterMask(filters)?.coverage;
      if (isDenseMask(sourceMask)) {
        context?.validateCommit?.({ ...graph, layers: graph.layers.map(item => item === layer ? { ...item, filters } : item) });
        await this.readDenseMask(sourceMask);
      }
      layer.filters = filters;
      return ({ set_layer_filter_mask: 'Set filter effect mask', modify_layer_filter_mask: 'Edit filter effect mask', clear_layer_filter_mask: 'Remove filter effect mask' })[command];
    }
    if (command === 'bake_layer_filters') {
      this.validateGraph(graph);
      const plan = planFilterBake(graph, args.layerId);
      // Reuse the old 64-character hash as a same-size placeholder. Only the
      // current asset and filters change, so actual publication cannot enlarge
      // this prospective graph. Later transaction edits still validate at commit.
      const candidate = { ...graph, layers: graph.layers.map(layer => layer.id === plan.layer.id ? { ...layer, filters: [] } : layer) };
      this.validateGraph(candidate);
      assert(typeof context?.validateCommit === 'function', 'Filter baking requires a revision-bound publication context.', 'INVALID_ARGUMENTS');
      context.validateCommit(candidate);
      if (plan.active) {
        const { data } = await bakeFilterSource({ layer: plan.layer, filters: plan.filters, assetsDir: this.assetsDir, tempRoot: this.dataDir, prepareColorLookup: parameters => this.prepareColorLookup(parameters), resolveAlpha8: mask => this.readDenseMask(mask) });
        if (data) plan.layer.asset = await this.storeAsset(data);
      }
      plan.layer.filters = [];
      return 'Bake layer filters';
    }
    if (command === 'create_repair_layer') {
      this.validateGraph(graph);
      const tree = layerTree(graph.layers), source = retouchRoot(tree, clippingIndex(tree), args.sourceLayerId).layer;
      assert(graph.layers.length < MAX_LAYERS, 'Native documents support up to 64 layers.', 'LIMIT_EXCEEDED');
      const layerId = args.newLayerId === undefined ? randomUUID() : args.newLayerId;
      assert(typeof layerId === 'string' && NEW_LAYER_UUID.test(layerId), 'newLayerId must be a lowercase UUID.');
      assert(!tree.nodes.has(layerId), 'newLayerId already belongs to a document layer.');
      const layerName = name(args.name, `${source.name.slice(0, 193)} repair`);
      const created = await this.addPaintLayer(graph, layerName, layerId);
      graph.layers.pop();
      graph.layers.splice(graph.layers.indexOf(source) + 1, 0, created);
      return { label: 'Create repair layer', layerId };
    }
    if (command === 'load_layer_selection') {
      this.validateGraph(graph);
      const staged = await loadLayerSelection(graph, args, {
        returnAlpha: true, resolveAlpha8: mask => this.readDenseMask(mask),
        renderLayer: (layer, options) => this.renderLayer(layer, options),
        sourceAssetBytes: async layer => {
          const size = async asset => {
            const stat = await fs.stat(path.join(this.assetsDir, asset));
            assert(stat.isFile() && stat.size > 0 && stat.size <= PROJECT_BUNDLE_LIMITS.maxAssetBytes, 'Invalid source asset.', 'INVALID_IMAGE');
            return stat.size;
          };
          return { encodedSourceBytes: await size(layer.asset), encodedAlphaBytes: layer.alphaAsset ? await size(layer.alphaAsset) : 0 };
        },
      });
      await this.publishMaskAlpha(graph, staged.alpha, graph.width, graph.height, descriptor => { graph.selection = descriptor; }, args, context);
      return staged.label;
    }
    if (command === 'set_clipping_chain') {
      const layers = changedClippingLayers(graph, layerTree(graph.layers), args);
      this.validateGraph({ ...graph, layers });
      graph.layers = layers;
      return args.layerIds.length ? 'Set clipping chain' : 'Release clipping chain';
    }
    if (GUIDE_COMMANDS.includes(command)) {
      const updated = updatedGuides(graph, command, args);
      graph.guides = updated.guides;
      return updated.label;
    }
    if (command === 'set_group_compositing') {
      const tree = layerTree(graph.layers), node = tree.nodes.get(args.layerId), blendMode = args.blendMode ?? 'normal';
      assert(node, 'Layer was not found.', 'NOT_FOUND');
      assert(node.layer.type === 'group', 'Choose a group to change compositing.', 'INVALID_TARGET');
      assert(['pass-through', 'isolated'].includes(args.mode) && BLENDS.includes(blendMode), 'Choose a supported group mode and blend mode.', 'INVALID_ARGUMENT');
      assert(args.mode === 'isolated' || blendMode === 'normal', 'Pass-through groups require normal blending.', 'UNSUPPORTED');
      assert(args.mode === node.layer.mode || !containsProtected(node), 'Unprotect every protected descendant explicitly before changing this group’s compositing mode.', 'PROTECTED_LAYER');
      const changed = { ...node.layer, mode: args.mode, blendMode };
      this.validateGraph({ ...graph, layers: graph.layers.map(layer => layer.id === changed.id ? changed : layer) });
      Object.assign(node.layer, { mode: args.mode, blendMode });
      return `Set group ${args.mode} compositing`;
    }
    if (LAYER_STYLE_COMMANDS.includes(command)) {
      const updated = updatedLayerStyles(graph, command, args);
      this.validateGraph(updated.graph);
      graph.layers = updated.graph.layers;
      if (updated.graph.layerStyles !== undefined) graph.layerStyles = updated.graph.layerStyles;
      return updated.label;
    }
    if (MORPHOLOGY_COMMANDS.includes(command)) {
      assert(MORPHOLOGY_OPERATIONS.includes(args.operation), 'Choose expand, contract, border or smooth.');
      number(args.radius, 'radius', 1, 100, true);
      const target = command === 'morph_layer_mask' ? graph.layers.find(layer => layer.id === args.layerId) : null;
      if (command === 'morph_layer_mask') assert(target, 'Layer was not found.', 'NOT_FOUND');
      const mask = target ? target.mask : graph.selection, n = graph.width * graph.height;
      assert(mask, 'Create a mask or selection before reshaping it.', target ? 'NO_MASK' : 'NO_SELECTION');
      assertDenseMaskBudget(Math.max(maskBufferBytes(mask) + n, 4 * n + 4 * Math.max(graph.width, graph.height), 3 * n + 64), maskPreparationWork(mask));
      const alpha = await materializeMorphology(graph, target, args, mask => this.readDenseMask(mask));
      await this.publishMaskAlpha(graph, alpha, graph.width, graph.height, descriptor => { if (target) target.mask = descriptor; else graph.selection = descriptor; }, args, context);
      return `${args.operation[0].toUpperCase()}${args.operation.slice(1)} ${target ? 'layer mask' : 'selection'}`;
    }
    if (DISTORT_COMMANDS.includes(command)) {
      const layer = graph.layers.find(item => item.id === args.layerId);
      assert(layer, 'Layer was not found.', 'NOT_FOUND');
      assert(DISTORT_CONTENT_TYPES.includes(layer.type), 'Distort requires an individual image, solid, text, shape, path or gradient layer.', 'INVALID_TARGET');
      assert(!layer.protected, 'Unprotect this layer explicitly before adding, editing or removing Distort.', 'PROTECTED_LAYER');
      const transforms = [...layer.transforms];
      if (command === 'add_layer_distort') transforms.push(createDistort(graph.width, graph.height, args.corners));
      else {
        const index = args.transformIndex;
        assert(Number.isInteger(index) && index >= 0 && index < transforms.length, 'Distort stage was not found.', 'NOT_FOUND');
        assert(transforms[index].type === 'distort', 'Choose a Distort stage from the complete geometry list.', 'INVALID_TARGET');
        if (command === 'delete_layer_distort') transforms.splice(index, 1);
        else transforms[index] = createDistort(transforms[index].width, transforms[index].height, args.corners);
      }
      this.validateGraph({ ...graph, layers: graph.layers.map(item => item.id === layer.id ? { ...layer, transforms } : item) });
      layer.transforms = transforms;
      return ({ add_layer_distort: 'Add layer Distort', update_layer_distort: 'Update layer Distort', delete_layer_distort: 'Remove layer Distort' })[command];
    }
    if (LAYER_FILTER_COMMANDS.includes(command)) {
      const layer = graph.layers.find((item) => item.id === args.layerId);
      assert(layer, 'Layer was not found.', 'NOT_FOUND');
      assert(layer.type === 'raster', 'Editable filters require a raster layer. Rasterize the selected vector or text layer first.', 'INVALID_TARGET');
      assert(!layer.protected, 'Unprotect this layer explicitly before editing its filter stack.', 'PROTECTED_LAYER');
      const filters = editedFilterStack(layer.filters, command, args);
      // Resource, protection and graph checks happen before changing this
      // staged graph; invalid stacks cannot write assets or consume history.
      this.validateGraph({ ...graph, layers: graph.layers.map((item) => item.id === layer.id ? { ...layer, filters } : item) });
      layer.filters = filters;
      const lookup = command === 'add_layer_filter' ? filterEntries(filters).at(-1) : command === 'update_layer_filter' ? filterEntries(filters).find(entry => entry.id === args.filterId) : null;
      if (lookup?.kind === 'color_lookup' && (command === 'add_layer_filter' || args.parameters !== undefined && Reflect.ownKeys(args.parameters).length)) {
        context?.validateCommit?.(graph);
        await this.verifyColorLookup(lookup.parameters);
      }
      return ({ add_layer_filter: 'Add layer filter', update_layer_filter: 'Update layer filter', reorder_layer_filter: 'Reorder layer filter', delete_layer_filter: 'Delete layer filter', clear_layer_filters: 'Clear layer filters' })[command];
    }
    if (command === 'align_layers' || command === 'distribute_layers') {
      const minimum = command === 'distribute_layers' ? 3 : (args.relativeTo ?? 'canvas') === 'layers' ? 2 : 1;
      assert(Array.isArray(args.layerIds) && args.layerIds.length >= minimum && args.layerIds.length <= MAX_LAYERS && args.layerIds.every((id) => typeof id === 'string' && ID.test(id)) && new Set(args.layerIds).size === args.layerIds.length, `Choose ${minimum}–64 unique content layers for this arrangement.`);
      const ids = new Set(args.layerIds), targets = graph.layers.filter((item) => ids.has(item.id)), tree = layerTree(graph.layers);
      const clipping = clippingIndex(tree);
      assert(targets.length === ids.size, 'A selected arrangement layer was not found.', 'NOT_FOUND');
      // Validate every target before reading source pixels or changing geometry.
      for (const layer of targets) {
        assertNoClipping(clipping, layer.id, 'arranging it');
        assert(contentLayer(layer), 'Arrange individual content layers; group and adjustment targets are unsupported.', 'INVALID_TARGET');
        assert(layer.visible && layer.opacity > 0, 'Reveal every selected layer and give it nonzero opacity before arranging it.', 'INVALID_TARGET');
        assert(!layer.mask, 'Remove the selected layer’s canvas-anchored mask before arranging it. Source cutout alpha can remain enabled.', 'INVALID_TARGET');
        const blocked = ancestors(tree.nodes.get(layer.id)).find(({ layer }) => layer.mode === 'isolated' || !layer.visible || layer.opacity !== 1 || layer.mask);
        assert(!blocked, `Group ${blocked?.layer.name ?? ''} must use pass-through compositing and be visible, fully opaque and unmasked before arranging its content. Reset the group or move the layer outside it.`, 'INVALID_TARGET');
      }
      const items = [];
      for (const layer of targets) {
        const pixels = await this.visibleLayerPixels(graph, layer, { outline: false, effects: false }), bounds = alphaBounds(pixels, graph.width, graph.height);
        assert(bounds, 'A selected layer has no nonzero-alpha content to arrange.', 'EMPTY_LAYER');
        items.push({ id: layer.id, bounds: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height } });
      }
      const options = { ...args, items, width: graph.width, height: graph.height };
      const plan = command === 'align_layers' ? planAlignment(options) : planDistribution(options);
      for (const move of plan) if (move.x || move.y) tree.nodes.get(move.layerId).layer.transforms.push(affineOptions(move, graph.width, graph.height));
      return command === 'align_layers' ? 'Align layers' : 'Distribute layers';
    }
    if (SAVED_SELECTION_COMMANDS.includes(command)) {
      if (command !== 'load_selection' || (args.mode ?? 'replace') === 'replace' || !graph.selection && (args.mode ?? 'replace') === 'add') return mutateSavedSelection(graph, command, args);
      const saved = graph.savedSelections?.find(item => item.id === args.selectionId);
      assert(saved, 'Saved selection was not found.', 'NOT_FOUND');
      assert(graph.selection, 'Create an active selection before combining.', 'NO_SELECTION');
      assert(['add', 'subtract', 'intersect'].includes(args.mode), 'Invalid selection combination mode.');
      const n = graph.width * graph.height, a = graph.selection, b = saved.mask;
      const aBytes = maskBufferBytes(a, { feather: false }), bBytes = maskBufferBytes(b, { feather: false });
      assertDenseMaskBudget(Math.max(maskBufferBytes(a), aBytes + maskBufferBytes(b), aBytes + bBytes + n, 3 * n + 64), maskPreparationWork(a) + maskPreparationWork(b));
      const alpha = await materializeSavedCombination(a, b, graph.width, graph.height, args.mode, mask => this.readDenseMask(mask));
      await this.publishMaskAlpha(graph, alpha, graph.width, graph.height, descriptor => { graph.selection = descriptor; }, args, context);
      return `Load selection (${args.mode})`;
    }
    if (['create_group', 'group_layers', 'ungroup_layer', 'move_layer', 'duplicate_layer', 'delete_layer', 'reorder_layer'].includes(command)) return this.mutateStructure(graph, command, args);
    let layer;
    if (LAYER_MASK_POSITION_COMMANDS.includes(command)) {
      layer = graph.layers.find(item => item.id === args.layerId);
      assert(layer, 'Layer was not found.', 'NOT_FOUND');
      assert(layer.mask, 'Create an additional layer mask before positioning it.', 'NO_MASK');
      if (command === 'set_layer_mask_position') {
        const mask = setLayerMaskPosition(layer, graph.width, graph.height, args.x, args.y);
        this.validateGraph({ ...graph, layers: graph.layers.map(item => item === layer ? { ...layer, mask } : item) });
        layer.mask = mask;
        return 'Position layer mask';
      }
      assert(positionedLayerMask(layer.mask), 'This additional layer mask has no retained position to rasterize.', 'MASK_NOT_POSITIONED');
      assertDenseMaskBudget(Math.max(maskBufferBytes(layer.mask) + graph.width * graph.height, 3 * graph.width * graph.height + 64), maskPreparationWork(layer.mask));
      const alpha = await materializeMaskAlpha(layer.mask, graph.width, graph.height, mask => this.readDenseMask(mask), { layer });
      await this.publishMaskAlpha(graph, alpha, graph.width, graph.height, descriptor => { layer.mask = descriptor; }, args, context);
      return 'Rasterize mask position';
    }
    if(command==='modify_layer_mask'){
      layer=graph.layers.find(item=>item.id===args.layerId);
      assert(layer,'Layer was not found.','NOT_FOUND');
      assert(layer.mask,'The layer has no mask to refine.','NO_MASK');
      if (args.density !== undefined) {
        const density = number(args.density, 'density', 0, 1);
        if (density === 1) delete layer.maskDensity;
        else layer.maskDensity = density;
      }
      const source = layerMaskSource(layer);
      if(args.feather!==undefined)source.feather=number(args.feather,'feather',0,100);
      if(args.invert!==undefined){assert(typeof args.invert==='boolean','invert must be boolean.');source.invert=args.invert;}
      return 'Refine layer mask';
    }
    if (['set_layer', 'duplicate_layer', 'delete_layer', 'reorder_layer', 'rasterize_layer', 'update_adjustment', 'update_text', 'set_layer_mask', 'transform_layer', 'update_shape', 'update_path', 'update_gradient', 'fill_area', 'mask_from_selection', 'paint_mask', 'extract_subject', 'set_layer_outline', 'set_layer_protection', 'paint_cutout_mask', 'refine_cutout_from_selection', 'set_layer_effects', 'set_layer_fill'].includes(command)) {
      layer = graph.layers.find((item) => item.id === args.layerId);
      assert(layer, 'Layer was not found.', 'NOT_FOUND');
    }
    if (['add_adjustment', 'add_text', 'duplicate_layer', 'add_paint_layer', 'add_shape', 'add_path', 'add_gradient', 'extract_subject', 'place_layer'].includes(command)) assert(graph.layers.length < MAX_LAYERS, 'Native documents support up to 64 layers.', 'LIMIT_EXCEEDED');
    if (layer?.protected && ['fill_area', 'update_text', 'update_shape', 'update_path', 'update_gradient', 'delete_layer'].includes(command)) throw error('PROTECTED_LAYER', 'Unprotect this layer explicitly before changing its pixels or content.');
    if (layer && filterEntries(layer.filters).length && ['fill_area', 'extract_subject', 'paint_cutout_mask', 'refine_cutout_from_selection'].includes(command)) throw error('FILTER_STACK_ACTIVE', 'Bake or clear this layer’s filter stack explicitly before changing or extracting source pixels or source alpha. Disabled entries must also be removed; painting on another layer remains available.');
    switch (command) {
      case 'set_layer_fill': {
        assert(LAYER_FILL_CONTENT_TYPES.includes(layer.type), 'Layer Fill requires an individual content layer.', 'INVALID_TARGET');
        const fill = normalizeLayerFillOpacity(args.fillOpacity);
        assert(!layer.protected || fill === layerFillOpacity(layer), 'Unprotect this layer explicitly before changing its Fill.', 'PROTECTED_LAYER');
        assert(fill === 1 || !clippingIndex(layerTree(graph.layers)).participants.has(layer.id), 'Release this layer’s clipping chain before changing its Fill.', 'INVALID_TARGET');
        const changed = setLayerFillOpacity(layer, fill);
        this.validateGraph({ ...graph, layers: graph.layers.map(item => item === layer ? changed : item) });
        graph.layers[graph.layers.indexOf(layer)] = changed;
        return 'Set layer Fill';
      }
      case 'set_layer_protection': {
        assert(typeof args.protected === 'boolean', 'protected must be boolean.');
        assert(contentLayer(layer), 'Protect individual content layers, not groups or adjustments.', 'INVALID_TARGET');
        assert(!args.protected || !hasActiveFilters(layer), 'Disable or clear every active filter before protecting this layer.', 'PROTECTED_LAYER');
        layer.protected = args.protected; return args.protected ? 'Protect layer' : 'Unprotect layer';
      }
      case 'set_layer_outline': {
        assert(contentLayer(layer), 'Outlines require an individual content layer.', 'INVALID_TARGET');
        layer.outline = { width: number(args.width, 'outline width', 0, 64), color: color(args.color ?? '#ffffff') };
        return 'Set outside outline';
      }
      case 'set_layer_effects': {
        assert(contentLayer(layer), 'Layer effects require an individual content layer.', 'INVALID_TARGET');
        assert(args.effects !== undefined, 'effects is required; use null or an empty object to clear layer effects.');
        const effects = normalizeEffects(args.effects);
        graph.layers[graph.layers.indexOf(layer)] = setLayerOutsideEffects(layer, effects);
        return effects ? 'Set outside layer effects' : 'Clear outside layer effects';
      }
      case 'refine_cutout_from_selection': {
        assert(layer.type === 'raster' && layer.alphaAsset, 'Select an extracted source cutout with a separate alpha mask.', 'INVALID_TARGET');
        assert(!layer.placement && layer.transforms.length === 0 && layer.width === graph.width && layer.height === graph.height,
          'Refine the extracted source cutout before placement or geometry transforms, then place it again.', 'INVALID_TARGET');
        assert(graph.selection, 'Create a selection around the source details to refine.', 'NO_SELECTION');
        const mode = args.mode ?? 'add';
        assert(['add', 'subtract', 'intersect', 'replace'].includes(mode), 'Invalid cutout selection refinement mode.');
        if (hasDenseMasks(graph)) assertDenseMaskBudget(graph.width * graph.height + maskBufferBytes(graph.selection), maskPreparationWork(graph.selection));
        const alpha = await this.readAlpha(layer.alphaAsset, layer.width, layer.height);
        const coverage = await this.prepareMaskCoverage(graph.selection);
        for (let y = 0; y < graph.height; y++) for (let x = 0; x < graph.width; x++) {
          const i = y * graph.width + x, selected = coverage(x, y);
          alpha[i] = mode === 'add' ? Math.max(alpha[i], Math.round(selected * 255))
            : mode === 'subtract' ? Math.round(alpha[i] * (1 - selected))
            : mode === 'intersect' ? Math.round(alpha[i] * selected)
            : Math.round(selected * 255);
          if (isDenseMask(graph.selection) && (i + 1) % 65536 === 0) await yieldEventLoop();
        }
        layer.alphaAsset = await this.storeAlpha(alpha, graph.width, graph.height);
        return `Refine cutout from selection (${mode})`;
      }
      case 'paint_cutout_mask': {
        assert(layer.type === 'raster' && layer.alphaAsset, 'Select an extracted source cutout with a separate alpha mask.', 'INVALID_TARGET');
        assert(!layer.placement && layer.transforms.length === 0 && layer.width === graph.width && layer.height === graph.height,
          'Refine the extracted source cutout before placement or geometry transforms, then place it again. Undo its transforms or reopen the original source to refine its alpha.', 'INVALID_TARGET');
        const mode = args.mode ?? 'add';
        assert(['add', 'subtract', 'replace'].includes(mode), 'Cutout mask mode must be add, subtract or replace.');
        const alpha = await this.readAlpha(layer.alphaAsset, layer.width, layer.height);
        const pixels = Buffer.alloc(graph.width * graph.height * 4, 255);
        for (let i = 0; i < alpha.length; i++) pixels[i * 4 + 3] = mode === 'replace' ? 0 : alpha[i];
        const painted = applyStroke({ pixels, width: graph.width, height: graph.height, tool: mode === 'subtract' ? 'eraser' : 'brush', color: '#ffffff', points: args.points, size: args.size, hardness: args.hardness ?? 1, opacity: args.opacity ?? 1 });
        for (let i = 0; i < alpha.length; i++) alpha[i] = painted[i * 4 + 3];
        layer.alphaAsset = await this.storeAlpha(alpha, graph.width, graph.height);
        return 'Refine cutout alpha';
      }
      case 'extract_subject': {
        assertNoClipping(clippingIndex(layerTree(graph.layers)), layer.id, 'extracting its source');
        assert(this.segmentSubject, 'Local subject segmentation is not configured.', 'UNSUPPORTED');
        assert(layer.type === 'raster', 'Subject extraction requires a raster photo layer.', 'INVALID_TARGET');
        assert(args.protect === undefined || typeof args.protect === 'boolean', 'protect must be boolean.');
        assert(args.hideOriginal === undefined || typeof args.hideOriginal === 'boolean', 'hideOriginal must be boolean.');
        if (args.protect ?? true) assert(ancestors(layerTree(graph.layers).nodes.get(layer.id)).every(({ layer }) => layer.opacity === 1 && layer.blendMode === 'normal'), 'Unprotect the new cutout explicitly or reset ancestor opacity and blending before extracting it into this group.', 'PROTECTED_LAYER');
        const cutoutId = randomUUID(), cutoutName = name(args.name, `${layer.name.slice(0, 191)} cutout`);
        if (graph.layers.some(item => positionedLayerMask(item.mask))) {
          const prospective = { ...structuredClone(layer), id: cutoutId, name: cutoutName, visible: true, role: 'cutout', protected: args.protect ?? true };
          const layers = graph.layers.map(item => item === layer && (args.hideOriginal ?? true) ? { ...item, visible: false } : item);
          layers.splice(graph.layers.indexOf(layer) + 1, 0, prospective);
          this.validateGraph({ ...graph, layers });
        }
        const sourcePixels = await this.sourcePixels(layer);
        const segmented = await this.segmentPixels(sourcePixels, layer.width, layer.height);
        let alpha = segmented.alpha;
        if (layer.alphaAsset) {
          const previous = await this.readAlpha(layer.alphaAsset, layer.width, layer.height);
          alpha = Buffer.from(alpha);
          for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round(alpha[i] * previous[i] / 255);
        }
        const alphaAsset = await this.storeAlpha(alpha, layer.width, layer.height);
        const cutout = { ...structuredClone(layer), id: cutoutId, name: cutoutName, visible: true, role: 'cutout', protected: args.protect ?? true, alphaAsset, cutout: { model: segmented.model, sourceLayerId: layer.id } };
        graph.layers.splice(graph.layers.indexOf(layer) + 1, 0, cutout);
        if (args.hideOriginal ?? true) layer.visible = false;
        return 'Extract subject';
      }
      case 'select_subject': {
        assert(this.segmentSubject, 'Local subject segmentation is not configured.', 'UNSUPPORTED');
        const alpha = await this.subjectSelectionAlpha(graph, args);
        await this.publishMaskAlpha(graph, alpha, graph.width, graph.height, descriptor => { graph.selection = descriptor; }, args, context);
        return 'Select subject';
      }
      case 'place_layer': {
        const box = rectangle(args, graph);
        assert(args.protect === undefined || typeof args.protect === 'boolean', 'protect must be boolean.');
        const sourceProject = this.project(args.sourceDocumentId, args.sourceExpectedRevision);
        const sourceGraph = args.sourceDocumentId === args.documentId ? graph : graphOf(sourceProject);
        const sourceLayer = sourceGraph.layers.find((item) => item.id === args.sourceLayerId);
        assertNoClipping(clippingIndex(layerTree(sourceGraph.layers)), args.sourceLayerId, 'placing it in another layer');
        assert(sourceLayer && contentLayer(sourceLayer), 'Place an individual raster, text, vector or gradient layer; group placement is unsupported.', 'INVALID_TARGET');
        assert(!filterEntries(sourceLayer.filters).length, 'Bake or clear the source layer’s filter stack explicitly before placement. Placement does not implicitly bake filters or change their source-pixel coordinates.', 'FILTER_STACK_ACTIVE');
        const nonneutral = ancestors(layerTree(sourceGraph.layers).nodes.get(sourceLayer.id)).find(({ layer }) => layer.mode === 'isolated' || layer.opacity !== 1 || layer.mask);
        assert(!nonneutral, `Group ${nonneutral?.layer.name ?? ''} has ${nonneutral?.layer.mode === 'isolated' ? 'isolated compositing' : nonneutral?.layer.mask ? 'a mask' : 'reduced opacity'}. Move the source layer out of that group or reset its compositing, mask and opacity before placing it, to preserve soft alpha and editable effects.`, 'INVALID_TARGET');
        const sourceOpacity = sourceLayer.opacity * (await this.ancestorContext(sourceGraph, sourceLayer)).opacity;
        assert(sourceOpacity > 0, 'The source layer has no visible pixels to place.', 'EMPTY_LAYER');
        // Keep opacity as an editable layer property. Baking it into the alpha
        // changes blur rounding and the opacity of overlapping outside styles.
        const source = await this.visibleLayerPixels(sourceGraph, { ...sourceLayer, opacity: 1 }, { outline: false, effects: false, ancestorOpacity: false, fill: false });
        const bounds = alphaBounds(source, sourceGraph.width, sourceGraph.height);
        assert(bounds, 'The source layer has no visible pixels to place.', 'EMPTY_LAYER');
        const scale = Math.min(box.width / bounds.width, box.height / bounds.height);
        const width = Math.max(1, Math.min(box.width, Math.round(bounds.width * scale))), height = Math.max(1, Math.min(box.height, Math.round(bounds.height * scale)));
        let image = rawImage(source, sourceGraph.width, sourceGraph.height).extract(bounds);
        if (width !== bounds.width || height !== bounds.height) image = image.resize(width, height, { fit: 'fill', kernel: 'lanczos3' });
        const resized = await image.raw().toBuffer(), placed = Buffer.alloc(graph.width * graph.height * 4), alpha = Buffer.alloc(graph.width * graph.height);
        const left = box.x + Math.floor((box.width - width) / 2), top = box.y + Math.floor((box.height - height) / 2);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const from = (y * width + x) * 4, to = ((top + y) * graph.width + left + x) * 4;
          placed[to] = resized[from]; placed[to + 1] = resized[from + 1]; placed[to + 2] = resized[from + 2]; alpha[to / 4] = resized[from + 3];
        }
        for (let i = 3; i < placed.length; i += 4) placed[i] = 255;
        const asset = await this.storeAsset(await rawImage(placed, graph.width, graph.height).png().toBuffer());
        const alphaAsset = await this.storeAlpha(alpha, graph.width, graph.height);
        const placedLayer = { ...layerBase(name(args.name, sourceLayer.name), 'raster'), opacity: sourceOpacity, role: 'cutout', protected: args.protect ?? true, asset, alphaAsset, sourceAsset: sourceLayer.sourceAsset ?? asset, sourceFormat: sourceLayer.sourceFormat ?? 'png', width: graph.width, height: graph.height, transforms: [], origin: { documentId: sourceProject.id, layerId: sourceLayer.id }, placement: { x: left, y: top, width, height, sourceBounds: bounds } };
        if (sourceLayer.outline) placedLayer.outline = structuredClone(sourceLayer.outline);
        if (sourceLayer.effects) placedLayer.effects = structuredClone(sourceLayer.effects);
        if (sourceLayer.cutout) placedLayer.cutout = structuredClone(sourceLayer.cutout);
        if (sourceLayer.provenance) placedLayer.provenance = structuredClone(sourceLayer.provenance);
        graph.layers.push(placedLayer);
        return 'Place layer proportionally';
      }
      case 'select_color': {
        const mode = args.mode ?? 'replace', combining = mode !== 'replace' && graph.selection;
        assert(graph.selection || !['subtract', 'intersect'].includes(mode), 'Create a selection before combining.', 'NO_SELECTION');
        if (hasDenseMasks(graph) || combining) validateDenseMaskOperation(graph, { phases: [10 * graph.width * graph.height + (combining ? maskBufferBytes(graph.selection) : 0), 3 * graph.width * graph.height + 64], additionalWork: combining ? maskPreparationWork(graph.selection) : 0 });
        const candidate = selectColorAlpha({ x: args.x, y: args.y, tolerance: args.tolerance, contiguous: args.contiguous, pixels: await this.renderGraph(graph), width: graph.width, height: graph.height });
        const alpha = await combineMaskAlpha(graph.selection, candidate, graph.width, graph.height, mode, mask => this.readDenseMask(mask));
        await this.publishMaskAlpha(graph, alpha, graph.width, graph.height, descriptor => { graph.selection = descriptor; }, args, context);
        return 'Select by color';
      }
      case 'mask_from_selection': {
        assert(graph.selection, 'Create a selection first.', 'NO_SELECTION');
        layer.mask = structuredClone(graph.selection); delete layer.maskDensity; return 'Mask from selection';
      }
      case 'paint_selection': case 'paint_mask': {
        const target = command === 'paint_mask' ? layer : null, selection = target ? target.mask : graph.selection, n = graph.width * graph.height;
        assertDenseMaskBudget(Math.max((args.mode === 'replace' ? 0 : maskBufferBytes(selection)) + 10 * n, 3 * n + 64), args.mode === 'replace' ? 0 : maskPreparationWork(selection));
        const alpha = await materializePaintMask(graph, target, args, mask => this.readDenseMask(mask));
        await this.publishMaskAlpha(graph, alpha, graph.width, graph.height, descriptor => { if (target) target.mask = descriptor; else graph.selection = descriptor; }, args, context);
        return command === 'paint_mask' ? 'Paint layer mask' : 'Paint selection';
      }
      case 'fill_area': {
        assert(layer.type === 'raster', 'Fill requires a raster layer. Add a paint layer or rasterize the selected layer.', 'INVALID_TARGET');
        assert(['color', 'erase'].includes(args.mode ?? 'color'), 'Fill mode must be color or erase.');
        assert((args.x === undefined) === (args.y === undefined), 'Specify both fill x and y, or omit both.');
        if (hasDenseMasks(graph)) { const n = graph.width * graph.height; validateDenseMaskOperation(graph, { retainedBytes: maskBufferBytes(graph.selection) + 5 * n, phases: [maskBufferBytes(graph.selection) + 10 * n], additionalWork: maskPreparationWork(graph.selection) + protectedMaskPreparationWork(graph) }); }
        const selection = await this.prepareMaskCoverage(graph.selection);
        const floodAlpha = args.x === undefined ? null : selectColorAlpha({ ...args, pixels: await this.renderGraph(graph), width: graph.width, height: graph.height });
        const flood = floodAlpha ? (x, y) => floodAlpha[y * graph.width + x] / 255 : () => 1;
        const pixels = await this.renderLayer(layer);
        const protectedPixels = await this.protectedPixels(graph);
        const output = fillPixels({ ...args, pixels, width: graph.width, height: graph.height, erase: args.mode === 'erase', coverage: (x, y) => protectedPixels[y * graph.width + x] ? 0 : selection(x, y) * flood(x, y) });
        layer.asset = await this.storeAsset(await rawImage(output, graph.width, graph.height).png().toBuffer());
        layer.width = graph.width; layer.height = graph.height; layer.transforms = [];
        delete layer.alphaAsset;
        return args.mode === 'erase' ? 'Erase selected area' : 'Fill selected area';
      }
      case 'add_shape': case 'add_path': case 'add_gradient': case 'update_shape': case 'update_path': case 'update_gradient': {
        const type = command.split('_')[1], updating = command.startsWith('update_');
        if (updating) assert(layer.type === type, `Select a ${type} layer to update.`, 'INVALID_TARGET');
        const key = type === 'gradient' ? 'gradient' : 'vector';
        const input = updating ? { ...layer[key], ...args } : args;
        const settings = type === 'shape' ? normalizeShape(input) : type === 'path' ? normalizePath(input) : normalizeGradient(input);
        if (updating) {
          layer[key] = settings;
          if (args.name !== undefined) layer.name = name(args.name);
        } else graph.layers.push({ ...layerBase(name(args.name, type === 'shape' ? `${settings.shape[0].toUpperCase()}${settings.shape.slice(1)}` : type === 'path' ? 'Path' : 'Gradient'), type), [key]: settings, width: graph.width, height: graph.height, transforms: [], ...(type === 'gradient' && graph.selection ? { mask: normalizeMask(graph.selection, graph.width, graph.height, { persisted: true }) } : {}) });
        return `${updating ? 'Update' : 'Add'} ${type}`;
      }
      case 'add_adjustment': {
        assert(Object.hasOwn(ADJUSTMENTS, args.kind), 'Unsupported adjustment kind.', 'UNSUPPORTED');
        adjustmentValue(args.kind, args.value);
        const mask = args.mask ? normalizeMask(args.mask, graph.width, graph.height) : graph.selection ? normalizeMask(graph.selection, graph.width, graph.height, { persisted: true }) : null;
        const parameters = normalizeParameters(args.kind, args.parameters);
        const defaultName = ({ color_balance: 'Color Balance', black_white: 'Black & White', channel_mixer: 'Channel Mixer', gradient_map: 'Gradient Map', selective_color: 'Selective Color', hue_saturation: 'Hue / Saturation', photo_filter: 'Photo Filter' })[args.kind] ?? `${args.kind[0].toUpperCase()}${args.kind.slice(1)}`;
        graph.layers.push({ ...layerBase(name(args.name, defaultName), 'adjustment'), kind: args.kind, value: args.value, mask, ...(parameters ? { parameters } : {}) });
        if (args.kind === 'color_lookup') { this.validateGraph(graph); context?.validateCommit?.(graph); await this.verifyColorLookup(parameters); }
        return `Add ${args.kind}`;
      }
      case 'update_adjustment': {
        assert(layer.type === 'adjustment', 'Select an adjustment layer to update.', 'INVALID_TARGET');
        if (args.value !== undefined) layer.value = adjustmentValue(layer.kind, args.value);
        if (args.parameters !== undefined) {
          assert(args.parameters && typeof args.parameters === 'object' && !Array.isArray(args.parameters), 'parameters must be an object.');
          layer.parameters = layer.kind === 'photo_filter' ? mergePhotoFilterParameters(layer.parameters, args.parameters) : layer.kind === 'color_lookup' ? mergeColorLookupParameters(layer.parameters, args.parameters) : layer.kind === 'curves' ? mergeCurvesParameters(layer.parameters, args.parameters) : normalizeParameters(layer.kind, { ...layer.parameters, ...args.parameters });
        }
        if (args.mask !== undefined) {
          layer.mask = args.mask === null ? null : normalizeMask(args.mask, graph.width, graph.height);
          delete layer.maskDensity;
        }
        if (layer.kind === 'color_lookup' && args.parameters !== undefined && Reflect.ownKeys(args.parameters).length) { this.validateGraph(graph); context?.validateCommit?.(graph); await this.verifyColorLookup(layer.parameters); }
        return `Update ${layer.name}`;
      }
      case 'set_layer_mask': {
        assert(args.mask !== undefined, 'mask is required; use null to remove a mask.');
        layer.mask = args.mask === null ? null : normalizeMask(args.mask, graph.width, graph.height);
        delete layer.maskDensity;
        return args.mask === null ? 'Remove layer mask' : 'Set layer mask';
      }
      case 'transform_layer': {
        assert(contentLayer(layer), 'Transform an individual image, text, shape, path or gradient layer. Group transforms are unsupported.', 'INVALID_TARGET');
        const transform = affineOptions(args, graph.width, graph.height);
        assert(!layer.protected || transform.scaleX === transform.scaleY, 'Unprotect this layer explicitly before stretching its proportions. Use equal horizontal and vertical scales to keep protection.', 'PROTECTED_LAYER');
        layer.transforms.push(transform);
        return `Transform ${layer.name}`;
      }
      case 'add_paint_layer': {
        await this.addPaintLayer(graph, args.name); return 'Add paint layer';
      }
      case 'rasterize_layer': {
        assert(['solid', 'text', 'shape', 'path', 'gradient'].includes(layer.type), 'Rasterize supports solid, text, shape, path and gradient layers.', 'INVALID_TARGET');
        const pixels = await this.renderLayer(layer);
        const asset = await this.storeAsset(await rawImage(pixels, graph.width, graph.height).png().toBuffer());
        const raster = { ...layerBase(layer.name, 'raster'), id: layer.id, visible: layer.visible, opacity: layer.opacity, blendMode: layer.blendMode, mask: layer.mask ?? null, asset, sourceAsset: asset, sourceFormat: 'png', width: graph.width, height: graph.height, transforms: [] };
        if (layer.outline) raster.outline = structuredClone(layer.outline);
        if (layer.effects) raster.effects = structuredClone(layer.effects);
        if (layer.protected !== undefined) raster.protected = layer.protected;
        if (layer.parentId !== undefined) raster.parentId = layer.parentId;
        if (layer.maskDensity !== undefined) raster.maskDensity = layer.maskDensity;
        if (layer.clipBaseId !== undefined) raster.clipBaseId = layer.clipBaseId;
        graph.layers[graph.layers.indexOf(layer)] = raster;
        return `Rasterize ${layer.name}`;
      }
      case 'paint_stroke': {
        const sampling = normalizeRetouchSampling(args);
        if (hasDenseMasks(graph)) {
          const n = graph.width * graph.height, distinctSample = sampling && sampling.sampleMode !== 'current', retained = (distinctSample ? 8 : 4) * n;
          validateDenseMaskOperation(graph, { retainedBytes: retained + maskBufferBytes(graph.selection, { feather: false }), phases: [(distinctSample ? 15 : 11) * n + maskBufferBytes(graph.selection)], additionalWork: maskPreparationWork(graph.selection) + protectedMaskPreparationWork(graph) });
        }
        let target = args.layerId ? graph.layers.find((item) => item.id === args.layerId) : null;
        if (args.layerId) assert(target, 'Layer was not found.', 'NOT_FOUND');
        else {
          assert(args.tool === 'brush' || args.tool === 'pencil', 'Select a raster layer for this tool, or add a paint layer.', 'INVALID_TARGET');
          assert(graph.layers.length < MAX_LAYERS, 'Native documents support up to 64 layers.', 'LIMIT_EXCEEDED');
          target = await this.addPaintLayer(graph);
        }
        assert(target.type === 'raster', 'This tool requires a raster layer. Add a paint layer or rasterize the selected editable layer.', 'INVALID_TARGET');
        assert(!target.protected, 'Unprotect this layer explicitly before painting or retouching its pixels.', 'PROTECTED_LAYER');
        assert(!filterEntries(target.filters).length, 'Bake or clear this layer’s filter stack explicitly before painting or retouching, including disabled entries. Paint on another layer to retain the editable stack.', 'FILTER_STACK_ACTIVE');
        if (sampling?.sampleMode === 'current-and-below') {
          const tree = layerTree(graph.layers); retouchRoot(tree, clippingIndex(tree), target.id);
        }
        const pixels = await this.renderLayer(target);
        const composite = await frozenRetouchSample(pixels, sampling, options => this.renderGraph(graph, options), target.id);
        const coverage = await this.prepareMaskCoverage(graph.selection);
        const protectedPixels = await this.protectedPixels(graph);
        const output = applyStroke({ ...args, pixels, width: graph.width, height: graph.height, composite, coverage: (x, y) => protectedPixels[Math.floor(y) * graph.width + Math.floor(x)] ? 0 : coverage(x - 0.5, y - 0.5) });
        target.asset = await this.storeAsset(await rawImage(output, graph.width, graph.height).png().toBuffer());
        target.width = graph.width; target.height = graph.height; target.transforms = [];
        delete target.alphaAsset;
        return `${args.tool[0].toUpperCase()}${args.tool.slice(1)} stroke`;
      }
      case 'set_layer': {
        if (args.name !== undefined) layer.name = name(args.name);
        if (args.visible !== undefined) { assert(typeof args.visible === 'boolean', 'visible must be boolean.'); layer.visible = args.visible; }
        if (args.opacity !== undefined) {
          const opacity = number(args.opacity, 'opacity', 0, 1);
          assert(!layer.protected || opacity === layer.opacity, 'Unprotect this layer explicitly before changing its opacity.', 'PROTECTED_LAYER');
          if (layer.type === 'group') assert(opacity === layer.opacity || !containsProtected(layerTree(graph.layers).nodes.get(layer.id)), 'Unprotect every protected descendant explicitly before changing group opacity.', 'PROTECTED_LAYER');
          layer.opacity = opacity;
        }
        if (args.blendMode !== undefined) {
          assert(!layer.protected || args.blendMode === layer.blendMode, 'Unprotect this layer explicitly before changing its color blending.', 'PROTECTED_LAYER');
          assert(BLENDS.includes(args.blendMode), 'Unsupported blend mode.', 'UNSUPPORTED');
          assert(layer.type !== 'adjustment' || args.blendMode === 'normal', 'Adjustment layers support normal blending only.', 'UNSUPPORTED');
          assert(layer.type !== 'group' || layer.mode === 'isolated' || args.blendMode === 'normal', 'Switch this group to isolated compositing before choosing a nonnormal blend mode.', 'UNSUPPORTED');
          layer.blendMode = args.blendMode;
        }
        return `Update ${layer.name}`;
      }
      case 'duplicate_layer': {
        const copy = { ...structuredClone(layer), id: randomUUID(), name: `${layer.name.slice(0, 194)} copy` };
        graph.layers.splice(graph.layers.indexOf(layer) + 1, 0, copy); return `Duplicate ${layer.name}`;
      }
      case 'delete_layer': graph.layers.splice(graph.layers.indexOf(layer), 1); return `Delete ${layer.name}`;
      case 'reorder_layer': {
        number(args.index, 'index', 0, graph.layers.length - 1, true);
        graph.layers.splice(graph.layers.indexOf(layer), 1); graph.layers.splice(args.index, 0, layer); return `Reorder ${layer.name}`;
      }
      case 'add_text': case 'update_text': {
        const input = command === 'update_text' ? { ...layer, ...args } : args;
        if (command === 'update_text') assert(layer.type === 'text', 'Select a text layer to edit.', 'INVALID_TARGET');
        assert(typeof input.text === 'string' && input.text.trim().length > 0 && input.text.length <= 2000, 'text must contain 1–2000 characters.');
        assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text), 'Text contains unsupported control characters.');
        number(input.x, 'x', 0, (layer?.width ?? graph.width) - 1); number(input.y, 'y', 0, (layer?.height ?? graph.height) - 1); number(input.fontSize, 'fontSize', 1, 1000); color(input.color);
        const spacing = normalizeTextSpacing({ tracking: args.tracking === undefined ? layer?.tracking : args.tracking, leading: args.leading === undefined ? layer?.leading : args.leading }, { command: true });
        const settings = { text: input.text, x: input.x, y: input.y, fontSize: input.fontSize, color: input.color, ...textOptions(input), ...spacing };
        if (command === 'update_text') {
          Object.assign(layer, settings);
          for (const field of TEXT_SPACING_PROPERTIES) if (!Object.hasOwn(spacing, field)) delete layer[field];
        }
        else graph.layers.push({ ...layerBase(name(args.name, args.text.slice(0, 60)), 'text'), ...settings, width: graph.width, height: graph.height, transforms: [] });
        return command === 'update_text' ? 'Update text' : 'Add text';
      }
      case 'resize_canvas': {
        const transform=canvasTransform(graph.width,graph.height,args.width,args.height,args.anchor??'center');
        assert(args.selectPadding===undefined||typeof args.selectPadding==='boolean','selectPadding must be boolean.');
        if(args.selectPadding)assert(args.width>graph.width||args.height>graph.height,'Expand at least one canvas dimension to select added space.');
        this.preflightMaskCanvas(graph, transform);
        for(const item of graph.layers){
          if(contentLayer(item))item.transforms.push(transform);
          if(item.mask) await this.transformEditingMask(graph,item.mask,transform,mask=>{item.mask=mask;},args,context);
        }
        if(args.selectPadding){
          const x=Math.max(0,transform.x),y=Math.max(0,transform.y);
          graph.selection={shape:'rectangle',x,y,width:Math.min(args.width,transform.x+graph.width)-x,height:Math.min(args.height,transform.y+graph.height)-y,feather:0,invert:true};
        }else if(graph.selection)await this.transformEditingMask(graph,graph.selection,transform,mask=>{graph.selection=mask;},args,context);
        for(const saved of graph.savedSelections??[])await this.transformEditingMask(graph,saved.mask,transform,mask=>{saved.mask=mask;},args,context);
        if(graph.guides!==undefined)graph.guides=transformGuides(graph.guides,transform,graph.width,graph.height);
        graph.width=args.width;graph.height=args.height;
        return 'Change canvas bounds';
      }
      case 'crop_document': case 'resize_document': {
        const transform = command === 'crop_document' ? { type: 'crop', ...rectangle(args, graph) } : { type: 'resize', width: args.width, height: args.height };
        const method = command === 'resize_document' ? normalizeDocumentResizeMethod(args.resample) : DOCUMENT_RESIZE_DEFAULT;
        const contentTransform = method === DOCUMENT_RESIZE_DEFAULT ? transform : { type: 'resample', width: transform.width, height: transform.height, kernel: method };
        dimensions(transform.width, transform.height);
        if (transform.type === 'resize' && (transform.width !== graph.width || transform.height !== graph.height)) {
          const positioned = graph.layers.filter(item => positionedLayerMask(item.mask));
          assert(!positioned.length, `Rasterize additional mask positions before resizing the image: ${positioned.map(item => item.name).join(', ')}. Crop and canvas-bounds changes remain available.`, 'MASK_POSITION_REQUIRES_RASTERIZE');
        }
        if (transform.type === 'resize' && graph.layers.some((item) => item.protected && contentLayer(item))) {
          // Drive scaling from the longer source axis. The other output axis
          // may differ by half a pixel because raster dimensions are integers.
          const roundingError = Math.abs(transform.width * graph.height - transform.height * graph.width);
          assert(roundingError <= 0.5 * Math.max(graph.width, graph.height),
            'Unprotect the document’s protected layers explicitly before changing its proportions. Use proportional dimensions or change canvas bounds instead.', 'PROTECTED_LAYER');
        }
        this.preflightMaskCanvas(graph, transform, contentTransform);
        for (const item of graph.layers) {
          if (contentLayer(item)) item.transforms.push(contentTransform);
          if (item.mask) await this.transformEditingMask(graph, item.mask, transform, mask => { item.mask = mask; }, args, context);
        }
        if (graph.selection) await this.transformEditingMask(graph, graph.selection, transform, mask => { graph.selection = mask; }, args, context);
        for (const saved of graph.savedSelections ?? []) await this.transformEditingMask(graph, saved.mask, transform, mask => { saved.mask = mask; }, args, context);
        if (graph.guides !== undefined) graph.guides = transformGuides(graph.guides, transform, graph.width, graph.height);
        graph.width = transform.width; graph.height = transform.height;
        return transform.type === 'crop' ? 'Crop canvas' : 'Resize canvas';
      }
      case 'select_rectangle': graph.selection = rectangle(args, graph); return 'Select rectangle';
      case 'select_region': graph.selection = normalizeMask(args, graph.width, graph.height); return `Select ${graph.selection.shape ?? 'rectangle'}`;
      case 'modify_selection': {
        assert(graph.selection, 'Create a selection first.', 'NO_SELECTION');
        if (args.feather !== undefined) graph.selection.feather = number(args.feather, 'feather', 0, 100);
        if (args.invert !== undefined) { assert(typeof args.invert === 'boolean', 'invert must be boolean.'); graph.selection.invert = args.invert; }
        return 'Modify selection';
      }
      case 'clear_selection': graph.selection = null; return 'Clear selection';
      default: throw error('UNSUPPORTED', `Native backend does not support ${command}.`);
    }
  }

  async renderLayer(layer, { protectedPixels, filters = true } = {}) {
    assert(contentLayer(layer), 'Only individual content layers have source pixels.', 'INVALID_TARGET');
    let image;
    if (layer.type === 'raster') image = sharp(await fs.readFile(path.join(this.assetsDir, layer.asset)), { limitInputPixels: MAX_PIXELS });
    else if (layer.type === 'solid') image = sharp({ create: { width: layer.width, height: layer.height, channels: 4, background: layer.color } });
    else if (layer.type === 'shape' || layer.type === 'path') image = sharp(Buffer.from(vectorSvg(layer.type, layer.vector, layer.width, layer.height)), { limitInputPixels: MAX_PIXELS });
    else if (layer.type === 'gradient') image = rawImage(gradientPixels(layer.gradient, layer.width, layer.height), layer.width, layer.height);
    else {
      if (layer.fontFamily === 'Fraunces') await ensureBundledFonts();
      // Escaping makes user text literal SVG text, never external markup or resources.
      const lines = layer.text.split('\n').map((line, index) => `<tspan x="${layer.x}" y="${textLineBaseline(layer, index)}">${xml(line)}</tspan>`).join('');
      const anchor = layer.align === 'center' ? 'middle' : layer.align === 'right' ? 'end' : 'start';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layer.width}" height="${layer.height}"><text font-family="${layer.fontFamily ?? 'sans-serif'}" font-weight="${layer.fontWeight ?? 'normal'}" font-style="${layer.fontStyle ?? 'normal'}" text-anchor="${anchor}" font-size="${layer.fontSize}"${textTrackingAttribute(layer)} fill="${layer.color}" xml:space="preserve">${lines}</text></svg>`;
      image = sharp(Buffer.from(svg), { limitInputPixels: MAX_PIXELS });
    }
    let result = await image.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert(result.info.width === layer.width && result.info.height === layer.height, 'Raster asset dimensions do not match the layer.', 'RENDER_ERROR');
    if (layer.alphaAsset) result.data = combineAlpha(result.data, await this.readAlpha(layer.alphaAsset, layer.width, layer.height));
    const original = result.data, active = filters && hasActiveFilters(layer);
    const filtered = active ? await applyLayerFilters(original, layer.width, layer.height, layer.filters, { prepareColorLookup: parameters => this.prepareColorLookup(parameters), resolveAlpha8: mask => this.readDenseMask(mask) }) : original;
    const pixels = await this.renderLayerGeometry(layer, filtered);
    if (active && protectedPixels?.some((value) => value > 0)) {
      const unchanged = await this.renderLayerGeometry(layer, original);
      assert(protectedPixels.length * 4 === pixels.length, 'Protected footprint dimensions do not match this layer.', 'RENDER_ERROR');
      const width = layer.transforms.at(-1)?.width ?? layer.width;
      for (let row = 0; row < protectedPixels.length / width; row++) {
        for (let x = 0; x < width; x++) {
          const index = row * width + x;
          if (!protectedPixels[index]) continue;
          const i = index * 4;
          pixels[i] = unchanged[i]; pixels[i + 1] = unchanged[i + 1]; pixels[i + 2] = unchanged[i + 2];
        }
        if ((row + 1) % 32 === 0) await yieldEventLoop();
      }
    }
    return pixels;
  }

  async renderLayerGeometry(layer, pixels) {
    let result = { data: pixels, info: { width: layer.width, height: layer.height } };
    for (const transform of layer.transforms) {
      if (transform.type === 'distort') {
        result = { data: await distortPixels(result.data, result.info.width, result.info.height, transform), info: result.info };
        continue;
      }
      if (transform.type === 'resample') {
        result = { data: await resamplePixels(result.data, result.info.width, result.info.height, transform), info: { ...result.info, width: transform.width, height: transform.height } };
        continue;
      }
      if(transform.type==='canvas'){
        result={data:resizeCanvasPixels(result.data,result.info.width,result.info.height,transform),info:{...result.info,width:transform.width,height:transform.height}};
        continue;
      }
      if (transform.type === 'affine') {
        result = { data: affinePixels(result.data, result.info.width, result.info.height, transform), info: result.info };
        continue;
      }
      let pipeline = rawImage(result.data, result.info.width, result.info.height);
      if (transform.type === 'crop') pipeline = pipeline.extract({ left: transform.x, top: transform.y, width: transform.width, height: transform.height });
      else pipeline = pipeline.resize(transform.width, transform.height, { fit: 'fill', kernel: 'lanczos3' });
      result = await pipeline.raw().toBuffer({ resolveWithObject: true });
    }
    return result.data;
  }

  async readAlpha(asset, width, height) {
    assert(HASH.test(asset), 'Invalid alpha asset reference.');
    const image = sharp(await fs.readFile(path.join(this.assetsDir, asset)), { limitInputPixels: MAX_PIXELS });
    const metadata = await image.metadata();
    assert(metadata.format === 'png' && metadata.width === width && metadata.height === height, 'Cutout alpha asset dimensions do not match its source.', 'RENDER_ERROR');
    return image.extractChannel(0).raw().toBuffer();
  }

  async storeAlpha(alpha, width, height) {
    dimensions(width, height);
    assert(Buffer.isBuffer(alpha) && alpha.length === width * height, 'Subject alpha must match the image dimensions.', 'INVALID_IMAGE');
    return this.storeAsset(await sharp(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer());
  }

  async sourcePixels(layer) {
    const result = await sharp(await fs.readFile(path.join(this.assetsDir, layer.asset)), { limitInputPixels: MAX_PIXELS }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert(result.info.width === layer.width && result.info.height === layer.height, 'Source dimensions do not match the raster layer.', 'RENDER_ERROR');
    return layer.alphaAsset ? combineAlpha(result.data, await this.readAlpha(layer.alphaAsset, layer.width, layer.height)) : result.data;
  }

  async segmentPixels(pixels, width, height) {
    const png = await rawImage(pixels, width, height).png().toBuffer();
    const result = await this.segmentSubject(png);
    assert(result && Buffer.isBuffer(result.alpha) && result.alpha.length === width * height && result.width === width && result.height === height, 'Subject segmentation returned invalid alpha dimensions.', 'INVALID_IMAGE');
    assert(typeof result.model === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(result.model), 'Subject segmentation returned an invalid model identifier.', 'INVALID_IMAGE');
    assert(result.alpha.some((value, index) => value > 0 && pixels[index * 4 + 3] > 0), 'No visible subject was found in this layer.', 'EMPTY_SUBJECT');
    return { alpha: Buffer.from(result.alpha), model: result.model };
  }

  async ancestorContext(graph, layer) {
    const chain = ancestors(layerTree(graph.layers).nodes.get(layer.id)), masks = [];
    for (const { layer: parent } of chain) masks.push(await this.prepareLayerMaskCoverage(parent));
    return { visible: chain.every(({ layer }) => layer.visible && layer.opacity > 0), opacity: chain.reduce((value, { layer }) => value * layer.opacity, 1),
      coverage: (x, y) => masks.reduce((value, mask) => value * mask(x, y), 1) };
  }

  async visibleLayerPixels(graph, layer, { outline = true, effects = true, ancestorOpacity = true, filters = true, fill = true } = {}) {
    if (hasDenseMasks(graph)) validateDenseMaskOperation(graph, { retainedBytes: 4 * graph.width * graph.height, additionalWork: protectedMaskPreparationWork(graph, layer.id) + ancestors(layerTree(graph.layers).nodes.get(layer.id)).reduce((sum, node) => sum + additionalMaskWork(node.layer), 0) });
    const protectedPixels = filters && hasActiveFilters(layer) ? await this.protectedPixels(graph, { beforeLayerId: layer.id }) : undefined;
    const source = await this.renderLayer(layer, { protectedPixels, filters }), coverage = await this.prepareLayerMaskCoverage(layer);
    const chain = ancestors(layerTree(graph.layers).nodes.get(layer.id)).reverse();
    const pixels = Buffer.from(source);
    const fillOpacity = fill ? layerFillOpacity(layer) : 1;
    if (fillOpacity === 1) {
      for (let i = 3; i < pixels.length; i += 4) {
        const index = (i - 3) / 4;
        pixels[i] = clamp(source[i] * layer.opacity * coverage(index % graph.width, Math.floor(index / graph.width)));
      }
    } else {
      const bodyOpacity = layer.opacity * fillOpacity;
      for (let i = 3; i < pixels.length; i += 4) {
        const index = (i - 3) / 4;
        pixels[i] = clamp(source[i] * bodyOpacity * coverage(index % graph.width, Math.floor(index / graph.width)));
      }
    }
    const decoration = await this.layerDecoration(graph, layer, source, coverage, { outline, effects });
    if (decoration) {
      // Outside styles and effective subject alpha never share a pixel.
      for (let i = 0; i < pixels.length; i += 4) if (decoration[i + 3] > 0) {
        pixels[i] = decoration[i]; pixels[i + 1] = decoration[i + 1]; pixels[i + 2] = decoration[i + 2]; pixels[i + 3] = clamp(decoration[i + 3] * layer.opacity);
      }
    }
    // Each group rounds its own composite to RGBA8. Collapsing ancestor
    // opacities/masks into one multiplication can erase visible alpha=1 hair.
    for (const { layer: group } of chain) {
      const mask = await this.prepareLayerMaskCoverage(group), opacity = ancestorOpacity ? group.opacity : 1;
      for (let i = 3; i < pixels.length; i += 4) {
        const index = (i - 3) / 4;
        pixels[i] = clamp(pixels[i] * opacity * mask(index % graph.width, Math.floor(index / graph.width)));
      }
    }
    return pixels;
  }

  async layerDecoration(graph, layer, source, coverage, { outline = true, effects = true } = {}) {
    const styles = layerOutsideEffects(layer);
    const decoration = effects && styles ? await renderOutsideEffects(source, graph.width, graph.height, styles, coverage) : null;
    const ring = outline && layer.outline?.width > 0 ? outsideOutline(source, graph.width, graph.height, layer.outline, coverage) : null;
    if (decoration && ring) composite(decoration, ring, 1, 'normal', null, graph.width);
    return decoration ?? ring;
  }

  markProtected(footprint, source, width, coverage, ring, ancestorCoverage = () => 1, fillOpacity = 1) {
    for (let index = 0; index < footprint.length; index++) {
      const x = index % width, y = Math.floor(index / width);
      if (ancestorCoverage(x, y) > 0 && ((fillOpacity > 0 && source[index * 4 + 3] > 0 && coverage(x, y) > 0) || ring?.[index * 4 + 3] > 0)) footprint[index] = 1;
    }
  }

  async protectedPixels(graph, { excludeLayerId, beforeLayerId } = {}) {
    const footprint = new Uint8Array(graph.width * graph.height);
    for (const layer of graph.layers) {
      if (layer.id === beforeLayerId) break;
      if (!layer.protected || !layer.visible || layer.opacity === 0 || !contentLayer(layer) || layer.id === excludeLayerId) continue;
      const context = await this.ancestorContext(graph, layer);
      if (!context.visible) continue;
      const source = await this.renderLayer(layer), coverage = await this.prepareLayerMaskCoverage(layer);
      const decoration = await this.layerDecoration(graph, layer, source, coverage);
      this.markProtected(footprint, source, graph.width, coverage, decoration, context.coverage, layerFillOpacity(layer));
    }
    return footprint;
  }

  async render(project) {
    return this.renderGraph(graphOf(project));
  }

  async addPaintLayer(graph, layerName, layerId) {
    const asset = await this.storeAsset(await rawImage(Buffer.alloc(graph.width * graph.height * 4), graph.width, graph.height).png().toBuffer());
    const layer = { ...layerBase(name(layerName, 'Paint layer'), 'raster'), role: 'paint', asset, sourceAsset: asset, sourceFormat: 'png', width: graph.width, height: graph.height, transforms: [] };
    if (layerId !== undefined) layer.id = layerId;
    graph.layers.push(layer);
    return layer;
  }

  renderGraph(graph, options = {}) {
    return withMaskPreparationBudget(hasDenseMasks(graph) || options.filterContextGraph && hasDenseMasks(options.filterContextGraph), () => this.renderGraphPrepared(graph, options));
  }

  async renderGraphPrepared(graph, { filterContextGraph, clippingPreviewMemberId, ignoreAdjustments = false, stopAfterRootId } = {}) {
    this.validateGraph(graph);
    const tree = layerTree(graph.layers);
    const clipping = clippingIndex(tree);
    assert(typeof ignoreAdjustments === 'boolean', 'ignoreAdjustments must be boolean.');
    const cutoff = stopAfterRootId === undefined ? tree.roots.length : tree.roots.indexOf(retouchRoot(tree, clipping, stopAfterRootId)) + 1;
    if (filterContextGraph) this.validateGraph(filterContextGraph);
    validateDenseMaskResources(graph, { filterContextGraph });
    // A generated background below a cutout must remain visible through soft
    // subject edges. Protect only lower content that this layer could cover.
    const state = { pixels: Buffer.alloc(graph.width * graph.height * 4), footprint: new Uint8Array(graph.width * graph.height) };
    const renderNodes = async (nodes, state, ancestorCoverage = () => 1) => {
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
        const { layer, children } = nodes[nodeIndex], chain = clipping.chains.get(layer.id);
        // Consume the full run even when its base is hidden or transparent.
        // Members never fall through into ordinary sibling compositing.
        if (chain) nodeIndex += chain.members.length;
        if (!layer.visible || layer.opacity === 0) continue;
        if (chain) {
          const protection = filterContextGraph ? await this.protectedPixels(filterContextGraph, { beforeLayerId: layer.id }) : state.footprint;
          const mask = await this.prepareLayerMaskCoverage(layer);
          // This owned base buffer becomes the interior; only its RGB changes.
          // No second base buffer or saved alpha plane survives member awaits.
          let interior = await this.renderLayer(layer, { protectedPixels: protection });
          if (clippingPreviewMemberId && chain.members.some(({ layer }) => layer.id === clippingPreviewMemberId)) {
            const member = chain.members.find(({ layer }) => layer.id === clippingPreviewMemberId).layer;
            const source = await this.renderLayer(member, { protectedPixels: protection });
            await clipMemberContribution(source, interior, { width: graph.width, memberLayer: member, baseLayer: layer,
              coverage: await this.prepareLayerMaskCoverage(member), baseCoverage: mask, protectedPixels: protection });
            interior = null;
            composite(state.pixels, source, 1, 'normal', () => 1, graph.width);
          } else {
            for (const { layer: member } of chain.members) {
              if (!member.visible || member.opacity === 0) continue;
              // Limit the member lifetime to this iteration, including filtered
              // geometry buffers, before another member or decoration renders.
              let source = await this.renderLayer(member, { protectedPixels: protection });
              await blendClippingInterior(interior, source, { width: graph.width, opacity: member.opacity, blendMode: member.blendMode,
                baseCoverage: mask, coverage: await this.prepareLayerMaskCoverage(member), protectedPixels: protection });
              source = null;
            }
            const decoration = await this.layerDecoration(graph, layer, interior, mask);
            if (decoration) composite(state.pixels, decoration, layer.opacity, layer.blendMode, (x, y) => protection[y * graph.width + x] ? 0 : 1, graph.width);
            composite(state.pixels, interior, layer.opacity, layer.blendMode, mask, graph.width);
          }
        } else if (layer.type === 'group') {
          const coverage = await this.prepareLayerMaskCoverage(layer);
          const scope = layer.mask ? (x, y) => ancestorCoverage(x, y) * coverage(x, y) : ancestorCoverage;
          if (layer.mode === 'isolated') {
            const child = { pixels: Buffer.alloc(state.pixels.length), footprint: Uint8Array.from(state.footprint) };
            await renderNodes(children, child, scope);
            composite(state.pixels, child.pixels, layer.opacity, layer.blendMode, coverage, graph.width);
            for (let index = 0; index < state.footprint.length; index++) if (child.footprint[index] && coverage(index % graph.width, Math.floor(index / graph.width)) > 0) state.footprint[index] = 1;
          } else if (layer.opacity === 1 && !layer.mask) await renderNodes(children, state, scope);
          else {
            const before = Buffer.from(state.pixels), child = { pixels: state.pixels, footprint: Uint8Array.from(state.footprint) };
            // Only the child owns the live working surface. Neutral ancestor
            // frames must not retain stale buffers replaced by adjustments.
            state.pixels = null;
            await renderNodes(children, child, scope);
            state.pixels = mixGroup(before, child.pixels, graph.width, layer.opacity, coverage);
            for (let index = 0; index < state.footprint.length; index++) if (child.footprint[index] && coverage(index % graph.width, Math.floor(index / graph.width)) > 0) state.footprint[index] = 1;
          }
        } else if (layer.type === 'adjustment') {
          if (!ignoreAdjustments) state.pixels = await this.applyAdjustment(state.pixels, graph.width, graph.height, layer, state.footprint);
        }
        else {
          // Inspection omits other document pixels but keeps their earlier
          // protection for filters, generated content and outside decorations.
          // Ordinary source RGB remains independently inspectable.
          const generated = !layer.protected && (layer.role === 'generated' || Boolean(layer.provenance?.jobId));
          const contextual = hasActiveFilters(layer) || generated || layerOutsideEffects(layer) || layer.outline?.width > 0;
          const protection = filterContextGraph && contextual
            ? await this.protectedPixels(filterContextGraph, { beforeLayerId: layer.id }) : state.footprint;
          const source = await this.renderLayer(layer, { protectedPixels: protection }), mask = await this.prepareLayerMaskCoverage(layer);
          // Explicitly protected content retains normal stacking. Clipping two
          // protected generated copies against one another would erase both.
          const allowed = generated ? (x, y) => protection[y * graph.width + x] ? 0 : 1 : null;
          const coverage = allowed ? (x, y) => allowed(x, y) * mask(x, y) : mask;
          const decoration = await this.layerDecoration(graph, layer, source, coverage);
          if (decoration) composite(state.pixels, decoration, layer.opacity, layer.blendMode, (x, y) => protection[y * graph.width + x] ? 0 : 1, graph.width);
          const fillOpacity = layerFillOpacity(layer);
          if (fillOpacity === 1) composite(state.pixels, source, layer.opacity, layer.blendMode, coverage, graph.width);
          else if (fillOpacity > 0) composite(state.pixels, source, layer.opacity * fillOpacity, layer.blendMode, coverage, graph.width);
          if (layer.protected) this.markProtected(state.footprint, source, graph.width, mask, decoration, ancestorCoverage, fillOpacity);
        }
      }
    };
    await renderNodes(cutoff === tree.roots.length ? tree.roots : tree.roots.slice(0, cutoff), state);
    return state.pixels;
  }

  async applyAdjustment(input, width, height, layer, protectedPixels) {
    if (layer.kind === 'color_lookup') { normalizeColorLookupParameters(layer.parameters); if (layer.opacity === 0) return input; }
    if (layer.value === 0 && !PARAMETERIZED_ADJUSTMENTS.includes(layer.kind) && layer.kind !== 'threshold') return input;
    const colorMapping = COLOR_MAPPING_KINDS.includes(layer.kind);
    // Every kind yields within 65,536 pixel visits. Previously cooperative
    // color mappings keep their tighter row cadence where applicable.
    const pixelBatchRows = Math.max(1, Math.floor(65_536 / width));
    const yieldRows = colorMapping ? Math.min(colorTransformYieldRows(layer.kind, width), pixelBatchRows) : pixelBatchRows;
    let changed = ['median', 'mosaic'].includes(layer.kind) ? await spatialAdjustment(input, width, height, layer) : null;
    if (layer.kind === 'blur' || layer.kind === 'sharpen') {
      let image = rawImage(input, width, height);
      image = layer.kind === 'blur' ? image.blur(Math.max(0.3, layer.value)) : image.sharpen({ sigma: Math.max(0.001, layer.value) });
      changed = await image.raw().toBuffer();
    }
    let lookupTransform;
    if (layer.kind === 'color_lookup') { validateColorLookupGlobalBytes(layer, width, height); lookupTransform = await this.prepareColorLookup(layer.parameters); }
    const output = Buffer.from(input);
    const coverage = await prepareLayerMaskCoverage(layer, mask => this.readDenseMask(mask));
    const transform = lookupTransform ?? adjustmentTransform(layer);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (protectedPixels?.[y * width + x]) continue;
        const amount = layer.opacity * coverage(x, y);
        if (amount === 0) continue; // Exact preservation, including invisible RGB and alpha.
        const i = (y * width + x) * 4;
        if (colorMapping && input[i + 3] === 0) continue;
        const adjusted = changed ? [changed[i], changed[i + 1], changed[i + 2]] : transform(input[i], input[i + 1], input[i + 2]);
        for (let channel = 0; channel < 3; channel++) {
          const value = input[i + channel];
          output[i + channel] = clamp(value + (adjusted[channel] - value) * amount);
        }
      }
      if ((y + 1) % yieldRows === 0) await yieldEventLoop();
    }
    return output;
  }

  async histogram(graph) {
    const pixels = await this.renderGraph(graph);
    const result = { red: Array(256).fill(0), green: Array(256).fill(0), blue: Array(256).fill(0), luminance: Array(256).fill(0), pixelCount: 0 };
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] !== 0) {
      result.red[pixels[i]]++; result.green[pixels[i + 1]]++; result.blue[pixels[i + 2]]++;
      result.luminance[clamp(pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722)]++;
      result.pixelCount++;
    }
    return result;
  }

  async cachedPreview(project, args) {
    const maxWidth = number(args.maxWidth ?? 1600, 'maxWidth', 1, MAX_AXIS, true);
    // The public preview contract uses 32–2400. Keep older direct-native
    // callers' wider range working, without admitting those entries to cache.
    const key = maxWidth >= 32 && maxWidth <= 2400 && CACHE_ID.test(project.id) && Number.isSafeInteger(project.revision)
      ? { documentId: project.id, revision: project.revision, maxWidth } : null;
    const cached = key && this.previewCache.get(key);
    if (cached) return cached;
    const preview = await this.output(project, 'get_preview', { ...args, maxWidth });
    if (key) this.previewCache.set(key, preview);
    return preview;
  }

  async output(project, command, args) {
    const graph = graphOf(project);
    let width = graph.width, height = graph.height;
    let format = 'png';
    if (command === 'get_preview') {
      const maxWidth = number(args.maxWidth ?? 1600, 'maxWidth', 1, MAX_AXIS, true);
      if (width > maxWidth) { height = Math.max(1, Math.round(height * maxWidth / width)); width = maxWidth; }
    } else {
      assert(['png', 'jpeg', 'webp','tiff'].includes(args.format), 'Export format must be png, jpeg, webp or tiff.', 'UNSUPPORTED');
      format = args.format;
      if (args.quality !== undefined) number(args.quality, 'quality', 1, 100, true);
      if (args.density !== undefined) { assert(format !== 'webp', 'Density metadata is supported for PNG, JPEG and TIFF export.'); number(args.density, 'density', 1, 1200, true); }
      if (args.matte !== undefined) { assert(format === 'jpeg', 'Matte color is available for JPEG only.'); color(args.matte); }
      if (args.lossless !== undefined) assert(format === 'webp' && typeof args.lossless === 'boolean', 'Lossless option is available for WebP only.');
    }
    let image = rawImage(await this.render(project), graph.width, graph.height);
    if (width !== graph.width || height !== graph.height) image = image.resize(width, height, { fit: 'fill' });
    image = image.withIccProfile('srgb');
    if (command === 'export_document' && args.density !== undefined) image = image.withMetadata({ density: args.density });
    if (format === 'jpeg') image = image.flatten({ background: args.matte ?? '#ffffff' }).jpeg({ quality: args.quality ?? 90, chromaSubsampling:'4:4:4' });
    else if (format === 'webp') image = image.webp({ quality: args.quality ?? 90, lossless:args.lossless ?? false });
    else if (format === 'tiff') image = image.tiff({ compression:'deflate',predictor:'horizontal',resolutionUnit:'inch',...(args.density!==undefined?{xres:args.density/25.4,yres:args.density/25.4}:{}) });
    else image = image.png();
    const data = (await image.toBuffer()).toString('base64');
    const common = { data, mimeType: `image/${format}`, width, height };
    if (command === 'get_preview') return { ...common, revision: project.revision };
    const filename = `${graph.name.replace(/[^a-zA-Z0-9 _.-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'image'}.${format === 'jpeg' ? 'jpg' : format}`;
    return { ...common, filename,flattened:true,bitDepth:8,colorSpace:'sRGB',...(args.density!==undefined?{density:args.density}:{}) };
  }

  async layerPreview(project, args) {
    const view = args.view ?? 'layer';
    assert(['layer', 'source', 'mask'].includes(view), 'Layer preview view must be layer, source or mask.');
    const maxWidth = number(args.maxWidth ?? 1600, 'maxWidth', 32, 2400, true);
    assert(typeof args.layerId === 'string' && ID.test(args.layerId), 'Invalid layerId.');
    const graph = graphOf(project), layer = graph.layers.find((item) => item.id === args.layerId);
    this.validateGraph(graph);
    assert(layer, 'Layer was not found.', 'NOT_FOUND');
    assert(layer.type !== 'adjustment', 'An adjustment has no isolated image. Preview the complete document to inspect its effect.', 'INVALID_TARGET');
    if (view === 'source') assert(typeof layer.sourceAsset === 'string' && HASH.test(layer.sourceAsset), 'This layer has no preserved source image.', 'INVALID_TARGET');
    if (view === 'mask') assert(layer.type === 'raster' && typeof layer.alphaAsset === 'string' && HASH.test(layer.alphaAsset), 'This layer has no separate source cutout alpha mask.', 'INVALID_TARGET');
    try {
      let image, sourceWidth, sourceHeight, visibleBounds, boundsSpace;
      if (view === 'layer') {
        // Inspection deliberately reveals a hidden layer in isolation. A blend
        // mode has no other document layers as its backdrop in this view.
        const tree = layerTree(graph.layers), clipping = clippingIndex(tree), node = tree.nodes.get(layer.id), parents = ancestors(node);
        const chain = clipping.chains.get(layer.id) ?? clipping.members.get(layer.id);
        const revealed = new Set([...parents.map(({ layer }) => layer.id), layer.id, ...(chain ? [chain.base.layer.id] : [])]);
        const selected = chain ? [chain.base, ...chain.members] : subtree(node);
        const isolated = { ...graph, layers: [...parents, ...selected].map(({ layer }) => revealed.has(layer.id) ? { ...layer, visible: true } : layer) };
        const context = { ...graph, layers: graph.layers.map((item) => revealed.has(item.id) ? { ...item, visible: true } : item) };
        const pixels = await this.renderGraph(isolated, { filterContextGraph: context, ...(clipping.members.has(layer.id) ? { clippingPreviewMemberId: layer.id } : {}) }), bounds = alphaBounds(pixels, graph.width, graph.height);
        visibleBounds = bounds ? { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height } : null;
        boundsSpace = 'document';
        image = rawImage(pixels, graph.width, graph.height);
        sourceWidth = graph.width; sourceHeight = graph.height;
      } else if (view === 'mask') {
        sourceWidth = layer.width; sourceHeight = layer.height;
        const alpha = await this.readAlpha(layer.alphaAsset, sourceWidth, sourceHeight);
        let left = sourceWidth, top = sourceHeight, right = -1, bottom = -1;
        for (let y = 0; y < sourceHeight; y++) for (let x = 0; x < sourceWidth; x++) if (alpha[y * sourceWidth + x] > 0) {
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
        visibleBounds = right < left ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
        boundsSpace = 'source';
        image = sharp(alpha, { raw: { width: sourceWidth, height: sourceHeight, channels: 1 }, limitInputPixels: MAX_PIXELS });
      } else {
        const file = path.join(this.assetsDir, layer.sourceAsset), stat = await fs.stat(file);
        assert(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES, 'Source image exceeds native preview input limits.', 'LIMIT_EXCEEDED');
        image = sharp(await fs.readFile(file), { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
        const metadata = await image.metadata();
        assert(['png', 'jpeg', 'webp', 'tiff'].includes(metadata.format) && (metadata.pages ?? 1) === 1, 'Source image format is unsupported.', 'INVALID_IMAGE');
        dimensions(metadata.width, metadata.height);
        const rotateAxes = [5, 6, 7, 8].includes(metadata.orientation);
        sourceWidth = rotateAxes ? metadata.height : metadata.width;
        sourceHeight = rotateAxes ? metadata.width : metadata.height;
        image = image.rotate();
      }
      const output = await image.toColourspace('srgb').ensureAlpha().resize({ width: maxWidth, withoutEnlargement: true }).withIccProfile('srgb').png().toBuffer({ resolveWithObject: true });
      return { data: output.data.toString('base64'), mimeType: 'image/png', width: output.info.width, height: output.info.height,
        sourceWidth, sourceHeight, revision: project.revision, documentId: project.id, layerId: layer.id, view,
        ...(boundsSpace ? { visibleBounds, boundsSpace } : {}) };
    } catch (cause) {
      if (cause?.code === 'LIMIT_EXCEEDED') throw error('LIMIT_EXCEEDED', 'The layer preview exceeds native image limits.');
      throw error('INVALID_IMAGE', 'The layer preview could not be decoded or rendered.');
    }
  }
}

function composite(destination, source, opacity, mode, coverage, width) {
  assert(destination.length === source.length, 'Layer dimensions do not match canvas.', 'RENDER_ERROR');
  const backdrop = [0, 0, 0], foreground = [0, 0, 0];
  for (let i = 0; i < destination.length; i += 4) {
    const pixel = i / 4;
    let sa = source[i + 3] / 255 * opacity * (coverage ? coverage(pixel % width, Math.floor(pixel / width)) : 1);
    if (mode === 'dissolve') sa = dissolveAlpha(sa, pixel);
    if (sa === 0) continue;
    const da = destination[i + 3] / 255;
    const alpha = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++) { backdrop[c] = destination[i + c] / 255; foreground[c] = source[i + c] / 255; }
    const blended = mode === 'normal' || mode === 'dissolve' ? foreground : blendRGB(backdrop, foreground, mode);
    for (let c = 0; c < 3; c++) {
      destination[i + c] = clamp(255 * ((1 - sa) * da * backdrop[c] + (1 - da) * sa * foreground[c] + sa * da * blended[c]) / alpha);
    }
    destination[i + 3] = clamp(alpha * 255);
  }
}

// Inverse sampling keeps output allocation bounded by the existing canvas even
// at 8× scaling. Interpolate premultiplied colors to avoid dark alpha fringes.
function affinePixels(input, width, height, transform) {
  const output = Buffer.alloc(input.length);
  if (transform.scaleX === 1 && transform.scaleY === 1 && transform.rotation === 0 && !transform.flipX && !transform.flipY && Number.isInteger(transform.x) && Number.isInteger(transform.y)) {
    // Whole-pixel layout moves copy bytes directly, including transparent RGB.
    const left = Math.max(0, -transform.x), top = Math.max(0, -transform.y);
    const right = Math.min(width, width - transform.x), bottom = Math.min(height, height - transform.y);
    if (right > left) for (let y = top; y < bottom; y++) {
      const start = (y * width + left) * 4, target = ((y + transform.y) * width + left + transform.x) * 4;
      input.copy(output, target, start, start + (right - left) * 4);
    }
    return output;
  }
  const radians = transform.rotation * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const sx = transform.scaleX * (transform.flipX ? -1 : 1), sy = transform.scaleY * (transform.flipY ? -1 : 1);
  const cx = width / 2, cy = height / 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = x + 0.5 - cx - transform.x, dy = y + 0.5 - cy - transform.y;
    const sourceX = (cos * dx + sin * dy) / sx + cx - 0.5;
    const sourceY = (-sin * dx + cos * dy) / sy + cy - 0.5;
    const left = Math.floor(sourceX), top = Math.floor(sourceY), fx = sourceX - left, fy = sourceY - top;
    if (left < -1 || top < -1 || left >= width || top >= height) continue;
    let alpha = 0, red = 0, green = 0, blue = 0;
    for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
      const px = left + ox, py = top + oy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const weight = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
      const i = (py * width + px) * 4, weightedAlpha = weight * input[i + 3] / 255;
      alpha += weightedAlpha; red += weightedAlpha * input[i]; green += weightedAlpha * input[i + 1]; blue += weightedAlpha * input[i + 2];
    }
    if (alpha > 0) {
      const i = (y * width + x) * 4;
      output[i] = clamp(red / alpha); output[i + 1] = clamp(green / alpha); output[i + 2] = clamp(blue / alpha); output[i + 3] = clamp(alpha * 255);
    }
  }
  return output;
}

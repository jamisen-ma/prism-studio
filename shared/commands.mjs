import { z } from 'zod';
import { COLOR_LOOKUP_LIMITS, normalizeColorLookupParameters, colorLookupBase64Bytes } from './color-lookup.mjs';
import { CHANNEL_SELECTION_CHANNELS, CHANNEL_PREVIEW_LIMITS, normalizeDenseMaskDescriptor } from './dense-mask.mjs';
import { COLOR_RANGE_LIMITS, COLOR_RANGE_PREVIEW_LIMITS, normalizeColorRangeSettings } from './color-range.mjs';
import {BLEND_MODES} from './blend-modes.mjs';
import { LAYER_FILTER_BLEND_MODES } from './filter-blend-modes.mjs';
import {FONT_FAMILIES} from './fonts.mjs';
import { assertEditRecipeJson, createEditRecipeSchemas, validateEditRecipeSemantics } from './edit-recipes.mjs';

const id = z.string().min(1).max(160);
const dimensions = { width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) };
const document = { documentId: id };
const revision = { ...document, expectedRevision: z.number().int().min(0).optional() };
const color = z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hex color');
const rect = { x: z.number().int().min(0).max(8192), y: z.number().int().min(0).max(8192), ...dimensions };
const point=z.object({x:z.number().finite().min(0).max(8192),y:z.number().finite().min(0).max(8192)}).strict();
const strokePoint=z.object({x:z.number().finite().min(-8192).max(16384),y:z.number().finite().min(-8192).max(16384)}).strict();
const mask = z.object({ x:rect.x.optional(),y:rect.y.optional(),width:dimensions.width.optional(),height:dimensions.height.optional(), shape:z.enum(['rectangle','ellipse','polygon']).optional(), points:z.array(point).min(3).max(256).optional(), feather: z.number().min(0).max(100).optional(), invert: z.boolean().optional() }).strict();
const filterMaskOptions = { feather: z.number().finite().min(0).max(100).optional(), invert: z.boolean().optional() };
const filterMaskDescriptor = z.discriminatedUnion('shape', [
  z.object({ shape: z.literal('rectangle'), ...rect, ...filterMaskOptions }).strict(),
  z.object({ shape: z.literal('ellipse'), ...rect, ...filterMaskOptions }).strict(),
  z.object({ shape: z.literal('bitmap'), x: z.literal(0).optional(), y: z.literal(0).optional(), ...dimensions,
    runs: z.array(z.number().int().min(0).max(24_000_000)).max(600_000), ...filterMaskOptions }).strict(),
  z.object({ shape: z.literal('alpha8'), x: z.literal(0).optional(), y: z.literal(0).optional(), ...dimensions,
    asset: z.string().length(64).regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(33).max(24_000_032), ...filterMaskOptions }).strict(),
]);
const distortCommands = new Set(['add_layer_distort', 'update_layer_distort', 'delete_layer_distort']);
const distortPoint = z.object({ x: z.number().finite().min(-16384).max(16384), y: z.number().finite().min(-16384).max(16384) }).strict();
const distortCorners = z.array(distortPoint).length(4);
const revisionPinnedMutationCommands = new Set(['bake_layer_filters', 'set_layer_filter_mask', 'modify_layer_filter_mask', 'clear_layer_filter_mask', 'import_color_lookup', 'load_channel_selection', 'load_color_range_selection', 'set_layer_fill', ...distortCommands]);
const colorRangeCommands = new Set(['get_color_range_preview', 'load_color_range_selection']);
const colorRangeSettings = {
  colors: z.array(z.string().length(7).regex(/^#[0-9a-f]{6}$/i)).min(1).max(COLOR_RANGE_LIMITS.maxColors),
  tolerance: z.number().int().min(0).max(COLOR_RANGE_LIMITS.maxTolerance).default(32),
  falloff: z.number().int().min(0).max(COLOR_RANGE_LIMITS.maxFalloff).default(32),
  invert: z.boolean().default(false),
};
const font={fontFamily:z.enum(FONT_FAMILIES).optional(),fontWeight:z.enum(['normal','bold']).optional(),fontStyle:z.enum(['normal','italic']).optional(),align:z.enum(['left','center','right']).optional(),tracking:z.number().int().min(-1000).max(1000).optional(),leading:z.number().finite().min(1).max(2000).nullable().optional()};
const percentage = z.number().finite().min(-200).max(200).refine(value => Math.round(value * 100) / 100 === value, 'Use increments of 0.01 percent');
const mixerRow = z.array(percentage).length(4);
const tonalPercentage = (min, max) => z.number().finite().min(min).max(max).refine(value => Math.round(value * 100) / 100 === value, 'Use increments of 0.01 percent');
const balanceRow = z.array(tonalPercentage(-100, 100)).length(3);
const grayMix = tonalPercentage(-200, 300);
const selectiveRanges = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];
const selectiveRow = z.array(tonalPercentage(-100, 100)).length(4);
const hueSaturationRanges = ['master','reds','yellows','greens','cyans','blues','magentas'];
const hueSaturationRow = z.tuple([tonalPercentage(-180,180),tonalPercentage(-100,100),tonalPercentage(-100,100)]);
const curvePoints = z.array(z.object({ x:z.number().finite().min(0).max(255), y:z.number().finite().min(0).max(255) }).strict()).min(2).max(16);
const curveBank = z.object({
  points: curvePoints.refine(points => points[0].x === 0 && points.at(-1).x === 255 && points.every((point,index) => index === 0 || point.x > points[index-1].x), 'Curve bank points must increase strictly from x=0 to x=255').optional(),
  interpolation: z.enum(['linear','smooth']).optional(),
}).strict();
const curveBanks = z.object(Object.fromEntries(['master','red','green','blue'].map(name => [name,curveBank.optional()]))).strict();
const lookupSourceName = z.string().min(1).max(COLOR_LOOKUP_LIMITS.maxSourceNameLength).refine(value => value.isWellFormed() && Boolean(value.trim()) && !['.', '..'].includes(value) && !/[\u0000-\u001f\u007f/\\]/.test(value), 'Use a well-formed source basename');
const lookupDescriptor = z.object({
  asset: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(1).max(COLOR_LOOKUP_LIMITS.maxBytes),
  gridSize: z.number().int().min(COLOR_LOOKUP_LIMITS.minGridSize).max(COLOR_LOOKUP_LIMITS.maxGridSize),
  inputSpace: z.literal('srgb'), sourceName: lookupSourceName,
  title: z.string().max(COLOR_LOOKUP_LIMITS.maxTitleLength).refine(value => value.isWellFormed() && !/[\u0000-\u001f\u007f"\\]/.test(value), 'Use a literal well-formed title').optional(),
}).strict();
const lookupData = z.string().min(4).max(4 * Math.ceil(COLOR_LOOKUP_LIMITS.maxBytes / 3)).refine(value => { try { colorLookupBase64Bytes(value); return true; } catch { return false; } }, 'Use canonical base64 containing at most 4 MiB');
const parameterSchemas = {
  photo_filter: z.object({color:color.length(7).optional(),density:tonalPercentage(0,100).optional(),preserveLuminosity:z.boolean().optional()}).strict(),
  color_lookup: z.union([lookupDescriptor,z.object({}).strict()]),
  hue_saturation: z.object(Object.fromEntries(hueSaturationRanges.map(range=>[range,hueSaturationRow.optional()]))).strict(),
  selective_color: z.object({method:z.enum(['relative','absolute']).optional(),...Object.fromEntries(selectiveRanges.map(range=>[range,selectiveRow.optional()]))}).strict(),
  levels: z.object({black:z.number().min(0).max(254),white:z.number().min(1).max(255),gamma:z.number().min(0.1).max(10),outputBlack:z.number().min(0).max(255),outputWhite:z.number().min(0).max(255)}).strict(),
  curves: z.union([
    z.object({mode:z.literal('single').optional(),points:curvePoints.optional(),channel:z.enum(['rgb','red','green','blue']).optional(),interpolation:z.enum(['linear','smooth']).optional()}).strict(),
    z.object({mode:z.literal('banks'),banks:curveBanks.optional()}).strict(),
  ]),
  channel_mixer: z.object({monochrome:z.boolean().optional(),red:mixerRow.optional(),green:mixerRow.optional(),blue:mixerRow.optional(),gray:mixerRow.optional()}).strict(),
  gradient_map: z.object({stops:z.array(z.object({offset:z.number().finite().min(0).max(1),color}).strict()).min(2).max(16).refine(stops => stops[0].offset === 0 && stops.at(-1).offset === 1 && stops.every((stop,index) => index === 0 || stop.offset > stops[index-1].offset), 'Gradient map stops must increase strictly from 0 to 1').optional(),reverse:z.boolean().optional()}).strict(),
  color_balance: z.object({shadows:balanceRow.optional(),midtones:balanceRow.optional(),highlights:balanceRow.optional(),preserveLuminosity:z.boolean().optional()}).strict(),
  black_white: z.object({reds:grayMix.optional(),yellows:grayMix.optional(),greens:grayMix.optional(),cyans:grayMix.optional(),blues:grayMix.optional(),magentas:grayMix.optional(),tint:z.boolean().optional(),tintColor:color.optional(),tintAmount:tonalPercentage(0,100).optional()}).strict(),
};
const parameters=z.union(Object.values(parameterSchemas));
// Source-only families must not become global adjustment kinds or parameters.
const sourceParameterSchemas={
  ...parameterSchemas,
  unsharp_mask:z.object({amount:tonalPercentage(0,500).optional(),sigma:z.number().finite().min(0).max(50).optional(),threshold:z.number().int().min(0).max(255).optional()}).strict(),
  add_noise:z.object({amount:tonalPercentage(0,400).optional(),distribution:z.enum(['uniform','gaussian']).optional(),monochromatic:z.boolean().optional(),seed:z.number().int().min(0).max(4294967295).optional()}).strict(),
  shadows_highlights:z.object({shadows:tonalPercentage(0,100).optional(),highlights:tonalPercentage(0,100).optional(),shadowWidth:tonalPercentage(1,100).optional(),highlightWidth:tonalPercentage(1,100).optional(),sigma:z.number().finite().min(0).max(50).optional()}).strict(),
};
const sourceParameters=z.union(Object.values(sourceParameterSchemas));
const name = z.string().trim().min(1).max(200);
const blendMode = z.enum(BLEND_MODES);
const strict = (shape) => z.object(shape).strict();
const vectorStyle={fill:color.nullable().optional(),stroke:color.nullable().optional(),strokeWidth:z.number().min(0).max(100).optional()};
const shapeFields={shape:z.enum(['rectangle','ellipse','triangle','polygon','star','line']),x:strokePoint.shape.x,y:strokePoint.shape.y,...dimensions,...vectorStyle,radius:z.number().min(0).max(4096).optional(),sides:z.number().int().min(3).max(100).optional(),innerRadius:z.number().min(0.01).max(1).optional()};
const pathFields={nodes:z.array(strokePoint.extend({in:strokePoint.optional(),out:strokePoint.optional()})).min(2).max(256),closed:z.boolean().optional(),...vectorStyle};
const gradientFields={kind:z.enum(['linear','radial','angle','reflected','diamond']),start:strokePoint,end:strokePoint,stops:z.array(strict({offset:z.number().min(0).max(1),color,opacity:z.number().min(0).max(1).optional()})).min(2).max(16)};
const partialFields=(fields)=>Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,value.optional()]));
const layerFilterKind=z.enum(['exposure','brightness','contrast','saturation','temperature','blur','sharpen','vibrance','hue','highlights','shadows','levels','curves','invert','grayscale','sepia','posterize','threshold','median','mosaic','channel_mixer','gradient_map','color_balance','black_white','unsharp_mask','add_noise','high_pass','shadows_highlights','selective_color','hue_saturation','color_lookup','photo_filter']);
const layerFilterFields={value:z.number().finite().min(-180).max(256),parameters:sourceParameters.optional(),enabled:z.boolean().optional(),opacity:z.number().min(0).max(1).optional(),blendMode:z.enum(LAYER_FILTER_BLEND_MODES).optional()};
const morphologyFields={operation:z.enum(['expand','contract','border','smooth']),radius:z.number().int().min(1).max(100)};

export const commandSchemas = {
  capabilities: strict({}),
  list_documents: strict({}),
  get_document: strict(document),
  create_document: strict({ name, ...dimensions, background: color.default('#151520') }),
  import_color_lookup: strict({ ...document, expectedRevision:z.number().int().positive(), target:z.enum(['adjustment','layer-filter']), layerId:id.optional(), filterId:id.optional(), data:lookupData, sourceName:lookupSourceName, inputSpace:z.literal('srgb') }),
  import_image: strict({ name, data: z.string().min(4).max(40 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Expected base64 image bytes'), mimeType: z.enum(['image/png','image/jpeg','image/webp','image/tiff']) }),
  get_preview: strict({ ...document, maxWidth: z.number().int().min(32).max(2400).default(1600) }),
  get_layer_preview: strict({ ...document, layerId:id, view:z.enum(['layer','source','mask']).default('layer'), maxWidth:z.number().int().min(32).max(2400).default(1600) }),
  get_mask_preview: strict({ ...revision, source:z.enum(['selection','layer-mask','filter-mask']).default('selection'), layerId:id.optional(), maskMode:z.enum(['raw','effective']).optional(), maxEdge:z.number().int().min(32).max(2400).default(700) }),
  get_channel_preview: strict({ ...document, expectedRevision: z.number().int().positive().optional(), channel: z.enum(CHANNEL_SELECTION_CHANNELS).default('luma'), invert: z.boolean().default(false), maxEdge: z.number().int().min(32).max(CHANNEL_PREVIEW_LIMITS.maxEdge).default(CHANNEL_PREVIEW_LIMITS.defaultMaxEdge) }),
  load_channel_selection: strict({ ...document, expectedRevision: z.number().int().positive(), channel: z.enum(CHANNEL_SELECTION_CHANNELS).default('luma'), mode: z.enum(['replace','add','subtract','intersect']).default('replace'), invert: z.boolean().default(false) }),
  get_color_range_preview: strict({ ...document, expectedRevision: z.number().int().positive().optional(), ...colorRangeSettings, maxEdge: z.number().int().min(COLOR_RANGE_PREVIEW_LIMITS.minEdge).max(COLOR_RANGE_PREVIEW_LIMITS.maxEdge).default(COLOR_RANGE_PREVIEW_LIMITS.defaultMaxEdge) }),
  load_color_range_selection: strict({ ...document, expectedRevision: z.number().int().positive(), ...colorRangeSettings, mode: z.enum(['replace','add','subtract','intersect']).default('replace') }),
  add_adjustment: strict({ ...revision, kind: z.enum(['exposure','brightness','contrast','saturation','temperature','blur','sharpen','vibrance','hue','highlights','shadows','levels','curves','invert','grayscale','sepia','posterize','threshold','median','mosaic','channel_mixer','gradient_map','color_balance','black_white','selective_color','hue_saturation','color_lookup','photo_filter']), value: z.number().finite().min(-180).max(256), parameters:parameters.optional(), name: name.optional(), mask: mask.optional() }),
  update_adjustment:strict({...revision,layerId:id,value:z.number().finite().min(-180).max(256).optional(),parameters:parameters.optional(),mask:mask.nullable().optional()}),
  add_layer_filter:strict({...revision,layerId:id,kind:layerFilterKind,...layerFilterFields}),
  update_layer_filter:strict({...revision,layerId:id,filterId:id,...partialFields(layerFilterFields)}),
  reorder_layer_filter:strict({...revision,layerId:id,filterId:id,index:z.number().int().min(0).max(7)}),
  delete_layer_filter:strict({...revision,layerId:id,filterId:id}),
  clear_layer_filters:strict({...revision,layerId:id}),
  bake_layer_filters:strict({...document,expectedRevision:z.number().int().positive(),layerId:id}),
  set_layer_filter_mask:strict({...document,expectedRevision:z.number().int().positive(),layerId:id,source:z.enum(['selection','all','none','mask']),mask:filterMaskDescriptor.optional()}),
  modify_layer_filter_mask:strict({...document,expectedRevision:z.number().int().positive(),layerId:id,enabled:z.boolean().optional(),...filterMaskOptions,density:z.number().finite().min(0).max(1).optional()}),
  clear_layer_filter_mask:strict({...document,expectedRevision:z.number().int().positive(),layerId:id}),
  set_layer: strict({ ...revision, layerId: id, name: name.optional(), visible: z.boolean().optional(), opacity: z.number().min(0).max(1).optional(), blendMode: blendMode.optional() }),
  duplicate_layer: strict({ ...revision, layerId: id }),
  create_group:strict({...revision,name:name.optional(),parentId:id.nullable().optional(),index:z.number().int().min(0).max(63).optional()}),
  set_group_compositing:strict({...revision,layerId:id,mode:z.enum(['pass-through','isolated']),blendMode:blendMode.optional()}),
  set_clipping_chain:strict({...revision,baseLayerId:id,layerIds:z.array(id).max(63)}),
  add_guide:strict({...revision,axis:z.enum(['horizontal','vertical']),position:z.number().int().min(0).max(8192)}),
  update_guide:strict({...revision,guideId:id,position:z.number().int().min(0).max(8192)}),
  delete_guide:strict({...revision,guideId:id}),
  clear_guides:strict(revision),
  group_layers:strict({...revision,layerIds:z.array(id).min(1).max(64),name:name.optional()}),
  ungroup_layer:strict({...revision,layerId:id}),
  move_layer:strict({...revision,layerId:id,parentId:id.nullable(),index:z.number().int().min(0).max(63).optional()}),
  align_layers:strict({...revision,layerIds:z.array(id).min(1).max(64),axis:z.enum(['horizontal','vertical']),alignment:z.enum(['start','center','end']),relativeTo:z.enum(['canvas','layers']).default('canvas')}),
  distribute_layers:strict({...revision,layerIds:z.array(id).min(3).max(64),axis:z.enum(['horizontal','vertical']),spacing:z.enum(['centers','gaps']).default('gaps')}),
  delete_layer: strict({ ...revision, layerId: id }),
  reorder_layer: strict({ ...revision, layerId: id, index: z.number().int().min(0).max(63) }),
  add_text: strict({ ...revision, text: z.string().min(1).max(2000), x: z.number().int().min(0).max(8192), y: z.number().int().min(0).max(8192), fontSize: z.number().min(1).max(1000), color, name: name.optional(),...font }),
  update_text:strict({...revision,layerId:id,text:z.string().min(1).max(2000).optional(),x:z.number().int().min(0).max(8192).optional(),y:z.number().int().min(0).max(8192).optional(),fontSize:z.number().min(1).max(1000).optional(),color:color.optional(),...font}),
  add_paint_layer:strict({...revision,name:name.optional()}),
  create_repair_layer:strict({...revision,sourceLayerId:id,newLayerId:z.string().uuid().regex(/^[0-9a-f-]+$/, 'Use a lowercase UUID').optional(),name:name.optional()}),
  rasterize_layer:strict({...revision,layerId:id}),
  paint_stroke:strict({...revision,layerId:id.optional(),tool:z.enum(['brush','pencil','eraser','clone','heal','dodge','burn','blur','sharpen','smudge','sponge','red_eye','color_replace']),points:z.array(strokePoint.extend({pressure:z.number().min(0).max(1).optional()})).min(1).max(2000),size:z.number().min(1).max(512),hardness:z.number().min(0).max(1),opacity:z.number().min(0).max(1),flow:z.number().min(0.01).max(1).optional(),color:color.optional(),source:strokePoint.optional(),strength:z.number().min(-100).max(100).optional(),tolerance:z.number().min(0).max(255).optional(),sampleMode:z.enum(['current','current-and-below','all']).optional(),ignoreAdjustments:z.boolean().optional()}),
  set_layer_mask:strict({...revision,layerId:id,mask:mask.nullable()}),
  modify_layer_mask:strict({...revision,layerId:id,feather:z.number().min(0).max(100).optional(),invert:z.boolean().optional(),density:z.number().min(0).max(1).optional()}),
  set_layer_mask_position:strict({...revision,layerId:id,x:z.number().int().min(-16384).max(16384),y:z.number().int().min(-16384).max(16384)}),
  apply_layer_mask_position:strict({...revision,layerId:id}),
  select_region:strict({...revision,shape:z.enum(['rectangle','ellipse','polygon']),x:rect.x.optional(),y:rect.y.optional(),width:dimensions.width.optional(),height:dimensions.height.optional(),points:z.array(point).min(3).max(256).optional(),feather:z.number().min(0).max(100).optional(),invert:z.boolean().optional()}),
  modify_selection:strict({...revision,feather:z.number().min(0).max(100).optional(),invert:z.boolean().optional()}),
  morph_selection:strict({...revision,...morphologyFields}),
  morph_layer_mask:strict({...revision,layerId:id,...morphologyFields}),
  save_selection:strict({...revision,name:name.optional(),selectionId:id.optional()}),
  load_selection:strict({...revision,selectionId:id,mode:z.enum(['replace','add','subtract','intersect']).default('replace')}),
  load_layer_selection:strict({...revision,layerId:id,source:z.enum(['content','layer-mask']).default('content'),maskMode:z.enum(['raw','effective']).optional(),mode:z.enum(['replace','add','subtract','intersect']).default('replace'),invert:z.boolean().default(false)}),
  rename_selection:strict({...revision,selectionId:id,name}),
  delete_selection:strict({...revision,selectionId:id}),
  transform_layer:strict({...revision,layerId:id,x:z.number().finite().min(-16384).max(16384),y:z.number().finite().min(-16384).max(16384),scaleX:z.number().min(0.05).max(8).optional(),scaleY:z.number().min(0.05).max(8).optional(),rotation:z.number().min(-180).max(180).optional(),flipX:z.boolean().optional(),flipY:z.boolean().optional()}),
  add_layer_distort: strict({ ...revision, expectedRevision: z.number().int().min(1), layerId: id, corners: distortCorners }),
  update_layer_distort: strict({ ...revision, expectedRevision: z.number().int().min(1), layerId: id, transformIndex: z.number().int().min(0).max(499), corners: distortCorners }),
  delete_layer_distort: strict({ ...revision, expectedRevision: z.number().int().min(1), layerId: id, transformIndex: z.number().int().min(0).max(499) }),
  get_histogram:strict(document),
  add_shape:strict({...revision,...shapeFields,name:name.optional()}),
  update_shape:strict({...revision,layerId:id,...partialFields(shapeFields)}),
  add_path:strict({...revision,...pathFields,name:name.optional()}),
  update_path:strict({...revision,layerId:id,...partialFields(pathFields)}),
  add_gradient:strict({...revision,...gradientFields,name:name.optional()}),
  update_gradient:strict({...revision,layerId:id,...partialFields(gradientFields)}),
  select_color:strict({...revision,x:rect.x,y:rect.y,tolerance:z.number().min(0).max(255).default(32),contiguous:z.boolean().default(true),mode:z.enum(['replace','add','subtract','intersect']).default('replace')}),
  fill_area:strict({...revision,layerId:id,x:rect.x.optional(),y:rect.y.optional(),color:color.optional(),opacity:z.number().min(0).max(1).default(1),tolerance:z.number().min(0).max(255).default(32),contiguous:z.boolean().default(true),mode:z.enum(['color','erase']).default('color')}),
  sample_color:strict({...document,x:rect.x,y:rect.y,radius:z.number().int().min(0).max(50).default(0)}),
  mask_from_selection:strict({...revision,layerId:id}),
  paint_selection:strict({...revision,points:z.array(strokePoint.extend({pressure:z.number().min(0).max(1).optional()})).min(1).max(2000),size:z.number().min(1).max(512),hardness:z.number().min(0).max(1).default(1),opacity:z.number().min(0).max(1).default(1),mode:z.enum(['add','subtract','replace']).default('add')}),
  paint_mask:strict({...revision,layerId:id,points:z.array(strokePoint.extend({pressure:z.number().min(0).max(1).optional()})).min(1).max(2000),size:z.number().min(1).max(512),hardness:z.number().min(0).max(1).default(1),opacity:z.number().min(0).max(1).default(1),mode:z.enum(['add','subtract','replace']).default('add')}),
  crop_document: strict({ ...revision, ...rect }),
  resize_document: strict({ ...revision, ...dimensions, resample: z.enum(['nearest','cubic','mitchell','lanczos3']).optional() }),
  resize_canvas:strict({...revision,...dimensions,anchor:z.enum(['top-left','top','top-right','left','center','right','bottom-left','bottom','bottom-right']).default('center'),selectPadding:z.boolean().default(false)}),
  select_subject: strict({...revision,layerId:id.optional()}),
  extract_subject:strict({...revision,layerId:id,name:name.optional(),protect:z.boolean().default(true),hideOriginal:z.boolean().default(true)}),
  place_layer:strict({...revision,sourceDocumentId:id,sourceLayerId:id,sourceExpectedRevision:z.number().int().min(1).optional(),...rect,name:name.optional(),protect:z.boolean().default(true)}),
  set_layer_outline:strict({...revision,layerId:id,width:z.number().int().min(0).max(64),color:color.default('#ffffff')}),
  save_layer_style:strict({...revision,layerId:id,name:name.optional(),styleId:id.optional()}),
  apply_layer_style:strict({...revision,styleId:id,layerIds:z.array(id).min(1).max(64)}),
  rename_layer_style:strict({...revision,styleId:id,name}),
  delete_layer_style:strict({...revision,styleId:id}),
  set_layer_effects:strict({...revision,layerId:id,effects:strict({shadow:strict({color:color.optional(),opacity:z.number().min(0).max(1).optional(),blur:z.number().min(0).max(64).optional(),x:z.number().min(-256).max(256).optional(),y:z.number().min(-256).max(256).optional()}).optional(),glow:strict({color:color.optional(),opacity:z.number().min(0).max(1).optional(),blur:z.number().min(0).max(64).optional()}).optional()}).nullable()}),
  set_layer_fill:strict({...document,expectedRevision:z.number().int().min(1),layerId:id,fillOpacity:z.number().finite().min(0).max(1)}),
  set_layer_protection:strict({...revision,layerId:id,protected:z.boolean()}),
  paint_cutout_mask:strict({...revision,layerId:id,points:z.array(strokePoint.extend({pressure:z.number().min(0).max(1).optional()})).min(1).max(2000),size:z.number().min(1).max(512),hardness:z.number().min(0).max(1).default(1),opacity:z.number().min(0).max(1).default(1),mode:z.enum(['add','subtract','replace']).default('add')}),
  refine_cutout_from_selection:strict({...revision,layerId:id,mode:z.enum(['add','subtract','intersect','replace']).default('add')}),
  select_rectangle: strict({ ...revision, ...rect }),
  clear_selection: strict(revision),
  undo: strict(revision),
  redo: strict(revision),
  save_document: strict(document),
  export_document: strict({ ...document, format: z.enum(['png','jpeg','webp','tiff']).default('png'), quality: z.number().int().min(1).max(100).default(92), matte:color.optional(),density:z.number().int().min(1).max(1200).optional(),lossless:z.boolean().optional() }),
  apply_transaction: strict({ ...revision, label: name, operations: z.array(strict({ command: z.string(), args: z.record(z.string(),z.unknown()).default({}) })).min(1).max(30) }),
};

const editRecipeSchemas = createEditRecipeSchemas(commandSchemas);
Object.assign(commandSchemas, editRecipeSchemas.commands);
const editRecipeCommandNames = new Set(Object.keys(editRecipeSchemas.commands));

export const readCommands = new Set(['capabilities','list_documents','get_document','get_preview','get_layer_preview','get_mask_preview','get_histogram','sample_color','export_document','get_edit_recipe','validate_edit_recipe']);
readCommands.add('get_channel_preview');
readCommands.add('get_color_range_preview');
export const transactionCommands = new Set(['add_adjustment','update_adjustment','set_layer','duplicate_layer','delete_layer','reorder_layer','add_text','update_text','add_paint_layer','rasterize_layer','paint_stroke','set_layer_mask','select_region','modify_selection','transform_layer','crop_document','resize_document','select_subject','select_rectangle','clear_selection','add_shape','update_shape','add_path','update_path','add_gradient','update_gradient','select_color','fill_area','mask_from_selection','paint_selection','paint_mask']);
for (const command of distortCommands) transactionCommands.add(command);
transactionCommands.add('modify_layer_mask');
for(const command of ['set_layer_mask_position','apply_layer_mask_position'])transactionCommands.add(command);
transactionCommands.add('create_repair_layer');
transactionCommands.add('resize_canvas');
transactionCommands.add('refine_cutout_from_selection');
transactionCommands.add('set_layer_effects');
transactionCommands.add('set_layer_fill');
for(const command of ['save_layer_style','apply_layer_style','rename_layer_style','delete_layer_style'])transactionCommands.add(command);
for(const command of ['create_group','group_layers','ungroup_layer','move_layer'])transactionCommands.add(command);
transactionCommands.add('set_group_compositing');
transactionCommands.add('set_clipping_chain');
for(const command of ['add_guide','update_guide','delete_guide','clear_guides'])transactionCommands.add(command);
for(const command of ['save_selection','load_selection','rename_selection','delete_selection'])transactionCommands.add(command);
transactionCommands.add('load_layer_selection');
transactionCommands.add('load_channel_selection');
transactionCommands.add('load_color_range_selection');
for(const command of ['align_layers','distribute_layers'])transactionCommands.add(command);
for(const command of ['add_layer_filter','update_layer_filter','reorder_layer_filter','delete_layer_filter','clear_layer_filters'])transactionCommands.add(command);
transactionCommands.add('bake_layer_filters');
transactionCommands.add('import_color_lookup');
for (const command of ['set_layer_filter_mask', 'modify_layer_filter_mask', 'clear_layer_filter_mask']) transactionCommands.add(command);
for(const command of ['morph_selection','morph_layer_mask'])transactionCommands.add(command);
for(const command of ['extract_subject','place_layer','set_layer_outline','set_layer_protection','paint_cutout_mask'])transactionCommands.add(command);
export const commandLabels = {
  add_layer_distort: 'Add four-corner distortion', update_layer_distort: 'Edit four-corner distortion', delete_layer_distort: 'Remove four-corner distortion',
  capabilities:'Read available tools', list_documents:'List documents', get_document:'Inspect document',
  create_document:'Create document', import_color_lookup:'Import Color Lookup', import_image:'Import image', get_preview:'Render preview',
  add_adjustment:'Add adjustment', set_layer:'Update layer', duplicate_layer:'Duplicate layer', delete_layer:'Delete layer', reorder_layer:'Reorder layer',
  add_text:'Add text', crop_document:'Crop document', resize_document:'Resize document', select_subject:'Select subject', select_rectangle:'Select area',
  clear_selection:'Clear selection', undo:'Undo', redo:'Redo', save_document:'Save project', export_document:'Export image', apply_transaction:'Apply edit plan',
  update_adjustment:'Edit adjustment',update_text:'Edit text',add_paint_layer:'Add paint layer',rasterize_layer:'Rasterize layer',paint_stroke:'Paint or retouch',set_layer_mask:'Edit layer mask',select_region:'Select region',modify_selection:'Refine selection',transform_layer:'Transform layer',get_histogram:'Read image histogram',
  add_shape:'Draw shape',update_shape:'Edit shape',add_path:'Draw path',update_path:'Edit path',add_gradient:'Add gradient',update_gradient:'Edit gradient',select_color:'Select color region',fill_area:'Fill or erase region',sample_color:'Sample image color',mask_from_selection:'Mask from selection',
  paint_selection:'Paint selection',paint_mask:'Paint layer mask',
  modify_layer_mask:'Refine layer mask',
  set_layer_mask_position:'Move layer mask',apply_layer_mask_position:'Rasterize mask position',
  extract_subject:'Extract subject cutout',place_layer:'Place layer from another document',set_layer_outline:'Edit outside outline',set_layer_protection:'Protect original pixels',
  paint_cutout_mask:'Refine cutout coverage',
  refine_cutout_from_selection:'Refine cutout from selection',
  get_layer_preview:'Inspect layer, original or mask',
  get_mask_preview:'Inspect selection or layer mask coverage',
  get_channel_preview:'Preview composite channel coverage',
  load_channel_selection:'Load selection from composite channel',
  get_color_range_preview:'Preview Color Range coverage',
  load_color_range_selection:'Load Color Range selection',
  set_layer_effects:'Edit layer shadow and glow',
  set_layer_fill:'Set layer content Fill opacity',
  save_layer_style:'Save reusable layer style',apply_layer_style:'Apply saved layer style',rename_layer_style:'Rename saved layer style',delete_layer_style:'Delete saved layer style',
  create_group:'Create layer group',group_layers:'Group layers',ungroup_layer:'Ungroup layers',move_layer:'Move layer to group',
  set_group_compositing:'Set group isolation and blending',
  set_clipping_chain:'Set or release clipping chain',
  add_guide:'Add layout guide',update_guide:'Move layout guide',delete_guide:'Delete layout guide',clear_guides:'Clear layout guides',
  save_selection:'Save named selection',load_selection:'Restore or combine selection',rename_selection:'Rename saved selection',delete_selection:'Delete saved selection',
  load_layer_selection:'Load selection from layer transparency or mask',
  align_layers:'Align layers',distribute_layers:'Distribute layers',
  add_layer_filter:'Add editable layer filter',update_layer_filter:'Edit layer filter',reorder_layer_filter:'Reorder layer filters',delete_layer_filter:'Remove layer filter',clear_layer_filters:'Clear layer filters',
  bake_layer_filters:'Bake filters into working pixels',
  set_layer_filter_mask:'Set filter effect mask',modify_layer_filter_mask:'Edit filter effect mask',clear_layer_filter_mask:'Remove filter effect mask',
  resize_canvas:'Change canvas bounds',
  morph_selection:'Reshape selection',morph_layer_mask:'Reshape layer mask',
  create_repair_layer:'Create separate repair layer',
  save_edit_recipe:'Save reusable edit recipe',get_edit_recipe:'Inspect edit recipe',rename_edit_recipe:'Rename edit recipe',delete_edit_recipe:'Delete edit recipe',validate_edit_recipe:'Validate recipe targets',apply_edit_recipe:'Apply edit recipe',
};

export function commandError(code, message) { return Object.assign(new Error(message), { code }); }

function parseEditRecipe(schema, value) {
  assertEditRecipeJson(value);
  try { return schema.parse(value); }
  catch (error) { throw commandError('INVALID_ARGUMENTS', error.issues?.slice(0, 16).map(issue => `${issue.path.join('.') || 'recipe'}: ${issue.message}`).join('; ') || 'Invalid edit recipe'); }
}
export function validateEditRecipeDefinition(value) { return validateEditRecipeSemantics(parseEditRecipe(editRecipeSchemas.definitionSchema, value), validateCommand); }
export function validateEditRecipeRecord(value) { return validateEditRecipeSemantics(parseEditRecipe(editRecipeSchemas.recordSchema, value), validateCommand); }
export function validateEditRecipeBindings(value) { return parseEditRecipe(editRecipeSchemas.bindingsSchema, value); }

// Validate the new immutable descriptor before Zod snapshots can invoke getters
// or erase property attributes, including the record copy in a transaction.
function validateDenseMaskArguments(command, args) {
  const operations = command === 'apply_transaction'
    ? args && typeof args === 'object' && Object.getOwnPropertyDescriptor(args, 'operations')?.value
    : [{ command, args }];
  if (!Array.isArray(operations)) return;
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Object.getOwnPropertyDescriptor(operation, 'command')?.value !== 'set_layer_filter_mask') continue;
    const options = Object.getOwnPropertyDescriptor(operation, 'args')?.value;
    if (!options || typeof options !== 'object') continue;
    const property = Object.getOwnPropertyDescriptor(options, 'mask');
    if (!property) continue;
    if (!property.enumerable || !Object.hasOwn(property, 'value')) throw commandError('INVALID_ARGUMENTS', 'Source masks require an ordinary data property.');
    const value = property.value;
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw commandError('INVALID_ARGUMENTS', 'Source masks require a plain data descriptor.');
    const shape = Object.getOwnPropertyDescriptor(value, 'shape');
    if (shape && (!shape.enumerable || !Object.hasOwn(shape, 'value'))) throw commandError('INVALID_ARGUMENTS', 'Source mask shape requires an ordinary data property.');
    if (shape?.value === 'alpha8') {
      try { normalizeDenseMaskDescriptor(value); }
      catch (error) { throw commandError('INVALID_ARGUMENTS', error.message); }
    }
  }
}

function colorRangeDataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw commandError('INVALID_ARGUMENTS', 'Color Range command envelopes require plain data objects.');
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw commandError('INVALID_ARGUMENTS', 'Color Range command envelopes accept own enumerable data fields only.');
    fields[key] = descriptor.value;
  }
  return fields;
}

function checkColorRangeEnvelope(command, args) {
  const fields = colorRangeDataObject(args);
  const allowed = new Set(['documentId', 'expectedRevision', 'colors', 'tolerance', 'falloff', 'invert', command === 'get_color_range_preview' ? 'maxEdge' : 'mode']);
  for (const key of Object.keys(fields)) if (!allowed.has(key) || fields[key] === undefined)
    throw commandError('INVALID_ARGUMENTS', 'Unsupported or undefined Color Range argument.');
  const settings = Object.create(null);
  for (const key of ['colors', 'tolerance', 'falloff', 'invert']) if (Object.hasOwn(fields, key)) settings[key] = fields[key];
  try { normalizeColorRangeSettings(settings); }
  catch (error) { throw commandError('INVALID_ARGUMENTS', error.message); }
  if (Object.hasOwn(fields, 'expectedRevision') && !(Number.isInteger(fields.expectedRevision) && fields.expectedRevision > 0))
    throw commandError('INVALID_ARGUMENTS', 'Color Range requires a positive expectedRevision when supplied.');
  if (Object.hasOwn(fields, 'maxEdge') && !(Number.isInteger(fields.maxEdge) && fields.maxEdge >= COLOR_RANGE_PREVIEW_LIMITS.minEdge && fields.maxEdge <= COLOR_RANGE_PREVIEW_LIMITS.maxEdge))
    throw commandError('INVALID_ARGUMENTS', 'Color Range preview size exceeds the supported range.');
  if (Object.hasOwn(fields, 'mode') && !['replace', 'add', 'subtract', 'intersect'].includes(fields.mode))
    throw commandError('INVALID_ARGUMENTS', 'Choose a supported Color Range selection mode.');
}

/** Inspect before Zod/structured snapshots erase raw own-property evidence.
 * Native execute uses the Boolean to capture BOTH the read and mutation at
 * call time. Transaction discovery never reads an accessor to find a step. */
export function checkColorRangeCommandArguments(command, args) {
  if (colorRangeCommands.has(command)) { checkColorRangeEnvelope(command, args); return true; }
  if (command !== 'apply_transaction') return false;
  const envelope = colorRangeDataObject(args), operations = envelope.operations;
  if (!Array.isArray(operations) || Object.getPrototypeOf(operations) !== Array.prototype)
    throw commandError('INVALID_ARGUMENTS', 'Transaction operations require an ordinary dense array.');
  const length = Object.getOwnPropertyDescriptor(operations, 'length')?.value;
  if (!Number.isInteger(length) || length < 1 || length > 30 || Reflect.ownKeys(operations).length !== length + 1)
    throw commandError('INVALID_ARGUMENTS', 'Transaction operations require one to thirty ordinary entries.');
  let contains = false;
  for (let index = 0; index < length; index++) {
    const entry = Object.getOwnPropertyDescriptor(operations, String(index));
    if (!entry?.enumerable || !Object.hasOwn(entry, 'value'))
      throw commandError('INVALID_ARGUMENTS', 'Transaction entries require own enumerable data properties.');
    const step = colorRangeDataObject(entry.value);
    if (colorRangeCommands.has(step.command)) {
      checkColorRangeEnvelope(step.command, step.args);
      contains = true;
    }
  }
  return contains;
}

export function validateCommand(command, args = {}) {
  const schema = commandSchemas[command];
  if (!schema) throw commandError('UNSUPPORTED_COMMAND', `Unknown editing command: ${String(command).slice(0,80)}`);
  checkColorRangeCommandArguments(command, args);
  validateDenseMaskArguments(command, args);
  if (editRecipeCommandNames.has(command)) assertEditRecipeJson(args, { maxValues: 8256 });
  const suppliedParameters = args && typeof args==='object' ? Object.getOwnPropertyDescriptor(args,'parameters')?.value : undefined;
  if(suppliedParameters && typeof suppliedParameters==='object' && ['asset','bytes','gridSize','inputSpace','sourceName','title'].some(key=>Object.hasOwn(suppliedParameters,key))) { try { normalizeColorLookupParameters(suppliedParameters); } catch(error) { throw commandError('INVALID_ARGUMENTS',error.message); } }
  if(command==='import_color_lookup') {
    if(!args || ![Object.prototype,null].includes(Object.getPrototypeOf(args)) || Reflect.ownKeys(args).some(key=>{const field=Object.getOwnPropertyDescriptor(args,key);return typeof key!=='string'||!field.enumerable||!Object.hasOwn(field,'value');})) throw commandError('INVALID_ARGUMENTS','Color Lookup imports accept plain data fields only.');
  }
  let parsed;
  try { parsed = schema.parse(args); }
  catch (error) { throw commandError('INVALID_ARGUMENTS', error.issues?.map(i => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') || 'Invalid command arguments'); }
  if (colorRangeCommands.has(command)) {
    const { colors, tolerance, falloff, invert } = parsed;
    Object.assign(parsed, normalizeColorRangeSettings({ colors, tolerance, falloff, invert }));
  }
  if (command === 'set_layer_fill' && parsed.fillOpacity === 0) parsed.fillOpacity = 0;
  if (parsed.width && parsed.height && parsed.width * parsed.height > 24_000_000) throw commandError('IMAGE_TOO_LARGE', 'Images are limited to 24 million pixels in this release.');
  if (command === 'save_edit_recipe') validateEditRecipeDefinition({ name: parsed.name, slots: parsed.slots, steps: parsed.steps });
  if(command==='import_color_lookup') {
    if(parsed.target==='adjustment' && parsed.filterId!==undefined) throw commandError('INVALID_ARGUMENTS','A global Color Lookup cannot have a filterId.');
    if(parsed.target==='layer-filter' && parsed.layerId===undefined) throw commandError('INVALID_ARGUMENTS','Choose a raster layer for a source Color Lookup.');
  }
  if(command==='load_layer_selection'&&parsed.source==='content'&&parsed.maskMode!==undefined)throw commandError('INVALID_ARGUMENTS','Mask coverage mode applies only to a layer-mask source.');
  if(command==='get_mask_preview'){
    if(parsed.source==='selection'&&(parsed.layerId!==undefined||parsed.maskMode!==undefined))throw commandError('INVALID_ARGUMENTS','Layer and mask mode apply only to a layer-mask preview.');
    if(['layer-mask','filter-mask'].includes(parsed.source)&&parsed.layerId===undefined)throw commandError('INVALID_ARGUMENTS','Choose a layer for an additional-mask or filter-mask preview.');
  }
  if (command === 'set_layer_filter_mask') {
    if ((parsed.source === 'mask') !== (parsed.mask !== undefined)) throw commandError('INVALID_ARGUMENTS', 'Supply a source mask descriptor only when source is mask.');
    if (parsed.mask?.shape === 'alpha8') {
      try { normalizeDenseMaskDescriptor(parsed.mask); }
      catch (error) { throw commandError('INVALID_ARGUMENTS', error.message); }
    }
    if (parsed.mask?.shape === 'bitmap') {
      const { width, height, runs } = parsed.mask;
      if (width * height > 24_000_000 || runs.length % 3 !== 0) throw commandError('INVALID_ARGUMENTS', 'Invalid source bitmap dimensions or run triples.');
      let end = 0;
      for (let i = 0; i < runs.length; i += 3) {
        const [start, length, alpha] = runs.slice(i, i + 3);
        if (start < end || length < 1 || start + length > width * height || alpha < 1 || alpha > 255) throw commandError('INVALID_ARGUMENTS', 'Source bitmap runs must be ordered, nonoverlapping and within the source frame, with alpha 1 through 255.');
        end = start + length;
      }
    }
  }
  if (command === 'modify_layer_filter_mask' && ['enabled','feather','invert','density'].every(key => parsed[key] === undefined)) throw commandError('INVALID_ARGUMENTS', 'Supply at least one filter-mask setting to update.');
  if(command==='group_layers'&&new Set(parsed.layerIds).size!==parsed.layerIds.length)throw commandError('INVALID_ARGUMENTS','Choose each layer only once.');
  if(command==='apply_layer_style'&&new Set(parsed.layerIds).size!==parsed.layerIds.length)throw commandError('INVALID_ARGUMENTS','Choose each layer only once.');
  if(command==='set_clipping_chain'&&(new Set(parsed.layerIds).size!==parsed.layerIds.length||parsed.layerIds.includes(parsed.baseLayerId)))throw commandError('INVALID_ARGUMENTS','Choose each upper layer only once, excluding the clipping base.');
  if(command==='set_group_compositing'&&parsed.mode==='pass-through'&&parsed.blendMode!==undefined&&parsed.blendMode!=='normal')throw commandError('INVALID_ARGUMENTS','Pass-through groups require normal blending. Choose isolated mode for another blend.');
  if(['align_layers','distribute_layers'].includes(command)&&new Set(parsed.layerIds).size!==parsed.layerIds.length)throw commandError('INVALID_ARGUMENTS','Choose each layer only once.');
  if(command==='align_layers'&&parsed.relativeTo==='layers'&&parsed.layerIds.length<2)throw commandError('INVALID_ARGUMENTS','Select at least two layers to align against their combined bounds.');
  if(command==='export_document'){
    if(parsed.matte!==undefined&&parsed.format!=='jpeg')throw commandError('INVALID_ARGUMENTS','A matte color applies only to JPEG export.');
    if(parsed.lossless!==undefined&&parsed.format!=='webp')throw commandError('INVALID_ARGUMENTS','The lossless option applies only to WebP export.');
    if(parsed.density!==undefined&&parsed.format==='webp')throw commandError('INVALID_ARGUMENTS','Density metadata is supported for PNG, JPEG and TIFF export.');
  }
  if (command === 'add_adjustment' || command === 'add_layer_filter') {
    const schemas = command === 'add_layer_filter' ? sourceParameterSchemas : parameterSchemas;
    const range = {exposure:[-5,5],blur:[0,50],sharpen:[0,10],high_pass:[0,50],hue:[-180,180],levels:[0,0],curves:[0,0],channel_mixer:[0,0],gradient_map:[0,0],color_balance:[0,0],black_white:[0,0],selective_color:[0,0],hue_saturation:[0,0],color_lookup:[0,0],photo_filter:[0,0],unsharp_mask:[0,0],add_noise:[0,0],shadows_highlights:[0,0],invert:[0,100],grayscale:[0,100],sepia:[0,100],posterize:[2,256],threshold:[0,255],median:[1,15],mosaic:[1,128]}[parsed.kind]||[-100,100];
    if (parsed.value < range[0] || parsed.value > range[1]) throw commandError('INVALID_ARGUMENTS', `${parsed.kind} must be between ${range[0]} and ${range[1]}.`);
    if(['posterize','threshold','median','mosaic'].includes(parsed.kind)&&!Number.isInteger(parsed.value))throw commandError('INVALID_ARGUMENTS',`${parsed.kind} requires an integer value.`);
    if(parsed.kind==='median'&&parsed.value%2===0)throw commandError('INVALID_ARGUMENTS','Median size must be an odd integer.');
    if(parsed.kind === 'color_lookup' && !lookupDescriptor.safeParse(parsed.parameters).success) throw commandError('INVALID_ARGUMENTS','A new Color Lookup requires a complete verified asset descriptor.');
    if(parsed.parameters && !schemas[parsed.kind])throw commandError('INVALID_ARGUMENTS','The selected kind does not accept parameters.');
    if(parsed.parameters && !schemas[parsed.kind].safeParse(parsed.parameters).success)throw commandError('INVALID_ARGUMENTS','Parameters do not match the selected kind.');
  }
  if(command==='update_layer_filter'&&['value','parameters','enabled','opacity','blendMode'].every(key=>parsed[key]===undefined))throw commandError('INVALID_ARGUMENTS','Supply at least one filter setting to update.');
  if(parsed.parameters){
    const p=parsed.parameters;
    if('black' in p && (p.black>=p.white || p.outputBlack>p.outputWhite))throw commandError('INVALID_ARGUMENTS','Levels require black < white and outputBlack <= outputWhite.');
    if('points' in p && (p.points[0].x!==0 || p.points.at(-1).x!==255 || p.points.some((point,index)=>index>0&&point.x<=p.points[index-1].x)))throw commandError('INVALID_ARGUMENTS','Curves must start at x=0, end at x=255 and have increasing x coordinates.');
  }
  if(command==='select_region'){
    if(parsed.shape==='polygon' && !parsed.points)throw commandError('INVALID_ARGUMENTS','Polygon selection requires at least three points.');
    if(parsed.shape!=='polygon' && ['x','y','width','height'].some(key=>parsed[key]===undefined))throw commandError('INVALID_ARGUMENTS','Rectangle and ellipse selections require x, y, width and height.');
    if(parsed.shape!=='polygon' && parsed.points)throw commandError('INVALID_ARGUMENTS','Only polygon selections accept points.');
  }
  if(parsed.mask && command !== 'set_layer_filter_mask'){
    if(parsed.mask.shape==='polygon' && !parsed.mask.points)throw commandError('INVALID_ARGUMENTS','Polygon masks require points.');
    if(parsed.mask.shape!=='polygon' && parsed.mask.points)throw commandError('INVALID_ARGUMENTS','Only polygon masks accept points.');
    if(parsed.mask.shape!=='polygon' && ['x','y','width','height'].some(key=>parsed.mask[key]===undefined))throw commandError('INVALID_ARGUMENTS','Rectangle and ellipse masks require x, y, width and height.');
  }
  if(command==='paint_stroke'){
    if(!['clone','heal'].includes(parsed.tool)&&(parsed.sampleMode!==undefined||parsed.ignoreAdjustments!==undefined))throw commandError('INVALID_ARGUMENTS','Sampling options apply only to clone and heal strokes.');
    if(parsed.sampleMode==='current'&&parsed.ignoreAdjustments===true)throw commandError('INVALID_ARGUMENTS','Current-layer sampling contains no adjustment layers to skip.');
    if(parsed.tool!=='brush' && !parsed.layerId)throw commandError('INVALID_ARGUMENTS','Choose a raster layer for retouching or erasing.');
    if(['clone','heal'].includes(parsed.tool) && !parsed.source)throw commandError('INVALID_ARGUMENTS','Choose a source point for cloning or healing.');
    if(['brush','pencil','color_replace'].includes(parsed.tool) && !parsed.color)throw commandError('INVALID_ARGUMENTS','Choose a paint color.');
    if(parsed.tool!=='sponge' && parsed.strength<0)throw commandError('INVALID_ARGUMENTS','Only sponge accepts negative strength.');
  }
  if(command==='fill_area'){
    if((parsed.x===undefined)!==(parsed.y===undefined))throw commandError('INVALID_ARGUMENTS','Supply both x and y for a point fill.');
    if(parsed.mode==='color'&&!parsed.color)throw commandError('INVALID_ARGUMENTS','Color fill requires a color.');
  }
  if(parsed.stops && (parsed.stops[0].offset!==0 || parsed.stops.at(-1).offset!==1 || parsed.stops.some((stop,index)=>index>0&&stop.offset<=parsed.stops[index-1].offset)))throw commandError('INVALID_ARGUMENTS','Gradient stops must increase from offset 0 to 1.');
  if (command === 'apply_transaction') {
    if (parsed.operations.some(operation => revisionPinnedMutationCommands.has(operation.command)) && !(parsed.expectedRevision > 0)) throw commandError('INVALID_TRANSACTION', 'A transaction that sets layer Fill, loads a channel or Color Range selection, imports a lookup, bakes filters, edits a filter mask or edits distortion requires a positive expectedRevision on the transaction.');
    let lookupImportBytes = 0;
    parsed.operations = parsed.operations.map(operation => {
      if (!transactionCommands.has(operation.command)) throw commandError('INVALID_TRANSACTION', `${operation.command} cannot be included in an edit transaction.`);
      if (operation.args.documentId && operation.args.documentId !== parsed.documentId) throw commandError('INVALID_TRANSACTION', 'Every operation must target the same document.');
      if ('expectedRevision' in operation.args) throw commandError('INVALID_TRANSACTION', 'Set expectedRevision on the transaction, not individual operations.');
      const validated = validateCommand(operation.command, {...operation.args, documentId:parsed.documentId, ...(revisionPinnedMutationCommands.has(operation.command) ? {expectedRevision:parsed.expectedRevision} : {})});
      if(operation.command==='import_color_lookup') { lookupImportBytes += colorLookupBase64Bytes(validated.data); if(lookupImportBytes > COLOR_LOOKUP_LIMITS.maxTransactionBytes) throw commandError('LIMIT_EXCEEDED','A transaction may import at most 4 MiB of Color Lookup files.'); }
      delete validated.documentId;
      if (revisionPinnedMutationCommands.has(operation.command)) delete validated.expectedRevision;
      return {command:operation.command,args:validated};
    });
  }
  return parsed;
}

export function validateBackendOptions(backend,command,args){
  if(backend!=='photoshop')return;
  if(colorRangeCommands.has(command))throw commandError('UNSUPPORTED_COMMAND','Color Range preview and selections are implemented in Prism Native.');
  if(['get_channel_preview','load_channel_selection'].includes(command))throw commandError('UNSUPPORTED_COMMAND','Composite-channel preview and selections are implemented in Prism Native.');
  if(['add_adjustment','update_adjustment','add_layer_filter','update_layer_filter'].includes(command)&&(args.kind==='photo_filter'||args.parameters&&['color','density'].some(key=>Object.hasOwn(args.parameters,key))))throw commandError('UNSUPPORTED_COMMAND','Photo Filter is implemented in Prism Native.');
  if(command==='import_color_lookup' || (['add_adjustment','add_layer_filter'].includes(command) && args.kind==='color_lookup') || args.parameters && ['asset','bytes','gridSize','inputSpace','sourceName','title'].some(key=>Object.hasOwn(args.parameters,key))) throw commandError('UNSUPPORTED_COMMAND','Imported Color Lookup files use the Prism Native contract.');
  if(['add_adjustment','update_adjustment','add_layer_filter','update_layer_filter'].includes(command)&&(args.parameters?.mode!==undefined||args.parameters?.banks!==undefined))throw commandError('UNSUPPORTED_COMMAND','Explicit Curves representations and channel banks are implemented in Prism Native.');
  if(['add_adjustment','update_adjustment','add_layer_filter','update_layer_filter'].includes(command)&&args.parameters?.interpolation!==undefined)throw commandError('UNSUPPORTED_COMMAND','Explicit Curves interpolation is implemented in Prism Native.');
  if(['add_adjustment','update_adjustment','add_layer_filter','update_layer_filter'].includes(command)&&(args.kind==='hue_saturation'||args.parameters?.master!==undefined||hueSaturationRanges.some(range=>Array.isArray(args.parameters?.[range])&&args.parameters[range].length===3)))throw commandError('UNSUPPORTED_COMMAND','Targeted Hue / Saturation is implemented in Prism Native.');
  if(['add_adjustment','update_adjustment','add_layer_filter','update_layer_filter'].includes(command)&&(args.kind==='selective_color'||args.parameters?.method!==undefined||selectiveRanges.some(range=>Array.isArray(args.parameters?.[range]))))throw commandError('UNSUPPORTED_COMMAND','Selective Color is implemented in Prism Native.');
  if (distortCommands.has(command)) throw commandError('UNSUPPORTED_COMMAND', 'Editable four-corner distortion is implemented in Prism Native.');
  if(command==='resize_document'&&args.resample!==undefined)throw commandError('UNSUPPORTED_COMMAND','Explicit image resampling methods are implemented in Prism Native.');
  if(editRecipeCommandNames.has(command))throw commandError('UNSUPPORTED_COMMAND','Reusable typed edit recipes are implemented in Prism Native.');
  if(['set_layer_mask_position','apply_layer_mask_position'].includes(command))throw commandError('UNSUPPORTED_COMMAND','Independent additional-mask positioning is implemented in Prism Native.');
  if(command==='create_repair_layer'||command==='paint_stroke'&&(args.sampleMode!==undefined||args.ignoreAdjustments!==undefined))throw commandError('UNSUPPORTED_COMMAND','Repair-layer creation and explicit retouch sampling are implemented in Prism Native.');
  if(command==='import_color_lookup') {
    if(parsed.target==='adjustment' && parsed.filterId!==undefined) throw commandError('INVALID_ARGUMENTS','A global Color Lookup cannot have a filterId.');
    if(parsed.target==='layer-filter' && parsed.layerId===undefined) throw commandError('INVALID_ARGUMENTS','Choose a raster layer for a source Color Lookup.');
  }
  if(command==='load_layer_selection')throw commandError('UNSUPPORTED_COMMAND','Layer transparency and mask selections are implemented in Prism Native.');
  if(command==='get_mask_preview')throw commandError('UNSUPPORTED_COMMAND','Selection and additional-mask inspection are implemented in Prism Native.');
  if(['add_text','update_text'].includes(command)&&(args.tracking!==undefined||args.leading!==undefined))throw commandError('UNSUPPORTED_COMMAND','Editable tracking and leading are implemented in Prism Native.');
  if(command==='modify_layer_mask'&&args.density!==undefined)throw commandError('UNSUPPORTED_COMMAND','Additional layer-mask density is implemented in Prism Native.');
  if(command==='add_adjustment'&&['channel_mixer','gradient_map','color_balance','black_white','selective_color','hue_saturation'].includes(args.kind))throw commandError('UNSUPPORTED_COMMAND','These parameterized color adjustments are implemented in Prism Native.');
  if(command==='set_group_compositing')throw commandError('UNSUPPORTED_COMMAND','Group isolation and blending are implemented in Prism Native.');
  if(command==='set_clipping_chain')throw commandError('UNSUPPORTED_COMMAND','Editable clipping chains are implemented in Prism Native.');
  if(['add_guide','update_guide','delete_guide','clear_guides'].includes(command))throw commandError('UNSUPPORTED_COMMAND','Document guides are implemented in Prism Native.');
  if(['save_layer_style','apply_layer_style','rename_layer_style','delete_layer_style'].includes(command))throw commandError('UNSUPPORTED_COMMAND','Reusable layer styles are implemented in Prism Native.');
  if(['morph_selection','morph_layer_mask'].includes(command))throw commandError('UNSUPPORTED_COMMAND','Mask morphology is implemented in Prism Native.');
  if(['add_layer_filter','update_layer_filter','reorder_layer_filter','delete_layer_filter','clear_layer_filters','bake_layer_filters','set_layer_filter_mask','modify_layer_filter_mask','clear_layer_filter_mask'].includes(command))throw commandError('UNSUPPORTED_COMMAND','Editable layer filters are implemented in Prism Native.');
  if(['align_layers','distribute_layers'].includes(command))throw commandError('UNSUPPORTED_COMMAND','Layer arrangement is implemented in Prism Native.');
  if(['save_selection','load_selection','rename_selection','delete_selection'].includes(command))throw commandError('UNSUPPORTED_COMMAND','Saved selections are implemented in Prism Native.');
  if(['create_group','group_layers','ungroup_layer','move_layer'].includes(command))throw commandError('UNSUPPORTED_COMMAND','Nested group editing is implemented in Prism Native.');
  if(command==='export_document'&&(!['png','jpeg'].includes(args.format)||args.matte!==undefined||args.density!==undefined||args.lossless!==undefined))throw commandError('UNSUPPORTED_COMMAND','These export options are available in Prism Native.');
  if(command==='apply_transaction'){for(const operation of args.operations)validateBackendOptions(backend,operation.command,operation.args);return;}
  if(['extract_subject','place_layer','set_layer_outline','set_layer_effects','set_layer_fill','set_layer_protection','paint_cutout_mask','refine_cutout_from_selection','resize_canvas','get_layer_preview'].includes(command)||(command==='select_subject'&&args.layerId))throw commandError('UNSUPPORTED_COMMAND','This editing option is currently available in Prism Native.');
  if(command==='set_layer' && args.blendMode!==undefined && !['normal','multiply','screen','overlay','darken','lighten','difference','exclusion'].includes(args.blendMode))throw commandError('UNSUPPORTED_COMMAND','This Photoshop bridge version supports normal, multiply, screen, overlay, darken, lighten, difference and exclusion blending.');
  if(command==='add_adjustment' && (args.parameters || (args.mask?.shape && args.mask.shape!=='rectangle')))throw commandError('UNSUPPORTED_COMMAND','This Photoshop bridge version supports scalar adjustments with rectangular masks or the active Photoshop selection.');
  if(command==='add_text' && ['fontFamily','fontWeight','fontStyle','align'].some(key=>args[key]!==undefined))throw commandError('UNSUPPORTED_COMMAND','Custom typography settings are currently available in Prism Native.');
}

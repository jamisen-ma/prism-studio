import { randomUUID } from 'node:crypto';
import { normalizeEffects } from './layer-effects.mjs';
import { layerOutsideEffects, setLayerOutsideEffects } from './layer-fill.mjs';

export const MAX_LAYER_STYLES = 32;
export const LAYER_STYLE_PROPERTIES = Object.freeze(['outline', 'shadow', 'glow']);
export const LAYER_STYLE_COMMANDS = Object.freeze(['save_layer_style', 'apply_layer_style', 'rename_layer_style', 'delete_layer_style']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CONTENT = new Set(['raster', 'solid', 'text', 'shape', 'path', 'gradient']);
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const check = (condition, message, code) => { if (!condition) fail(message, code); };
function object(value, fields, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key)), `Invalid ${label} fields.`);
}
function styleName(value) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= 200, 'Style name must contain 1–200 characters.');
  return value.trim();
}
function outlineSettings(outline) {
  object(outline, ['width', 'color'], 'preset outline');
  check(Number.isInteger(outline.width) && outline.width >= 0 && outline.width <= 64, 'Preset outline width must be an integer between 0 and 64 canvas pixels.');
  check(typeof outline.color === 'string' && /^#[a-f0-9]{6}$/i.test(outline.color), 'Preset outline color must be #RRGGBB.');
  return { width: outline.width, color: outline.color.toLowerCase() };
}

/** Settings are reusable without rendering the source. Positive effect opacity
 * is an enabled setting, not a promise of visible pixels on every layer. */
export function normalizeLayerStyle(style) {
  object(style, ['id', 'name', 'outline', 'effects'], 'saved layer style');
  check(typeof style.id === 'string' && UUID.test(style.id), 'Saved layer styles require UUID identifiers.');
  const result = { id: style.id, name: styleName(style.name) };
  if (style.outline !== undefined) {
    const outline = outlineSettings(style.outline);
    if (outline.width > 0) result.outline = outline;
  }
  if (style.effects !== undefined) {
    const effects = normalizeEffects(style.effects);
    if (effects) result.effects = effects;
  }
  check((result.outline?.width ?? 0) > 0 || Object.values(result.effects ?? {}).some(effect => effect.opacity > 0),
    'Add a nonzero outline or enable a shadow or glow before saving a layer style.', 'NO_LAYER_STYLE');
  return result;
}

export function validateLayerStyles(graph) {
  if (graph.layerStyles === undefined) return;
  check(Array.isArray(graph.layerStyles), 'Saved layer styles must be an array.');
  check(graph.layerStyles.length <= MAX_LAYER_STYLES, 'Documents support up to 32 saved layer styles.', 'LIMIT_EXCEEDED');
  const seen = new Set();
  for (const entry of graph.layerStyles) {
    const style = normalizeLayerStyle(entry);
    check(!seen.has(style.id), 'Saved layer style identifiers must be unique.'); seen.add(style.id);
  }
}

/** Return a staged graph and label. Never mutate the input: native validates
 * all resource/protection rules on this candidate before publishing it. */
export function updatedLayerStyles(graph, command, args) {
  check(LAYER_STYLE_COMMANDS.includes(command), 'Unsupported layer style command.', 'UNSUPPORTED');
  validateLayerStyles(graph);
  const saved = (graph.layerStyles ?? []).map(normalizeLayerStyle);
  let existing;
  if (args.styleId !== undefined) {
    check(typeof args.styleId === 'string' && UUID.test(args.styleId), 'Choose a saved style UUID.');
    existing = saved.find(style => style.id === args.styleId);
    check(existing, 'Saved layer style was not found.', 'NOT_FOUND');
  }
  if (command === 'save_layer_style') {
    check(typeof args.layerId === 'string' && UUID.test(args.layerId), 'Choose a content layer UUID.');
    const layer = graph.layers.find(item => item.id === args.layerId);
    check(layer, 'Layer was not found.', 'NOT_FOUND');
    check(CONTENT.has(layer.type), 'Save outside styles from an individual content layer, not a group or adjustment.', 'INVALID_TARGET');
    check(existing || saved.length < MAX_LAYER_STYLES, 'Documents support up to 32 saved layer styles. Overwrite or delete an existing style.', 'LIMIT_EXCEEDED');
    const effects = layerOutsideEffects(layer);
    const captured = normalizeLayerStyle({ id: existing?.id ?? randomUUID(), name: args.name ?? existing?.name ?? `${layer.name.slice(0, 194)} style`,
      ...(layer.outline ? { outline: layer.outline } : {}), ...(effects ? { effects } : {}) });
    return { graph: { ...graph, layerStyles: existing ? saved.map(style => style.id === existing.id ? captured : style) : [...saved, captured] }, label: existing ? 'Update saved layer style' : 'Save layer style' };
  }
  check(existing, 'Choose a saved layer style first.', 'NOT_FOUND');
  if (command === 'rename_layer_style') return { graph: { ...graph, layerStyles: saved.map(style => style.id === existing.id ? { ...style, name: styleName(args.name) } : style) }, label: 'Rename saved layer style' };
  if (command === 'delete_layer_style') return { graph: { ...graph, layerStyles: saved.filter(style => style.id !== existing.id) }, label: 'Delete saved layer style' };
  check(Array.isArray(args.layerIds) && args.layerIds.length >= 1 && args.layerIds.length <= 64 && args.layerIds.every(id => typeof id === 'string' && UUID.test(id)) && new Set(args.layerIds).size === args.layerIds.length, 'Choose 1–64 unique content layer identifiers.');
  const ids = new Set(args.layerIds), targets = graph.layers.filter(layer => ids.has(layer.id));
  check(targets.length === ids.size, 'A target layer was not found.', 'NOT_FOUND');
  check(targets.every(layer => CONTENT.has(layer.type)), 'Apply outside styles to individual content layers, not groups or adjustments.', 'INVALID_TARGET');
  const layers = graph.layers.map(layer => {
    if (!ids.has(layer.id)) return layer;
    const changed = setLayerOutsideEffects(layer, existing.effects ?? null);
    delete changed.outline;
    if (existing.outline) changed.outline = structuredClone(existing.outline);
    return changed;
  });
  return { graph: { ...graph, layers }, label: `Apply layer style to ${targets.length} ${targets.length === 1 ? 'layer' : 'layers'}` };
}

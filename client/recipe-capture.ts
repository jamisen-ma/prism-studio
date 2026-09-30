import { photoFilterParameters } from './photo-filter';
import { recipeHasLookup } from './color-lookup';
import { targetedHSLParameters } from './targeted-hsl';
import { selectiveColorParameters } from './selective-color';
import { curveParameters } from './curves';
import type { EditRecipeCommand, EditRecipeDefinition, EditRecipeSlot, EditRecipeStep, Layer } from './api';
import { unsharpParameters } from './unsharp';
import { noiseParameters } from './noise';
import { localToneParameters } from './local-tone';
import { effectiveFilterBlend } from './filter-blend';
export type CaptureChoice = { key: string; label: string; command: EditRecipeCommand; defaults: boolean };
const contentTypes = ['raster', 'solid', 'text', 'shape', 'path', 'gradient'];
export const recipeCommands: EditRecipeCommand[] = ['add_layer_filter', 'update_adjustment', 'update_text', 'set_layer_effects', 'set_layer_outline'];
export function captureChoices(layer?: Layer): CaptureChoice[] {
  if (!layer) return [];
  const choices: CaptureChoice[] = [];
  if (layer.type === 'raster' && layer.filters?.length) choices.push({ key: 'filters', label: `Filters (${layer.filters.length}, including disabled entries)`, command: 'add_layer_filter', defaults: true });
  if (layer.type === 'text') choices.push({ key: 'typography', label: 'Typography (keeps target text and position)', command: 'update_text', defaults: true });
  if (layer.type === 'adjustment' && layer.kind && typeof layer.value === 'number') choices.push({ key: 'adjustment', label: `${layer.kind.replaceAll('_', ' ')} adjustment settings`, command: 'update_adjustment', defaults: true });
  if (contentTypes.includes(layer.type)) {
    if (layer.effects?.shadow || layer.effects?.glow) choices.push({ key: 'effects', label: 'Outside shadow / glow', command: 'set_layer_effects', defaults: true });
    if (layer.outline) choices.push({ key: 'outline', label: 'Outside outline', command: 'set_layer_outline', defaults: true });
    choices.push({ key: 'clear-effects', label: 'Clear shadow / glow on target', command: 'set_layer_effects', defaults: false }, { key: 'clear-outline', label: 'Clear outline on target', command: 'set_layer_outline', defaults: false });
  }
  return choices;
}
export function captureRecipe(layer: Layer, selected: Set<string>, name: string, label: string): EditRecipeDefinition {
  if (selected.has('filters') && layer.filters?.some(filter => filter.kind === 'color_lookup') || selected.has('adjustment') && layer.kind === 'color_lookup') throw Error('Recipes cannot carry Color Lookup files. Uncheck Filters to capture other settings, or transfer the editable .prism project.');
  if (selected.has('filters') && layer.filterMask) throw Error('Filter recipes cannot include this source effect mask. Uncheck Filters to capture other settings, or remove the mask explicitly before capturing filters.');
  const target = 'target', steps: EditRecipeStep[] = [], slot: EditRecipeSlot = { key: target, label: label.trim() || 'Target layer', type: 'content' };
  if (selected.has('filters') && layer.type === 'raster') { slot.type = 'raster'; for (const filter of layer.filters || []) steps.push({ command: 'add_layer_filter', target, args: { kind: filter.kind, value: filter.value, ...(effectiveFilterBlend(filter.blendMode) !== 'normal' ? { blendMode: filter.blendMode } : {}), ...(filter.kind === 'photo_filter' ? { parameters: photoFilterParameters(filter.parameters) } : filter.kind === 'hue_saturation' ? { parameters: targetedHSLParameters(filter.parameters) } : filter.kind === 'selective_color' ? { parameters: selectiveColorParameters(filter.parameters) } : filter.kind === 'curves' ? { parameters: curveParameters(filter.parameters) } : filter.kind === 'shadows_highlights' ? { parameters: localToneParameters(filter.parameters) } : filter.kind === 'add_noise' ? { parameters: noiseParameters(filter.parameters) } : filter.kind === 'unsharp_mask' ? { parameters: unsharpParameters(filter.parameters) } : filter.parameters ? { parameters: structuredClone(filter.parameters) } : {}), enabled: filter.enabled ?? true, opacity: filter.opacity ?? 1 } }); }
  if (selected.has('typography') && layer.type === 'text') { slot.type = 'text'; steps.push({ command: 'update_text', target, args: { fontFamily: layer.fontFamily || 'sans-serif', fontSize: layer.fontSize ?? 64, color: layer.color || '#ffffff', fontWeight: layer.fontWeight || 'normal', fontStyle: layer.fontStyle || 'normal', align: layer.align || 'left', tracking: layer.tracking ?? 0, leading: layer.leading ?? null } }); }
  if (selected.has('adjustment') && layer.type === 'adjustment') { slot.type = 'adjustment'; slot.kind = layer.kind; steps.push({ command: 'update_adjustment', target, args: { value: layer.value, ...(layer.kind === 'photo_filter' ? { parameters: photoFilterParameters(layer.parameters) } : layer.kind === 'hue_saturation' ? { parameters: targetedHSLParameters(layer.parameters) } : layer.kind === 'selective_color' ? { parameters: selectiveColorParameters(layer.parameters) } : layer.kind === 'curves' ? { parameters: curveParameters(layer.parameters) } : layer.parameters ? { parameters: structuredClone(layer.parameters) } : {}) } }); }
  if (selected.has('effects')) steps.push({ command: 'set_layer_effects', target, args: { effects: structuredClone(layer.effects || null) } });
  if (selected.has('outline') && layer.outline) steps.push({ command: 'set_layer_outline', target, args: { width: layer.outline.width, color: layer.outline.color || '#ffffff' } });
  if (selected.has('clear-effects')) steps.push({ command: 'set_layer_effects', target, args: { effects: null } });
  if (selected.has('clear-outline')) steps.push({ command: 'set_layer_outline', target, args: { width: 0, color: '#ffffff' } });
  return { version: 1, name: name.trim(), slots: [slot], steps };
}
export function slotMatches(slot: EditRecipeSlot, layer: Layer) { return slot.type === 'content' ? contentTypes.includes(layer.type) : layer.type === slot.type && (slot.type !== 'adjustment' || layer.kind === slot.kind); }
const fields: Record<EditRecipeCommand, string[]> = { add_layer_filter: ['kind', 'value', 'parameters', 'enabled', 'opacity', 'blendMode'], update_adjustment: ['value', 'parameters'], update_text: ['fontSize', 'color', 'fontFamily', 'fontWeight', 'fontStyle', 'align', 'tracking', 'leading'], set_layer_effects: ['effects'], set_layer_outline: ['width', 'color'] };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function keys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) throw Error('Recipe contains unsupported fields. Import only a recipe definition without IDs or bindings.'); }
function safeJson(value: unknown, depth = 0, counter = { value: 0 }) { if (++counter.value > 8192 || depth > 12) throw Error('Recipe is too complex.'); if (typeof value === 'number' && !Number.isFinite(value)) throw Error('Recipe values must be finite.'); if (Array.isArray(value)) for (const item of value) safeJson(item, depth + 1, counter); else if (object(value)) for (const [key, item] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('Recipe contains a forbidden key.'); safeJson(item, depth + 1, counter); } }
export function parseRecipeFile(text: string): EditRecipeDefinition {
  const value: unknown = JSON.parse(text); safeJson(value);
  if (!object(value)) throw Error('Choose a Prism recipe definition.'); keys(value, ['format', 'version', 'name', 'slots', 'steps']);
  if (value.format !== 'prism-edit-recipe' || value.version !== 1 || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || !Array.isArray(value.slots) || !value.slots.length || value.slots.length > 16 || !Array.isArray(value.steps) || !value.steps.length || value.steps.length > 30) throw Error('Use a version 1 Prism recipe with 1–16 slots and 1–30 steps.');
  const slots: EditRecipeSlot[] = value.slots.map(item => {
    if (!object(item)) throw Error('Each recipe slot must be an object.'); keys(item, ['key', 'label', 'type', 'kind']);
    if (typeof item.key !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(item.key) || !['raster', 'text', 'content', 'adjustment'].includes(String(item.type)) || item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 80) || item.kind !== undefined && typeof item.kind !== 'string') throw Error('Recipe target slots are invalid.');
    return { key: item.key, type: item.type as EditRecipeSlot['type'], ...(typeof item.label === 'string' ? { label: item.label } : {}), ...(typeof item.kind === 'string' ? { kind: item.kind } : {}) };
  });
  if (new Set(slots.map(slot => slot.key)).size !== slots.length) throw Error('Recipe target slot keys must be unique.');
  const steps: EditRecipeStep[] = value.steps.map(item => {
    if (!object(item)) throw Error('Each recipe step must be an object.'); keys(item, ['command', 'target', 'args']);
    if (!recipeCommands.includes(item.command as EditRecipeCommand) || typeof item.target !== 'string' || !slots.some(slot => slot.key === item.target) || !object(item.args)) throw Error('Recipe has an unsupported command or target.');
    const command = item.command as EditRecipeCommand; keys(item.args, fields[command]); const args = structuredClone(item.args); if (command === 'add_layer_filter' && args.blendMode === 'normal') delete args.blendMode; return { command, target: item.target, args };
  });
  if (recipeHasLookup({ slots, steps })) throw Error('This recipe references a Color Lookup file. Recipes cannot carry lookup assets; use an editable .prism project.');
  return { version: 1, name: value.name.trim(), slots, steps };
}

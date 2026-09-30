import { COLOR_LOOKUP_POLICY, COLOR_LOOKUP_LIMITS, normalizeColorLookupParameters, type ColorLookupParameters } from '../shared/color-lookup.mjs';
import type { Backend, BackendId, EditRecipeDefinition } from './api';

export type LookupScope = 'global' | 'source';
export const colorLookupCapabilityKey = (capabilities?: Backend) => JSON.stringify([capabilities?.id, capabilities?.colorLookupPolicy, capabilities?.colorLookupFormats, capabilities?.colorLookupInputSpaces, capabilities?.colorLookupLimits, capabilities?.adjustmentKinds, capabilities?.layerFilterKinds, capabilities?.layerFilterCoordinates, capabilities?.commands]);
const includes = (value: unknown, item: string) => Array.isArray(value) && value.every(entry => typeof entry === 'string') && value.includes(item);
export function supportsColorLookup(capabilities: Backend | undefined, backend: BackendId, scope: LookupScope): boolean {
  if (!capabilities || backend !== 'native' || capabilities.id !== backend || capabilities.colorLookupPolicy !== COLOR_LOOKUP_POLICY || !includes(capabilities.colorLookupFormats, 'cube-3d') || !includes(capabilities.colorLookupInputSpaces, 'srgb')) return false;
  const limits = capabilities.colorLookupLimits;
  if (!limits || Object.keys(COLOR_LOOKUP_LIMITS).some(key => !Number.isSafeInteger(limits[key as keyof typeof COLOR_LOOKUP_LIMITS]) || limits[key as keyof typeof COLOR_LOOKUP_LIMITS]! <= 0)) return false;
  if (limits.minGridSize! < 2 || limits.maxGridSize! > COLOR_LOOKUP_LIMITS.maxGridSize || limits.minGridSize! > limits.maxGridSize!) return false;
  return scope === 'global' ? includes(capabilities.adjustmentKinds, 'color_lookup') : capabilities.layerFilterCoordinates === 'source' && includes(capabilities.layerFilterKinds, 'color_lookup');
}
export function lookupParameters(value: unknown): ColorLookupParameters | undefined {
  try { return normalizeColorLookupParameters(value); } catch { return; }
}
export function supportsLookupEntry(capabilities: Backend | undefined, backend: BackendId, scope: LookupScope, value: unknown): boolean {
  const parameters = lookupParameters(value), limits = capabilities?.colorLookupLimits;
  return Boolean(parameters && limits && supportsColorLookup(capabilities, backend, scope) && parameters.gridSize >= limits.minGridSize! && parameters.gridSize <= limits.maxGridSize! && parameters.bytes <= limits.maxBytes! && parameters.sourceName.length <= limits.maxSourceNameLength! && (parameters.title === undefined || parameters.title.length <= limits.maxTitleLength!));
}
export function colorLookupFileError(file: Pick<File, 'name' | 'size'>, capabilities?: Backend): string | undefined {
  const maxBytes = Math.min(COLOR_LOOKUP_LIMITS.maxBytes, capabilities?.colorLookupLimits?.maxBytes ?? 0);
  const maxName = Math.min(COLOR_LOOKUP_LIMITS.maxSourceNameLength, capabilities?.colorLookupLimits?.maxSourceNameLength ?? 0);
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > maxBytes) return `Choose a nonempty lookup file up to ${maxBytes.toLocaleString()} bytes.`;
  if (!file.name.trim() || file.name === '.' || file.name === '..' || file.name.length > maxName || /[\u0000-\u001f\u007f/\\]/.test(file.name) || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(file.name)) return `Use a filename up to ${maxName} characters without control characters or path separators.`;
}
export function recipeHasLookup(definition?: Pick<EditRecipeDefinition, 'slots' | 'steps'>): boolean {
  return Boolean(definition?.slots.some(slot => slot.kind === 'color_lookup') || definition?.steps.some(step => step.command === 'add_layer_filter' && step.args.kind === 'color_lookup'));
}

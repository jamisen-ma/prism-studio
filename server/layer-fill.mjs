import { LAYER_FILL_POLICY, LAYER_FILL_CONTENT_TYPES } from '../shared/layer-fill.mjs';
import { normalizeEffects } from './layer-effects.mjs';

export { LAYER_FILL_POLICY, LAYER_FILL_CONTENT_TYPES };
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
const WRAPPER_KEYS = ['version', 'fillOpacity', 'styles'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function strictObject(value, keys, required = keys) {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Layer Fill metadata must be a plain object.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      fail('Layer Fill metadata contains an unsupported property.');
  }
  if (required.some(key => !Object.hasOwn(value, key))) fail('Layer Fill metadata is incomplete.');
  return value;
}

export function normalizeLayerFillOpacity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail('Layer Fill must be between 0 and 1.');
  return value === 0 ? 0 : value;
}

// The `in` check does not evaluate inherited getters. A marker inherited from
// a custom prototype still enters strict validation and is rejected there.
const wrapped = value => object(value) && WRAPPER_KEYS.some(key => key in value);

function normalizeWrapper(value) {
  strictObject(value, WRAPPER_KEYS);
  const fillOpacity = normalizeLayerFillOpacity(value.fillOpacity);
  if (value.version !== 1 || fillOpacity === 1) fail('Layer Fill requires version 1 and a nonunit stored value.');
  if (value.styles === null) return { version: 1, fillOpacity, styles: null };
  strictObject(value.styles, ['shadow', 'glow'], []);
  if (!Object.keys(value.styles).length) fail('A stored Layer Fill wrapper uses null for absent outside styles.');
  for (const kind of ['shadow', 'glow']) if (Object.hasOwn(value.styles, kind)) {
    strictObject(value.styles[kind], kind === 'shadow' ? ['color', 'opacity', 'blur', 'x', 'y'] : ['color', 'opacity', 'blur']);
  }
  const styles = normalizeEffects(value.styles);
  for (const kind of Object.keys(styles)) for (const key of Object.keys(styles[kind]))
    if (!Object.is(styles[kind][key], value.styles[kind][key])) fail('Stored Layer Fill styles must contain complete normalized values.');
  return { version: 1, fillOpacity, styles };
}

/** New wrappers are strict and canonical. Unwrapped legacy settings retain
 * their existing normalizer, including sparse defaults and null/empty forms. */
export function normalizeLayerFillEffects(value) {
  if (value === undefined) return undefined;
  return wrapped(value) ? normalizeWrapper(value) : normalizeEffects(value);
}

function storedEffects(layer) {
  if (!object(layer)) fail('Layer Fill requires layer metadata.');
  if (Object.hasOwn(layer, 'fillOpacity')) fail('Public fillOpacity cannot be used as stored layer metadata.');
  const descriptor = Object.getOwnPropertyDescriptor(layer, 'effects');
  if (!descriptor) {
    if ('effects' in layer) fail('Stored layer effects must be an own data property.');
    return undefined;
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Stored layer effects must be an enumerable data property.');
  const value = descriptor.value;
  if (wrapped(value)) normalizeWrapper(value);
  else if (value !== undefined) normalizeEffects(value);
  return value;
}

/** Read views preserve literal legacy truthiness; callers must not mutate
 * returned styles. Validation and owned updates occur outside pixel loops. */
export function layerFillOpacity(layer) {
  const value = storedEffects(layer);
  return wrapped(value) ? (value.fillOpacity === 0 ? 0 : value.fillOpacity) : 1;
}
export function layerOutsideEffects(layer) {
  const value = storedEffects(layer);
  return wrapped(value) ? value.styles : value;
}

/** Return an owned layer without changing caller metadata. */
export function setLayerFillOpacity(layer, value) {
  const fillOpacity = normalizeLayerFillOpacity(value), effects = storedEffects(layer);
  const previous = wrapped(effects) ? effects.fillOpacity : 1;
  const result = structuredClone(layer);
  if (fillOpacity === previous) {
    if (wrapped(effects)) result.effects.fillOpacity = fillOpacity;
    return result;
  }
  const styles = wrapped(effects) ? effects.styles : effects === undefined ? null : normalizeEffects(effects);
  if (fillOpacity === 1) {
    if (styles) result.effects = structuredClone(styles);
    else delete result.effects;
  } else result.effects = { version: 1, fillOpacity, styles: styles ? structuredClone(styles) : null };
  return result;
}

/** The public style payload remains the legacy payload. Fill is retained. */
export function setLayerOutsideEffects(layer, effects) {
  const current = storedEffects(layer), styles = normalizeEffects(effects), result = structuredClone(layer);
  if (wrapped(current)) result.effects = { version: 1, fillOpacity: current.fillOpacity === 0 ? 0 : current.fillOpacity, styles };
  else if (styles) result.effects = styles;
  else delete result.effects;
  return result;
}

export function projectLayerFill(layer) {
  const effects = storedEffects(layer), result = structuredClone(layer);
  if (wrapped(effects)) {
    result.fillOpacity = effects.fillOpacity === 0 ? 0 : effects.fillOpacity;
    if (effects.styles) result.effects = structuredClone(effects.styles);
    else delete result.effects;
  }
  return result;
}

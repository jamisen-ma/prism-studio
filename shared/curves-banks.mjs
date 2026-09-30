import { compileSmoothCurveLookup } from './smooth-curves.mjs';

export const CURVES_BANKS_POLICY = 'master-byte-then-channel-byte-v1';
export const CURVES_BANK_NAMES = Object.freeze(['master', 'red', 'green', 'blue']);
export const CURVES_BANKS_CACHE_BYTES = 1280;
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
const identity = () => [{ x: 0, y: 0 }, { x: 255, y: 255 }];
function object(input, keys, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`Unsupported ${label} field.`);
  }
  return input;
}
function points(input) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length < 2 || input.length > 16 || Reflect.ownKeys(input).length !== input.length + 1) fail('A curve bank requires 2–16 dense points.');
  const result = Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Curve bank points must be data properties.');
    const point = object(descriptor.value, ['x', 'y'], 'curve bank point');
    if (!['x', 'y'].every(key => typeof point[key] === 'number' && Number.isFinite(point[key]) && point[key] >= 0 && point[key] <= 255)) fail('Curve bank points must be finite in 0–255.');
    return { x: point.x, y: point.y };
  });
  if (result[0].x !== 0 || result.at(-1).x !== 255 || result.some((point, index) => index && point.x <= result[index - 1].x)) fail('Curve bank X coordinates must strictly increase from 0 to 255.');
  return result;
}
function bankPatch(input) {
  const value = object(input, ['points', 'interpolation'], 'curve bank'), result = {};
  if (value.points !== undefined) result.points = points(value.points);
  if (value.interpolation !== undefined) {
    if (!['linear', 'smooth'].includes(value.interpolation)) fail('Curve bank interpolation must be linear or smooth.');
    result.interpolation = value.interpolation;
  }
  return result;
}
function banksPatch(parameters) {
  const value = object(parameters, ['mode', 'banks'], 'banked Curves');
  if (value.mode !== 'banks') fail('Curve banks require explicit mode banks.');
  const supplied = value.banks === undefined ? {} : object(value.banks, CURVES_BANK_NAMES, 'curve banks'), result = {};
  for (const name of CURVES_BANK_NAMES) if (supplied[name] !== undefined) result[name] = bankPatch(supplied[name]);
  return result;
}
export function normalizeCurvesBanksParameters(parameters) {
  const supplied = banksPatch(parameters), banks = {};
  for (const name of CURVES_BANK_NAMES) banks[name] = { points: identity(), interpolation: 'linear', ...supplied[name] };
  return { mode: 'banks', banks };
}
export function mergeCurvesBanksParameters(previous, patch) {
  const current = normalizeCurvesBanksParameters(previous), supplied = banksPatch(patch), banks = {};
  for (const name of CURVES_BANK_NAMES) banks[name] = { ...current.banks[name], ...supplied[name] };
  return { mode: 'banks', banks };
}

/** Fresh selected-bank LUT. Keep the legacy Linear arithmetic and segment
 * choice literal; Smooth retains its existing authored-knot byte policy. */
export function compileCurvesBankLookup(spec = {}) {
  const bank = { points: identity(), interpolation: 'linear', ...bankPatch(spec) };
  if (bank.interpolation === 'smooth') return compileSmoothCurveLookup(bank.points);
  const lookup = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const points = bank.points;
    let segment = 1;
    while (segment < points.length - 1 && points[segment].x < i) segment++;
    const a = points[segment - 1], b = points[segment];
    lookup[i] = Math.max(0, Math.min(255, Math.round(a.y + (b.y - a.y) * (i - a.x) / (b.x - a.x))));
  }
  return lookup;
}

/** Master is quantized before each component. Peak tables are output768 +
 * Master256 + one component256; only output768 escapes. No shared views. */
export function compileCurvesBanksLookup(parameters) {
  const { banks } = normalizeCurvesBanksParameters(parameters), output = new Uint8Array(768), master = compileCurvesBankLookup(banks.master);
  for (let channel = 0; channel < 3; channel++) {
    const component = compileCurvesBankLookup(banks[CURVES_BANK_NAMES[channel + 1]]);
    for (let i = 0; i < 256; i++) output[256 * channel + i] = component[master[i]];
  }
  return output;
}

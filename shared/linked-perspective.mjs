// Local authoring for ordinary Distort corners. No renderer or stored mode.
export const LINKED_PERSPECTIVE_AXES = Object.freeze(['horizontal', 'vertical']);

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_ARGUMENT';
  throw error;
}

function record(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be a plain data object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain data object.`);
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length) invalid(`${label} has unexpected fields.`);
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) invalid(`${label} has unexpected fields.`);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property.enumerable || !Object.hasOwn(property, 'value')) invalid(`${label} requires own enumerable data fields.`);
    result[key] = property.value;
  }
  for (const key of required) if (!Object.hasOwn(result, key)) invalid(`${label} is missing ${key}.`);
  return result;
}

export function perspectivePartner(cornerIndex, axis) {
  if (!Number.isInteger(cornerIndex) || cornerIndex < 0 || cornerIndex > 3) invalid('Corner index must be an integer from 0 to 3.');
  if (axis !== 'horizontal' && axis !== 'vertical') invalid('Perspective axis must be horizontal or vertical.');
  return axis === 'horizontal' ? cornerIndex ^ 1 : 3 - cornerIndex;
}

function copyCorners(baseline, limit) {
  if (!Array.isArray(baseline) || Object.getPrototypeOf(baseline) !== Array.prototype) invalid('Corner baseline must be an ordinary four-point array.');
  const keys = Reflect.ownKeys(baseline);
  const length = Object.getOwnPropertyDescriptor(baseline, 'length');
  if (length.value !== 4 || keys.length !== 5 || keys.some(key => !['0', '1', '2', '3', 'length'].includes(key))) invalid('Corner baseline must contain exactly four points.');
  const corners = [];
  for (let i = 0; i < 4; i++) {
    const property = Object.getOwnPropertyDescriptor(baseline, String(i));
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) invalid('Corner baseline requires four own data points.');
    const point = record(property.value, ['x', 'y'], [], 'Corner');
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > limit || Math.abs(point.y) > limit) invalid('Baseline coordinates must be finite and within the corner limit.');
    corners.push({ x: point.x, y: point.y });
  }
  return corners;
}

export function linkedPerspectiveCorners(baseline, options) {
  const input = record(options, ['cornerIndex', 'axis', 'delta'], ['limit'], 'Perspective options');
  const partnerIndex = perspectivePartner(input.cornerIndex, input.axis);
  const limit = Object.hasOwn(input, 'limit') ? input.limit : 16384;
  if (!Number.isInteger(limit) || limit < 1 || limit > 16384) invalid('Corner limit must be an integer from 1 to 16384.');
  if (!Number.isFinite(input.delta) || Math.abs(input.delta) > 2 * limit) invalid('Delta must be finite and no greater than twice the corner limit.');
  const corners = copyCorners(baseline, limit);
  if (input.delta !== 0) {
    const axis = input.axis === 'horizontal' ? 'x' : 'y';
    // Keep this fixed binary64 order. The selected result must not determine
    // the partner's delta: it can round away a displacement the partner keeps.
    corners[input.cornerIndex][axis] = corners[input.cornerIndex][axis] + input.delta;
    corners[partnerIndex][axis] = corners[partnerIndex][axis] - input.delta;
  }
  return {
    corners,
    partnerIndex,
    withinBounds: corners.every(point => Math.abs(point.x) <= limit && Math.abs(point.y) <= limit)
  };
}

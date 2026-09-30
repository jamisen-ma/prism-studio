// Independently authored coordinate fixtures and dyadic binary64 oracle.
// No production, prototype, DOM or third-party implementation imports.
const view = new DataView(new ArrayBuffer(8));
function units(value) {
  if (!Number.isFinite(value)) throw Error('Finite coordinate required');
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false), exponent = Number((bits >> 52n) & 2047n), fraction = bits & ((1n << 52n) - 1n);
  const absolute = exponent === 0 ? fraction : ((1n << 52n) | fraction) << BigInt(exponent - 1);
  return bits >> 63n ? -absolute : absolute;
}
function fromUnits(value) {
  const negative = value < 0n, absolute = negative ? -value : value;
  if (!absolute) return 0;
  const length = absolute.toString(2).length;
  let result;
  if (length <= 53) result = Number(absolute) * Number.MIN_VALUE;
  else {
    const shift = BigInt(length - 53), half = 1n << (shift - 1n);
    let significand = absolute >> shift;
    const remainder = absolute - (significand << shift);
    if (remainder > half || remainder === half && (significand & 1n)) significand++;
    result = Number(significand) * 2 ** (Number(shift) - 1074);
  }
  return negative ? -result : result;
}
/** Exact dyadic sum followed by independent nearest/even binary64 rounding. */
export function addBinary64Reference(left, right) {
  const exact = units(left) + units(right);
  if (exact === 0n) return Object.is(left, -0) && Object.is(right, -0) ? -0 : 0;
  return fromUnits(exact);
}
export function linkedPerspectiveReference(baseline, { cornerIndex, axis, delta, limit = 16384 }) {
  const partners = axis === 'horizontal' ? [1, 0, 3, 2] : [3, 2, 1, 0];
  const partnerIndex = partners[cornerIndex], coordinate = axis === 'horizontal' ? 'x' : 'y';
  const corners = baseline.map(point => ({ x: point.x, y: point.y }));
  if (delta !== 0) {
    corners[cornerIndex][coordinate] = addBinary64Reference(baseline[cornerIndex][coordinate], delta);
    corners[partnerIndex][coordinate] = addBinary64Reference(baseline[partnerIndex][coordinate], -delta);
  }
  return { corners, partnerIndex, withinBounds: corners.every(point => Math.abs(point.x) <= limit && Math.abs(point.y) <= limit) };
}
export const LINKED_PERSPECTIVE_RECTANGLE = Object.freeze([
  Object.freeze({ x: 0, y: 0 }), Object.freeze({ x: 100, y: 0 }),
  Object.freeze({ x: 100, y: 80 }), Object.freeze({ x: 0, y: 80 }),
]);
const points = values => values.map(([x, y]) => ({ x, y }));
export const LINKED_PERSPECTIVE_GOLDENS = Object.freeze([
  { axis: 'horizontal', cornerIndex: 0, delta: 10, partnerIndex: 1, corners: points([[10, 0], [90, 0], [100, 80], [0, 80]]) },
  { axis: 'horizontal', cornerIndex: 1, delta: 10, partnerIndex: 0, corners: points([[-10, 0], [110, 0], [100, 80], [0, 80]]) },
  { axis: 'horizontal', cornerIndex: 2, delta: 10, partnerIndex: 3, corners: points([[0, 0], [100, 0], [110, 80], [-10, 80]]) },
  { axis: 'horizontal', cornerIndex: 3, delta: 10, partnerIndex: 2, corners: points([[0, 0], [100, 0], [90, 80], [10, 80]]) },
  { axis: 'vertical', cornerIndex: 0, delta: 8, partnerIndex: 3, corners: points([[0, 8], [100, 0], [100, 80], [0, 72]]) },
  { axis: 'vertical', cornerIndex: 1, delta: 8, partnerIndex: 2, corners: points([[0, 0], [100, 8], [100, 72], [0, 80]]) },
  { axis: 'vertical', cornerIndex: 2, delta: 8, partnerIndex: 1, corners: points([[0, 0], [100, -8], [100, 88], [0, 80]]) },
  { axis: 'vertical', cornerIndex: 3, delta: 8, partnerIndex: 0, corners: points([[0, -8], [100, 0], [100, 80], [0, 88]]) },
]);

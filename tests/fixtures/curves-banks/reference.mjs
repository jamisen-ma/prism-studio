// Independent bank-composition fixtures. No production imports. Linear pins
// the existing declared Number order. Smooth uses closed-form test curves;
// this deliberately does not duplicate the general runtime PCHIP compiler.
export const CURVES_BANK_NAMES = Object.freeze(['master', 'red', 'green', 'blue']);
export const CURVES_IDENTITY_POINTS = Object.freeze([Object.freeze({ x: 0, y: 0 }), Object.freeze({ x: 255, y: 255 })]);
const byte = value => Math.max(0, Math.min(255, Math.round(value)));
const peakByte = x => Number((8n * BigInt(x) * BigInt(255 - x) + 255n) / 510n);
export function curveBankReference(value, supplied = {}) {
  const points = supplied.points ?? CURVES_IDENTITY_POINTS;
  if (supplied.interpolation === 'smooth') {
    if (points.every(point => point.x === point.y)) return value;
    const knot = points.find(point => point.x === value); if (knot) return byte(knot.y);
    if (points.length === 2) return byte(points[0].y + (points[1].y - points[0].y) * (value - points[0].x) / (points[1].x - points[0].x));
    if (points.length === 3 && points[0].x === 0 && points[1].x === 127.5 && points[2].x === 255) {
      if (points[0].y === 0 && points[1].y === 255 && points[2].y === 0) return peakByte(value);
      if (points[0].y === 255 && points[1].y === 0 && points[2].y === 255) return 255 - peakByte(value);
    }
    throw new Error('Reference supports identity, two-point and closed-form symmetric Smooth fixtures only.');
  }
  let right = 1;
  while (right < points.length - 1 && points[right].x < value) right++;
  const a = points[right - 1], b = points[right];
  return byte(a.y + (b.y - a.y) * (value - a.x) / (b.x - a.x));
}
export function curvesBanksReference(rgb, parameters = { mode: 'banks' }) {
  if (parameters.mode !== 'banks') throw new Error('Explicit bank fixture required.');
  const banks = parameters.banks ?? {};
  return rgb.map((value, channel) => curveBankReference(curveBankReference(value, banks.master), banks[CURVES_BANK_NAMES[channel + 1]]));
}
export const CURVES_BANKS_POLYNOMIAL = {
  mode: 'banks', banks: {
    master: { points: [{ x: 0, y: 0 }, { x: 127.5, y: 255 }, { x: 255, y: 0 }], interpolation: 'smooth' },
    red: { points: [{ x: 0, y: 0 }, { x: 255, y: 127.5 }], interpolation: 'linear' },
    green: { points: [{ x: 0, y: 255 }, { x: 255, y: 0 }], interpolation: 'linear' },
    blue: { points: [{ x: 0, y: 0 }, { x: 255, y: 255 }], interpolation: 'smooth' },
  },
};
export const CURVES_BANKS_PHOTO = {
  mode: 'banks', banks: {
    master: { points: [{ x: 0, y: 0 }, { x: 48, y: 42 }, { x: 128, y: 132 }, { x: 208, y: 217 }, { x: 255, y: 255 }], interpolation: 'linear' },
    red: { points: [{ x: 0, y: 0 }, { x: 64, y: 62 }, { x: 192, y: 198 }, { x: 255, y: 255 }], interpolation: 'linear' },
    green: { points: [{ x: 0, y: 0 }, { x: 128, y: 129 }, { x: 255, y: 255 }], interpolation: 'linear' },
    blue: { points: [{ x: 0, y: 4 }, { x: 64, y: 68 }, { x: 192, y: 187 }, { x: 255, y: 250 }], interpolation: 'linear' },
  },
};
export const CURVES_BANKS_GOLDENS = [
  { label: 'Master and component round separately', rgb: [1, 1, 1], parameters: { mode: 'banks', banks: Object.fromEntries(CURVES_BANK_NAMES.map(name => [name, { points: [{ x: 0, y: 0 }, { x: 255, y: 127.5 }], interpolation: 'linear' }])) }, expected: [1, 1, 1] },
  { label: 'Master precedes component', rgb: [1, 150, 66], parameters: { mode: 'banks', banks: {
    master: { points: [{ x: 0, y: 0 }, { x: 96, y: 144 }, { x: 255, y: 255 }] },
    red: { points: [{ x: 0, y: 0 }, { x: 160, y: 112 }, { x: 255, y: 255 }] },
  } }, expected: [1, 182, 99] },
];

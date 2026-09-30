export const TEXT_SPACING_PROPERTIES = Object.freeze(['tracking', 'leading']);
export const TEXT_TRACKING_UNITS = 'thousandths-em';
export const TEXT_LEADING_UNITS = 'source-pixels';
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };

/** Normalize new edits without mutating the source. Graph validation uses the
 * default mode: null/undefined stored values are invalid, but explicit tracking
 * zero remains a compatible persisted value. The returned edit omits resets;
 * its caller must DELETE old keys, not merely Object.assign this object. */
export function normalizeTextSpacing(input, { command = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Text spacing settings must be an object.');
  const output = {};
  if (Object.hasOwn(input, 'tracking')) {
    const value = input.tracking;
    if (!(command && value === undefined)) {
      if (!Number.isInteger(value) || value < -1000 || value > 1000) fail('Text tracking must be an integer from -1000 to 1000 thousandths of an em.');
      if (value !== 0) output.tracking = value;
    }
  }
  if (Object.hasOwn(input, 'leading')) {
    const value = input.leading;
    if (!(command && (value === undefined || value === null))) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 2000) fail('Text leading must be a finite number from 1 to 2000 source pixels; use null to restore Auto.');
      output.leading = value;
    }
  }
  return output;
}

export function textLineBaseline(layer, index) {
  // Preserve legacy operation order, including fractional font sizes. Replacing
  // index*fontSize*1.2 with index*(fontSize*1.2) can change SVG coordinates.
  return layer.leading === undefined
    ? layer.y + layer.fontSize + index * layer.fontSize * 1.2
    : layer.y + layer.fontSize + index * layer.leading;
}

export function textTrackingAttribute(layer) {
  // Even a numerically zero SVG attribute is omitted so old source markup is
  // byte-identical. Leave Unicode strings and glyph shaping to the renderer.
  return layer.tracking === undefined || layer.tracking === 0 ? '' : ` letter-spacing="${layer.fontSize * layer.tracking / 1000}"`;
}

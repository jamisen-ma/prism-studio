// Test-only clipping assembly experiment. This module is not imported by the
// editor, advertises no capability, and does not implement Photoshop parity.
export const CLIPPING_PROTOTYPE_LIMITS = Object.freeze({ maxDimension: 256, maxPixels: 65_536, maxMembers: 8 });
const BLENDS = new Set(['normal', 'multiply', 'screen']);
const fail = message => { throw new TypeError(message); };
const byte = value => Math.max(0, Math.min(255, Math.round(value)));
function unit(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(`${label} must be a finite fraction.`);
  return value;
}
function layer(input, count, label) {
  if (!input || !Buffer.isBuffer(input.pixels) || input.pixels.length !== count * 4) fail(`${label} needs exact RGBA8 bytes.`);
  const opacity = unit(input.opacity ?? 1, `${label} opacity`), blendMode = input.blendMode ?? 'normal';
  if (!BLENDS.has(blendMode)) fail('The prototype supports only normal, multiply and screen.');
  if (input.visible !== undefined && typeof input.visible !== 'boolean') fail('Visibility must be boolean.');
  if (input.mask !== undefined) {
    if (!(Array.isArray(input.mask) || input.mask instanceof Float64Array) || input.mask.length !== count) fail('Mask coverage must match the image.');
    for (const amount of input.mask) unit(amount, 'Mask coverage');
  }
  return { ...input, opacity, blendMode, visible: input.visible !== false };
}
function blend(back, front, mode) {
  if (mode === 'multiply') return back * front / 255;
  if (mode === 'screen') return 255 - (255 - back) * (255 - front) / 255;
  return front;
}

/** Assemble colors over the base's interior, preserving its original alpha.
 * Base mask/opacity are applied once only in the final composite. Upper
 * contributions are suppressed at inherited protected coverage. No styles,
 * filters, geometry, persistent metadata or external side effects exist here. */
export function prototypeClippingChain({ width, height, base: inputBase, members: inputMembers = [], backdrop, protectedPixels } = {}) {
  const limits = CLIPPING_PROTOTYPE_LIMITS;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) fail('Prototype dimensions exceed the small-fixture limit.');
  const count = width * height;
  if (!Buffer.isBuffer(backdrop) || backdrop.length !== count * 4) fail('Backdrop needs exact RGBA8 bytes.');
  if (!Array.isArray(inputMembers) || inputMembers.length > limits.maxMembers) fail('Too many prototype clipping members.');
  if (protectedPixels !== undefined && (!(protectedPixels instanceof Uint8Array) || protectedPixels.length !== count || protectedPixels.some(value => value !== 0 && value !== 1))) fail('Protection must be a binary pixel plane.');
  const base = layer(inputBase, count, 'Base'), members = inputMembers.map((value, index) => layer(value, count, `Member ${index}`));
  const interior = Buffer.from(base.pixels), pixels = Buffer.from(backdrop);
  if (!base.visible || base.opacity === 0) return { interior, pixels };
  for (const member of members) {
    if (!member.visible || member.opacity === 0) continue;
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      if (!base.pixels[i + 3] || (base.mask?.[p] ?? 1) === 0 || protectedPixels?.[p]) continue;
      const amount = member.pixels[i + 3] / 255 * member.opacity * (member.mask?.[p] ?? 1);
      if (!amount) continue;
      for (let channel = 0; channel < 3; channel++) {
        const current = interior[i + channel], color = blend(current, member.pixels[i + channel], member.blendMode);
        interior[i + channel] = byte(current + (color - current) * amount);
      }
    }
  }
  for (let p = 0; p < count; p++) {
    const i = p * 4, foregroundAlpha = interior[i + 3] / 255 * base.opacity * (base.mask?.[p] ?? 1);
    if (!foregroundAlpha) continue; // Preserve backdrop's invisible RGB too.
    const backgroundAlpha = backdrop[i + 3] / 255, alpha = foregroundAlpha + backgroundAlpha * (1 - foregroundAlpha);
    for (let channel = 0; channel < 3; channel++) {
      const back = backdrop[i + channel], front = interior[i + channel], mixed = blend(back, front, base.blendMode);
      pixels[i + channel] = byte((back * backgroundAlpha * (1 - foregroundAlpha) + front * foregroundAlpha * (1 - backgroundAlpha) + mixed * foregroundAlpha * backgroundAlpha) / alpha);
    }
    pixels[i + 3] = byte(alpha * 255);
  }
  return { interior, pixels };
}

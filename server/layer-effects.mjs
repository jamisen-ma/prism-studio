import sharp from 'sharp';

const MAX_PIXELS = 24_000_000;
const MAX_PADDED_PIXELS = 32_000_000;
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const byte = (value) => Math.max(0, Math.min(255, Math.round(value)));
function finite(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be between ${min} and ${max}.`);
  return value;
}
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail(`Invalid ${label} settings.`);
}

export function normalizeEffects(effects) {
  if (effects === null) return null;
  object(effects, ['shadow', 'glow'], 'layer effects');
  const result = {};
  for (const kind of ['shadow', 'glow']) if (Object.hasOwn(effects, kind)) {
    const input = effects[kind], shadow = kind === 'shadow';
    object(input, shadow ? ['color', 'opacity', 'blur', 'x', 'y'] : ['color', 'opacity', 'blur'], kind);
    const color = input.color === undefined ? (shadow ? '#000000' : '#ffffff') : input.color;
    if (typeof color !== 'string' || !/^#[a-f0-9]{6}$/i.test(color)) fail('Effect color must be #RRGGBB.');
    result[kind] = { color: color.toLowerCase(), opacity: finite(input.opacity === undefined ? (shadow ? 0.35 : 0.5) : input.opacity, 'Effect opacity', 0, 1), blur: finite(input.blur === undefined ? 8 : input.blur, 'Effect blur', 0, 64) };
    if (shadow) {
      result[kind].x = finite(input.x === undefined ? 4 : input.x, 'Shadow x offset', -256, 256);
      result[kind].y = finite(input.y === undefined ? 6 : input.y, 'Shadow y offset', -256, 256);
    }
  }
  return Object.keys(result).length ? result : null;
}

async function blurredAlpha(alpha, width, height, sigma) {
  // Below the supported 0.3 Gaussian sigma, the rounded 8-bit neighborhood is
  // effectively unchanged. Zero is an exact, unblurred translated shadow.
  if (sigma < 0.3) return { pixels: alpha, width, height, padding: 0 };
  const padding = Math.ceil(sigma * Math.sqrt(-2 * Math.log(0.01))) + 1;
  const paddedWidth = width + padding * 2, paddedHeight = height + padding * 2;
  if (paddedWidth * paddedHeight > MAX_PADDED_PIXELS) fail('Effect working image exceeds its bounded pixel budget.', 'LIMIT_EXCEEDED');
  const padded = Buffer.alloc(paddedWidth * paddedHeight);
  for (let y = 0; y < height; y++) alpha.copy(padded, (y + padding) * paddedWidth + padding, y * width, (y + 1) * width);
  // Explicit zero padding prevents libvips's edge extension from inventing
  // coverage outside the canvas. Keep the padding until shadow translation.
  let pixels;
  try {
    pixels = await sharp(padded, { raw: { width: paddedWidth, height: paddedHeight, channels: 1 }, limitInputPixels: MAX_PADDED_PIXELS })
      .greyscale().blur({ sigma, precision: 'float', minAmplitude: 0.01 }).raw().toBuffer();
  } catch { fail('The outside layer effect could not be rendered.', 'RENDER_ERROR'); }
  return { pixels, width: paddedWidth, height: paddedHeight, padding };
}

function sample(mask, x, y) {
  const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top;
  let value = 0;
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const sx = left + dx, sy = top + dy;
    if (sx >= 0 && sy >= 0 && sx < mask.width && sy < mask.height) value += mask.pixels[sy * mask.width + sx] * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
  }
  return value;
}

// Returns combined shadow then glow RGBA, or null when nothing can render.
// Source RGB/alpha are immutable; layer opacity is deliberately left to the
// caller so overlapping effects receive that opacity exactly once as a group.
export async function renderOutsideEffects(pixels, width, height, effects, coverage = () => 1) {
  if (!Buffer.isBuffer(pixels) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_PIXELS || pixels.length !== width * height * 4) fail('Invalid layer effect image dimensions.', 'LIMIT_EXCEEDED');
  if (typeof coverage !== 'function') fail('Effect mask coverage must be a function.');
  const settings = normalizeEffects(effects);
  if (!settings || !Object.values(settings).some((effect) => effect.opacity > 0)) return null;
  const alpha = Buffer.alloc(width * height), occupied = new Uint8Array(width * height);
  let any = false;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    let amount;
    try { amount = coverage(x, y); } catch { fail('Effect mask coverage failed.'); }
    finite(amount, 'Effect mask coverage', 0, 1);
    occupied[index] = pixels[index * 4 + 3] > 0 && amount > 0 ? 1 : 0;
    alpha[index] = byte(pixels[index * 4 + 3] * amount);
    if (alpha[index]) any = true;
  }
  if (!any) return null;
  const output = Buffer.alloc(pixels.length);
  let lastSigma, mask;
  for (const kind of ['shadow', 'glow']) {
    const effect = settings[kind];
    if (!effect || effect.opacity === 0) continue;
    if (lastSigma !== effect.blur) { mask = await blurredAlpha(alpha, width, height, effect.blur); lastSigma = effect.blur; }
    const rgb = [1, 3, 5].map((offset) => parseInt(effect.color.slice(offset, offset + 2), 16));
    const offsetX = effect.x ?? 0, offsetY = effect.y ?? 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * width + x, i = index * 4;
      if (occupied[index]) continue; // Preserve opaque AND translucent subject pixels exactly.
      const foreground = sample(mask, x - offsetX + mask.padding, y - offsetY + mask.padding) / 255 * effect.opacity;
      if (foreground <= 0) continue;
      const backdrop = output[i + 3] / 255, combined = foreground + backdrop * (1 - foreground);
      for (let channel = 0; channel < 3; channel++) output[i + channel] = byte((rgb[channel] * foreground + output[i + channel] * backdrop * (1 - foreground)) / combined);
      output[i + 3] = byte(255 * combined);
    }
  }
  return output;
}

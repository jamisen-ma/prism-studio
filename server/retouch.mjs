// Canvas-sized RGBA8 retouch operations. No asset I/O and no input mutation.
// Healing transfers a frozen source patch with a local mean-color correction;
// it is a sampled healing brush, not content-aware or generative reconstruction.

const TOOLS = new Set(['brush', 'pencil', 'eraser', 'clone', 'heal', 'dodge', 'burn', 'blur', 'sharpen', 'smudge', 'sponge', 'red_eye', 'color_replace']);
const MAX_AXIS = 8192;
const MAX_PIXELS = 24_000_000;
const MAX_POINTS = 2000;
const MAX_DABS = 100_000;
const MAX_PIXEL_VISITS = 60_000_000;
const MIN_COORDINATE = -8192;
const MAX_COORDINATE = 16384;
const clampByte = value => Math.max(0, Math.min(255, Math.round(value)));

function reject(message, code = 'INVALID_ARGUMENT') {
  throw Object.assign(new Error(message), { code });
}
function finite(value, name, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    reject(`${name} must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}.`);
  }
  return value;
}
function rgba(buffer, name, byteLength) {
  if (!(buffer instanceof Uint8Array) || buffer.length !== byteLength) reject(`${name} must be an RGBA8 Buffer or Uint8Array of exactly ${byteLength} bytes.`);
}
function coordinate(point, name) {
  if (!point || typeof point !== 'object' || Array.isArray(point)) reject(`${name} must contain x and y coordinates.`);
  finite(point.x, `${name}.x`, MIN_COORDINATE, MAX_COORDINATE);
  finite(point.y, `${name}.y`, MIN_COORDINATE, MAX_COORDINATE);
}

function validate(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) reject('Stroke arguments must be an object.');
  const { pixels, width, height, tool, points, size, hardness, opacity, color, source, composite, coverage, strength, tolerance } = args;
  finite(width, 'width', 1, MAX_AXIS, true);
  finite(height, 'height', 1, MAX_AXIS, true);
  if (width * height > MAX_PIXELS) reject('Retouch supports at most 24 megapixels.', 'LIMIT_EXCEEDED');
  rgba(pixels, 'pixels', width * height * 4);
  if (!TOOLS.has(tool)) reject(`tool must be one of: ${[...TOOLS].join(', ')}.`);
  if (!Array.isArray(points) || points.length < 1 || points.length > MAX_POINTS) reject('A stroke needs 1–2000 points.');
  const normalizedPoints = Array.from(points, (point, index) => {
    coordinate(point, `points[${index}]`);
    return { x: point.x, y: point.y, pressure: point.pressure === undefined ? 1 : finite(point.pressure, `points[${index}].pressure`, 0, 1) };
  });
  finite(size, 'size', 1, 512);
  finite(hardness, 'hardness', 0, 1);
  finite(opacity, 'opacity', 0, 1);
  if (args.flow !== undefined) finite(args.flow, 'flow', 0.01, 1);
  if (color !== undefined && (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color))) reject('color must be #RRGGBB.');
  if (tool === 'color_replace' && color === undefined) reject('color_replace requires a replacement color.');
  if (strength !== undefined) finite(strength, 'strength', tool === 'sponge' ? -100 : 0, 100);
  if (tolerance !== undefined) finite(tolerance, 'tolerance', 0, 255);
  if (coverage !== undefined && typeof coverage !== 'function') reject('coverage must be a function returning a number from 0 to 1.');
  if (source !== undefined) coordinate(source, 'source');
  if (composite !== undefined) rgba(composite, 'composite', width * height * 4);
  if (tool === 'clone' || tool === 'heal') {
    if (!source) reject(`${tool} requires a source point.`);
    if (!composite) reject(`${tool} requires the frozen visible composite.`);
  }
  return normalizedPoints;
}

// Build a bounded plan before allocating the output/mask or modifying any pixels.
// Adaptive spacing follows the pressure-dependent radius, including at pen-down.
function planStroke(points, size, width, height, opacity, tool, even = false) {
  const dabs = [];
  let visits = 0;
  let steps = 0;
  const region = { left: width, top: height, right: -1, bottom: -1 };
  const add = point => {
    if (++steps > MAX_DABS) reject('Stroke needs too many interpolated brush tips. Split it into shorter strokes.', 'LIMIT_EXCEEDED');
    if (point.pressure === 0 || opacity === 0) return;
    if (tool === 'pencil') point = { ...point, x: Math.floor(point.x) + 0.5, y: Math.floor(point.y) + 0.5 };
    const radius = size * 0.5 * Math.sqrt(point.pressure);
    const outer = radius + 0.5;
    const left = Math.max(0, Math.ceil(point.x - outer - 0.5));
    const top = Math.max(0, Math.ceil(point.y - outer - 0.5));
    const right = Math.min(width - 1, Math.floor(point.x + outer - 0.5));
    const bottom = Math.min(height - 1, Math.floor(point.y + outer - 0.5));
    if (left > right || top > bottom) return;
    const sampleCost = tool === 'blur' || tool === 'sharpen' ? 9 : tool === 'clone' || tool === 'heal' ? 4 : 1;
    visits += (right - left + 1) * (bottom - top + 1) * sampleCost;
    if (visits > MAX_PIXEL_VISITS) reject('Stroke exceeds the 60-million-sample work limit. Reduce its size or split it into shorter strokes.', 'LIMIT_EXCEEDED');
    region.left = Math.min(region.left, left); region.top = Math.min(region.top, top);
    region.right = Math.max(region.right, right); region.bottom = Math.max(region.bottom, bottom);
    dabs.push({ ...point, radius, left, top, right, bottom });
  };
  add(points[0]);
  let carry = 0;
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1], end = points[index];
    if ((start.pressure === 0 && end.pressure === 0) || opacity === 0) continue;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (!distance) { if (!even) add(end); continue; }
    // even (flow < 1): keep dab spacing continuous across input points so buildup has no beads at event boundaries.
    let travelled = even ? -carry : 0;
    while (travelled < distance) {
      const pressure = start.pressure + (end.pressure - start.pressure) * Math.max(0, travelled) / distance;
      const radius = size * 0.5 * Math.sqrt(pressure);
      const spacing = Math.max(0.35, Math.min(24, radius * 0.3));
      if (even && travelled + spacing > distance) break;
      travelled = Math.min(distance, Math.max(0, travelled + spacing));
      const fraction = travelled / distance;
      add({ x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction, pressure: start.pressure + (end.pressure - start.pressure) * fraction });
    }
    carry = distance - travelled;
  }
  return { dabs, region };
}

// Bilinear sampling in pixel-index coordinates. Out-of-image neighbors are
// transparent. Interpolation is premultiplied to avoid dark/colored alpha fringes.
function sample(buffer, width, height, x, y) {
  const left = Math.floor(x), top = Math.floor(y);
  if (left < -1 || top < -1 || left >= width || top >= height) return [0, 0, 0, 0];
  const fractionX = x - left, fractionY = y - top;
  let red = 0, green = 0, blue = 0, alpha = 0;
  for (let dy = 0; dy <= 1; dy++) {
    const sy = top + dy;
    if (sy < 0 || sy >= height) continue;
    for (let dx = 0; dx <= 1; dx++) {
      const sx = left + dx;
      if (sx < 0 || sx >= width) continue;
      const weight = (dx ? fractionX : 1 - fractionX) * (dy ? fractionY : 1 - fractionY);
      if (!weight) continue;
      const offset = (sy * width + sx) * 4;
      const weightedAlpha = buffer[offset + 3] / 255 * weight;
      alpha += weightedAlpha;
      red += buffer[offset] * weightedAlpha;
      green += buffer[offset + 1] * weightedAlpha;
      blue += buffer[offset + 2] * weightedAlpha;
    }
  }
  return alpha > 0 ? [red / alpha, green / alpha, blue / alpha, alpha] : [0, 0, 0, 0];
}

// A small ring limits the influence of a central blemish. Its color offset is
// frozen for the whole stroke, just like clone sampling, and never reads output.
function healingCorrection(composite, width, height, target, source, size) {
  const radius = Math.max(2, Math.min(32, size * 0.75));
  const mean = center => {
    let red = 0, green = 0, blue = 0, alpha = 0;
    const step = Math.max(1, radius / 8);
    for (let y = -radius; y <= radius; y += step) {
      for (let x = -radius; x <= radius; x += step) {
        const distance = Math.hypot(x, y);
        if (distance < radius * 0.5 || distance > radius) continue;
        const pixel = sample(composite, width, height, center.x + x - 0.5, center.y + y - 0.5);
        alpha += pixel[3];
        red += pixel[0] * pixel[3]; green += pixel[1] * pixel[3]; blue += pixel[2] * pixel[3];
      }
    }
    return alpha > 0 ? [red / alpha, green / alpha, blue / alpha] : null;
  };
  const destinationMean = mean(target), sourceMean = mean(source);
  return destinationMean && sourceMean ? destinationMean.map((value, channel) => value - sourceMean[channel]) : [0, 0, 0];
}

function sourceOver(output, original, index, red, green, blue, alpha) {
  if (alpha <= 0) return;
  const destinationAlpha = original[index + 3] / 255;
  const retained = destinationAlpha * (1 - alpha);
  const resultAlpha = alpha + retained;
  output[index] = clampByte((red * alpha + original[index] * retained) / resultAlpha);
  output[index + 1] = clampByte((green * alpha + original[index + 1] * retained) / resultAlpha);
  output[index + 2] = clampByte((blue * alpha + original[index + 2] * retained) / resultAlpha);
  output[index + 3] = clampByte(resultAlpha * 255);
}

// One stop of exposure, mixed by brush opacity/coverage. Lookup tables keep the
// inner pixel loop small and preserve target alpha, including translucent edges.
function exposureTable(multiplier) {
  return Array.from({ length: 256 }, (_, value) => {
    const encoded = value / 255;
    const linear = encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
    const adjusted = Math.min(1, linear * multiplier);
    return 255 * (adjusted <= 0.0031308 ? adjusted * 12.92 : 1.055 * adjusted ** (1 / 2.4) - 0.055);
  });
}
const DODGE = exposureTable(2);
const BURN = exposureTable(0.5);

function gaussianPixel(buffer, width, height, x, y) {
  let red = 0, green = 0, blue = 0, alpha = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const sx = Math.max(0, Math.min(width - 1, x + dx));
    const sy = Math.max(0, Math.min(height - 1, y + dy));
    const index = (sy * width + sx) * 4;
    const weight = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1) / 16;
    const weightedAlpha = buffer[index + 3] / 255 * weight;
    alpha += weightedAlpha;
    red += buffer[index] * weightedAlpha; green += buffer[index + 1] * weightedAlpha; blue += buffer[index + 2] * weightedAlpha;
  }
  return alpha > 0 ? [red / alpha, green / alpha, blue / alpha, alpha] : [0, 0, 0, 0];
}

// Blur brush: like Photoshop's Blur tool, successive dabs keep softening, so the
// effective radius grows with brush size and strength. Repeated alpha-weighted
// [1 2 1] passes over the stroke region (premultiplied, float) are computed once.
// One pass equals gaussianPixel exactly. Returns (x, y) => [r, g, b, alpha0..1].
const MAX_BLUR_WORK = 60_000_000;
function blurredRegion(pixels, width, height, region, passes) {
  const margin = passes;
  const left = Math.max(0, region.left - margin), top = Math.max(0, region.top - margin);
  const right = Math.min(width - 1, region.right + margin), bottom = Math.min(height - 1, region.bottom + margin);
  const w = right - left + 1, h = bottom - top + 1;
  passes = Math.max(1, Math.min(passes, Math.floor(MAX_BLUR_WORK / (w * h * 6))));
  let current = new Float32Array(w * h * 4), next = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const source = ((top + y) * width + left + x) * 4, target = (y * w + x) * 4, alpha = pixels[source + 3] / 255;
    current[target] = pixels[source] * alpha; current[target + 1] = pixels[source + 1] * alpha; current[target + 2] = pixels[source + 2] * alpha; current[target + 3] = alpha;
  }
  const temp = new Float32Array(w * h * 4);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const l = (y * w + Math.max(0, x - 1)) * 4, c = (y * w + x) * 4, r = (y * w + Math.min(w - 1, x + 1)) * 4;
      for (let k = 0; k < 4; k++) temp[c + k] = (current[l + k] + 2 * current[c + k] + current[r + k]) / 4;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = (Math.max(0, y - 1) * w + x) * 4, c = (y * w + x) * 4, d = (Math.min(h - 1, y + 1) * w + x) * 4;
      for (let k = 0; k < 4; k++) next[c + k] = (temp[u + k] + 2 * temp[c + k] + temp[d + k]) / 4;
    }
    [current, next] = [next, current];
  }
  return (x, y) => {
    const index = ((y - top) * w + x - left) * 4, alpha = current[index + 3];
    return alpha > 0 ? [current[index] / alpha, current[index + 1] / alpha, current[index + 2] / alpha, alpha] : [0, 0, 0, 0];
  };
}

function mixPremultiplied(a, b, amount) {
  const retained = a[3] * (1 - amount), added = b[3] * amount;
  const alpha = retained + added;
  return alpha > 0 ? [(a[0] * retained + b[0] * added) / alpha, (a[1] * retained + b[1] * added) / alpha, (a[2] * retained + b[2] * added) / alpha, alpha] : [0, 0, 0, 0];
}

const luminance = rgb => rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11;
function replaceColor(rgb, targetLuminance) {
  const difference = targetLuminance - luminance(rgb);
  let result = rgb.map(value => value + difference);
  const minimum = Math.min(...result);
  if (minimum < 0) result = result.map(value => targetLuminance + (value - targetLuminance) * targetLuminance / (targetLuminance - minimum));
  const maximum = Math.max(...result);
  if (maximum > 255) result = result.map(value => targetLuminance + (value - targetLuminance) * (255 - targetLuminance) / (maximum - targetLuminance));
  return result;
}

function mixColor(output, original, index, rgb, amount) {
  for (let channel = 0; channel < 3; channel++) output[index + channel] = clampByte(original[index + channel] + (rgb[channel] - original[index + channel]) * amount);
}

/**
 * Apply one undoable brush stroke to canvas-sized RGBA8 pixels.
 * coverage receives pixel-center document coordinates (x + 0.5, y + 0.5).
 * Pressure scales both radius (sqrt) and opacity (linear). Overlapping dabs take
 * maximum coverage within this stroke: input event density does not build flow.
 * With flow < 1 each (evenly spaced) dab moves coverage that fraction toward the cap.
 * Separate strokes can build opacity normally. Always returns a fresh Buffer.
 */
export function applyStroke(args) {
  const points = validate(args);
  const { pixels, width, height, tool, size, hardness, opacity, source, composite, coverage } = args;
  const { dabs, region } = planStroke(points, size, width, height, opacity, tool, args.flow !== undefined && args.flow < 1);
  const output = Buffer.from(pixels);
  if (!dabs.length) return output;
  const maskWidth = region.right - region.left + 1;
  const maskHeight = region.bottom - region.top + 1;
  const applied = new Uint16Array(maskWidth * maskHeight);
  const paint = args.color || '#000000';
  const rgb = [1, 3, 5].map(offset => parseInt(paint.slice(offset, offset + 2), 16));
  const sourceOffset = source ? { x: source.x - points[0].x, y: source.y - points[0].y } : null;
  const correction = tool === 'heal' ? healingCorrection(composite, width, height, points[0], source, size) : null;
  const strength = (args.strength === undefined ? 50 : args.strength) / 100;
  const flow = args.flow === undefined ? 1 : args.flow;
  const tolerance = args.tolerance === undefined ? 48 : args.tolerance;
  // Like Photoshop's hotspot, sample the single pixel under the first point (no bilinear mix across edges).
  const reference = tool === 'color_replace' ? sample(pixels, width, height, Math.max(0, Math.min(width - 1, Math.floor(points[0].x))), Math.max(0, Math.min(height - 1, Math.floor(points[0].y)))) : null;
  const blurAt = tool === 'blur' && strength > 0 ? blurredRegion(pixels, width, height, region, Math.max(1, Math.min(24, Math.round(size * strength / 8)))) : null;
  if (reference && reference[3] === 0) reject('Start color replacement on a visible pixel in the target layer.');
  let carried = tool === 'smudge' ? sample(pixels, width, height, points[0].x - 0.5, points[0].y - 0.5) : null;
  let previousDab = points[0];

  for (const dab of dabs) {
    if (carried) {
      const distance = Math.hypot(dab.x - previousDab.x, dab.y - previousDab.y);
      const pickup = 1 - Math.exp(-distance / (Math.max(1, dab.radius) * (1 + strength * 8)));
      const beneath = sample(pixels, width, height, dab.x - 0.5, dab.y - 0.5);
      carried = mixPremultiplied(carried, beneath, pickup);
      previousDab = dab;
    }
    const inner = Math.max(0, dab.radius - 0.5) * hardness;
    const outer = dab.radius + 0.5;
    for (let y = dab.top; y <= dab.bottom; y++) {
      for (let x = dab.left; x <= dab.right; x++) {
        const distance = Math.hypot(x + 0.5 - dab.x, y + 0.5 - dab.y);
        if (distance >= outer || (tool === 'pencil' && distance > dab.radius)) continue;
        let tip = 1;
        if (tool !== 'pencil' && distance > inner) {
          const t = (outer - distance) / (outer - inner);
          tip = t * t * (3 - 2 * t);
        }
        let selected = 1;
        if (coverage) {
          try { selected = coverage(x + 0.5, y + 0.5); }
          catch (error) { reject(`Selection coverage failed: ${error?.message || error}`); }
          finite(selected, 'coverage result', 0, 1);
        }
        const target = Math.round(tip * dab.pressure * opacity * selected * 65535);
        const maskIndex = (y - region.top) * maskWidth + x - region.left;
        if (target <= applied[maskIndex]) continue;
        // Flow below 100% builds coverage dab by dab toward the opacity cap, like Photoshop's Flow.
        const quantized = flow < 1 ? applied[maskIndex] + Math.max(1, Math.round((target - applied[maskIndex]) * flow)) : target;
        applied[maskIndex] = quantized;
        const gain = quantized / 65535;
        const index = (y * width + x) * 4;
        if (tool === 'brush' || tool === 'pencil') {
          sourceOver(output, pixels, index, rgb[0], rgb[1], rgb[2], gain);
        } else if (tool === 'eraser') {
          output[index + 3] = clampByte(pixels[index + 3] * (1 - gain));
        } else if (tool === 'clone' || tool === 'heal') {
          const sampled = sample(composite, width, height, x + sourceOffset.x, y + sourceOffset.y);
          if (correction) for (let channel = 0; channel < 3; channel++) sampled[channel] = Math.max(0, Math.min(255, sampled[channel] + correction[channel]));
          sourceOver(output, pixels, index, sampled[0], sampled[1], sampled[2], sampled[3] * gain);
        } else if (tool === 'smudge') {
          sourceOver(output, pixels, index, carried[0], carried[1], carried[2], carried[3] * gain * strength);
        } else if (tool === 'blur') {
          if (!blurAt) continue;
          const blurred = blurAt(x, y);
          const original = [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3] / 255];
          const mixed = mixPremultiplied(original, blurred, gain * Math.sqrt(strength));
          if (mixed[3] > 0) {
            output[index] = clampByte(mixed[0]); output[index + 1] = clampByte(mixed[1]); output[index + 2] = clampByte(mixed[2]);
            output[index + 3] = clampByte(mixed[3] * 255);
          }
        } else if (tool === 'sharpen' && pixels[index + 3] > 0) {
          const blurred = gaussianPixel(pixels, width, height, x, y);
          for (let channel = 0; channel < 3; channel++) output[index + channel] = clampByte(pixels[index + channel] + (pixels[index + channel] - blurred[channel]) * strength * 2 * gain);
        } else if (tool === 'sponge' && pixels[index + 3] > 0) {
          const original = [pixels[index], pixels[index + 1], pixels[index + 2]];
          const gray = luminance(original);
          mixColor(output, pixels, index, original.map(value => Math.max(0, Math.min(255, gray + (value - gray) * (1 + strength)))), gain);
        } else if (tool === 'red_eye' && pixels[index + 3] > 0) {
          const [red, green, blue] = [pixels[index], pixels[index + 1], pixels[index + 2]];
          if (red > Math.max(green, blue) * 1.35 && red - Math.max(green, blue) > 25) output[index] = clampByte(red + ((green + blue) / 2 - red) * gain * strength);
        } else if (tool === 'color_replace' && pixels[index + 3] > 0) {
          const original = [pixels[index], pixels[index + 1], pixels[index + 2]];
          const difference = Math.hypot(original[0] - reference[0], original[1] - reference[1], original[2] - reference[2]) / Math.sqrt(3);
          if (difference <= tolerance + 1e-9) mixColor(output, pixels, index, replaceColor(rgb, luminance(original)), gain * strength);
        } else if ((tool === 'dodge' || tool === 'burn') && pixels[index + 3] > 0) {
          const table = tool === 'dodge' ? DODGE : BURN;
          for (let channel = 0; channel < 3; channel++) {
            const original = pixels[index + channel];
            output[index + channel] = clampByte(original + (table[original] - original) * gain);
          }
        }
      }
    }
  }
  return output;
}

import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import sharp from 'sharp';
import { COLOR_RANGE_POLICY, COLOR_RANGE_LIMITS, COLOR_RANGE_PREVIEW_LIMITS, normalizeColorRangeSettings } from '../shared/color-range.mjs';
import { combineMaskAlpha } from './dense-mask.mjs';
import { maskPreviewDimensions } from './mask-preview.mjs';
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };

// Native command preflight checks the complete envelope. These helpers also
// own their settings before awaiting a renderer when called independently.
function ownField(value, key) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Color Range arguments require a plain object.');
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (!field) return undefined;
  if (!field.enumerable || !Object.hasOwn(field, 'value')) fail('Color Range arguments require own data fields.');
  return field.value;
}
function settingsFromArgs(args) {
  const settings = {};
  for (const key of ['colors', 'tolerance', 'falloff', 'invert']) {
    const value = ownField(args, key);
    if (Object.hasOwn(args, key)) settings[key] = value;
  }
  return normalizeColorRangeSettings(settings);
}
function dimensions(graph) {
  const { width, height } = graph;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 24_000_000) fail('Color Range requires a bounded native canvas.');
  return { width, height, pixels: width * height };
}
function checkPixels(pixels, count) {
  if (!(pixels instanceof Uint8Array) || pixels.length !== 4 * count) fail('The Color Range renderer returned invalid RGBA bytes.');
}
export function colorRangeComparisonWork(pixelCount, colorCount) {
  if (!Number.isSafeInteger(pixelCount) || pixelCount < 1 || !Number.isInteger(colorCount) || colorCount < 1 || colorCount > COLOR_RANGE_LIMITS.maxColors) fail('Invalid Color Range comparison dimensions.');
  const comparisons = pixelCount * colorCount;
  if (!Number.isSafeInteger(comparisons) || comparisons > COLOR_RANGE_LIMITS.maxComparisons) fail('Color Range exceeds 192 million sample comparisons.', 'LIMIT_EXCEEDED');
  return comparisons;
}

/** Private typed tables; callback input is four trusted RGB8/A8 bytes. */
export function compileColorRange(input) {
  const { colors, tolerance, falloff, invert } = normalizeColorRangeSettings(input);
  const samples = new Uint8Array(colors.length * 3), lookup = new Uint8Array(256);
  for (let j = 0; j < colors.length; j++) for (let c = 0; c < 3; c++) samples[3 * j + c] = parseInt(colors[j].slice(1 + 2 * c, 3 + 2 * c), 16);
  for (let distance = 0; distance < 256; distance++) lookup[distance] = distance <= tolerance ? 255
    : falloff === 0 || distance >= tolerance + falloff ? 0
      : Math.floor((2 * 255 * (tolerance + falloff - distance) + falloff) / (2 * falloff));
  return (red, green, blue, alpha) => {
    let distance = 255;
    for (let j = 0; j < samples.length; j += 3) {
      const current = Math.max(Math.abs(red - samples[j]), Math.abs(green - samples[j + 1]), Math.abs(blue - samples[j + 2]));
      if (current < distance) distance = current;
    }
    const coverage = Math.floor((2 * lookup[distance] * alpha + 255) / 510);
    return invert ? 255 - coverage : coverage;
  };
}
async function extractRange(graph, settings, render) {
  const { width, height, pixels: count } = dimensions(graph), pixels = await render(graph);
  checkPixels(pixels, count);
  const coverage = compileColorRange(settings), output = Buffer.allocUnsafe(count);
  const batch = Math.floor(COLOR_RANGE_LIMITS.comparisonBatch / settings.colors.length);
  for (let i = 0; i < count; i++) {
    output[i] = coverage(pixels[4 * i], pixels[4 * i + 1], pixels[4 * i + 2], pixels[4 * i + 3]);
    if ((i + 1) % batch === 0) await yieldEventLoop();
  }
  return output;
}
export async function materializeColorRangeSelection(graph, args, render, resolveAlpha8) {
  const settings = settingsFromArgs(args), mode = ownField(args, 'mode') ?? 'replace', { width, height, pixels } = dimensions(graph);
  if (!['replace', 'add', 'subtract', 'intersect'].includes(mode)) fail('Invalid Color Range selection mode.');
  if (!graph.selection && ['subtract', 'intersect'].includes(mode)) fail('Create a selection before combining.', 'NO_SELECTION');
  colorRangeComparisonWork(pixels, settings.colors.length);
  // Only candidate bytes escape extraction; the rendered RGB and matcher are
  // no longer owned here when active coverage/output and publication begin.
  const candidate = await extractRange(graph, settings, render);
  return combineMaskAlpha(graph.selection, candidate, width, height, mode, resolveAlpha8);
}
async function sampleRange(graph, settings, maxEdge, render) {
  const { width: sourceWidth, height: sourceHeight, pixels: count } = dimensions(graph);
  const { width, height } = maskPreviewDimensions(sourceWidth, sourceHeight, maxEdge), pixels = await render(graph);
  checkPixels(pixels, count);
  const coverage = compileColorRange(settings), gray = Buffer.allocUnsafe(width * height), batch = Math.floor(COLOR_RANGE_LIMITS.comparisonBatch / settings.colors.length);
  for (let i = 0; i < gray.length; i++) {
    const x = i % width, y = Math.floor(i / width), sx = Math.min(sourceWidth - 1, Math.floor((2 * x + 1) * sourceWidth / (2 * width))), sy = Math.min(sourceHeight - 1, Math.floor((2 * y + 1) * sourceHeight / (2 * height))), offset = 4 * (sy * sourceWidth + sx);
    gray[i] = coverage(pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]);
    if ((i + 1) % batch === 0) await yieldEventLoop();
  }
  return { gray, width, height, sourceWidth, sourceHeight };
}
export async function renderColorRangePreview(graph, args, render) {
  const settings = settingsFromArgs(args), maxEdge = ownField(args, 'maxEdge') ?? COLOR_RANGE_PREVIEW_LIMITS.defaultMaxEdge;
  if (!Number.isInteger(maxEdge) || maxEdge < COLOR_RANGE_PREVIEW_LIMITS.minEdge || maxEdge > COLOR_RANGE_PREVIEW_LIMITS.maxEdge) fail('Invalid Color Range preview edge.');
  const frame = dimensions(graph), preview = maskPreviewDimensions(frame.width, frame.height, maxEdge);
  colorRangeComparisonWork(preview.width * preview.height, settings.colors.length);
  const { gray, ...result } = await sampleRange(graph, settings, maxEdge, render);
  const data = await sharp(gray, { raw: { width: result.width, height: result.height, channels: 1 } }).toColourspace('b-w').png({ compressionLevel: 6, adaptiveFiltering: false, palette: false }).toBuffer();
  if (data.length > COLOR_RANGE_PREVIEW_LIMITS.maxBytes) fail('Color Range preview exceeds 8 MiB.', 'LIMIT_EXCEEDED');
  return { ...result, ...settings, maxEdge, coveragePolicy: COLOR_RANGE_POLICY, sampling: 'nearest-pixel-center', mimeType: 'image/png', data };
}

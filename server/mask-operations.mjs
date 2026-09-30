import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import sharp from 'sharp';
import { CHANNEL_SELECTION_POLICY, CHANNEL_SELECTION_CHANNELS, CHANNEL_PREVIEW_LIMITS } from '../shared/dense-mask.mjs';
import { prepareMaskCoverage, prepareRawLayerMaskCoverage, materializeMaskAlpha, combineMaskAlpha } from './dense-mask.mjs';
import { maskPreviewDimensions } from './mask-preview.mjs';
import { morphMask } from './mask-morphology.mjs';
import { applyStroke } from './retouch.mjs';
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const byte = value => Math.max(0, Math.min(255, Math.round(value * 255)));
export function normalizeChannelOptions(args, { preview = false } = {}) {
  const channel = args.channel ?? 'luma', invert = args.invert ?? false, mode = args.mode ?? 'replace';
  if (!CHANNEL_SELECTION_CHANNELS.includes(channel) || typeof invert !== 'boolean') fail('Choose a native composite channel and Boolean inversion.');
  if (!preview && !['replace', 'add', 'subtract', 'intersect'].includes(mode)) fail('Invalid channel selection mode.');
  return { channel, invert, mode };
}
export function channelCoverageByte(pixels, offset, channel, invert = false) {
  const component = channel === 'alpha' ? pixels[offset + 3] : channel === 'luma'
    ? Math.floor((2 * (2126 * pixels[offset] + 7152 * pixels[offset + 1] + 722 * pixels[offset + 2]) + 10000) / 20000)
    : pixels[offset + ({ red: 0, green: 1, blue: 2 })[channel]];
  const result = channel === 'alpha' ? component : Math.floor((2 * component * pixels[offset + 3] + 255) / 510);
  return invert ? 255 - result : result;
}
async function extractChannel(graph, options, render) {
  const pixels = await render(graph), output = Buffer.allocUnsafe(graph.width * graph.height);
  for (let i = 0; i < output.length; i++) { output[i] = channelCoverageByte(pixels, 4 * i, options.channel, options.invert); if ((i + 1) % 65536 === 0) await yieldEventLoop(); }
  return output;
}
/** Only final output escapes; RGB, candidate and active coverage cannot be
 * retained by the later native frame/store/dedup publication scope. */
export async function materializeChannelSelection(graph, args, render, resolver) {
  const options = normalizeChannelOptions(args);
  if (!graph.selection && ['subtract', 'intersect'].includes(options.mode)) fail('Create a selection before combining.', 'NO_SELECTION');
  const alpha = await extractChannel(graph, options, render);
  return combineMaskAlpha(graph.selection, alpha, graph.width, graph.height, options.mode, resolver);
}
async function sampleChannelPreview(graph, args, render) {
  const { channel, invert } = normalizeChannelOptions(args, { preview: true }), maxEdge = args.maxEdge ?? CHANNEL_PREVIEW_LIMITS.defaultMaxEdge;
  const { width, height } = maskPreviewDimensions(graph.width, graph.height, maxEdge), pixels = await render(graph), gray = Buffer.allocUnsafe(width * height);
  for (let i = 0; i < gray.length; i++) {
    const x = i % width, y = Math.floor(i / width), sx = Math.min(graph.width - 1, Math.floor((2 * x + 1) * graph.width / (2 * width))), sy = Math.min(graph.height - 1, Math.floor((2 * y + 1) * graph.height / (2 * height)));
    gray[i] = channelCoverageByte(pixels, 4 * (sy * graph.width + sx), channel, invert);
    if ((i + 1) % 65536 === 0) await yieldEventLoop();
  }
  return { gray, width, height, channel, invert, maxEdge };
}
export async function renderChannelPreview(graph, args, render) {
  const { gray, ...result } = await sampleChannelPreview(graph, args, render);
  const data = await sharp(gray, { raw: { width: result.width, height: result.height, channels: 1 } }).toColourspace('b-w').png({ compressionLevel: 6, adaptiveFiltering: false, palette: false }).toBuffer();
  if (data.length > CHANNEL_PREVIEW_LIMITS.maxBytes) fail('Channel preview exceeds 8 MiB.', 'LIMIT_EXCEEDED');
  return { ...result, data, mimeType: 'image/png', sourceWidth: graph.width, sourceHeight: graph.height, coveragePolicy: CHANNEL_SELECTION_POLICY, sampling: 'nearest-pixel-center' };
}
export async function materializeSavedCombination(active, saved, width, height, mode, resolver) {
  if (!active && ['subtract', 'intersect'].includes(mode)) fail('Create an active selection before combining.', 'NO_SELECTION');
  const a = await prepareMaskCoverage(active, resolver), b = await prepareMaskCoverage(saved, resolver), output = Buffer.allocUnsafe(width * height);
  for (let i = 0; i < output.length; i++) {
    const x = i % width, y = Math.floor(i / width), left = a(x, y), right = b(x, y);
    output[i] = byte(mode === 'add' ? Math.max(left, right) : mode === 'subtract' ? left * (1 - right) : left * right);
    if ((i + 1) % 65536 === 0) await yieldEventLoop();
  }
  return output;
}
export async function materializeMorphology(graph, layer, args, resolver) {
  const alpha = await materializeMaskAlpha(layer?.mask ?? graph.selection, graph.width, graph.height, resolver, { layer, raw: true });
  return morphMask({ alpha, width: graph.width, height: graph.height, operation: args.operation, radius: args.radius });
}
export async function materializePaintMask(graph, layer, args, resolver) {
  const { width, height } = graph, mode = args.mode ?? 'add';
  if (!['add', 'subtract', 'replace'].includes(mode)) fail('Invalid mask painting mode.');
  const mask = layer?.mask ?? graph.selection;
  const coverage = mode === 'replace' ? null : layer ? await prepareRawLayerMaskCoverage(layer, resolver) : await prepareMaskCoverage(mask, resolver);
  const pixels = Buffer.alloc(width * height * 4);
  if (mode !== 'replace' && (mask || layer && mode === 'subtract')) for (let i = 0; i < width * height; i++) {
    pixels[4 * i] = pixels[4 * i + 1] = pixels[4 * i + 2] = 255;
    pixels[4 * i + 3] = byte(coverage(i % width, Math.floor(i / width)));
    if ((i + 1) % 65536 === 0) await yieldEventLoop();
  }
  const painted = applyStroke({ pixels, width, height, tool: mode === 'subtract' ? 'eraser' : 'brush', points: args.points, size: args.size, hardness: args.hardness ?? 1, opacity: args.opacity ?? 1, color: '#ffffff' });
  const output = Buffer.allocUnsafe(width * height);
  for (let i = 0; i < output.length; i++) { output[i] = painted[4 * i + 3]; if ((i + 1) % 65536 === 0) await yieldEventLoop(); }
  return output;
}
export async function materializeTransformedByteMask(mask, oldWidth, oldHeight, transform, resolver) {
  const canvas = transform.type === 'canvas', crop = transform.type === 'crop', bake = canvas || crop && mask.feather > 0;
  const coverage = await prepareMaskCoverage({ ...mask, feather: bake ? mask.feather : 0, invert: canvas ? mask.invert : false }, resolver);
  const alpha = Buffer.alloc(transform.width * transform.height);
  for (let i = 0; i < alpha.length; i++) {
    const x = i % transform.width, y = Math.floor(i / transform.width);
    const sx = canvas ? x - transform.x : crop ? x + transform.x : Math.min(oldWidth - 1, Math.floor((x + .5) * oldWidth / transform.width));
    const sy = canvas ? y - transform.y : crop ? y + transform.y : Math.min(oldHeight - 1, Math.floor((y + .5) * oldHeight / transform.height));
    if (sx >= 0 && sy >= 0 && sx < oldWidth && sy < oldHeight) alpha[i] = byte(coverage(sx, sy));
    if ((i + 1) % 65536 === 0) await yieldEventLoop();
  }
  return { alpha, invert: canvas ? false : mask.invert ?? false,
    feather: bake ? 0 : (mask.feather ?? 0) * (transform.type === 'resize' ? Math.min(transform.width / oldWidth, transform.height / oldHeight) : 1) };
}

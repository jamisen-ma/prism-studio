import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { maskCoverage, bitmapMask } from './masks.mjs';
import { morphMask, MORPHOLOGY_LIMITS } from './mask-morphology.mjs';
import { rawLayerMaskCoverage, layerMaskStorageBytes, positionedLayerMask, LAYER_MASK_POSITION_LIMITS } from './layer-mask.mjs';

export const MORPHOLOGY_COMMANDS = Object.freeze(['morph_selection', 'morph_layer_mask']);
export const MORPHOLOGY_OPERATIONS = Object.freeze(['expand', 'contract', 'border', 'smooth']);
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };

export async function mutateMorphology(graph, command, args) {
  if (!MORPHOLOGY_COMMANDS.includes(command)) fail('Unknown mask operation.');
  if (!MORPHOLOGY_OPERATIONS.includes(args.operation)) fail('Choose expand, contract, border or smooth.');
  if (!Number.isInteger(args.radius) || args.radius < 1 || args.radius > MORPHOLOGY_LIMITS.maxRadius) fail('Mask radius must be an integer from 1 to 100.');
  let layer;
  if (command === 'morph_layer_mask') {
    layer = graph.layers.find(item => item.id === args.layerId);
    if (!layer) fail('Layer was not found.', 'NOT_FOUND');
    if (!layer.mask) fail('Create a layer mask before reshaping it.', 'NO_MASK');
  } else if (!graph.selection) fail('Create a selection before reshaping it.', 'NO_SELECTION');
  const mask = layer ? layer.mask : graph.selection, { width, height } = graph;
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= MORPHOLOGY_LIMITS.maxDimension) || width * height > MORPHOLOGY_LIMITS.maxPixels) fail('Mask dimensions exceed the native image limits.', 'LIMIT_EXCEEDED');
  // Work on raw-mask effective alpha, before the separate layer.maskDensity.
  // Feathering, inversion and canvas clipping become bitmap coverage once;
  // density remains on the layer and is never baked or applied twice here.
  if (layer && positionedLayerMask(mask) && layerMaskStorageBytes(layer, { raw: true }) + width * height * 4 + 4 * Math.max(width, height) > LAYER_MASK_POSITION_LIMITS.maxWorkingBytes)
    fail('Reshaping this retained mask exceeds the 256 MiB working-buffer limit. Rasterize or reduce its source first.', 'LIMIT_EXCEEDED');
  const coverage = layer ? rawLayerMaskCoverage(layer) : maskCoverage(mask), alpha = Buffer.allocUnsafe(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) alpha[y * width + x] = Math.round(coverage(x, y) * 255);
    if ((y + 1) % 32 === 0) await yieldEventLoop();
  }
  const output = await morphMask({ alpha, width, height, operation: args.operation, radius: args.radius });
  const replacement = bitmapMask(output, width, height);
  // Publish to this transaction's private graph only after all calculations
  // and RLE complexity checks pass. Source assets and named masks are untouched.
  if (layer) layer.mask = replacement;
  else graph.selection = replacement;
  const action = { expand: 'Expand', contract: 'Contract', border: 'Border', smooth: 'Smooth' }[args.operation];
  return `${action} ${layer ? 'layer mask' : 'selection'}`;
}

export const RETOUCH_SAMPLE_MODES = ['current', 'current-and-below', 'all'];
export const RETOUCH_SAMPLING_TOOLS = ['clone', 'heal'];

const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };

// Resolve defaults without making sampling fields legal for other tools.
export function normalizeRetouchSampling(args) {
  if (!RETOUCH_SAMPLING_TOOLS.includes(args.tool)) {
    if (args.sampleMode !== undefined || args.ignoreAdjustments !== undefined)
      fail('Sampling options apply to clone and heal only.');
    return null;
  }
  const sampleMode = args.sampleMode === undefined ? 'all' : args.sampleMode;
  const ignoreAdjustments = args.ignoreAdjustments === undefined ? false : args.ignoreAdjustments;
  if (!RETOUCH_SAMPLE_MODES.includes(sampleMode)) fail('sampleMode must be current, current-and-below or all.');
  if (typeof ignoreAdjustments !== 'boolean') fail('ignoreAdjustments must be boolean.');
  if (sampleMode === 'current' && ignoreAdjustments) fail('Current-layer sampling has no adjustment layers to ignore. Turn off ignoreAdjustments or choose a composite sample mode.');
  return { sampleMode, ignoreAdjustments };
}

// A root prefix never splits a group subtree or a clipping run. A hidden root
// still establishes the prefix; rendering visibility is a later decision.
export function retouchRoot(tree, clipping, layerId) {
  const node = tree.nodes.get(layerId);
  if (!node) fail('Layer was not found.', 'NOT_FOUND');
  if (node.layer.type !== 'raster') fail('Choose a raster layer for repair placement or Current & Below sampling.', 'INVALID_TARGET');
  if (node.parent || clipping.participants.has(layerId))
    fail('Current & Below sampling and repair placement require a root raster outside clipping chains. Move the layer to the document root and release its clipping chain, or choose another sample mode.', 'INVALID_TARGET');
  return node;
}

export function frozenRetouchSample(pixels, sampling, renderComposite, layerId) {
  if (!sampling) return undefined;
  if (sampling.sampleMode === 'current') return pixels;
  // The default keeps the original call path, including its default options.
  if (sampling.sampleMode === 'all' && !sampling.ignoreAdjustments) return renderComposite();
  return renderComposite({ ignoreAdjustments: sampling.ignoreAdjustments,
    ...(sampling.sampleMode === 'current-and-below' ? { stopAfterRootId: layerId } : {}) });
}

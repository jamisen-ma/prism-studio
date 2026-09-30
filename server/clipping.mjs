import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { blendRGB, dissolveAlpha, BLEND_MODES } from './blend.mjs';
import { layerFillOpacity, layerOutsideEffects } from './layer-fill.mjs';

export const CLIPPING_LAYER_TYPES = Object.freeze(['raster', 'solid', 'text', 'shape', 'path', 'gradient']);
export const CLIPPING_BLEND_POLICY = 'grouped-base';
export const CLIPPING_RETAINED_BYTES_PER_PIXEL = 5;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };
const check = (condition, message, code) => { if (!condition) fail(message, code); };
const content = layer => CLIPPING_LAYER_TYPES.includes(layer.type);
const generated = layer => layer.role === 'generated' || Boolean(layer.provenance?.jobId);
const enabledStyles = layer => {
  const effects = layerOutsideEffects(layer);
  return (layer.outline?.width ?? 0) > 0 || Boolean(effects?.shadow && (effects.shadow.opacity ?? 0.35) > 0) ||
    Boolean(effects?.glow && (effects.glow.opacity ?? 0.5) > 0);
};

/** Validate links using canonical direct siblings, including hidden nodes. */
export function clippingIndex(tree) {
  const chains = new Map(), members = new Map(), participants = new Set();
  for (const node of tree.nodes.values()) {
    const layer = node.layer;
    if (layer.clipBaseId === undefined) continue;
    check(typeof layer.clipBaseId === 'string' && UUID.test(layer.clipBaseId), 'A clipping base must be a layer UUID.');
    const base = tree.nodes.get(layer.clipBaseId);
    check(content(layer) && base && content(base.layer) && base.layer.clipBaseId === undefined && base !== node,
      'Clipping requires an unlinked content base and individual content members.', 'INVALID_TARGET');
    check(node.parent === base.parent, 'A clipping base and its members must be direct siblings.', 'INVALID_TARGET');
    check(!generated(base.layer), 'Generated content cannot be a clipping base. Choose an ordinary shape, text or image base.', 'INVALID_TARGET');
    check(!base.layer.protected && !layer.protected, 'Release the clipping chain before protecting its base or members, including hidden layers.', 'PROTECTED_LAYER');
    check(layerFillOpacity(base.layer) === 1 && layerFillOpacity(layer) === 1, 'Clipping bases and members require Fill 100%. Reset Fill explicitly before creating this chain.', 'INVALID_TARGET');
    check(!enabledStyles(layer), 'Clear enabled outside styles on upper clipping members. Outside styles are supported on the base only.', 'INVALID_TARGET');
    const chain = chains.get(base.layer.id) ?? { base, members: [] };
    const siblings = base.parent ? base.parent.children : tree.roots;
    check(siblings[siblings.indexOf(base) + chain.members.length + 1] === node,
      'Clipping members must be an uninterrupted bottom-to-top run immediately above their base.', 'INVALID_TARGET');
    chain.members.push(node); chains.set(base.layer.id, chain); members.set(layer.id, chain);
    participants.add(base.layer.id); participants.add(layer.id);
  }
  return { chains, members, participants };
}

export function assertNoClipping(index, layerId, operation) {
  check(!index.participants.has(layerId), `Release this layer’s clipping chain before ${operation}. Its base and members remain independently editable.`, 'INVALID_TARGET');
}

export function changedClippingLayers(graph, tree, args) {
  clippingIndex(tree);
  const base = tree.nodes.get(args.baseLayerId);
  check(base, 'Clipping base layer was not found.', 'NOT_FOUND');
  check(content(base.layer) && base.layer.clipBaseId === undefined, 'Choose an unlinked individual content base.', 'INVALID_TARGET');
  check(Array.isArray(args.layerIds) && args.layerIds.length <= 63 && args.layerIds.every(id => typeof id === 'string' && UUID.test(id)) && new Set(args.layerIds).size === args.layerIds.length,
    'Choose at most 63 unique clipping member IDs in bottom-to-top order.');
  const siblings = base.parent ? base.parent.children : tree.roots, offset = siblings.indexOf(base);
  for (let i = 0; i < args.layerIds.length; i++) {
    const member = tree.nodes.get(args.layerIds[i]);
    check(member, 'A clipping member was not found.', 'NOT_FOUND');
    check(siblings[offset + i + 1] === member, 'Choose consecutive direct siblings immediately above the base, in bottom-to-top order.', 'INVALID_TARGET');
    check(member.layer.clipBaseId === undefined || member.layer.clipBaseId === base.layer.id, 'Release the member’s existing clipping chain before linking it to another base.', 'INVALID_TARGET');
  }
  const chosen = new Set(args.layerIds);
  return graph.layers.map(layer => {
    if (chosen.has(layer.id)) return { ...layer, clipBaseId: base.layer.id };
    if (layer.clipBaseId === base.layer.id) { const copy = { ...layer }; delete copy.clipBaseId; return copy; }
    return layer;
  });
}

function validatePixels(base, member, width) {
  check(Buffer.isBuffer(base) && Buffer.isBuffer(member) && base.length === member.length && base.length > 0 && base.length % 4 === 0 &&
    Number.isInteger(width) && width >= 1 && width <= 8192 && base.length % (width * 4) === 0 && base.length / width / 4 <= 8192 && base.length / 4 <= 24_000_000,
  'Clipping pixels must have matching bounded RGBA8 dimensions.');
}
export const clippingOpacity = (alpha, opacity, coverage, mode, index) => {
  const value = alpha / 255 * opacity * coverage;
  return mode === 'dissolve' ? dissolveAlpha(value, index) : value;
};

/** Own base/interior is mutated in place, RGB only. No alpha plane or duplicate
 * base surface is retained. The caller owns source buffers and validates masks. */
export async function blendClippingInterior(interior, member, { width, opacity = 1, blendMode = 'normal', baseCoverage = () => 1, coverage = () => 1, protectedPixels } = {}) {
  validatePixels(interior, member, width);
  check(BLEND_MODES.includes(blendMode) && Number.isFinite(opacity) && opacity >= 0 && opacity <= 1, 'Invalid clipping opacity or blend mode.');
  check(!protectedPixels || protectedPixels.length === interior.length / 4, 'Clipping protection must match the image dimensions.');
  const backdrop = [0, 0, 0], foreground = [0, 0, 0];
  for (let y = 0; y < interior.length / width / 4; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x, i = pixel * 4;
      if (!interior[i + 3] || protectedPixels?.[pixel] || baseCoverage(x, y) <= 0) continue;
      const amount = clippingOpacity(member[i + 3], opacity, coverage(x, y), blendMode, pixel);
      if (!amount) continue;
      for (let c = 0; c < 3; c++) { backdrop[c] = interior[i + c] / 255; foreground[c] = member[i + c] / 255; }
      const mixed = blendRGB(backdrop, foreground, blendMode);
      // Interpolate in byte units; normalizing the existing byte and scaling
      // back after interpolation can turn an exact x.5 tie into x.499999999.
      for (let c = 0; c < 3; c++) {
        const back = interior[i + c], front = member[i + c];
        const blended = blendMode === 'normal' || blendMode === 'dissolve' ? front
          : blendMode === 'multiply' ? back * front / 255
          : blendMode === 'screen' ? 255 - (255 - back) * (255 - front) / 255 : mixed[c] * 255;
        interior[i + c] = Math.max(0, Math.min(255, Math.round(back + (blended - back) * amount)));
      }
    }
    if (y % 32 === 31) await yieldEventLoop();
  }
  return interior;
}

/** A member inspection has no base or sibling RGB and no blend backdrop. Each
 * dissolve decision happens independently, before the coverages are combined. */
export async function clipMemberContribution(member, base, { width, memberLayer, baseLayer, coverage, baseCoverage, protectedPixels } = {}) {
  validatePixels(base, member, width);
  for (let y = 0; y < member.length / width / 4; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x, i = p * 4;
      const a = clippingOpacity(member[i + 3], memberLayer.opacity, coverage(x, y), memberLayer.blendMode, p);
      const b = clippingOpacity(base[i + 3], baseLayer.opacity, baseCoverage(x, y), baseLayer.blendMode, p);
      member[i + 3] = protectedPixels?.[p] ? 0 : Math.round(255 * a * b);
    }
    if (y % 32 === 31) await yieldEventLoop();
  }
  return member;
}

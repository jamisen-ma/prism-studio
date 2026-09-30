import sharp from 'sharp';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { layerMaskCoverage, layerMaskStorageBytes, positionedLayerMask } from './layer-mask.mjs';
import { preflightPsdExport, writePsdExport, PSD_EXPORT_LIMITS } from './psd-export.mjs';
import { validateLayerFilterResources } from './layer-filters.mjs';
import { layerTree } from './groups.mjs';
import { hasDistort, estimateDistortResources, estimateDistortLeafBytes } from './distort-resources.mjs';
import { hasDenseMasks, estimateDenseMaskResources, estimateDenseLeafBytes, maskBufferBytes, additionalMaskWork, assertDenseMaskBudget } from './dense-mask-resources.mjs';

let profilePromise;
function srgbProfile() {
  // Use the same built-in sRGB profile as native PNG/JPEG/TIFF exports.
  // No imported profile, external path or caller-supplied ICC is accepted.
  if (!profilePromise) profilePromise = (async () => {
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } }).withIccProfile('srgb').png().toBuffer();
    const { icc } = await sharp(png).metadata();
    if (!Buffer.isBuffer(icc)) throw new Error('Built-in sRGB profile is unavailable.');
    return icc;
  })().catch(error => { profilePromise = undefined; throw error; });
  return profilePromise;
}

function attachNames(report, graph) {
  const names = new Map(graph.layers.map(layer => [layer.id, layer.name]));
  for (const list of [report.issues, report.warnings]) for (const item of list) if (item.layerId && names.has(item.layerId)) item.layerName = names.get(item.layerId);
  return report;
}

async function exactMask(native, layer, width, height, retain) {
  if (!layer.mask) return {};
  const coverage = await native.prepareLayerMaskCoverage(layer), bytes = retain ? Buffer.allocUnsafe(width * height) : undefined;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = coverage(x, y) * 255, rounded = Math.round(value);
      if (!Number.isFinite(value) || rounded < 0 || rounded > 255 || Math.abs(value - rounded) > 1e-9) return { issue: {
        code: 'MASK_NOT_REPRESENTABLE', layerId: layer.id, layerName: layer.name,
        message: 'This mask has fractional coverage that cannot be stored exactly as an 8-bit PSD mask. Keep the editable Prism project or use a flattened image export.',
      } };
      if (bytes) bytes[y * width + x] = rounded;
    }
    if ((y + 1) % Math.min(32, Math.max(1, Math.floor(65536 / width))) === 0) await yieldEventLoop();
  }
  return bytes ? { mask: bytes } : {};
}

export function estimateDistortPsdPreparation(graph, { retain = false } = {}) {
  if (!hasDistort(graph)) return 0;
  const count = graph.width * graph.height, maskPlanes = retain ? graph.layers.filter(layer => layer.mask).length * count : 0;
  const callback = Math.max(0, ...graph.layers.map(layer => layerMaskStorageBytes(layer)));
  const graphBytes = estimateDistortResources(graph).estimatedWorkingBytes;
  const collection = retain ? maskPlanes + 4 * count + Math.max(0, ...graph.layers.map((layer, index) =>
    index * 4 * count + estimateDistortLeafBytes(layer, { canvasPixels: count, filters: false }).estimatedWorkingBytes)) : 0;
  return Math.max(maskPlanes + callback, maskPlanes + graphBytes, collection);
}

async function prepare(native, project, retain) {
  const graph = structuredClone(project.states[project.cursor].graph), profile = await srgbProfile();
  const report = attachNames({ ...preflightPsdExport(graph, { iccProfileBytes: profile.length }), documentId: project.id, revision: project.revision }, graph);
  if (!report.supported) return { report };
  if (hasDenseMasks(graph)) {
    const count = graph.width * graph.height, maskPlanes = retain ? graph.layers.filter(layer => layer.mask).length * count : 0;
    const estimate = estimateDenseMaskResources(graph, { force: true });
    const callback = Math.max(0, ...graph.layers.map(layer => layer.maskDensity === 0 ? 0 : maskBufferBytes(layer.mask)));
    const collection = retain ? maskPlanes + 4 * count + Math.max(0, ...graph.layers.map((layer, index) => index * 4 * count + estimateDenseLeafBytes(layer, count, { filters: false }))) : 0;
    const bytes = Math.max(maskPlanes + callback + (retain ? count : 0), maskPlanes + estimate.estimatedWorkingBytes, collection);
    report.estimatedWorkingBytes = Math.max(report.estimatedWorkingBytes, bytes);
    try { assertDenseMaskBudget(report.estimatedWorkingBytes, estimate.preparationWork + graph.layers.reduce((total, layer) => total + additionalMaskWork(layer), 0)); }
    catch (cause) { report.issues.push({ code: 'WORKING_MEMORY_LIMIT', message: cause.message }); report.supported = false; return { report }; }
  }
  if (hasDistort(graph)) {
    report.estimatedWorkingBytes = Math.max(report.estimatedWorkingBytes, estimateDistortPsdPreparation(graph, { retain }));
    if (report.estimatedWorkingBytes > PSD_EXPORT_LIMITS.maxWorkingBytes) {
      report.issues.push({ code: 'WORKING_MEMORY_LIMIT', message: 'Distort rendering plus retained PSD masks and layer planes exceeds the 256 MiB working-buffer limit. Reduce the document or geometry first.' });
      report.supported = false;
      return { report };
    }
  }
  if (graph.layers.some(layer => positionedLayerMask(layer.mask))) {
    // Current-canvas masks remain in the Map while rendering. Their retained
    // sources can be much larger after a crop, so the writer-only canvas
    // estimate cannot describe preparation's callback peak.
    const count = graph.width * graph.height, maskPlanes = retain ? graph.layers.filter(layer => layer.mask).length * count : 0;
    const callback = Math.max(0, ...graph.layers.map(layer => layerMaskStorageBytes(layer)));
    const scratch = validateLayerFilterResources(graph, layerTree(graph.layers)).estimatedScratchBytes;
    // The renderer retains its composite/protection pair while source geometry
    // owns original, previous and next RGBA frames. These coexist with the
    // callback reserve; taking max(writer, callbacks) alone would omit them.
    const frames = graph.layers.map(layer => {
      const original = layer.width * layer.height;
      let previous = original, peak = original * (layer.alphaAsset ? 9 : 4);
      for (const transform of layer.transforms ?? []) {
        const next = transform.type === 'affine' ? previous : transform.width * transform.height;
        peak = Math.max(peak, 4 * original + 4 * previous + 4 * next);
        previous = next;
      }
      return peak;
    });
    const renderFrames = 5 * count + Math.max(0, ...frames);
    const collectedLayers = retain ? maskPlanes + 4 * count + Math.max(0, ...frames.map((bytes, index) => index * 4 * count + bytes)) : 0;
    const preparation = Math.max(maskPlanes + callback, maskPlanes + scratch + renderFrames, collectedLayers);
    report.estimatedWorkingBytes = Math.max(report.estimatedWorkingBytes, preparation);
    if (report.estimatedWorkingBytes > PSD_EXPORT_LIMITS.maxWorkingBytes) {
      report.issues.push({ code: 'WORKING_MEMORY_LIMIT', message: 'Retained mask callbacks and prepared PSD mask planes exceed the 256 MiB working-buffer limit. Rasterize mask positions or reduce the document first.' });
      report.supported = false;
      return { report };
    }
  }
  const masks = new Map();
  for (const layer of graph.layers) {
    const checked = await exactMask(native, layer, graph.width, graph.height, retain);
    if (checked.issue) report.issues.push(checked.issue);
    else if (checked.mask) masks.set(layer.id, checked.mask);
  }
  let composite;
  try { composite = await native.renderGraph(graph); }
  catch { throw Object.assign(new Error('PSD source pixels could not be rendered. The native project was not changed.'), { code: 'PSD_RENDER_FAILED' }); }
  for (let i = 3; i < composite.length; i += 4) if (composite[i] !== 255) {
    report.issues.push({ code: 'TRANSPARENT_COMPOSITE', message: 'This PSD export requires an opaque final image. Individual layers may retain transparency; the complete composition needs an opaque background.' });
    break;
  }
  report.supported = report.issues.length === 0;
  report.requiresPixelValidation = false;
  if (!retain || !report.supported) return { report };
  const layers = [];
  for (const layer of graph.layers) {
    let pixels;
    try { pixels = await native.renderLayer(layer, { filters: false }); }
    catch { throw Object.assign(new Error('A PSD layer could not be rendered. The native project was not changed.'), { code: 'PSD_RENDER_FAILED' }); }
    layers.push({ id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, pixels, ...(masks.has(layer.id) ? { mask: masks.get(layer.id) } : {}) });
  }
  return { report, graph, layers, composite, profile };
}

// Caller owns the native serialization/revision check. Both operations are
// read-only: no asset files, document history, preview-cache entries or graphs
// are published, even if mask/pixel validation or encoding fails.
export async function inspectNativePsd(native, project) {
  return (await prepare(native, project, false)).report;
}

export async function exportNativePsd(native, project) {
  const prepared = await prepare(native, project, true), { report } = prepared;
  if (!report.supported) throw Object.assign(new Error('This document cannot be exported as the supported layered PSD subset. Inspect its compatibility report for the specific layers and settings.'), { code: 'PSD_UNSUPPORTED', report });
  const { graph, layers, composite, profile } = prepared;
  const encoded = writePsdExport({ width: graph.width, height: graph.height, layers, composite, iccProfile: profile });
  const stem = graph.name.replace(/[^a-zA-Z0-9 _.-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'Image';
  return { ...encoded, filename: `${stem}.psd`, documentId: project.id, revision: project.revision, report };
}

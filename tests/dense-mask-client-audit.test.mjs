import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';
import { authoredFrame } from './fixtures/dense-mask/reference.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'prism-dense-client-audit-'));
after(() => rm(temporary, { recursive: true, force: true }));
const source = (await readFile(new URL('../client/dense-mask.ts', import.meta.url), 'utf8')).replace('../shared/dense-mask.mjs', new URL('../shared/dense-mask.mjs', import.meta.url).href);
const { code } = await transformWithOxc(source, 'dense-mask.ts');
await writeFile(join(temporary, 'helper.mjs'), code);
const { supportsDenseMasks, supportsMask, channelSupport, channelCapabilityKey, denseCapabilityKey, previewDimensions, validateChannelPreview, denseCommandMasks, maskShapeLabel } = await import(pathToFileURL(join(temporary, 'helper.mjs')).href);
const limits = { headerBytes: 32, maxDimension: 8192, maxPixels: 24_000_000, maxWorkingBytes: 268_435_456, maxPrepareWork: 384_000_000, maxHistoryAssets: 256, maxHistoryBytes: 3_221_225_472, yieldVisits: 65_536 };
const previewLimits = { maxEdge: 2400, defaultMaxEdge: 700, maxBytes: 8_388_608, maxWorkingBytes: 268_435_456, yieldVisits: 65_536 };
const caps = { id: 'native', connected: true, commands: ['get_document', 'get_channel_preview', 'load_channel_selection'], denseMaskPolicy: 'framed-raw-alpha8-v1', denseMaskLimits: limits, channelSelectionPolicy: 'composite-byte-alpha-v1', channelSelectionChannels: ['red', 'green', 'blue', 'luma', 'alpha'], channelPreviewLimits: previewLimits };

test('actual dense client requires complete typed contracts and independently bounded load and preview support', () => {
  const doc = { backend: 'native', width: 512, height: 512 };
  assert.equal(supportsDenseMasks(caps), true); assert.equal(channelSupport(caps, doc).load, true); assert.equal(channelSupport(caps, doc).preview, true);
  assert.equal(channelSupport({ ...caps, commands: ['get_channel_preview'] }, doc).load, false);
  assert.equal(channelSupport({ ...caps, commands: ['get_channel_preview'] }, doc).preview, true);
  assert.equal(channelSupport({ ...caps, commands: ['load_channel_selection'], channelPreviewLimits: undefined }, doc).load, true);
  assert.equal(channelSupport({ ...caps, commands: ['load_channel_selection'], channelPreviewLimits: undefined }, doc).preview, false);
  for (const patch of [{ id: 'photoshop' }, { connected: false }, { denseMaskPolicy: undefined }, { denseMaskPolicy: 'future' }, { denseMaskLimits: undefined }]) assert.equal(channelSupport({ ...caps, ...patch }, doc).semantic, false);
  for (const value of [undefined, null, 'red green blue luma alpha', ['red', 'green', 'blue', 'luma'], ['red', 'green', 'blue', 'luma', 'alpha', false]]) {
    assert.equal(channelSupport({ ...caps, channelSelectionChannels: value }, doc).semantic, false);
    assert.notEqual(channelCapabilityKey({ ...caps, channelSelectionChannels: value }), channelCapabilityKey(caps));
  }
  assert.equal(channelSupport({ ...caps, channelSelectionChannels: [...caps.channelSelectionChannels, 'future'] }, doc).semantic, true);
  for (const value of ['get_channel_preview load_channel_selection', ['get_channel_preview', false], undefined]) {
    assert.equal(channelSupport({ ...caps, commands: value }, doc).load, false); assert.equal(channelSupport({ ...caps, commands: value }, doc).preview, false);
  }
  for (const key of Object.keys(limits)) for (const value of [0, -1, NaN, Infinity, '32', limits[key] + 1]) {
    const changed = { ...caps, denseMaskLimits: { ...limits, [key]: value } };
    assert.equal(supportsDenseMasks(changed), false, `${key}=${String(value)}`); assert.notEqual(denseCapabilityKey(changed), denseCapabilityKey(caps));
  }
  const lower = { ...caps, denseMaskLimits: { ...limits, maxDimension: 1024, maxPixels: 1_000_000, maxWorkingBytes: 100_000_000, maxPrepareWork: 100_000_000, maxHistoryAssets: 16, maxHistoryBytes: 10_000_000, yieldVisits: 8192 }, channelPreviewLimits: { maxEdge: 700, defaultMaxEdge: 350, maxBytes: 1_000_000, maxWorkingBytes: 100_000_000, yieldVisits: 8192 } };
  assert.equal(channelSupport(lower, doc).load, true); assert.equal(channelSupport(lower, doc).preview, true); assert.equal(channelSupport(lower, doc).defaultEdge, 350);
  assert.equal(channelSupport(lower, { ...doc, width: 1025 }).semantic, false);
  for (const key of Object.keys(previewLimits)) for (const value of [0, Infinity, '700', previewLimits[key] + 1]) {
    if (key === 'defaultMaxEdge' && value === 701) continue; // A different valid default remains within the advertised range.
    const changed = { ...caps, channelPreviewLimits: { ...previewLimits, [key]: value } };
    assert.equal(channelSupport(changed, doc).preview, false, `${key}=${String(value)}`); assert.equal(channelSupport(changed, doc).load, true);
  }
});

test('actual dense client gates only masks consumed by each operation, retaining independent replacement and final deletion', () => {
  const descriptor = authoredFrame(Buffer.from([128]), 1, 1).descriptor, positioned = { shape: 'positioned', sourceWidth: 1, sourceHeight: 1, x: 1, y: 0, source: descriptor };
  const doc = { id: 'document', backend: 'native', width: 1, height: 1, revision: 1, selection: descriptor, savedSelections: [{ id: 'saved', mask: descriptor }], layers: [{ id: 'layer', mask: positioned, filters: [{ id: 'a' }, { id: 'b' }], filterMask: { coverage: descriptor } }] };
  assert.equal(supportsMask(descriptor, caps), true); assert.equal(supportsMask(positioned, caps), true);
  assert.equal(supportsMask(descriptor, { ...caps, denseMaskPolicy: undefined }), false);
  assert.equal(supportsMask({ ...descriptor, bytes: 34 }, caps), false);
  assert.equal(supportsMask({ shape: 'rectangle', x: 0, y: 0, width: 1, height: 1 }, undefined), true);
  assert.equal(maskShapeLabel(descriptor), 'Pixel mask'); assert.equal(maskShapeLabel({ shape: 'bitmap' }), 'Pixel mask');
  for (const command of ['load_channel_selection', 'load_layer_selection']) {
    assert.equal(denseCommandMasks(command, {}, doc).length, 0);
    assert.equal(denseCommandMasks(command, { mode: 'replace' }, doc).length, 0);
    assert.equal(denseCommandMasks(command, { mode: 'intersect' }, doc).length, 1);
  }
  assert.equal(denseCommandMasks('load_selection', { selectionId: 'saved' }, doc).length, 1, 'Default Replace consumes saved coverage only.');
  assert.equal(denseCommandMasks('load_selection', { selectionId: 'saved', mode: 'add' }, doc).length, 2);
  assert.equal(denseCommandMasks('paint_selection', {}, doc).length, 1, 'Default paint mode is Add.');
  assert.equal(denseCommandMasks('paint_selection', { mode: 'replace' }, doc).length, 0);
  assert.equal(denseCommandMasks('clear_selection', {}, doc).length, 0);
  assert.equal(denseCommandMasks('add_adjustment', {}, doc).length, 1);
  assert.equal(denseCommandMasks('add_adjustment', { mask: null }, doc).length, 0);
  assert.equal(denseCommandMasks('delete_layer_filter', { layerId: 'layer', filterId: 'a' }, doc).length, 1);
  assert.equal(denseCommandMasks('delete_layer_filter', { layerId: 'layer', filterId: 'a' }, { ...doc, layers: [{ ...doc.layers[0], filters: [{ id: 'a' }] }] }).length, 0);
  assert.equal(denseCommandMasks('clear_layer_filters', { layerId: 'layer' }, doc).length, 0);
});

test('actual channel preview validates exact rational output frame and captured request metadata', () => {
  assert.deepEqual(previewDimensions(420, 840, 457), { width: 229, height: 457 });
  assert.deepEqual(previewDimensions(8192, 1, 700), { width: 700, height: 1 });
  const doc = { id: 'fixture', revision: 8, width: 420, height: 840 };
  const result = { documentId: doc.id, revision: 8, sourceWidth: 420, sourceHeight: 840, width: 229, height: 457, channel: 'luma', invert: false, maxEdge: 457, coveragePolicy: 'composite-byte-alpha-v1', sampling: 'nearest-pixel-center', mimeType: 'image/png', data: 'AA==' };
  assert.doesNotThrow(() => validateChannelPreview(result, doc, 'luma', false, 457, 3));
  for (const [key, value] of Object.entries({ documentId: 'other', revision: 9, sourceWidth: 421, sourceHeight: 839, width: 228, height: 458, channel: 'red', invert: true, maxEdge: 456, coveragePolicy: 'other', sampling: 'linear', mimeType: 'image/jpeg', data: '' })) assert.throws(() => validateChannelPreview({ ...result, [key]: value }, doc, 'luma', false, 457, 3), key);
  assert.throws(() => validateChannelPreview({ ...result, data: 'AAAAAAAA' }, doc, 'luma', false, 457, 3));
});

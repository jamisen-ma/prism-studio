import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

// Load actual TS and its real formatting dependencies, without a browser or
// substituting a hand-written version of the percentage formatter.
const server = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let helper;
try { helper = await server.ssrLoadModule('/client/layer-fill.ts'); }
finally { await server.close(); }
const { effectiveLayerFill, fillPercent, parseFillDraft, fillCapabilityKey, supportsLayerFill, layerFillReason, isFillContent } = helper;

test('actual Fill client retains exact saved fractions and subnormals while refusing malformed or underflowing new drafts', () => {
  assert.equal(effectiveLayerFill(), 1); assert.equal(effectiveLayerFill({}), 1);
  for (const value of [0, Number.MIN_VALUE, Number.MIN_VALUE * 127, 1e-300, .07, .1, .375, .12345678901234568, 1 - 2 ** -53, 1]) {
    const text = fillPercent(value);
    assert.equal(parseFillDraft(text, value), value, `${value} survives its exact decimal display`);
    assert.equal(parseFillDraft(` ${text} `, value), value);
    assert.equal(effectiveLayerFill({ fillOpacity: value }), value);
  }
  assert.equal(fillPercent(.07), '7'); assert.equal(fillPercent(.375), '37.5');
  for (const text of ['37.5', '037.500', '3.75e1', '+.375e2']) assert.equal(parseFillDraft(text, .375), .375);
  for (const text of ['0', '-0', '+0.0', '-0e-999', '0e99']) assert.equal(Object.is(parseFillDraft(text, .5), 0), true);
  for (const text of ['', ' ', '1e', '-', '.', '0x10', 'Infinity', 'NaN', '1_0', '100.00000000000001', '-.0001', '1e-999', '-1e-999', '5e-324', '1e-323'])
    assert.equal(parseFillDraft(text, .5), undefined, text);
  assert.equal(parseFillDraft('50', .1), .5);
  assert.equal(parseFillDraft('100', Number.MIN_VALUE), 1);
  assert.equal(parseFillDraft('0', Number.MIN_VALUE), 0);
});

test('actual Fill support validates known type subsets and identifies hidden clipping bases independently of display state', () => {
  const caps = { id: 'native', connected: true, commands: ['set_layer_fill'], layerFillPolicy: 'content-alpha-outside-effects-v1', layerFillContentTypes: ['raster'] };
  const layer = { id: 'base', type: 'raster', visible: false, opacity: 0, fillOpacity: .375 };
  const document = { id: 'document', backend: 'native', revision: 1, layers: [layer] };
  assert.equal(supportsLayerFill(caps, 'native', 'raster'), true);
  assert.equal(supportsLayerFill(caps, 'native', 'text'), false);
  assert.equal(layerFillReason(document, layer, caps), '', 'Hidden and overall-zero content remains editable.');
  for (const type of ['raster', 'solid', 'text', 'shape', 'path', 'gradient']) assert.equal(isFillContent(type), true);
  for (const type of ['group', 'adjustment', 'future']) assert.equal(isFillContent(type), false);
  for (const patch of [{ id: 'photoshop' }, { connected: false }, { layerFillPolicy: 'future' },
    ...[undefined, null, [], 'set_layer_fill', ['set_layer_fill', null], ['set_layer']].map(commands => ({ commands })),
    ...[undefined, null, [], 'raster', ['raster', false], ['raster', 'future'], ['raster', 'raster']].map(layerFillContentTypes => ({ layerFillContentTypes }))]) {
    const malformed = { ...caps, ...patch };
    assert.equal(supportsLayerFill(malformed, 'native', 'raster'), false);
    assert.notEqual(fillCapabilityKey(malformed), fillCapabilityKey(caps));
  }
  assert.equal(supportsLayerFill(caps, 'photoshop', 'raster'), false);
  assert.match(layerFillReason(document, { ...layer, protected: true }, caps), /Unprotect/);
  const hiddenMember = { id: 'member', type: 'raster', visible: false, opacity: 0, clipBaseId: layer.id };
  const clipped = { ...document, layers: [layer, hiddenMember] };
  assert.match(layerFillReason(clipped, layer, caps), /clipping chain/);
  assert.match(layerFillReason(clipped, hiddenMember, caps), /clipping chain/);
  assert.match(layerFillReason(document, { ...layer, fillOpacity: NaN }, caps), /unavailable/);
});

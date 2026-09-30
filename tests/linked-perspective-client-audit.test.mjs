import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { LINKED_PERSPECTIVE_GOLDENS, LINKED_PERSPECTIVE_RECTANGLE } from './fixtures/linked-perspective/reference.mjs';

const server = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let helper, model;
try { helper = await server.ssrLoadModule('/client/linked-perspective.ts'); model = await server.ssrLoadModule('/client/distort-model.ts'); }
finally { await server.close(); }
const { parsePerspectiveDelta, perspectiveDeltaPending, linkedPerspectiveDraft } = helper;

test('actual paired-delta parser preserves complete precise Numbers and exposes every unresolved action', () => {
  for (const text of ['0', '-0', '+0.000', '-0e-999', '0e999']) { assert.equal(parsePerspectiveDelta(text) === 0, true); assert.equal(perspectiveDeltaPending(text), false); }
  assert.equal(Object.is(parsePerspectiveDelta('-0'), -0), true);
  for (const [text, value] of [[' 1.25e1 ', 12.5], ['-.125', -.125], ['5e-324', Number.MIN_VALUE], ['32768', 32768], ['-32768', -32768], ['.000000000001', 1e-12]]) {
    assert.equal(parsePerspectiveDelta(text), value); assert.equal(perspectiveDeltaPending(text), true);
  }
  for (const text of ['', ' ', '1e', '.', '+', 'Infinity', 'NaN', '0x10', '1_000', '1,5', '1e-999', '-1e-999', '32768.00000000001', '-32768.00000000001']) {
    assert.equal(parsePerspectiveDelta(text), undefined, text); assert.equal(perspectiveDeltaPending(text), true);
  }
  assert.equal(parsePerspectiveDelta('200', 100), 200); assert.equal(parsePerspectiveDelta('200.0001', 100), undefined);
  for (const limit of [0, .5, -1, Infinity, NaN, 16385]) assert.equal(parsePerspectiveDelta('0', limit), undefined);
});

test('actual paired draft helper keeps untouched strings, exact zero, original baselines and complete invalid candidates', () => {
  for (const golden of LINKED_PERSPECTIVE_GOLDENS) {
    const draft = LINKED_PERSPECTIVE_RECTANGLE.map(point => ({ x: `${point.x}.000`, y: `${point.y}e0` })), original = structuredClone(draft);
    const changed = linkedPerspectiveDraft(draft, golden.cornerIndex, golden.axis, golden.delta);
    assert.deepEqual(model.parseCorners(changed), golden.corners);
    const axis = golden.axis === 'horizontal' ? 'x' : 'y';
    for (let i = 0; i < 4; i++) for (const coordinate of ['x', 'y']) if (coordinate !== axis || ![golden.cornerIndex, golden.partnerIndex].includes(i)) assert.equal(changed[i][coordinate], draft[i][coordinate]);
    assert.deepEqual(draft, original); assert.notEqual(changed, draft);
  }
  const precise = [{ x: '16384.000', y: '-0' }, { x: '0e100', y: '5e-324' }, { x: '1.000', y: '1e0' }, { x: '-0e2', y: '01' }];
  for (const delta of [0, -0]) assert.deepEqual(linkedPerspectiveDraft(precise, 0, 'horizontal', delta), precise);
  const tiny = linkedPerspectiveDraft(precise, 0, 'horizontal', 1e-12);
  assert.equal(tiny[0].x, '16384.000'); assert.equal(tiny[1].x, '-1e-12');
  assert.equal(tiny[0].y, '-0'); assert.equal(tiny[3].x, '-0e2'); assert.equal(tiny[1].y, '5e-324');
  const baseline = [{ x: '0', y: '0' }, { x: '16384', y: '0' }, { x: '100', y: '80' }, { x: '0', y: '80' }];
  const out = linkedPerspectiveDraft(baseline, 0, 'horizontal', -32768);
  assert.equal(out[0].x, '-32768'); assert.equal(out[1].x, '49152'); assert.equal(model.parseCorners(out), undefined);
  assert.equal(linkedPerspectiveDraft(baseline, 0, 'horizontal', -32769), undefined);
  const bad = structuredClone(baseline); bad[0].x = '1e'; assert.equal(linkedPerspectiveDraft(bad, 0, 'horizontal', 1), undefined); assert.equal(bad[0].x, '1e');
  const before = structuredClone(precise);
  for (const delta of [1, -10, 1e-12, 0]) linkedPerspectiveDraft(precise, 0, 'horizontal', delta);
  assert.deepEqual(precise, before); assert.deepEqual(linkedPerspectiveDraft(precise, 0, 'horizontal', 0), before);
});

test('actual Distort gates reject offline or malformed commands while retaining independent command partitions and lower limits', () => {
  const layer = { id: 'layer', type: 'raster' };
  const caps = { id: 'native', connected: true, layerDistortPolicy: 'fixed-frame-projective-bilinear-v1', layerDistortCoordinates: 'stage-pixel-edges', layerDistortContentTypes: ['raster'],
    commands: ['add_layer_distort', 'update_layer_distort', 'delete_layer_distort'], limits: { maxDistortCorner: 100, maxDistortWork: 384000000, maxDistortWorkingBytes: 268435456 } };
  assert.deepEqual(model.distortSupport(caps, layer), { policy: true, limit: 100, add: true, update: true, remove: true });
  for (const commands of [undefined, null, 'add_layer_distort', ['add_layer_distort', 1], []]) {
    const result = model.distortSupport({ ...caps, commands }, layer); assert.equal(result.add, false); assert.equal(result.update, false); assert.equal(result.remove, false);
  }
  for (const [command, field] of [['add_layer_distort', 'add'], ['update_layer_distort', 'update'], ['delete_layer_distort', 'remove']]) {
    const result = model.distortSupport({ ...caps, commands: [command] }, layer);
    for (const name of ['add', 'update', 'remove']) assert.equal(result[name], name === field);
  }
  for (const patch of [{ connected: false }, { id: 'photoshop' }, { layerDistortPolicy: 'future' }, { layerDistortCoordinates: 'centers' }, { layerDistortContentTypes: 'raster' }, { layerDistortContentTypes: ['raster', null] }, { layerDistortContentTypes: ['text'] },
    ...[0, NaN, Infinity, 16385, .5].map(maxDistortCorner => ({ limits: { ...caps.limits, maxDistortCorner } }))]) {
    const result = model.distortSupport({ ...caps, ...patch }, layer); assert.equal(result.policy, false); assert.equal(result.add, false); assert.equal(result.update, false); assert.equal(result.remove, false);
  }
});

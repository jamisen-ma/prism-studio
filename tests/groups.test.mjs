import test from 'node:test';
import assert from 'node:assert/strict';
import { layerTree, flattenTree, subtree, ancestors, mixGroup, validateGroupResources } from '../server/groups.mjs';

test('canonical hierarchy retains sibling order and rejects noncontiguous, missing and content parents', () => {
  const layers = [{ id: 'g', type: 'group' }, { id: 'a', type: 'raster', parentId: 'g' }, { id: 'h', type: 'group', parentId: 'g' }, { id: 'b', type: 'raster', parentId: 'h' }, { id: 'c', type: 'raster' }];
  const tree = layerTree(layers);
  assert.deepEqual(flattenTree(tree.roots), layers);
  assert.deepEqual(subtree(tree.nodes.get('g')).map((node) => node.layer.id), ['g', 'a', 'h', 'b']);
  assert.deepEqual(ancestors(tree.nodes.get('b')).map((node) => node.layer.id), ['g', 'h']);
  for (const invalid of [
    [...layers, { id: 'd', parentId: 'g' }], [{ id: 'x', parentId: 'missing' }],
    [{ id: 'a', type: 'raster' }, { id: 'b', parentId: 'a' }], [{ id: 'g', type: 'group', parentId: 'g' }],
  ]) assert.throws(() => layerTree(invalid), { code: 'INVALID_ARGUMENT' });
});

test('premultiplied group interpolation preserves exact endpoints and soft alpha', () => {
  const before = Buffer.from([91, 17, 33, 0, 255, 0, 0, 128, 20, 60, 100, 255]);
  const after = Buffer.from([255, 255, 255, 255, 0, 0, 255, 128, 150, 80, 20, 90]);
  mixGroup(before, after, 3, 1, (x) => [0, 0.5, 1][x]);
  assert.deepEqual([...after], [91, 17, 33, 0, 128, 0, 128, 128, 150, 80, 20, 90]);
});

test('hidden group depth, protected ancestors and retained scratch are preflighted without allocating image buffers', () => {
  const nested = (count, opacity = 1) => Array.from({ length: count }, (_, index) => ({ id: `g${index}`, type: 'group', opacity, visible: false, ...(index ? { parentId: `g${index - 1}` } : {}) }));
  assert.throws(() => layerTree(nested(9)), { code: 'LIMIT_EXCEEDED' });
  assert.doesNotThrow(() => validateGroupResources(layerTree(nested(8)), 6000, 4000));
  assert.throws(() => validateGroupResources(layerTree(nested(3, 0.5)), 6000, 4000), { code: 'LIMIT_EXCEEDED' });
  assert.throws(() => validateGroupResources(layerTree([...nested(2, 0.5), { id: 'p', type: 'raster', parentId: 'g1', protected: true }]), 4, 4), { code: 'PROTECTED_LAYER' });
});

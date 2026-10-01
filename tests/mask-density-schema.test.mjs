import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand } from '../shared/commands.mjs';

const base = { documentId: 'document', layerId: 'layer' };
const mask = { x: 0, y: 0, width: 2, height: 2 };

test('density belongs to the layer-mask refinement command, with finite unit bounds and compatible empty refinement', () => {
  for (const density of [0, 0.0001, 128 / 255, 1]) assert.equal(validateCommand('modify_layer_mask', { ...base, density }).density, density);
  assert.deepEqual(validateCommand('modify_layer_mask', base), base);
  for (const density of [-0.01, 1.01, NaN, Infinity, -Infinity, '0.5', null]) assert.throws(() => validateCommand('modify_layer_mask', { ...base, density }), { code: 'INVALID_ARGUMENTS' });
  for (const misplaced of ['density', 'maskDensity']) {
    assert.throws(() => validateCommand('set_layer_mask', { ...base, mask: { ...mask, [misplaced]: 0.5 } }), { code: 'INVALID_ARGUMENTS' });
    assert.throws(() => validateCommand('add_adjustment', { documentId: base.documentId, kind: 'brightness', value: 10, mask: { ...mask, [misplaced]: 0.5 } }), { code: 'INVALID_ARGUMENTS' });
    assert.throws(() => validateCommand('select_region', { documentId: base.documentId, shape: 'rectangle', ...mask, [misplaced]: 0.5 }), { code: 'INVALID_ARGUMENTS' });
  }
  const args = validateCommand('modify_layer_mask', { ...base, density: 0.5, feather: 2, invert: true });
  const transaction = validateCommand('apply_transaction', { documentId: base.documentId, label: 'Refine mask', operations: [{ command: 'modify_layer_mask', args: { layerId: base.layerId, density: 0.5 } }] });
});

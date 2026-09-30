import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, validateBackendOptions, readCommands, transactionCommands } from '../shared/commands.mjs';

const base = { documentId: 'document', layerId: 'layer' };

test('mask-position commands require absolute bounded integer coordinates and keep persisted wrappers out of public mask authoring', () => {
  for (const x of [-16384, -1, 0, 16384]) {
    assert.deepEqual(validateCommand('set_layer_mask_position', { ...base, x, y: -x }), { ...base, x, y: -x });
  }
  for (const bad of [-16385, 16385, 0.5, Infinity, NaN, null, '2']) {
    for (const axis of ['x', 'y']) assert.throws(() => validateCommand('set_layer_mask_position', { ...base, x: 0, y: 0, [axis]: bad }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const fields of [{ x: 0 }, { y: 0 }, { x: 0, y: 0, relative: true }, { x: 0, y: 0, linked: true }]) {
    assert.throws(() => validateCommand('set_layer_mask_position', { ...base, ...fields }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.deepEqual(validateCommand('apply_layer_mask_position', base), base);
  assert.throws(() => validateCommand('apply_layer_mask_position', { ...base, x: 0 }), { code: 'INVALID_ARGUMENTS' });
  const source = { shape: 'rectangle', x: 0, y: 0, width: 8, height: 8 };
  const wrapper = { shape: 'positioned', sourceWidth: 8, sourceHeight: 8, x: 2, y: 0, source };
  for (const mask of [wrapper, { ...source, maskOffset: { x: 1, y: 2 } }, { ...source, sourceWidth: 8 }]) {
    assert.throws(() => validateCommand('set_layer_mask', { ...base, mask }), { code: 'INVALID_ARGUMENTS' });
    assert.throws(() => validateCommand('add_adjustment', { documentId: base.documentId, kind: 'brightness', value: 10, mask }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.throws(() => validateCommand('select_region', { documentId: base.documentId, ...wrapper }), { code: 'INVALID_ARGUMENTS' });
});

test('positioning and rasterizing are native-only transaction mutations and cannot become recipe steps', () => {
  const operations = [
    { command: 'set_layer_mask_position', args: { layerId: base.layerId, x: -4, y: 2 } },
    { command: 'apply_layer_mask_position', args: { layerId: base.layerId } },
  ];
  const transaction = validateCommand('apply_transaction', { documentId: base.documentId, expectedRevision: 3, label: 'Move and rasterize mask', operations });
  assert.deepEqual(transaction.operations, operations);
  for (const operation of operations) {
    assert.equal(readCommands.has(operation.command), false);
    assert.equal(transactionCommands.has(operation.command), true);
    assert.throws(() => validateBackendOptions('photoshop', operation.command, operation.args), { code: 'UNSUPPORTED_COMMAND' });
    assert.doesNotThrow(() => validateBackendOptions('native', operation.command, operation.args));
    assert.throws(() => validateCommand('save_edit_recipe', {
      documentId: base.documentId, name: 'Disallowed mask operation',
      slots: [{ key: 'photo', type: 'raster' }],
      steps: [{ command: operation.command, target: 'photo', args: {} }],
    }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.throws(() => validateBackendOptions('photoshop', 'apply_transaction', transaction), { code: 'UNSUPPORTED_COMMAND' });
  assert.throws(() => validateCommand('apply_transaction', { documentId: base.documentId, label: 'Invalid inner revision', operations: [{ ...operations[0], args: { ...operations[0].args, expectedRevision: 3 } }] }), { code: 'INVALID_TRANSACTION' });
});

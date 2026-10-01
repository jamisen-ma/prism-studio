import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, readCommands, transactionCommands } from '../shared/commands.mjs';

const base = { documentId: 'document', layerId: 'photo', expectedRevision: 2 };

test('filter baking requires an explicit target and positive revision without implicit options', () => {
  assert.deepEqual(validateCommand('bake_layer_filters', base), base);
  for (const expectedRevision of [undefined, null, 0, -1, 1.5, NaN, Infinity, '2']) assert.throws(() => validateCommand('bake_layer_filters', { ...base, expectedRevision }), { code: 'INVALID_ARGUMENTS' });
  for (const fields of [{ documentId: '' }, { layerId: '' }, { layerId: undefined }, { filterId: 'entry' }, { unprotect: true }, { flatten: true }, { scope: 'selection' }, { includeDisabled: true }]) assert.throws(() => validateCommand('bake_layer_filters', { ...base, ...fields }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(readCommands.has('bake_layer_filters'), false); assert.equal(transactionCommands.has('bake_layer_filters'), true);
});

test('bake transactions pin the enclosing revision, retain exact inner arguments and preserve ordinary transaction conventions', () => {
  const operations = [
    { command: 'bake_layer_filters', args: { layerId: 'photo' } },
    { command: 'set_layer', args: { layerId: 'photo', name: 'Ready for retouch' } },
  ];
  const transaction = { documentId: base.documentId, expectedRevision: 2, label: 'Bake and prepare', operations };
  const parsed = validateCommand('apply_transaction', transaction);
  assert.deepEqual(parsed, transaction);
  assert.notEqual(parsed.operations, operations); assert.notEqual(parsed.operations[0].args, operations[0].args);
  for (const expectedRevision of [undefined, 0]) assert.throws(() => validateCommand('apply_transaction', { ...transaction, expectedRevision }), { code: 'INVALID_TRANSACTION' });
  for (const fields of [{ expectedRevision: 2 }, { documentId: 'another' }]) assert.throws(() => validateCommand('apply_transaction', { ...transaction, operations: [{ ...operations[0], args: { ...operations[0].args, ...fields } }] }), { code: 'INVALID_TRANSACTION' });
  assert.doesNotThrow(() => validateCommand('apply_transaction', { documentId: base.documentId, label: 'Ordinary edit', operations: [operations[1]] }));
  assert.deepEqual(validateCommand('apply_transaction', { ...transaction, operations: [operations[0], operations[0]] }).operations, [operations[0], operations[0]]);
});

test('baking is excluded from metadata-only recipes and nested transactions', () => {
  assert.throws(() => validateCommand('save_edit_recipe', {
    documentId: base.documentId, name: 'Unsupported pixel recipe',
    slots: [{ key: 'photo', type: 'raster' }],
    steps: [{ command: 'bake_layer_filters', target: 'photo', args: {} }],
  }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateCommand('apply_transaction', {
    documentId: base.documentId, expectedRevision: 2, label: 'No nested transaction',
    operations: [{ command: 'apply_transaction', args: { label: 'Nested bake', operations: [{ command: 'bake_layer_filters', args: { layerId: 'photo' } }] } }],
  }), { code: 'INVALID_TRANSACTION' });
});

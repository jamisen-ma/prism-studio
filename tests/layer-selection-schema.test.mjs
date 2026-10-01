import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, commandLabels, transactionCommands, validateCommand } from '../shared/commands.mjs';

const base = { documentId: 'document', layerId: 'layer' };

test('layer selection has explicit source, coverage, combination and inversion options with no irrelevant mask mode', () => {
  assert.deepEqual(validateCommand('load_layer_selection', base), { ...base, source: 'content', mode: 'replace', invert: false });
  assert.ok(commandSchemas.load_layer_selection.shape.layerId); // MCP publishes the same strict schema.
  assert.equal(typeof commandLabels.load_layer_selection, 'string');
  for (const source of ['content', 'layer-mask']) for (const mode of ['replace', 'add', 'subtract', 'intersect']) {
    assert.deepEqual(validateCommand('load_layer_selection', { ...base, source, mode, invert: true }), { ...base, source, mode, invert: true });
  }
  for (const maskMode of ['raw', 'effective']) assert.equal(validateCommand('load_layer_selection', { ...base, source: 'layer-mask', maskMode }).maskMode, maskMode);
  for (const fields of [
    { source: 'visible' }, { source: null }, { maskMode: 'raw' }, { source: 'content', maskMode: 'effective' },
    { source: 'layer-mask', maskMode: 'source-alpha' }, { mode: 'union' }, { invert: 1 }, { invert: 'true' },
    { layerId: '' }, { density: 0.5 }, { expectedRevision: -1 }, { source: 'layer-mask', extra: true },
  ]) assert.throws(() => validateCommand('load_layer_selection', { ...base, ...fields }), { code: 'INVALID_ARGUMENTS' });
});

test('layer selection is a native transaction command with the same field validation inside transactions', () => {
  assert.ok(transactionCommands.has('load_layer_selection'));
  const transaction = validateCommand('apply_transaction', { documentId: 'document', expectedRevision: 7, label: 'Reuse soft alpha', operations: [
    { command: 'load_layer_selection', args: { layerId: 'layer', source: 'layer-mask', maskMode: 'raw', invert: true, mode: 'add' } },
    { command: 'save_selection', args: { name: 'Reusable alpha' } },
  ] });
  assert.deepEqual(transaction.operations[0].args, { layerId: 'layer', source: 'layer-mask', maskMode: 'raw', invert: true, mode: 'add' });
  assert.throws(() => validateCommand('apply_transaction', { documentId: 'document', label: 'Reject ignored mode', operations: [{ command: 'load_layer_selection', args: { layerId: 'layer', maskMode: 'raw' } }] }), { code: 'INVALID_ARGUMENTS' });
});

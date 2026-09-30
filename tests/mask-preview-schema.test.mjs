import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, readCommands, transactionCommands, validateCommand, validateBackendOptions } from '../shared/commands.mjs';

test('mask preview is a read with explicit source-specific arguments and bounded longest-edge size', () => {
  assert.ok(readCommands.has('get_mask_preview')); assert.ok(!transactionCommands.has('get_mask_preview'));
  assert.ok(commandSchemas.get_mask_preview.shape.maxEdge);
  assert.deepEqual(validateCommand('get_mask_preview', { documentId: 'doc' }), { documentId: 'doc', source: 'selection', maxEdge: 700 });
  for (const maskMode of ['raw', 'effective']) assert.deepEqual(validateCommand('get_mask_preview', { documentId: 'doc', expectedRevision: 9, source: 'layer-mask', layerId: 'layer', maskMode, maxEdge: 2400 }), { documentId: 'doc', expectedRevision: 9, source: 'layer-mask', layerId: 'layer', maskMode, maxEdge: 2400 });
  for (const fields of [
    { source: 'content' }, { layerId: 'layer' }, { maskMode: 'raw' }, { source: 'layer-mask' },
    { source: 'layer-mask', layerId: 'layer', maskMode: 'alpha' }, { maxEdge: 31 }, { maxEdge: 2401 },
    { maxEdge: 100.5 }, { maxEdge: NaN }, { maxEdge: '700' }, { maxWidth: 700 }, { expectedRevision: -1 }, { invert: true },
  ]) assert.throws(() => validateCommand('get_mask_preview', { documentId: 'doc', ...fields }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateCommand('apply_transaction', { documentId: 'doc', label: 'Read is not an edit', operations: [{ command: 'get_mask_preview', args: {} }] }), { code: 'INVALID_TRANSACTION' });
  assert.throws(() => validateBackendOptions('photoshop', 'get_mask_preview', validateCommand('get_mask_preview', { documentId: 'doc' })), { code: 'UNSUPPORTED_COMMAND' });
});

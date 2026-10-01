import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, commandSchemas } from '../shared/commands.mjs';

const base = { documentId: 'photo', expectedRevision: 4, width: 37, height: 29 };

test('resize methods are explicit optional native choices without changing legacy request shape', () => {
  assert.deepEqual(validateCommand('resize_document', base), base);
  assert.equal(Object.hasOwn(validateCommand('resize_document', base), 'resample'), false);
  for (const resample of ['nearest', 'cubic', 'mitchell', 'lanczos3']) {
    const args = { ...base, resample };
    assert.deepEqual(validateCommand('resize_document', args), args);
  }
  for (const resample of [null, '', 'Nearest', 'linear', 'auto', 'preserve-details', 1, true, ['nearest'], { kernel: 'nearest' }]) {
    assert.throws(() => validateCommand('resize_document', { ...base, resample }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const fields of [{ kernel: 'nearest' }, { resample: 'nearest', sharpen: true }, { width: 0 }, { height: 8193 }, { width: 7.5 }]) {
    assert.throws(() => validateCommand('resize_document', { ...base, ...fields }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.deepEqual(commandSchemas.resize_document.shape.resample.unwrap().options, ['nearest', 'cubic', 'mitchell', 'lanczos3']);
});

test('transaction resize keeps its chosen method and cannot silently send it to canvas bounds', () => {
  const operation = { command: 'resize_document', args: { width: 11, height: 13, resample: 'nearest' } };
  const args = { documentId: base.documentId, expectedRevision: 4, label: 'Resize pixel artwork', operations: [operation] };
  assert.deepEqual(validateCommand('apply_transaction', args), args);
  assert.throws(() => validateCommand('resize_canvas', { ...base, resample: 'nearest' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateCommand('apply_transaction', { ...args, operations: [{ ...operation, args: { ...operation.args, resample: 'automatic' } }] }), { code: 'INVALID_ARGUMENTS' });
  assert.doesNotThrow(() => validateCommand('apply_transaction', { documentId: base.documentId, label: args.label, operations: [operation] }));
});

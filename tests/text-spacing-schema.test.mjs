import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand } from '../shared/commands.mjs';

const create = { documentId: 'doc', text: 'AUTUMN\nOUTFITS', x: 10, y: 10, fontSize: 64, color: '#573c2d' };
const update = { documentId: 'doc', layerId: 'text' };

test('text spacing validates authored units, reset values and omitted update fields', () => {
  for (const [command, args] of [['add_text', create], ['update_text', update]]) {
    assert.equal(validateCommand(command, args).tracking, undefined); assert.equal(validateCommand(command, args).leading, undefined);
    for (const tracking of [-1000, -80, 0, 120, 1000]) assert.equal(validateCommand(command, { ...args, tracking }).tracking, tracking);
    for (const leading of [null, 1, 48.125, 2000]) assert.equal(validateCommand(command, { ...args, leading }).leading, leading);
    for (const fields of [{ tracking: -1001 }, { tracking: 1001 }, { tracking: 0.5 }, { tracking: null }, { tracking: '50' }, { tracking: Infinity }, { leading: 0 }, { leading: 2001 }, { leading: NaN }, { leading: -1 }, { leading: 'auto' }, { lineHeight: 1.2 }]) assert.throws(() => validateCommand(command, { ...args, ...fields }), { code: 'INVALID_ARGUMENTS' });
  }
});

test('spacing uses the same validation in native transactions', () => {
  const transaction = validateCommand('apply_transaction', { documentId: 'doc', expectedRevision: 4, label: 'Reset type spacing', operations: [{ command: 'update_text', args: { layerId: 'text', tracking: 0, leading: null } }] });
  assert.deepEqual(transaction.operations[0].args, { layerId: 'text', tracking: 0, leading: null });
  assert.throws(() => validateCommand('apply_transaction', { documentId: 'doc', label: 'Invalid spacing', operations: [{ command: 'update_text', args: { layerId: 'text', tracking: 1000.5 } }] }), { code: 'INVALID_ARGUMENTS' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateCommand, transactionCommands } from '../shared/commands.mjs';

const stroke = { documentId: 'doc', layerId: 'repair', tool: 'clone', points: [{ x: 5.5, y: 5.5 }], source: { x: 1.5, y: 1.5 }, size: 3, hardness: 1, opacity: 1 };
const invalid = value => value?.code === 'INVALID_ARGUMENTS';

test('retouch sampling validates only clone/heal fields while preserving omitted legacy options', () => {
  for (const tool of ['clone', 'heal']) {
    const legacy = validateCommand('paint_stroke', { ...stroke, tool });
    assert.equal(legacy.sampleMode, undefined); assert.equal(legacy.ignoreAdjustments, undefined);
    for (const sampleMode of ['current', 'current-and-below', 'all']) {
      assert.equal(validateCommand('paint_stroke', { ...stroke, tool, sampleMode }).sampleMode, sampleMode);
      assert.equal(validateCommand('paint_stroke', { ...stroke, tool, sampleMode, ignoreAdjustments: false }).ignoreAdjustments, false);
      if (sampleMode !== 'current') assert.equal(validateCommand('paint_stroke', { ...stroke, tool, sampleMode, ignoreAdjustments: true }).ignoreAdjustments, true);
    }
    assert.equal(validateCommand('paint_stroke', { ...stroke, tool, ignoreAdjustments: true }).sampleMode, undefined);
    for (const fields of [{ sampleMode: 'below' }, { sampleMode: null }, { ignoreAdjustments: 1 }, { ignoreAdjustments: 'true' }, { sampleMode: 'current', ignoreAdjustments: true }]) assert.throws(() => validateCommand('paint_stroke', { ...stroke, tool, ...fields }), invalid);
  }
  for (const tool of ['brush', 'pencil', 'eraser', 'dodge', 'burn', 'blur', 'sharpen', 'smudge', 'sponge', 'red_eye', 'color_replace']) {
    const fields = { ...stroke, tool, color: '#123456' };
    validateCommand('paint_stroke', fields);
    for (const option of [{ sampleMode: 'all' }, { ignoreAdjustments: false }]) assert.throws(() => validateCommand('paint_stroke', { ...fields, ...option }), invalid);
  }
});

test('repair layers accept explicit source and optional UUID identity with transaction validation', () => {
  const newLayerId = randomUUID(), create = { documentId: 'doc', sourceLayerId: 'source', newLayerId, name: 'Repair' };
  assert.deepEqual(validateCommand('create_repair_layer', create), create);
  assert.equal(validateCommand('create_repair_layer', { documentId: 'doc', sourceLayerId: 'source' }).newLayerId, undefined);
  for (const fields of [{ sourceLayerId: '' }, { newLayerId: 'not-a-uuid' }, { newLayerId: 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF' }, { newLayerId: null }, { name: '' }, { layerId: newLayerId }, { position: 1 }]) assert.throws(() => validateCommand('create_repair_layer', { ...create, ...fields }), invalid);
  assert.throws(() => validateCommand('create_repair_layer', { documentId: 'doc', newLayerId }), invalid);
  assert.equal(transactionCommands.has('create_repair_layer'), true);
  const transaction = validateCommand('apply_transaction', { documentId: 'doc', expectedRevision: 3, label: 'Separate repair', operations: [
    { command: 'create_repair_layer', args: { sourceLayerId: 'source', newLayerId } },
    { command: 'paint_stroke', args: { ...stroke, documentId: undefined, layerId: newLayerId, sampleMode: 'current-and-below', ignoreAdjustments: true } },
  ] });
  assert.equal(transaction.operations[0].args.newLayerId, transaction.operations[1].args.layerId);
  assert.equal(transaction.operations[1].args.documentId, undefined);
  const invalidTransaction = structuredClone(transaction); invalidTransaction.operations[1].args.sampleMode = 'current';
  assert.throws(() => validateCommand('apply_transaction', invalidTransaction), invalid);
});

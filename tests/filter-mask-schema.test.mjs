import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, validateCommand, validateEditRecipeDefinition, readCommands, transactionCommands } from '../shared/commands.mjs';

const base = { documentId: 'document', layerId: 'photo', expectedRevision: 2 };
const mutations = ['set_layer_filter_mask', 'modify_layer_filter_mask', 'clear_layer_filter_mask'];
const bitmap = { shape: 'bitmap', width: 4, height: 2, runs: [0, 1, 1, 2, 2, 128, 7, 1, 255] };
const authored = mask => ({ ...base, source: 'mask', mask });
const rejectSet = args => assert.throws(() => validateCommand('set_layer_filter_mask', args), { code: 'INVALID_ARGUMENTS' });

test('source filter masks distinguish explicit selection/all/none from strict source descriptors', () => {
  for (const source of ['selection', 'all', 'none']) {
    const args = { ...base, source }; assert.deepEqual(validateCommand('set_layer_filter_mask', args), args);
    rejectSet({ ...args, mask: bitmap });
  }
  for (const mask of [bitmap, { ...bitmap, x: 0, y: 0, feather: .125, invert: false }, { shape: 'rectangle', x: 0, y: 1, width: 4, height: 2 }, { shape: 'ellipse', x: 2, y: 0, width: 1, height: 1, feather: 100, invert: true }]) {
    const args = authored(mask); assert.deepEqual(validateCommand('set_layer_filter_mask', args), args);
  }
  for (const fields of [{}, { source: 'mask' }, { source: null }, { source: 'original' }, { source: 'all', enabled: false }, { source: 'none', density: .5 }]) rejectSet({ ...base, ...fields });
  for (const fields of [{ shape: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, { shape: 'positioned', source: bitmap }, { ...bitmap, clip: {} }, { ...bitmap, density: .1 }, { ...bitmap, enabled: false }, { ...bitmap, x: 1 }, { ...bitmap, y: -1 }, { ...bitmap, invert: 1 }, { ...bitmap, feather: 100.001 }, { ...bitmap, feather: '1' }, { x: 0, y: 0, width: 1, height: 1 }]) rejectSet(authored(fields));
});

test('source bitmap run metadata rejects invalid geometry, ordering and complexity before native dispatch', () => {
  assert.deepEqual(validateCommand('set_layer_filter_mask', authored({ ...bitmap, runs: [] })).mask.runs, []);
  for (const runs of [[0], [0, 1], [-1, 1, 255], [0, 0, 255], [0, 9, 255], [7, 2, 255], [0, 1, 0], [0, 1, 256], [0, 1, 1.5], [0, 2, 128, 1, 1, 255], [2, 1, 128, 0, 1, 255], [0, .5, 255], [0, 1, NaN], [0, 1, '255']]) rejectSet(authored({ ...bitmap, runs }));
  for (const dimensions of [{ width: 0 }, { width: 8193 }, { width: 8192, height: 8192 }, { height: 1.5 }, { height: '2' }]) rejectSet(authored({ ...bitmap, ...dimensions }));
  rejectSet(authored({ ...bitmap, runs: Array(600_003).fill(0) }));
  for (const shape of ['rectangle', 'ellipse']) for (const fields of [{ x: -1 }, { y: .5 }, { width: 0 }, { width: 8193 }, { runs: [] }]) rejectSet(authored({ shape, x: 0, y: 0, width: 1, height: 1, ...fields }));
});

test('filter-mask updates preserve sparse exact settings and all mutations pin positive revisions including transactions', () => {
  for (const settings of [{ enabled: false }, { enabled: true }, { density: Number.MIN_VALUE }, { density: .1 }, { density: 0.10000000000000002 }, { density: 0 }, { density: 1 }, { feather: .125 }, { invert: false }, { enabled: false, density: .123456789, feather: 100, invert: true }]) {
    const args = { ...base, ...settings }; assert.deepEqual(validateCommand('modify_layer_filter_mask', args), args);
  }
  for (const settings of [{}, { density: -Number.MIN_VALUE }, { density: 1.001 }, { density: null }, { density: '0.1' }, { enabled: 0 }, { feather: Infinity }, { mask: bitmap }, { filterId: 'entry' }]) assert.throws(() => validateCommand('modify_layer_filter_mask', { ...base, ...settings }), { code: 'INVALID_ARGUMENTS' });
  for (const command of mutations) {
    const fields = command === 'set_layer_filter_mask' ? { source: 'all' } : command === 'modify_layer_filter_mask' ? { enabled: false } : {};
    for (const expectedRevision of [undefined, null, 0, -1, .5, '2']) assert.throws(() => validateCommand(command, { ...base, ...fields, expectedRevision }), { code: 'INVALID_ARGUMENTS' });
    assert.equal(readCommands.has(command), false); assert.equal(transactionCommands.has(command), true);
    const operations = [{ command, args: { layerId: base.layerId, ...fields } }];
    const transaction = { documentId: base.documentId, expectedRevision: 2, label: 'Mask change', operations };
    assert.deepEqual(validateCommand('apply_transaction', transaction).operations, operations);
    assert.throws(() => validateCommand('apply_transaction', { ...transaction, expectedRevision: undefined }), { code: 'INVALID_TRANSACTION' });
    assert.throws(() => validateCommand('apply_transaction', { ...transaction, operations: [{ command, args: { ...operations[0].args, expectedRevision: 2 } }] }), { code: 'INVALID_TRANSACTION' });
  }
});

test('source mask inspection extends only its read source and mask mutations remain excluded from recipes', () => {
  assert.ok(commandSchemas.get_mask_preview.shape.source.unwrap().options.includes('filter-mask'));
  for (const maskMode of ['raw', 'effective']) {
    const args = { ...base, source: 'filter-mask', maskMode };
    assert.deepEqual(validateCommand('get_mask_preview', args), { ...args, maxEdge: 700 });
    const withoutRevision = { documentId: base.documentId, layerId: base.layerId, source: 'filter-mask', maskMode };
    assert.deepEqual(validateCommand('get_mask_preview', withoutRevision), { ...withoutRevision, maxEdge: 700 });
  }
  assert.throws(() => validateCommand('get_mask_preview', { documentId: base.documentId, source: 'filter-mask' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateCommand('get_mask_preview', { ...base, source: 'filter-mask', filterId: 'entry' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateCommand('load_layer_selection', { ...base, source: 'filter-mask' }), { code: 'INVALID_ARGUMENTS' });
  for (const command of mutations) assert.throws(() => validateEditRecipeDefinition({ name: 'Scope', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command, target: 'photo', args: command === 'set_layer_filter_mask' ? { source: 'all' } : command === 'modify_layer_filter_mask' ? { density: .5 } : {} }] }), { code: 'INVALID_ARGUMENTS' });
});

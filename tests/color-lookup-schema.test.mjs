import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, validateBackendOptions, validateEditRecipeDefinition } from '../shared/commands.mjs';
import { COLOR_LOOKUP_LIMITS } from '../shared/color-lookup.mjs';

const descriptor = { asset: 'ab'.repeat(32), bytes: 122, gridSize: 2, inputSpace: 'srgb', sourceName: 'Look.cube', title: 'Warm' };
const upload = { documentId: 'doc', expectedRevision: 1, target: 'adjustment', data: 'AA==', sourceName: 'Look.cube', inputSpace: 'srgb' };
const invalid = { code: 'INVALID_ARGUMENTS' };

test('Color Lookup import requires an explicit interpretation, pinned revision and unambiguous target', () => {
  for (const target of [{}, { layerId: 'grade' }, { target: 'layer-filter', layerId: 'photo' }, { target: 'layer-filter', layerId: 'photo', filterId: 'look' }]) assert.deepEqual(validateCommand('import_color_lookup', { ...upload, ...target }), { ...upload, ...target });
  for (const patch of [{ expectedRevision: undefined }, { expectedRevision: 0 }, { expectedRevision: 1.5 }, { inputSpace: undefined }, { inputSpace: 'log' }, { target: 'layer-filter' }, { filterId: 'filter' }, { target: 'unknown' }, { data: 'AB==' }, { data: 'AAA\n' }, { sourceName: '../file.cube' }, { path: '/tmp/look.cube' }]) assert.throws(() => validateCommand('import_color_lookup', { ...upload, ...patch }), invalid);
  let reads = 0; const accessor = { ...upload }; Object.defineProperty(accessor, 'data', { enumerable: true, get() { reads++; return 'AA=='; } });
  assert.throws(() => validateCommand('import_color_lookup', accessor), invalid); assert.equal(reads, 0);
});

test('Color Lookup creation needs a complete descriptor; updates allow only empty or complete replacement metadata', () => {
  for (const command of ['add_adjustment', 'add_layer_filter', 'update_adjustment', 'update_layer_filter']) {
    const base = { documentId: 'doc', ...(command !== 'add_adjustment' ? { layerId: 'photo' } : {}), ...(command === 'update_layer_filter' ? { filterId: 'look' } : {}), ...(command.startsWith('add_') ? { kind: 'color_lookup', value: 0 } : {}), parameters: descriptor };
    const parsed = validateCommand(command, base); assert.deepEqual(parsed.parameters, descriptor); assert.notEqual(parsed.parameters, descriptor);
    for (const parameters of [{ asset: descriptor.asset }, { ...descriptor, bytes: 0 }, { ...descriptor, title: null }, { ...descriptor, path: 'x' }]) assert.throws(() => validateCommand(command, { ...base, parameters }), invalid);
    let reads = 0; const accessor = { ...descriptor }; Object.defineProperty(accessor, 'asset', { enumerable: true, get() { reads++; return descriptor.asset; } });
    assert.throws(() => validateCommand(command, { ...base, parameters: accessor }), invalid); assert.equal(reads, 0);
    if (command.startsWith('add_')) {
      for (const parameters of [undefined, {}]) assert.throws(() => validateCommand(command, { ...base, parameters }), invalid);
      assert.throws(() => validateCommand(command, { ...base, value: 1 }), invalid);
    } else assert.deepEqual(validateCommand(command, { ...base, parameters: {} }).parameters, {});
  }
});

test('Color Lookup transactions pin the outer revision and admit aggregate decoded imports before execution', () => {
  const { documentId, expectedRevision, ...args } = upload;
  const transaction = { documentId, expectedRevision, label: 'Import look', operations: [{ command: 'import_color_lookup', args }] };
  assert.deepEqual(validateCommand('apply_transaction', transaction), transaction);
  assert.throws(() => validateCommand('apply_transaction', { ...transaction, expectedRevision: undefined }), { code: 'INVALID_TRANSACTION' });
  assert.throws(() => validateCommand('apply_transaction', { ...transaction, operations: [{ command: 'import_color_lookup', args: { ...args, expectedRevision: 1 } }] }), { code: 'INVALID_TRANSACTION' });
  const one = Buffer.alloc(COLOR_LOOKUP_LIMITS.maxTransactionBytes / 2).toString('base64');
  const two = { ...transaction, operations: [1, 2].map(() => ({ command: 'import_color_lookup', args: { ...args, data: one } })) };
  assert.doesNotThrow(() => validateCommand('apply_transaction', two));
  assert.throws(() => validateCommand('apply_transaction', { ...two, operations: [...two.operations, { command: 'import_color_lookup', args }] }), { code: 'LIMIT_EXCEEDED' });
});

test('Color Lookup stays native-only and asset-dependent recipes refuse without prohibiting ordinary recipes', () => {
  for (const [command, args] of [['import_color_lookup', upload], ['add_adjustment', { documentId: 'doc', kind: 'color_lookup', value: 0, parameters: descriptor }], ['update_adjustment', { documentId: 'doc', layerId: 'grade', parameters: descriptor }]]) {
    assert.doesNotThrow(() => validateBackendOptions('native', command, args));
    assert.throws(() => validateBackendOptions('photoshop', command, args), { code: 'UNSUPPORTED_COMMAND' });
    assert.throws(() => validateBackendOptions('photoshop', 'apply_transaction', { operations: [{ command, args }] }), { code: 'UNSUPPORTED_COMMAND' });
  }
  const source = { name: 'Look', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'color_lookup', value: 0, enabled: false, parameters: descriptor } }] };
  const global = { name: 'Look', slots: [{ key: 'grade', type: 'adjustment', kind: 'color_lookup' }], steps: [{ command: 'update_adjustment', target: 'grade', args: { value: 0, parameters: descriptor } }] };
  for (const recipe of [source, global]) {
    assert.throws(() => validateEditRecipeDefinition(recipe), invalid);
    assert.throws(() => validateCommand('save_edit_recipe', { documentId: 'doc', ...recipe }), invalid);
  }
  const ordinary = { ...source, steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'invert', value: 100 } }] };
  assert.deepEqual(validateEditRecipeDefinition(ordinary), ordinary);
});

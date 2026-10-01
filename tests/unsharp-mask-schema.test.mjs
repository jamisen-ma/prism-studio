import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, validateCommand, validateEditRecipeDefinition } from '../shared/commands.mjs';

const base = { documentId: 'document', layerId: 'photo', expectedRevision: 2 };
const add = parameters => ({ ...base, kind: 'unsharp_mask', value: 0, ...(parameters === undefined ? {} : { parameters }) });
const rejects = args => assert.throws(() => validateCommand('add_layer_filter', args), { code: 'INVALID_ARGUMENTS' });

test('Unsharp Mask has source-only finite typed controls with sparse defaults and exact authored precision', () => {
  for (const parameters of [undefined, {}, { amount: 0 }, { amount: 133.33 }, { amount: 500, sigma: 50, threshold: 255 }, { sigma: Number.MIN_VALUE }, { sigma: .3977, threshold: 0 }, { amount: 100, sigma: 1, threshold: 0 }]) {
    const args = add(parameters); assert.deepEqual(validateCommand('add_layer_filter', args), args);
  }
  for (const amount of [-.01, 500.01, .001, Number.MIN_VALUE, Infinity, NaN, null, true, '100']) rejects(add({ amount }));
  for (const sigma of [-Number.MIN_VALUE, 50.00001, Infinity, NaN, null, true, '1']) rejects(add({ sigma }));
  for (const threshold of [-1, 256, .01, Infinity, NaN, null, false, '0']) rejects(add({ threshold }));
  for (const parameters of [null, [], { radius: 1 }, { amount: 100, preserveLuminosity: true }, { amount: 100, tint: false }, { shadows: [0, 0, 0] }, { black: 0, white: 255, gamma: 1, outputBlack: 0, outputWhite: 255 }]) rejects(add(parameters));
  for (const value of [-1, .01, 1]) rejects({ ...add(), value });
  rejects({ ...add(), mask: null });
  for (const kind of ['brightness', 'blur', 'sharpen', 'black_white', 'color_balance']) rejects({ ...add({ amount: 100 }), kind });
});

test('Unsharp parameter updates are sparse and leave all global adjustment contracts unchanged', () => {
  for (const parameters of [{}, { amount: 12.34 }, { sigma: Number.MIN_VALUE }, { threshold: 255 }, { amount: 100, sigma: 1, threshold: 0 }]) {
    const args = { ...base, filterId: 'filter', parameters };
    assert.deepEqual(validateCommand('update_layer_filter', args), args);
    if (Object.keys(parameters).length) assert.throws(() => validateCommand('update_adjustment', { ...base, parameters }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.throws(() => validateCommand('update_layer_filter', { ...base, filterId: 'filter', parameters: { amount: 100, reds: 40 } }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateCommand('add_adjustment', { documentId: base.documentId, kind: 'unsharp_mask', value: 0 }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(commandSchemas.add_adjustment.shape.kind.options.length, 28);
  assert.equal(commandSchemas.add_layer_filter.shape.kind.options.length, 32);
  for (const kind of ['blur', 'sharpen']) {
    assert.deepEqual(validateCommand('add_adjustment', { documentId: base.documentId, kind, value: .001 }), { documentId: base.documentId, kind, value: .001 });
    assert.throws(() => validateCommand('add_adjustment', { documentId: base.documentId, kind, value: 1, parameters: { amount: 100 } }), { code: 'INVALID_ARGUMENTS' });
  }
});

test('Unsharp Mask participates only in raster recipe slots and native transactions', () => {
  const recipe = { name: 'Source detail', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'unsharp_mask', value: 0, parameters: { amount: 133.33, sigma: .3977, threshold: 10 }, opacity: .625 } }] };
  assert.deepEqual(validateEditRecipeDefinition(recipe), recipe);
  for (const type of ['text', 'content', 'adjustment']) {
    assert.throws(() => validateEditRecipeDefinition({ ...recipe, slots: [{ key: 'photo', type, ...(type === 'adjustment' ? { kind: 'sharpen' } : {}) }] }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const kind of ['sharpen', 'unsharp_mask']) assert.throws(() => validateEditRecipeDefinition({ ...recipe, slots: [{ key: 'photo', type: 'adjustment', kind }], steps: [{ command: 'update_adjustment', target: 'photo', args: { value: 0, parameters: { amount: 100 } } }] }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateEditRecipeDefinition({ ...recipe, steps: [{ ...recipe.steps[0], args: { ...recipe.steps[0].args, parameters: { amount: .001 } } }] }), { code: 'INVALID_ARGUMENTS' });
  const transaction = validateCommand('apply_transaction', { documentId: base.documentId, label: recipe.name, operations: [{ command: 'add_layer_filter', args: { layerId: base.layerId, ...recipe.steps[0].args } }] });
});

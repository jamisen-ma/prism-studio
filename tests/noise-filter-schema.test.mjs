import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, validateCommand, validateBackendOptions, validateEditRecipeDefinition } from '../shared/commands.mjs';

const base = { documentId: 'document', layerId: 'photo', expectedRevision: 2 };
const add = parameters => ({ ...base, kind: 'add_noise', value: 0, ...(parameters === undefined ? {} : { parameters }) });
const rejects = args => assert.throws(() => validateCommand('add_layer_filter', args), { code: 'INVALID_ARGUMENTS' });

test('Add Noise source controls retain exact amount, false and uint32 seed endpoints without coercion', () => {
  for (const parameters of [undefined, {}, { amount: 0 }, { amount: 13.37 }, { amount: 400, distribution: 'gaussian', monochromatic: false, seed: 4294967295 }, { seed: 0 }, { seed: 2147483648 }, { amount: 5, distribution: 'uniform', monochromatic: true, seed: 1 }]) {
    const args = add(parameters); assert.deepEqual(validateCommand('add_layer_filter', args), args);
  }
  for (const amount of [-.01, 400.01, .001, Number.MIN_VALUE, Infinity, NaN, null, true, '5']) rejects(add({ amount }));
  for (const seed of [-1, 4294967296, .01, Infinity, NaN, null, true, '0']) rejects(add({ seed }));
  for (const distribution of ['normal', 'Uniform', '', null, 0]) rejects(add({ distribution }));
  for (const monochromatic of [0, 1, null, 'false']) rejects(add({ monochromatic }));
  for (const parameters of [null, [], { sigma: 1 }, { amount: 5, threshold: 0 }, { seed: 1, tint: false }, { amount: 5, random: true }]) rejects(add(parameters));
  for (const value of [-1, .01, 1]) rejects({ ...add(), value });
  rejects({ ...add(), mask: null });
  for (const kind of ['brightness', 'blur', 'sharpen', 'black_white', 'color_balance', 'unsharp_mask']) rejects({ ...add({ seed: 1 }), kind });
});

test('Noise updates stay sparse and do not extend global adjustment families', () => {
  for (const parameters of [{}, { amount: 12.34 }, { seed: 0 }, { seed: 4294967295, monochromatic: false }, { distribution: 'gaussian' }]) {
    const args = { ...base, filterId: 'filter', parameters }; assert.deepEqual(validateCommand('update_layer_filter', args), args);
    if (Object.keys(parameters).length) assert.throws(() => validateCommand('update_adjustment', { ...base, parameters }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.throws(() => validateCommand('update_layer_filter', { ...base, filterId: 'filter', parameters: { seed: 1, sigma: 1 } }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateCommand('add_adjustment', { documentId: base.documentId, kind: 'add_noise', value: 0 }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(commandSchemas.add_adjustment.shape.kind.options.length, 28);
  assert.equal(commandSchemas.add_layer_filter.shape.kind.options.length, 32);
  for (const kind of ['sharpen', 'brightness']) assert.throws(() => validateCommand('add_adjustment', { documentId: base.documentId, kind, value: 1, parameters: { seed: 0 } }), { code: 'INVALID_ARGUMENTS' });
});

test('Seeded noise recipes preserve explicit settings only in raster slots and native transactions', () => {
  const recipe = { name: 'Repeatable grain', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'add_noise', value: 0, parameters: { amount: 13.37, distribution: 'gaussian', monochromatic: false, seed: 0 }, opacity: .625 } }] };
  assert.deepEqual(validateEditRecipeDefinition(recipe), recipe);
  for (const type of ['text', 'content', 'adjustment']) assert.throws(() => validateEditRecipeDefinition({ ...recipe, slots: [{ key: 'photo', type, ...(type === 'adjustment' ? { kind: 'sharpen' } : {}) }] }), { code: 'INVALID_ARGUMENTS' });
  for (const kind of ['brightness', 'add_noise']) assert.throws(() => validateEditRecipeDefinition({ ...recipe, slots: [{ key: 'photo', type: 'adjustment', kind }], steps: [{ command: 'update_adjustment', target: 'photo', args: { value: 0, parameters: { seed: 1 } } }] }), { code: 'INVALID_ARGUMENTS' });
  for (const parameters of [{ amount: .001 }, { seed: 4294967296 }, { distribution: 'gaussian', threshold: 0 }]) assert.throws(() => validateEditRecipeDefinition({ ...recipe, steps: [{ ...recipe.steps[0], args: { ...recipe.steps[0].args, parameters } }] }), { code: 'INVALID_ARGUMENTS' });
  const transaction = validateCommand('apply_transaction', { documentId: base.documentId, label: recipe.name, operations: [{ command: 'add_layer_filter', args: { layerId: base.layerId, ...recipe.steps[0].args } }] });
  assert.doesNotThrow(() => validateBackendOptions('native', 'apply_transaction', transaction));
  assert.throws(() => validateBackendOptions('photoshop', 'apply_transaction', transaction), { code: 'UNSUPPORTED_COMMAND' });
});

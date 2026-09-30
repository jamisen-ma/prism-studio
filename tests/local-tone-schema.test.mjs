import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, validateCommand, validateBackendOptions, validateEditRecipeDefinition } from '../shared/commands.mjs';

const base = { documentId: 'document', layerId: 'photo', expectedRevision: 2 };
const add = parameters => ({ ...base, kind: 'shadows_highlights', value: 0, ...(parameters === undefined ? {} : { parameters }) });
const rejects = args => assert.throws(() => validateCommand('add_layer_filter', args), { code: 'INVALID_ARGUMENTS' });

test('Local Shadows/Highlights keeps exact source parameters, centipercent widths and zero/subnormal sigma', () => {
  for (const parameters of [undefined, {}, { shadows: 0, highlights: 0 }, { shadows: 12.34 }, { highlights: 100, shadowWidth: 1, highlightWidth: 100, sigma: 50 }, { sigma: Number.MIN_VALUE }, { sigma: .528474, shadowWidth: 33.33 }, { shadows: 25, highlights: 0, shadowWidth: 50, highlightWidth: 50, sigma: 3 }]) {
    const args = add(parameters); assert.deepEqual(validateCommand('add_layer_filter', args), args);
  }
  for (const field of ['shadows', 'highlights']) for (const number of [-.01, 100.01, .001, Number.MIN_VALUE, Infinity, NaN, null, true, '25']) rejects(add({ [field]: number }));
  for (const field of ['shadowWidth', 'highlightWidth']) for (const number of [0, .99, 100.01, 1.001, 1.0000000000000002, Infinity, NaN, null, false, '50']) rejects(add({ [field]: number }));
  for (const sigma of [-Number.MIN_VALUE, 50.00001, Infinity, NaN, null, true, '3']) rejects(add({ sigma }));
  for (const parameters of [null, [], { radius: 3 }, { shadows: [0, 0, 0] }, { shadows: 25, preserveLuminosity: true }, { shadows: 25, amount: 5 }, { sigma: 3, threshold: 0 }, { highlights: 0, seed: 1 }]) rejects(add(parameters));
  for (const value of [-1, .01, 1]) rejects({ ...add(), value });
  rejects({ ...add(), mask: null });
  for (const kind of ['shadows', 'highlights', 'brightness', 'blur', 'sharpen', 'black_white', 'color_balance', 'unsharp_mask', 'add_noise', 'high_pass']) rejects({ ...add({ shadowWidth: 50 }), kind });
});

test('Local tone updates stay sparse without broadening global pointwise or parameter contracts', () => {
  for (const parameters of [{}, { shadows: 0 }, { highlights: 99.99 }, { sigma: Number.MIN_VALUE }, { shadowWidth: 1, highlightWidth: 100 }]) {
    const args = { ...base, filterId: 'filter', parameters }; assert.deepEqual(validateCommand('update_layer_filter', args), args);
    if (Object.keys(parameters).length) assert.throws(() => validateCommand('update_adjustment', { ...base, parameters }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.throws(() => validateCommand('update_layer_filter', { ...base, filterId: 'filter', parameters: { shadowWidth: 50, amount: 100 } }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateCommand('add_adjustment', { documentId: base.documentId, kind: 'shadows_highlights', value: 0 }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(commandSchemas.add_layer_filter.shape.kind.options.length, 32);
  assert.equal(commandSchemas.add_adjustment.shape.kind.options.length, 28);
  for (const kind of ['shadows', 'highlights']) {
    const args = { documentId: base.documentId, kind, value: -12.345 };
    assert.deepEqual(validateCommand('add_adjustment', args), args);
    assert.throws(() => validateCommand('add_adjustment', { ...args, parameters: { shadows: 25 } }), { code: 'INVALID_ARGUMENTS' });
  }
});

test('Local tone recipes are source-only and preserve authored settings through native transaction validation', () => {
  const recipe = { name: 'Local contrast repair', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'shadows_highlights', value: 0, parameters: { shadows: 12.34, highlights: 34.56, shadowWidth: 78.9, highlightWidth: 23.45, sigma: Number.MIN_VALUE }, opacity: .625, blendMode: 'multiply' } }] };
  assert.deepEqual(validateEditRecipeDefinition(recipe), recipe);
  for (const type of ['text', 'content', 'adjustment']) assert.throws(() => validateEditRecipeDefinition({ ...recipe, slots: [{ key: 'photo', type, ...(type === 'adjustment' ? { kind: 'shadows' } : {}) }] }), { code: 'INVALID_ARGUMENTS' });
  for (const kind of ['shadows', 'highlights', 'shadows_highlights']) assert.throws(() => validateEditRecipeDefinition({ ...recipe, slots: [{ key: 'photo', type: 'adjustment', kind }], steps: [{ command: 'update_adjustment', target: 'photo', args: { value: 0, parameters: { shadowWidth: 50 } } }] }), { code: 'INVALID_ARGUMENTS' });
  for (const parameters of [{ shadowWidth: 0 }, { highlights: .001 }, { shadows: 25, tint: false }]) assert.throws(() => validateEditRecipeDefinition({ ...recipe, steps: [{ ...recipe.steps[0], args: { ...recipe.steps[0].args, parameters } }] }), { code: 'INVALID_ARGUMENTS' });
  const transaction = validateCommand('apply_transaction', { documentId: base.documentId, label: recipe.name, operations: [{ command: 'add_layer_filter', args: { layerId: base.layerId, ...recipe.steps[0].args } }] });
  assert.doesNotThrow(() => validateBackendOptions('native', 'apply_transaction', transaction));
  assert.throws(() => validateBackendOptions('photoshop', 'apply_transaction', transaction), { code: 'UNSUPPORTED_COMMAND' });
});

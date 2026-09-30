import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, validateCommand, validateBackendOptions, validateEditRecipeDefinition } from '../shared/commands.mjs';

const base = { documentId: 'document', layerId: 'photo', expectedRevision: 2 };
const add = value => ({ ...base, kind: 'high_pass', value });
const rejects = args => assert.throws(() => validateCommand('add_layer_filter', args), { code: 'INVALID_ARGUMENTS' });

test('High Pass accepts true source sigma including zero and subnormal values without parameters', () => {
  for (const value of [0, Number.MIN_VALUE, .00001, .3977, 1, 12.3456789, 50]) {
    for (const settings of [{}, { enabled: false }, { opacity: 0 }, { blendMode: 'overlay', opacity: .375 }]) {
      const args = { ...add(value), ...settings }; assert.deepEqual(validateCommand('add_layer_filter', args), args);
    }
  }
  for (const value of [-Number.MIN_VALUE, -.001, 50.0001, Infinity, NaN, null, true, '1']) rejects(add(value));
  for (const parameters of [{}, { sigma: 1 }, { amount: 0 }, { threshold: 0 }, [], null]) {
    for (const settings of [{}, { enabled: false }, { opacity: 0 }]) rejects({ ...add(1), ...settings, parameters });
  }
  rejects({ ...add(1), preserveLuminosity: true });
});

test('High Pass remains source-only and updates do not inject kind, defaults or parameters', () => {
  assert.equal(commandSchemas.add_layer_filter.shape.kind.options.length, 32);
  assert.equal(commandSchemas.add_adjustment.shape.kind.options.length, 28);
  assert.ok(!commandSchemas.add_adjustment.shape.kind.options.includes('high_pass'));
  for (const value of [0, 1, 50]) assert.throws(() => validateCommand('add_adjustment', { documentId: base.documentId, kind: 'high_pass', value }), { code: 'INVALID_ARGUMENTS' });
  for (const settings of [{ value: Number.MIN_VALUE }, { value: 0 }, { value: 50 }, { opacity: .375 }, { blendMode: 'overlay' }, { enabled: false }]) {
    const args = { ...base, filterId: 'filter', ...settings }; assert.deepEqual(validateCommand('update_layer_filter', args), args);
  }
  assert.throws(() => validateCommand('update_layer_filter', { ...base, filterId: 'filter', kind: 'high_pass', value: 1 }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateCommand('update_layer_filter', { ...base, filterId: 'filter' }), { code: 'INVALID_ARGUMENTS' });
});

test('High Pass recipes require raster targets and preserve exact scalar values and explicit blending', () => {
  const recipe = { name: 'Gray-centered detail', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'high_pass', value: .3977, blendMode: 'overlay', opacity: .625 } }] };
  assert.deepEqual(validateEditRecipeDefinition(recipe), recipe);
  for (const value of [0, Number.MIN_VALUE, 50]) {
    const exact = { ...recipe, steps: [{ ...recipe.steps[0], args: { ...recipe.steps[0].args, value, enabled: false } }] };
    assert.deepEqual(validateEditRecipeDefinition(exact), exact);
  }
  for (const type of ['text', 'content', 'adjustment']) assert.throws(() => validateEditRecipeDefinition({ ...recipe, slots: [{ key: 'photo', type, ...(type === 'adjustment' ? { kind: 'sharpen' } : {}) }] }), { code: 'INVALID_ARGUMENTS' });
  for (const settings of [{ value: 51 }, { parameters: {} }, { parameters: { sigma: 1 } }, { blendMode: 'dissolve' }]) assert.throws(() => validateEditRecipeDefinition({ ...recipe, steps: [{ ...recipe.steps[0], args: { ...recipe.steps[0].args, ...settings } }] }), { code: 'INVALID_ARGUMENTS' });
  const transaction = validateCommand('apply_transaction', { documentId: base.documentId, label: recipe.name, operations: [{ command: 'add_layer_filter', args: { layerId: base.layerId, ...recipe.steps[0].args } }] });
  assert.doesNotThrow(() => validateBackendOptions('native', 'apply_transaction', transaction));
  assert.throws(() => validateBackendOptions('photoshop', 'apply_transaction', transaction), { code: 'UNSUPPORTED_COMMAND' });
});

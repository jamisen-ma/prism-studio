import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, validateBackendOptions, validateEditRecipeDefinition } from '../shared/commands.mjs';

const base = { documentId: 'document', layerId: 'photo', expectedRevision: 2 };

test('source Gaussian and RGB sharpen accept authored bounded finite sigma without added parameters or coercion', () => {
  for (const [kind, maximum] of [['blur', 50], ['sharpen', 10]]) {
    for (const value of [0, Number.MIN_VALUE, .001, .15, .3, 1, 2.37, maximum]) {
      const args = { ...base, kind, value, opacity: .375, enabled: false };
      assert.deepEqual(validateCommand('add_layer_filter', args), args);
    }
    for (const value of [-Number.MIN_VALUE, maximum + .001, NaN, Infinity, -Infinity, null, true, '1']) assert.throws(() => validateCommand('add_layer_filter', { ...base, kind, value }), { code: 'INVALID_ARGUMENTS' });
    for (const parameters of [{}, { amount: 1 }, { threshold: 0 }, { sigma: 1 }, { precision: 'float' }, { preserveAlpha: false }, { black: 0, white: 255, gamma: 1, outputBlack: 0, outputWhite: 255 }]) assert.throws(() => validateCommand('add_layer_filter', { ...base, kind, value: 1, parameters }), { code: 'INVALID_ARGUMENTS' });
    for (const fields of [{ radius: 1 }, { mask: null }, { generate: true }]) assert.throws(() => validateCommand('add_layer_filter', { ...base, kind, value: 1, ...fields }), { code: 'INVALID_ARGUMENTS' });
  }
});

test('spatial source steps participate in typed recipes and transactions without changing global adjustment contracts', () => {
  const recipe = { name: 'Source detail treatment', slots: [{ key: 'photo', type: 'raster' }], steps: [
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'blur', value: .15 } },
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'sharpen', value: 2.37, enabled: false, opacity: .5 } },
  ] };
  assert.deepEqual(validateEditRecipeDefinition(recipe), recipe);
  for (const step of recipe.steps) {
    const transaction = validateCommand('apply_transaction', { documentId: base.documentId, label: recipe.name, operations: [{ command: step.command, args: { layerId: base.layerId, ...step.args } }] });
    assert.doesNotThrow(() => validateBackendOptions('native', 'apply_transaction', transaction));
    assert.throws(() => validateBackendOptions('photoshop', 'apply_transaction', transaction), { code: 'UNSUPPORTED_COMMAND' });
    assert.throws(() => validateEditRecipeDefinition({ ...recipe, slots: [{ key: 'photo', type: 'text' }] }), { code: 'INVALID_ARGUMENTS' });
    const globalArgs = { documentId: base.documentId, kind: step.args.kind, value: step.args.value };
    assert.deepEqual(validateCommand('add_adjustment', globalArgs), globalArgs);
  }
  for (const [kind, value] of [['blur', 50.01], ['sharpen', 10.01]]) assert.throws(() => validateEditRecipeDefinition({ ...recipe, steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind, value } }] }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateEditRecipeDefinition({ ...recipe, steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'sharpen', value: 1, parameters: { threshold: 0 } } }] }), { code: 'INVALID_ARGUMENTS' });
});

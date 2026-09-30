import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, validateCommand, validateBackendOptions, validateEditRecipeDefinition } from '../shared/commands.mjs';

const modes = ['normal','darken','multiply','color_burn','linear_burn','darker_color','lighten','screen','color_dodge','linear_dodge','lighter_color','overlay','soft_light','hard_light','vivid_light','linear_light','pin_light','hard_mix','difference','exclusion','subtract','divide','hue','saturation','color','luminosity'];
const base = { documentId: 'document', layerId: 'photo', expectedRevision: 2 };
const add = blendMode => ({ ...base, kind: 'blur', value: 0, ...(blendMode === undefined ? {} : { blendMode }) });
const update = blendMode => ({ ...base, filterId: 'filter', blendMode });

test('source filter schemas accept the exact independent blend set and mode-only updates', () => {
  for (const mode of modes) {
    assert.deepEqual(validateCommand('add_layer_filter', add(mode)), add(mode));
    assert.deepEqual(validateCommand('update_layer_filter', update(mode)), update(mode));
  }
  assert.deepEqual(validateCommand('add_layer_filter', add()), add());
  assert.ok(!Object.hasOwn(validateCommand('update_layer_filter', { ...base, filterId: 'filter', opacity: .5 }), 'blendMode'));
  for (const blendMode of ['dissolve', 'Normal', '', 'future_mode', null, 1, false, [], {}]) {
    assert.throws(() => validateCommand('add_layer_filter', add(blendMode)), { code: 'INVALID_ARGUMENTS' });
    assert.throws(() => validateCommand('update_layer_filter', update(blendMode)), { code: 'INVALID_ARGUMENTS' });
  }
  assert.throws(() => validateCommand('update_layer_filter', { ...base, filterId: 'filter' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateCommand('add_layer_filter', { ...add('multiply'), parameters: { blendMode: 'screen' } }), { code: 'INVALID_ARGUMENTS' });
  assert.deepEqual(commandSchemas.add_layer_filter.shape.blendMode.unwrap().options, modes);
});

test('per-filter blending does not widen global adjustments or narrow whole-layer blending', () => {
  assert.equal(commandSchemas.add_layer_filter.shape.kind.options.length, 32);
  assert.equal(commandSchemas.add_adjustment.shape.kind.options.length, 28);
  for (const blendMode of modes) {
    assert.throws(() => validateCommand('add_adjustment', { documentId: base.documentId, kind: 'brightness', value: 1, blendMode }), { code: 'INVALID_ARGUMENTS' });
    assert.throws(() => validateCommand('update_adjustment', { ...base, value: 1, blendMode }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(validateCommand('set_layer', { ...base, blendMode: 'dissolve' }).blendMode, 'dissolve');
  assert.equal(validateCommand('set_group_compositing', { ...base, mode: 'isolated', blendMode: 'dissolve' }).blendMode, 'dissolve');
});

test('filter blend recipe fields stay source-only, explicit and native-transactional', () => {
  for (const blendMode of modes) {
    const recipe = { name: 'Blended effect', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'add_noise', value: 0, parameters: { amount: 0, seed: 0 }, enabled: false, opacity: 0, blendMode } }] };
    assert.deepEqual(validateEditRecipeDefinition(recipe), recipe);
    for (const type of ['text', 'content', 'adjustment']) assert.throws(() => validateEditRecipeDefinition({ ...recipe, slots: [{ key: 'photo', type, ...(type === 'adjustment' ? { kind: 'brightness' } : {}) }] }), { code: 'INVALID_ARGUMENTS' });
    const transaction = validateCommand('apply_transaction', { documentId: base.documentId, label: recipe.name, operations: [{ command: 'add_layer_filter', args: { layerId: base.layerId, ...recipe.steps[0].args } }, { command: 'update_layer_filter', args: { layerId: base.layerId, filterId: 'filter', blendMode } }] });
    assert.doesNotThrow(() => validateBackendOptions('native', 'apply_transaction', transaction));
    assert.throws(() => validateBackendOptions('photoshop', 'apply_transaction', transaction), { code: 'UNSUPPORTED_COMMAND' });
  }
  assert.throws(() => validateEditRecipeDefinition({ name: 'Wrong scope', slots: [{ key: 'tone', type: 'adjustment', kind: 'brightness' }], steps: [{ command: 'update_adjustment', target: 'tone', args: { value: 1, blendMode: 'multiply' } }] }), { code: 'INVALID_ARGUMENTS' });
});

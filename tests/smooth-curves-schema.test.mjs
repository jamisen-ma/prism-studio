import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, validateBackendOptions, validateEditRecipeDefinition } from '../shared/commands.mjs';

const points = [{ x: 0, y: 255 }, { x: Number.MIN_VALUE, y: 0 }, { x: 0.1, y: 64.5 }, { x: 0.10000000000000002, y: 64 }, { x: 255, y: 0.49999999999999994 }];
const base = { documentId: 'doc', layerId: 'layer' };
const invalid = { code: 'INVALID_ARGUMENTS' };

test('Curves permits explicit modes and sparse defaults without restricting existing finite point precision', () => {
  for (const command of ['add_adjustment', 'add_layer_filter']) {
    const target = command === 'add_adjustment' ? { documentId: 'doc' } : base;
    for (const parameters of [undefined, {}, { channel: 'green' }, { interpolation: 'linear' }, { interpolation: 'smooth' }, { points }, { points, channel: 'blue', interpolation: 'smooth' }]) {
      const input = { ...target, kind: 'curves', value: 0, ...(parameters === undefined ? {} : { parameters }) };
      const result = validateCommand(command, input);
      assert.deepEqual(result.parameters, parameters);
      if (parameters?.points) assert.notEqual(result.parameters.points, points);
    }
    for (const value of [-1, 0.01, 1]) assert.throws(() => validateCommand(command, { ...target, kind: 'curves', value, parameters: { interpolation: 'smooth' } }), invalid);
    for (const kind of ['levels', 'gradient_map', 'color_balance', 'brightness']) assert.throws(() => validateCommand(command, { ...target, kind, value: 0, parameters: { interpolation: 'smooth' } }), invalid);
  }
});

test('Curves interpolation rejects coercion, foreign fields and invalid complete point replacements', () => {
  const call = parameters => validateCommand('add_adjustment', { documentId: 'doc', kind: 'curves', value: 0, parameters });
  for (const interpolation of [null, true, 0, 'Smooth', 'cubic', 'pchip', '', {}, []]) assert.throws(() => call({ interpolation }), invalid);
  for (const parameters of [null, { interpolation: 'smooth', gamma: 1 }, { interpolation: 'smooth', unknown: 1 }, { channel: null }, { channel: 'alpha' }]) assert.throws(() => call(parameters), invalid);
  for (const bad of [[], [points[0]], [points[0], points[1]], [points[0], { x: 0, y: 20 }, points.at(-1)], [points[0], { x: NaN, y: 1 }, points.at(-1)], [points[0], { x: 1, y: Infinity }, points.at(-1)], [points[0], { x: 1, y: -0.001 }, points.at(-1)], [points[0], { x: 1, y: 20, tangent: 0 }, points.at(-1)], Array.from({ length: 17 }, (_, i) => ({ x: i * 255 / 16, y: i }))]) assert.throws(() => call({ interpolation: 'smooth', points: bad }), invalid);
});

test('Curves updates retain sparse detached fields and explicit interpolation stays native-only in transactions', () => {
  for (const command of ['update_adjustment', 'update_layer_filter']) {
    const target = { ...base, ...(command === 'update_layer_filter' ? { filterId: 'filter' } : {}) };
    for (const parameters of [{}, { interpolation: 'linear' }, { interpolation: 'smooth' }, { channel: 'red' }, { points }]) {
      const result = validateCommand(command, { ...target, parameters });
      assert.deepEqual(result.parameters, parameters); assert.equal(result.value, undefined);
      if (parameters.points) assert.notEqual(result.parameters.points, points);
    }
    for (const interpolation of ['linear', 'smooth']) {
      const args = { layerId: 'layer', ...(command === 'update_layer_filter' ? { filterId: 'filter' } : {}), parameters: { interpolation } };
      assert.doesNotThrow(() => validateBackendOptions('native', command, args));
      assert.throws(() => validateBackendOptions('photoshop', command, args), { code: 'UNSUPPORTED_COMMAND' });
      const transaction = validateCommand('apply_transaction', { documentId: 'doc', label: 'Curve mode', operations: [{ command, args }] });
      assert.throws(() => validateBackendOptions('photoshop', 'apply_transaction', transaction), { code: 'UNSUPPORTED_COMMAND' });
    }
  }
});

test('typed curve recipes preserve interpolation for both source and adjustment slots without crossing parameter families', () => {
  for (const interpolation of ['linear', 'smooth']) {
    const recipe = { name: 'Curves look', slots: [{ key: 'photo', type: 'raster' }, { key: 'grade', type: 'adjustment', kind: 'curves' }], steps: [
      { command: 'add_layer_filter', target: 'photo', args: { kind: 'curves', value: 0, parameters: { points, interpolation } } },
      { command: 'update_adjustment', target: 'grade', args: { value: 0, parameters: { interpolation } } },
    ] };
    assert.deepEqual(validateEditRecipeDefinition(recipe), recipe);
    const wrong = structuredClone(recipe); wrong.slots[1].kind = 'levels'; assert.throws(() => validateEditRecipeDefinition(wrong), invalid);
    const extra = structuredClone(recipe); extra.steps[1].args.parameters.mode = interpolation; assert.throws(() => validateEditRecipeDefinition(extra), invalid);
  }
});

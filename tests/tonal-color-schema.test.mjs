import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, validateEditRecipeDefinition } from '../shared/commands.mjs';

const base = { documentId: 'document', layerId: 'layer' };
const controls = { color_balance: { shadows: [-100, 0.01, 100], preserveLuminosity: false }, black_white: { reds: -200, magentas: 300, tint: false, tintColor: '#AABbCC', tintAmount: 17.25 } };

test('tonal kinds use value zero and accept only their own typed parameter family', () => {
  for (const command of ['add_adjustment', 'add_layer_filter']) {
    const identity = command === 'add_adjustment' ? { documentId: base.documentId } : base;
    for (const kind of ['color_balance', 'black_white']) {
      for (const parameters of [undefined, {}, controls[kind]]) assert.doesNotThrow(() => validateCommand(command, { ...identity, kind, value: 0, ...(parameters ? { parameters } : {}) }));
      for (const value of [-1, 0.01, 1]) assert.throws(() => validateCommand(command, { ...identity, kind, value }), { code: 'INVALID_ARGUMENTS' });
      const other = controls[kind === 'color_balance' ? 'black_white' : 'color_balance'];
      assert.throws(() => validateCommand(command, { ...identity, kind, value: 0, parameters: other }), { code: 'INVALID_ARGUMENTS' });
    }
    for (const parameters of Object.values(controls)) assert.throws(() => validateCommand(command, { ...identity, kind: 'brightness', value: 0, parameters }), { code: 'INVALID_ARGUMENTS' });
  }
});

test('balance rows and monochrome controls require exact finite centipercent values without coercion', () => {
  const create = (kind, parameters) => validateCommand('add_adjustment', { documentId: base.documentId, kind, value: 0, parameters });
  for (const parameters of [
    { shadows: [0, 0] }, { shadows: [0, 0, 0, 0] }, { shadows: [0, , 0] },
    ...[-100.01, 100.01, 0.001, Infinity, NaN, null, '0'].map(value => ({ highlights: [0, value, 0] })),
    { midtones: null }, { preserveLuminosity: 1 }, { preserveLuminosity: null }, { shadows: [0, 0, 0], tint: true },
  ]) assert.throws(() => create('color_balance', parameters), { code: 'INVALID_ARGUMENTS' });
  for (const key of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']) {
    for (const value of [-200, -0.01, 0, 17.25, 300]) assert.equal(create('black_white', { [key]: value }).parameters[key], value);
    for (const value of [-200.01, 300.01, 0.001, Infinity, NaN, null, '0']) assert.throws(() => create('black_white', { [key]: value }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const parameters of [{ tint: 'false' }, { tintColor: '#fff' }, { tintColor: null }, { tintAmount: -0.01 }, { tintAmount: 100.01 }, { tintAmount: 0.001 }, { tintAmount: NaN }, { tintAmount: null }, { tint: true, preserveLuminosity: true }, { unknown: 1 }, null]) assert.throws(() => create('black_white', parameters), { code: 'INVALID_ARGUMENTS' });
});

test('tonal partial updates remain sparse and detached until native kind-aware canonicalization', () => {
  for (const command of ['update_adjustment', 'update_layer_filter']) {
    const identity = { ...base, ...(command === 'update_layer_filter' ? { filterId: 'filter' } : {}) };
    for (const parameters of [{}, { midtones: [12.5, -3, 0] }, { preserveLuminosity: true }, { tint: false }, { tintColor: '#123ABC', tintAmount: 0 }, { blues: 0 }]) {
      const expected = structuredClone(parameters), parsed = validateCommand(command, { ...identity, parameters });
      if (parameters.midtones) parameters.midtones[0] = 99;
      assert.deepEqual(parsed.parameters, expected); assert.equal(parsed.value, undefined);
    }
    assert.throws(() => validateCommand(command, { ...identity, parameters: { midtones: [1, 2, 3], reds: 40 } }), { code: 'INVALID_ARGUMENTS' });
  }
});

test('new tonal kinds pass typed recipe checks and stay native-only in ordinary transactions', () => {
  for (const kind of ['color_balance', 'black_white']) {
    const args = { kind, value: 0, parameters: controls[kind] };
    const transaction = validateCommand('apply_transaction', { documentId: base.documentId, label: 'Tonal grade', operations: [{ command: 'add_adjustment', args }] });
    const recipe = { name: 'Tonal treatment', slots: [{ key: 'photo', type: 'raster' }, { key: 'grade', type: 'adjustment', kind }], steps: [
      { command: 'add_layer_filter', target: 'photo', args },
      { command: 'update_adjustment', target: 'grade', args: { value: 0, parameters: controls[kind] } },
    ] };
    assert.deepEqual(validateEditRecipeDefinition(recipe), recipe);
    recipe.steps[1].args.parameters = controls[kind === 'color_balance' ? 'black_white' : 'color_balance'];
    assert.throws(() => validateEditRecipeDefinition(recipe), { code: 'INVALID_ARGUMENTS' });
  }
});

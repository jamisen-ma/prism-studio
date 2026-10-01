import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, validateCommand, validateEditRecipeDefinition } from '../shared/commands.mjs';

const ranges = ['reds','yellows','greens','cyans','blues','magentas','whites','neutrals','blacks'];
const base = { documentId: 'doc', layerId: 'layer' }, invalid = { code: 'INVALID_ARGUMENTS' };

test('Selective Color discovery and both create contexts accept only value0 and their own exact typed family', () => {
  assert.equal(commandSchemas.add_adjustment.shape.kind.options.length, 28);
  assert.equal(commandSchemas.add_layer_filter.shape.kind.options.length, 32);
  for (const command of ['add_adjustment','add_layer_filter']) {
    const identity = command === 'add_adjustment' ? { documentId: 'doc' } : base;
    for (const parameters of [undefined, {}, { method: 'relative' }, { method: 'absolute' }, ...ranges.map(range => ({ [range]: [-100,-.01,17.25,100] }))]) {
      const args = { ...identity, kind: 'selective_color', value: 0, ...(parameters === undefined ? {} : { parameters }) };
      assert.deepEqual(validateCommand(command, args), args);
    }
    for (const value of [-1,.01,1]) assert.throws(() => validateCommand(command, { ...identity, kind: 'selective_color', value }), invalid);
    for (const parameters of [{ interpolation: 'smooth' }, { reds: 40 }, { shadows: [1,2,3] }, { monochrome: true }, { sigma: 1 }, { amount: 10 }]) assert.throws(() => validateCommand(command, { ...identity, kind: 'selective_color', value: 0, parameters }), invalid);
    for (const kind of ['brightness','black_white','color_balance','channel_mixer','curves']) assert.throws(() => validateCommand(command, { ...identity, kind, value: 0, parameters: { method: 'absolute', reds: [1,2,3,4] } }), invalid);
  }
});

test('Selective Color rejects coercion, partial rows, holes, foreign fields and precision beyond exact centipercent', () => {
  const call = parameters => validateCommand('add_adjustment', { documentId: 'doc', kind: 'selective_color', value: 0, parameters });
  for (const range of ranges) {
    for (const row of [null, [], [0,0,0], [0,0,0,0,0], [0,,0,0], ...[-100.01,100.01,.001,Number.MIN_VALUE,NaN,Infinity,null,'0',true].map(n => [0,n,0,0])]) assert.throws(() => call({ [range]: row }), invalid);
  }
  for (const method of [null, true, 0, '', 'Relative', 'CMYK', [], {}]) assert.throws(() => call({ method }), invalid);
  for (const parameters of [null, { method: 'absolute', preserveLuminosity: true }, { reds: [0,0,0,0], tint: false }, { reds: [0,0,0,0], unknown: 1 }]) assert.throws(() => call(parameters), invalid);
});

test('Selective partial updates stay sparse and detached and semantic fields survive transactions', () => {
  for (const command of ['update_adjustment','update_layer_filter']) {
    const identity = { ...base, ...(command === 'update_layer_filter' ? { filterId: 'filter' } : {}) };
    for (const parameters of [{}, { method: 'relative' }, ...ranges.map(range => ({ [range]: [.01,12.5,-100,100] }))]) {
      const expected = structuredClone(parameters), parsed = validateCommand(command, { ...identity, parameters });
      for (const range of ranges) if (parameters[range]) parameters[range][0] = 99;
      assert.deepEqual(parsed.parameters, expected); assert.equal(parsed.value, undefined);
      if (Object.keys(expected).length) {
        const args = { layerId: 'layer', ...(command === 'update_layer_filter' ? { filterId: 'filter' } : {}), parameters: expected };
        const transaction = validateCommand('apply_transaction', { documentId: 'doc', label: 'Selective', operations: [{ command, args }] });
        assert.deepEqual(transaction.operations[0].args.parameters, expected);
      }
    }
  }
});

test('typed Selective recipes preserve sparse fields while constraining source and adjustment slots to the correct family', () => {
  for (const parameters of [{}, { method: 'absolute', whites: [50,0,0,0] }, { neutrals: [-1.25,2.5,0,0] }]) {
    const recipe = { name: 'Selective recipe', slots: [{ key: 'photo', type: 'raster' }, { key: 'grade', type: 'adjustment', kind: 'selective_color' }], steps: [
      { command: 'add_layer_filter', target: 'photo', args: { kind: 'selective_color', value: 0, parameters } },
      { command: 'update_adjustment', target: 'grade', args: { value: 0, parameters } },
    ] };
    assert.deepEqual(validateEditRecipeDefinition(recipe), recipe);
    if (Object.keys(parameters).length) { const wrong = structuredClone(recipe); wrong.slots[1].kind = 'black_white'; assert.throws(() => validateEditRecipeDefinition(wrong), invalid); }
    const wrong = structuredClone(recipe); wrong.steps[0].args.value = 1; assert.throws(() => validateEditRecipeDefinition(wrong), invalid);
  }
});

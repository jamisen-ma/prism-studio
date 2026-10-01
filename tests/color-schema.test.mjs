import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand } from '../shared/commands.mjs';

const base = { documentId: 'doc', layerId: 'layer' };
const stops = [{ offset: 0, color: '#AAbb00' }, { offset: 0.12345, color: '#234567' }, { offset: 1, color: '#ffffff' }];

test('new parameterized kinds keep zero scalar values, strict families and complete bounded row/list patches', () => {
  for (const command of ['add_adjustment', 'add_layer_filter']) {
    const fields = command === 'add_adjustment' ? { documentId: base.documentId } : base;
    for (const kind of ['channel_mixer', 'gradient_map']) {
      assert.doesNotThrow(() => validateCommand(command, { ...fields, kind, value: 0 }));
      assert.doesNotThrow(() => validateCommand(command, { ...fields, kind, value: 0, parameters: {} }));
      for (const value of [-1, 0.01, 1]) assert.throws(() => validateCommand(command, { ...fields, kind, value }), { code: 'INVALID_ARGUMENTS' });
    }
    assert.deepEqual(validateCommand(command, { ...fields, kind: 'channel_mixer', value: 0, parameters: { red: [-200, 21.26, 71.52, 200] } }).parameters, { red: [-200, 21.26, 71.52, 200] });
    assert.deepEqual(validateCommand(command, { ...fields, kind: 'gradient_map', value: 0, parameters: { stops, reverse: true } }).parameters, { stops, reverse: true });
    for (const [kind, parameters] of [['channel_mixer', { stops }], ['gradient_map', { red: [100, 0, 0, 0] }], ['brightness', {}], ['levels', { red: [100, 0, 0, 0] }], ['curves', { reverse: true }]]) assert.throws(() => validateCommand(command, { ...fields, kind, value: 0, parameters }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const command of ['update_adjustment', 'update_layer_filter']) {
    const args = { ...base, ...(command === 'update_layer_filter' ? { filterId: 'filter' } : {}) };
    for (const parameters of [{}, { monochrome: true }, { gray: [21.26, 71.52, 7.22, 0] }, { reverse: false }, { stops }]) assert.deepEqual(validateCommand(command, { ...args, parameters }).parameters, parameters);
    for (const parameters of [{ red: [100, 0, 0] }, { red: [100, 0, 0, 0, 0] }, { gray: [0, 0, 0, 0.001] }, { blue: [201, 0, 0, 0] }, { green: [NaN, 0, 0, 0] }, { red: [Infinity, 0, 0, 0] }, { monochrome: 1 }, { gray: [0, 0, 0, 0], reverse: true }, { random: true }]) assert.throws(() => validateCommand(command, { ...args, parameters }), { code: 'INVALID_ARGUMENTS' });
  }
});

test('gradient-map stops reject opacity, unknown fields, bad endpoints and unordered tones without narrowing finite stop precision', () => {
  const fields = { documentId: 'doc', kind: 'gradient_map', value: 0 };
  const malformed = [[], [stops[0]], [{ offset: 0.01, color: '#000000' }, stops.at(-1)], [stops[0], { offset: 0.99, color: '#ffffff' }], [stops[0], stops[1], stops[1], stops.at(-1)], [stops[0], { ...stops.at(-1), opacity: 1 }], [stops[0], { ...stops.at(-1), color: '#fff' }], [stops[0], { ...stops.at(-1), offset: NaN }], Array.from({ length: 17 }, (_, i) => ({ offset: i / 16, color: '#000000' }))];
  for (const bad of malformed) assert.throws(() => validateCommand('add_adjustment', { ...fields, parameters: { stops: bad } }), { code: 'INVALID_ARGUMENTS' });
  const sixteen = Array.from({ length: 16 }, (_, i) => ({ offset: i / 15, color: '#123abc' }));
  assert.equal(validateCommand('add_adjustment', { ...fields, parameters: { stops: sixteen } }).parameters.stops.length, 16);
  const veryClose = [stops[0], { offset: 0.5, color: '#ff0000' }, { offset: 0.500000001, color: '#00ff00' }, stops.at(-1)];
  assert.deepEqual(validateCommand('add_adjustment', { ...fields, parameters: { stops: veryClose } }).parameters.stops, veryClose);
});

test('parameterless and parameterized new adjustments are accepted in nested transactions', () => {
  for (const kind of ['channel_mixer', 'gradient_map']) {
    for (const parameters of [undefined, {}]) {
      const args = { kind, value: 0, ...(parameters ? { parameters } : {}) };
      const transaction = validateCommand('apply_transaction', { documentId: 'doc', label: 'Native color', operations: [{ command: 'add_adjustment', args }] });
      assert.deepEqual(transaction.operations[0].args, args);
    }
  }
});

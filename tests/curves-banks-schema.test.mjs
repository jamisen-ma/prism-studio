import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, validateEditRecipeDefinition } from '../shared/commands.mjs';

const identity = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
const close = [{ x: 0, y: 255 }, { x: Number.MIN_VALUE, y: 0 }, { x: 0.1, y: 64.5 }, { x: 0.10000000000000002, y: 64 }, { x: 255, y: 0.49999999999999994 }];
const commands = ['add_adjustment', 'update_adjustment', 'add_layer_filter', 'update_layer_filter'];
const invalid = { code: 'INVALID_ARGUMENTS' };
const argumentsFor = (command, parameters) => ({ documentId: 'doc', ...(command === 'add_adjustment' ? {} : { layerId: 'layer' }), ...(command === 'update_layer_filter' ? { filterId: 'filter' } : {}), ...(command.startsWith('add_') ? { kind: 'curves', value: 0 } : {}), parameters });

test('banked Curves accepts explicit representations and sparse nested patches without rounding point coordinates', () => {
  const configurations = [{ mode: 'banks' }, { mode: 'banks', banks: {} }, { mode: 'banks', banks: { red: {} } }, { mode: 'banks', banks: { master: { points: close }, red: { interpolation: 'smooth' }, blue: { points: identity, interpolation: 'linear' } } }, { mode: 'single' }, { mode: 'single', channel: 'green', points: close, interpolation: 'smooth' }, {}];
  for (const command of commands) for (const parameters of configurations) {
    const result = validateCommand(command, argumentsFor(command, parameters));
    assert.deepEqual(result.parameters, parameters); assert.notEqual(result.parameters, parameters);
    if (parameters.banks) assert.notEqual(result.parameters.banks, parameters.banks);
    if (parameters.banks?.master?.points) assert.notEqual(result.parameters.banks.master.points, close);
  }
  for (const command of ['add_adjustment', 'add_layer_filter']) {
    for (const value of [-1, .01, 1]) assert.throws(() => validateCommand(command, { ...argumentsFor(command, { mode: 'banks' }), value }), invalid);
    for (const kind of ['levels', 'gradient_map', 'color_balance', 'brightness', 'hue_saturation']) assert.throws(() => validateCommand(command, { ...argumentsFor(command, { mode: 'banks' }), kind }), invalid);
  }
});

test('banked Curves rejects mixed representations, wrong bank fields and invalid hidden point lists before dispatch', () => {
  const malformed = [null, { mode: 'Banks' }, { mode: null }, { mode: true }, { banks: {} }, { mode: 'single', banks: {} }, { mode: 'banks', points: identity }, { mode: 'banks', channel: 'rgb' }, { mode: 'banks', interpolation: 'linear' }, { mode: 'banks', banks: null }, { mode: 'banks', banks: [] }, { mode: 'banks', banks: { rgb: {} } }, { mode: 'banks', banks: { alpha: {} } }, { mode: 'banks', banks: { master: { channel: 'red' } } }, { mode: 'banks', banks: { red: { interpolation: 'pchip' } } }, { mode: 'banks', banks: { red: null } }, { mode: 'banks', banks: { red: { tension: .5 } } }];
  const badLists = [[], [identity[0]], [{ x: 1, y: 0 }, identity[1]], [identity[0], { x: 255, y: Infinity }], [identity[0], { x: NaN, y: 1 }, identity[1]], [identity[0], { x: 0, y: 1 }, identity[1]], [identity[0], { x: 100, y: 1 }, { x: 99, y: 2 }, identity[1]], [identity[0], { x: 255, y: 255, tangent: 1 }], Array.from({ length: 17 }, (_, i) => ({ x: i * 255 / 16, y: i }))];
  for (const points of badLists) malformed.push({ mode: 'banks', banks: { master: { points: identity }, blue: { points } } });
  for (const command of commands) for (const parameters of malformed) assert.throws(() => validateCommand(command, argumentsFor(command, parameters)), invalid);
});

test('explicit Curves representation transitions stay native-only directly and in transactions', () => {
  for (const command of commands) for (const parameters of [{ mode: 'banks' }, { mode: 'single', channel: 'blue' }]) {
    const args = argumentsFor(command, parameters);
    const operationArgs = { ...args }; delete operationArgs.documentId;
    const transaction = validateCommand('apply_transaction', { documentId: 'doc', expectedRevision: 1, label: 'Explicit curves conversion', operations: [{ command, args: operationArgs }] });
    assert.deepEqual(transaction.operations[0].args.parameters, parameters);
  }
});

test('typed recipes accept complete or default banks and reject malformed nonselected banks and wrong slot families', () => {
  const definition = parameters => ({ name: 'Four curves', slots: [{ key: 'photo', type: 'raster' }, { key: 'grade', type: 'adjustment', kind: 'curves' }], steps: [
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'curves', value: 0, parameters } },
    { command: 'update_adjustment', target: 'grade', args: { value: 0, parameters } },
  ] });
  for (const parameters of [{ mode: 'banks' }, { mode: 'banks', banks: { master: { points: close, interpolation: 'smooth' }, green: { points: identity } } }, { mode: 'single', points: close }]) {
    const recipe = definition(parameters); assert.deepEqual(validateEditRecipeDefinition(recipe), recipe);
    const wrong = structuredClone(recipe); wrong.slots[1].kind = 'levels'; assert.throws(() => validateEditRecipeDefinition(wrong), invalid);
  }
  for (const parameters of [{ mode: 'banks', banks: { blue: { points: [{ x: 1, y: 0 }, identity[1]] } } }, { mode: 'banks', banks: { green: { interpolation: 'smooth', color: '#ff0000' } } }]) assert.throws(() => validateEditRecipeDefinition(definition(parameters)), invalid);
});

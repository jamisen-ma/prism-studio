import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { commandSchemas, validateCommand, checkColorRangeCommandArguments, readCommands, transactionCommands } from '../shared/commands.mjs';
const documentId = 'color-range-schema';
const invalid = operation => assert.throws(operation, error => ['INVALID_ARGUMENTS', 'INVALID_TRANSACTION'].includes(error.code));
const load = (patch = {}) => ({ documentId, expectedRevision: 1, colors: ['#aAbBcC'], ...patch });
const transaction = args => ({ documentId, expectedRevision: 3, label: 'Range mask', operations: [{ command: 'load_color_range_selection', args }] });

test('Color Range schemas retain explicit defaults, canonical owned swatches and separate read/load contracts', () => {
  const input = load(), output = validateCommand('load_color_range_selection', input);
  assert.deepEqual(output, { documentId, expectedRevision: 1, colors: ['#aabbcc'], tolerance: 32, falloff: 32, invert: false, mode: 'replace' });
  input.colors[0] = '#123456'; assert.equal(output.colors[0], '#aabbcc');
  assert.deepEqual(validateCommand('get_color_range_preview', { documentId, colors: ['#000000'] }),
    { documentId, colors: ['#000000'], tolerance: 32, falloff: 32, invert: false, maxEdge: 700 });
  for (const mode of ['replace', 'add', 'subtract', 'intersect']) for (const invert of [false, true]) {
    const parsed = validateCommand('load_color_range_selection', load({ mode, invert, tolerance: 255, falloff: 255 }));
    assert.equal(parsed.mode, mode); assert.equal(parsed.invert, invert); assert.equal(parsed.falloff, 255);
  }
  for (const tolerance of [-0, 0, 255]) assert.ok(Object.is(validateCommand('load_color_range_selection', load({ tolerance })).tolerance, tolerance === 0 ? 0 : 255));
  for (const command of ['get_color_range_preview', 'load_color_range_selection']) {
    for (const patch of [{ colors: [] }, { colors: Array(9).fill('#123456') }, { colors: ['#ffffff', '#FFFFFF'] }, { colors: ['#abcdef\n'] }, { colors: ['abcdef'] }, { colors: [1] }, { tolerance: -1 }, { tolerance: 256 }, { tolerance: .5 }, { tolerance: '32' }, { falloff: Infinity }, { falloff: NaN }, { falloff: null }, { invert: 1 }, { invert: 'false' }, { tolerance: undefined }, { layerId: 'a' }, { x: 1 }, { expectedRevision: 0 }, { expectedRevision: undefined }]) invalid(() => validateCommand(command, load(patch)));
  }
  invalid(() => validateCommand('load_color_range_selection', { documentId, colors: ['#ffffff'] }));
  invalid(() => validateCommand('load_color_range_selection', load({ maxEdge: 700 })));
  invalid(() => validateCommand('get_color_range_preview', load({ mode: 'replace' })));
  for (const maxEdge of [31, 2401, 32.5, null, '700']) invalid(() => validateCommand('get_color_range_preview', load({ maxEdge })));
  for (const maxEdge of [32, 700, 2400]) assert.equal(validateCommand('get_color_range_preview', load({ maxEdge })).maxEdge, maxEdge);
});

test('Color Range raw direct and transaction envelopes reject descriptors before any getter or schema snapshot', () => {
  let getters = 0;
  const accessor = (object, field, result) => { Object.defineProperty(object, field, { enumerable: true, configurable: true, get() { getters++; return result; } }); return object; };
  const cases = [];
  for (const field of ['colors', 'tolerance', 'falloff', 'invert']) cases.push(accessor({ colors: ['#123456'] }, field, field === 'colors' ? ['#123456'] : 0));
  const index = ['#123456']; accessor(index, '0', '#123456'); cases.push({ colors: index });
  const hidden = { colors: ['#123456'] }; Object.defineProperty(hidden, 'tolerance', { value: 32 }); cases.push(hidden);
  const symbol = { colors: ['#123456'], [Symbol('extra')]: 1 }; cases.push(symbol);
  const inherited = Object.create({ get tolerance() { getters++; return 32; } }); inherited.colors = ['#123456']; cases.push(inherited);
  const sparse = []; sparse.length = 1; cases.push({ colors: sparse });
  const extraArray = ['#123456']; extraArray.extra = 1; cases.push({ colors: extraArray });
  for (const args of cases) {
    // Preserve the raw shape; do not spread away non-enumerable/accessor evidence.
    if (Object.getPrototypeOf(args) === Object.prototype) Object.assign(args, { documentId, expectedRevision: 1 });
    for (const command of ['get_color_range_preview', 'load_color_range_selection']) invalid(() => validateCommand(command, args));
    invalid(() => validateCommand('apply_transaction', transaction(args)));
    assert.equal(getters, 0);
  }
  const stepArgs = { colors: ['#123456'] };
  for (const malformed of [accessor(transaction(stepArgs), 'operations', transaction(stepArgs).operations),
    { ...transaction(stepArgs), operations: [accessor({ command: 'load_color_range_selection', args: stepArgs }, 'command', 'load_color_range_selection')] },
    { ...transaction(stepArgs), operations: [accessor({ command: 'load_color_range_selection', args: stepArgs }, 'args', stepArgs)] }]) {
    invalid(() => validateCommand('apply_transaction', malformed)); assert.equal(getters, 0);
  }
  const nullProto = Object.assign(Object.create(null), load());
  assert.equal(validateCommand('load_color_range_selection', nullProto).colors[0], '#aabbcc');
  assert.equal(checkColorRangeCommandArguments('get_color_range_preview', load()), true);
  assert.equal(checkColorRangeCommandArguments('apply_transaction', transaction({ colors: ['#123456'] })), true);
  assert.equal(checkColorRangeCommandArguments('get_document', { documentId }), false);
});

test('Color Range transaction load pins the outer revision, preserves settings and excludes reads and recipes', () => {
  const input = transaction({ colors: ['#ABCDEF', '#001122'], mode: 'intersect' });
  const parsed = validateCommand('apply_transaction', input);
  assert.deepEqual(parsed.operations, [{ command: 'load_color_range_selection', args: { colors: ['#abcdef', '#001122'], tolerance: 32, falloff: 32, invert: false, mode: 'intersect' } }]);
  input.operations[0].args.colors.reverse(); assert.deepEqual(parsed.operations[0].args.colors, ['#abcdef', '#001122']);
  for (const expectedRevision of [0, undefined]) invalid(() => validateCommand('apply_transaction', { ...input, expectedRevision }));
  invalid(() => validateCommand('apply_transaction', transaction({ colors: ['#123456'], expectedRevision: 1 })));
  invalid(() => validateCommand('apply_transaction', transaction({ colors: ['#123456'], documentId: 'another' })));
  invalid(() => validateCommand('apply_transaction', { ...input, operations: [{ command: 'get_color_range_preview', args: { colors: ['#123456'] } }] }));
  invalid(() => validateCommand('save_edit_recipe', { documentId, name: 'Range', slots: [], steps: [{ command: 'load_color_range_selection', args: { colors: ['#123456'] } }] }));
  assert.ok(readCommands.has('get_color_range_preview')); assert.ok(!readCommands.has('load_color_range_selection'));
  assert.ok(transactionCommands.has('load_color_range_selection')); assert.ok(!transactionCommands.has('get_color_range_preview'));
});

test('Color Range MCP schemas are representable', () => {
  for (const command of ['get_color_range_preview', 'load_color_range_selection']) {
    const schema = z.toJSONSchema(commandSchemas[command]);
    assert.equal(schema.properties.colors.minItems, 1); assert.equal(schema.properties.colors.maxItems, 8);
    assert.equal(schema.properties.colors.items.minLength, 7); assert.equal(schema.properties.colors.items.maxLength, 7);
    assert.equal(schema.properties.tolerance.default, 32); assert.equal(schema.additionalProperties, false);
    assert.equal(schema.required.includes('expectedRevision'), command === 'load_color_range_selection');
  }
});

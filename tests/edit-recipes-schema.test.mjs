import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateCommand, validateBackendOptions, validateEditRecipeDefinition, validateEditRecipeRecord, validateEditRecipeBindings, readCommands } from '../shared/commands.mjs';
import { assertEditRecipeJson } from '../shared/edit-recipes.mjs';

const definition = () => ({ name: 'Warm cover', slots: [{ key: 'photo', type: 'raster' }, { key: 'heading', type: 'text', label: 'Title' }], steps: [
  { command: 'add_layer_filter', target: 'photo', args: { kind: 'temperature', value: 12 } },
  { command: 'update_text', target: 'heading', args: { fontFamily: 'Fraunces', tracking: 0, leading: null } },
] });
const invalid = cause => cause.code === 'INVALID_ARGUMENTS';

test('recipe schemas reuse typed command arguments, preserve reset instructions and reject semantic mismatches', () => {
  const input = definition(), parsed = validateEditRecipeDefinition(input);
  assert.deepEqual(parsed, input); parsed.steps[0].args.value = 80; assert.equal(input.steps[0].args.value, 12);
  assert.equal(parsed.steps[1].args.leading, null); assert.equal(parsed.steps[1].args.tracking, 0);
  const record = { id: randomUUID(), version: 1, ...input }; assert.deepEqual(validateEditRecipeRecord(record), record);
  for (const mutate of [
    value => value.slots.push({ key: 'photo', type: 'raster' }), value => value.slots.push({ key: 'unused', type: 'content' }),
    value => value.steps[0].target = 'missing', value => value.slots[0].type = 'text', value => value.steps[0].command = 'paint_stroke',
    value => value.steps[0].args.kind = 'unknown_filter', value => value.steps[0].args.parameters = { monochrome: true },
    value => value.steps[1].args.text = 'Do not copy text', value => value.steps[1].args.x = 20, value => value.steps[1].args = {},
    value => value.steps[0].args.layerId = randomUUID(), value => value.steps[0].args.mask = null,
    value => value.slots[0].key = 'constructor', value => value.slots[0].kind = 'temperature',
    value => value.name = 'Bad\u0000name', value => value.name = '\nName', value => value.slots[0].label = 'Bad\u007flabel', value => value.slots[0].label = '\tLabel',
  ]) { const bad = definition(); mutate(bad); assert.throws(() => validateEditRecipeDefinition(bad), invalid); }
  for (const changes of [{ version: 2 }, { id: 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF' }, { extra: true }]) assert.throws(() => validateEditRecipeRecord({ ...record, ...changes }), invalid);
  const alias = { fontSize: 40 }, repeated = { name: 'Independent copies', slots: [{ key: 'heading', type: 'text' }], steps: [{ command: 'update_text', target: 'heading', args: alias }, { command: 'update_text', target: 'heading', args: alias }] };
  const separate = validateEditRecipeDefinition(repeated); separate.steps[0].args.fontSize = 72; assert.equal(separate.steps[1].args.fontSize, 40); assert.equal(alias.fontSize, 40);
});

test('recipe kinds retain ordinary parameter and scalar validation without live layer context', () => {
  const make = (kind, args) => ({ name: 'Grade', slots: [{ key: 'grade', type: 'adjustment', kind }], steps: [{ command: 'update_adjustment', target: 'grade', args }] });
  const valid = [
    ['exposure', { value: 1.25 }], ['median', { value: 3 }], ['blur', { value: 12 }],
    ['levels', { value: 0, parameters: { black: 10, white: 245, gamma: 1.1, outputBlack: 0, outputWhite: 255 } }],
    ['channel_mixer', { value: 0, parameters: { red: [110, -5, -5, 1.25] } }],
    ['gradient_map', { value: 0, parameters: { stops: [{ offset: 0, color: '#102030' }, { offset: 1, color: '#F0D0A0' }] } }],
  ];
  for (const [kind, args] of valid) assert.deepEqual(validateEditRecipeDefinition(make(kind, args)), make(kind, args));
  for (const [kind, args] of [['exposure', { value: 6 }], ['median', { value: 4 }], ['levels', { value: 1 }], ['levels', { value: 0, parameters: { black: 245, white: 10, gamma: 1, outputBlack: 0, outputWhite: 255 } }], ['channel_mixer', { value: 0, parameters: { red: [100.001, 0, 0, 0] } }], ['gradient_map', { value: 0, parameters: { stops: [{ offset: 0.5, color: '#102030' }, { offset: 1, color: '#ffffff' }] } }]]) assert.throws(() => validateEditRecipeDefinition(make(kind, args)), invalid);
});

test('recipe entry guards reject hostile non-JSON inputs before evaluating accessors or deep schemas', () => {
  let reads = 0;
  const accessor = definition(); Object.defineProperty(accessor, 'name', { enumerable: true, get() { reads++; return 'No'; } });
  const cycle = definition(); cycle.loop = cycle;
  const sparse = definition(); delete sparse.steps[0];
  const custom = Object.assign(Object.create({ hidden: true }), definition());
  const symbol = definition(); symbol[Symbol('hidden')] = 'no';
  const dangerous = JSON.parse('{"name":"x","constructor":{},"slots":[],"steps":[]}');
  const deep = {}; let cursor = deep; for (let i = 0; i < 14; i++) { cursor.next = {}; cursor = cursor.next; }
  for (const value of [accessor, cycle, sparse, custom, symbol, dangerous, deep, { value: undefined }, { value: Infinity }, { value: NaN }, { value: 1n }, { value: () => {} }, new Date(), { large: 'x'.repeat(32769) }, Array(8193).fill(null)]) assert.throws(() => assertEditRecipeJson(value), invalid);
  assert.equal(reads, 0);
  assert.throws(() => validateCommand('save_edit_recipe', { documentId: 'doc', ...definition(), extra: deep }), invalid);
});

test('recipe transport requires an application revision, keeps read reports readonly and forbids nested or bridge use', () => {
  const recipeId = randomUUID(), layerId = randomUUID(), saved = { documentId: 'doc', ...definition() };
  validateCommand('save_edit_recipe', saved);
  assert.deepEqual(validateEditRecipeBindings({}), {});
  assert.deepEqual(validateEditRecipeBindings({ photo: layerId, heading: layerId }), { photo: layerId, heading: layerId });
  assert.throws(() => validateEditRecipeBindings({ photo: 'missing-uuid' }), invalid);
  const args = { documentId: 'doc', recipeId, bindings: { photo: layerId, heading: randomUUID() } };
  for (const expectedRevision of [undefined, 0, -1, 1.5]) assert.throws(() => validateCommand('apply_edit_recipe', { ...args, ...(expectedRevision === undefined ? {} : { expectedRevision }) }), invalid);
  assert.equal(validateCommand('apply_edit_recipe', { ...args, expectedRevision: 4 }).expectedRevision, 4);
  for (const command of ['get_edit_recipe', 'validate_edit_recipe']) assert.equal(readCommands.has(command), true);
  for (const command of ['save_edit_recipe', 'get_edit_recipe', 'rename_edit_recipe', 'delete_edit_recipe', 'validate_edit_recipe', 'apply_edit_recipe']) {
    assert.throws(() => validateBackendOptions('photoshop', command, {}), { code: 'UNSUPPORTED_COMMAND' });
    assert.throws(() => validateCommand('apply_transaction', { documentId: 'doc', label: 'No recipe nesting', operations: [{ command, args: {} }] }), { code: 'INVALID_TRANSACTION' });
  }
});

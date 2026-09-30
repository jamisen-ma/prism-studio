import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { commandSchemas, commandLabels, validateCommand, validateBackendOptions, readCommands, transactionCommands } from '../shared/commands.mjs';

const base = { documentId: 'fill-document', expectedRevision: 3, layerId: 'fill-layer', fillOpacity: 0.375 };
const invalid = operation => assert.throws(operation, error => ['INVALID_ARGUMENTS', 'INVALID_TRANSACTION'].includes(error.code));

test('Layer Fill has strict finite scalar inputs and a representable required revision schema', () => {
  for (const fillOpacity of [0, Number.MIN_VALUE, 1 / 3, 0.375, 1 - Number.EPSILON, 1]) {
    const input = { ...base, fillOpacity };
    assert.deepEqual(validateCommand('set_layer_fill', input), input);
  }
  assert.equal(Object.is(validateCommand('set_layer_fill', { ...base, fillOpacity: -0 }).fillOpacity, -0), false);
  for (const fillOpacity of [undefined, null, NaN, Infinity, -Infinity, -0.01, 1.01, '0.375', true, {}, []])
    invalid(() => validateCommand('set_layer_fill', { ...base, fillOpacity }));
  for (const expectedRevision of [undefined, null, 0, -1, 1.5, Infinity, '3'])
    invalid(() => validateCommand('set_layer_fill', { ...base, expectedRevision }));
  for (const extra of [{ opacity: 0.5 }, { percent: 37.5 }, { effects: null }, { mask: {} }, { protected: false }, { parameters: {} }])
    invalid(() => validateCommand('set_layer_fill', { ...base, ...extra }));
  for (const field of ['layerId', 'documentId']) for (const value of [undefined, null, '', 1])
    invalid(() => validateCommand('set_layer_fill', { ...base, [field]: value }));
  const schema = z.toJSONSchema(commandSchemas.set_layer_fill);
  assert.deepEqual(schema.required.sort(), ['documentId', 'expectedRevision', 'fillOpacity', 'layerId']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.fillOpacity.type, 'number');
  assert.equal(schema.properties.fillOpacity.minimum, 0); assert.equal(schema.properties.fillOpacity.maximum, 1);
  assert.equal(schema.properties.expectedRevision.minimum, 1);
  assert.ok(transactionCommands.has('set_layer_fill')); assert.ok(!readCommands.has('set_layer_fill'));
  assert.ok(commandLabels.set_layer_fill);
});

test('Layer Fill transaction owns the positive revision and remains outside the recipe allowlist', () => {
  const input = { documentId: base.documentId, expectedRevision: 3, label: 'Fill and protect', operations: [
    { command: 'set_layer_fill', args: { layerId: base.layerId, fillOpacity: 0.375 } },
    { command: 'set_layer_protection', args: { layerId: base.layerId, protected: true } },
  ] };
  assert.deepEqual(validateCommand('apply_transaction', input), input);
  for (const expectedRevision of [undefined, 0]) invalid(() => validateCommand('apply_transaction', { ...input, expectedRevision }));
  for (const extra of [{ documentId: 'another-document' }, { expectedRevision: 3 }, { fillOpacity: null }, { opacity: 0.5 }])
    invalid(() => validateCommand('apply_transaction', { ...input, operations: [{ command: 'set_layer_fill', args: { ...input.operations[0].args, ...extra } }] }));
  invalid(() => validateCommand('save_edit_recipe', { documentId: base.documentId, name: 'No hidden Fill capture',
    slots: [{ key: 'subject', type: 'raster' }], steps: [{ command: 'set_layer_fill', target: 'subject', args: { fillOpacity: 0.375 } }] }));
  invalid(() => validateCommand('set_layer', { documentId: base.documentId, layerId: base.layerId, fillOpacity: 0.5 }));
  invalid(() => validateCommand('set_layer_effects', { documentId: base.documentId, layerId: base.layerId, effects: { version: 1, fillOpacity: 0.5, styles: null } }));
});

test('Layer Fill is explicitly native-only directly and inside transactions', () => {
  assert.doesNotThrow(() => validateBackendOptions('native', 'set_layer_fill', base));
  assert.throws(() => validateBackendOptions('photoshop', 'set_layer_fill', base), { code: 'UNSUPPORTED_COMMAND' });
  assert.throws(() => validateBackendOptions('photoshop', 'apply_transaction', { documentId: base.documentId, expectedRevision: 3,
    operations: [{ command: 'set_layer_fill', args: { layerId: base.layerId, fillOpacity: 0.375 } }] }), { code: 'UNSUPPORTED_COMMAND' });
});

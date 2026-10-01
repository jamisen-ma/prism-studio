import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchemas, validateCommand, readCommands, transactionCommands } from '../shared/commands.mjs';

const documentId = 'channel-schema-document', layerId = 'channel-schema-layer';
const channels = ['red', 'green', 'blue', 'luma', 'alpha'];
const modes = ['replace', 'add', 'subtract', 'intersect'];
const descriptor = () => ({ shape: 'alpha8', asset: 'ab'.repeat(32), bytes: 262176, width: 512, height: 512 });
const invalid = operation => assert.throws(operation, error => ['INVALID_ARGUMENTS', 'INVALID_TRANSACTION'].includes(error.code));

test('Composite-channel mutation and preview have strict independent defaults, revisions and command categories', () => {
  assert.deepEqual(validateCommand('load_channel_selection', { documentId, expectedRevision: 1 }),
    { documentId, expectedRevision: 1, channel: 'luma', mode: 'replace', invert: false });
  assert.deepEqual(validateCommand('get_channel_preview', { documentId }),
    { documentId, channel: 'luma', invert: false, maxEdge: 700 });
  assert.ok(readCommands.has('get_channel_preview')); assert.ok(!readCommands.has('load_channel_selection'));
  assert.ok(transactionCommands.has('load_channel_selection')); assert.ok(!transactionCommands.has('get_channel_preview'));
  assert.deepEqual(commandSchemas.load_channel_selection.shape.channel.removeDefault().options, channels);
  for (const channel of channels) for (const mode of modes) for (const invert of [false, true]) {
    const input = { documentId, expectedRevision: 7, channel, mode, invert };
    assert.deepEqual(validateCommand('load_channel_selection', input), input);
  }
  for (const maxEdge of [32, 700, 2400]) for (const channel of channels) {
    const input = { documentId, expectedRevision: 7, channel, invert: true, maxEdge };
    assert.deepEqual(validateCommand('get_channel_preview', input), input);
  }
  for (const command of ['load_channel_selection', 'get_channel_preview']) {
    const base = { documentId, expectedRevision: 1 };
    for (const expectedRevision of [0, -1, 1.5, NaN, Infinity, '1', null]) invalid(() => validateCommand(command, { ...base, expectedRevision }));
    for (const channel of ['', 'rgb', 'luminosity', null, 1]) invalid(() => validateCommand(command, { ...base, channel }));
    for (const invert of [null, 0, 1, 'false']) invalid(() => validateCommand(command, { ...base, invert }));
    for (const extra of [{ layerId }, { source: 'original' }, { threshold: 128 }, { feather: 0 }, { pixels: [] }])
      invalid(() => validateCommand(command, { ...base, ...extra }));
  }
  invalid(() => validateCommand('load_channel_selection', { documentId }));
  for (const mode of ['union', 'screen', null, 1]) invalid(() => validateCommand('load_channel_selection', { documentId, expectedRevision: 1, mode }));
  invalid(() => validateCommand('load_channel_selection', { documentId, expectedRevision: 1, maxEdge: 32 }));
  invalid(() => validateCommand('get_channel_preview', { documentId, mode: 'add' }));
  for (const maxEdge of [31, 2401, 32.5, '700', null, Infinity]) invalid(() => validateCommand('get_channel_preview', { documentId, maxEdge }));
});

test('Composite-channel transactions inject a required positive outer revision without admitting read commands or recipes', () => {
  const base = { documentId, expectedRevision: 2, label: 'Load and save channel', operations: [
    { command: 'load_channel_selection', args: { channel: 'red' } },
    { command: 'save_selection', args: { name: 'Red coverage' } },
  ] };
  assert.deepEqual(validateCommand('apply_transaction', base), { ...base, operations: [
    { command: 'load_channel_selection', args: { channel: 'red', mode: 'replace', invert: false } }, base.operations[1],
  ] });
  for (const expectedRevision of [undefined, 0]) invalid(() => validateCommand('apply_transaction', { ...base, expectedRevision }));
  for (const fields of [{ documentId: 'another-document' }, { expectedRevision: 2 }, { channel: 'rgb' }])
    invalid(() => validateCommand('apply_transaction', { ...base, operations: [{ command: 'load_channel_selection', args: fields }] }));
  invalid(() => validateCommand('apply_transaction', { ...base, operations: [{ command: 'get_channel_preview', args: {} }] }));
  invalid(() => validateCommand('save_edit_recipe', { documentId, name: 'No hidden masks', slots: [{ key: 'image', type: 'raster' }],
    steps: [{ command: 'load_channel_selection', target: 'image', args: { channel: 'luma' } }] }));
});

test('Explicit source alpha8 reuse validates exact framed metadata without widening geometric mask APIs', () => {
  const input = { documentId, expectedRevision: 1, layerId, source: 'mask', mask: descriptor() };
  assert.deepEqual(validateCommand('set_layer_filter_mask', input), input);
  assert.deepEqual(validateCommand('set_layer_filter_mask', { ...input, mask: { ...descriptor(), x: 0, y: 0, feather: 100, invert: true } }),
    { ...input, mask: { ...descriptor(), x: 0, y: 0, feather: 100, invert: true } });
  for (const patch of [{ asset: 'AB'.repeat(32) }, { asset: 'ab'.repeat(32) + '\n' }, { bytes: 262175 }, { bytes: '262176' },
    { width: 8193 }, { width: 6001, height: 4000, bytes: 24004032 }, { x: 1 }, { y: null }, { feather: 101 }, { invert: 1 },
    { runs: [] }, { clip: { x: 0, y: 0, width: 1, height: 1 } }, { density: 1 }, { path: '/local/mask' }])
    invalid(() => validateCommand('set_layer_filter_mask', { ...input, mask: { ...descriptor(), ...patch } }));
  invalid(() => validateCommand('set_layer_filter_mask', { ...input, source: 'selection' }));
  invalid(() => validateCommand('set_layer_mask', { documentId, layerId, mask: descriptor() }));
  invalid(() => validateCommand('add_adjustment', { documentId, kind: 'brightness', value: 5, mask: descriptor() }));
  const bitmap = { shape: 'bitmap', width: 2, height: 1, runs: [0, 1, 128] };
  assert.deepEqual(validateCommand('set_layer_filter_mask', { ...input, mask: bitmap }), { ...input, mask: bitmap });
  let getterCalls = 0;
  for (const field of ['shape', 'asset', 'bytes', 'width', 'height', 'x', 'y', 'feather', 'invert']) {
    const malformed = descriptor();
    Object.defineProperty(malformed, field, { enumerable: true, get() { getterCalls++; return field === 'shape' ? 'alpha8' : 0; } });
    for (const transaction of [false, true]) {
      const args = { ...input, mask: malformed };
      invalid(() => transaction
        ? validateCommand('apply_transaction', { documentId, expectedRevision: 1, label: 'Reject accessor', operations: [
          { command: 'set_layer_filter_mask', args: { layerId, source: 'mask', mask: malformed } },
        ] })
        : validateCommand('set_layer_filter_mask', args));
      assert.equal(getterCalls, 0);
    }
  }
  for (const transaction of [false, true]) {
    const args = { layerId, source: 'mask' };
    Object.defineProperty(args, 'mask', { enumerable: true, get() { getterCalls++; return descriptor(); } });
    if (transaction) invalid(() => validateCommand('apply_transaction', { documentId, expectedRevision: 1, label: 'Reject mask accessor', operations: [{ command: 'set_layer_filter_mask', args }] }));
    else { Object.assign(args, { documentId, expectedRevision: 1 }); invalid(() => validateCommand('set_layer_filter_mask', args)); }
    assert.equal(getterCalls, 0);
  }
  const inheritedShape = descriptor();
  delete inheritedShape.shape;
  Object.setPrototypeOf(inheritedShape, { get shape() { getterCalls++; return 'alpha8'; } });
  invalid(() => validateCommand('set_layer_filter_mask', { ...input, mask: inheritedShape }));
  assert.equal(getterCalls, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';
import { commandSchemas } from '../shared/commands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-mcp-test-'));
  const companion = await createCompanion({ dataDir, port: 0 });
  const port = await companion.listen();
  const client = new Client({ name: 'prism-integration-tests', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'server/mcp.mjs')],
    cwd: root,
    env: { ...process.env, PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    await client.close();
    await companion.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    assert.ok(!stderr.includes(companion.token), 'MCP must never print the pairing token');
  });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return { client, companion, dataDir, call };
}

function result(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
}

function error(response) {
  assert.equal(response.isError, true, 'MCP failures must be marked isError');
  return JSON.parse(response.content.find(item => item.type === 'text').text);
}

async function image(response) {
  result(response);
  const content = response.content.find(item => item.type === 'image');
  assert.ok(content, 'get_preview must return a native MCP image content block');
  assert.equal(content.mimeType, 'image/png');
  return sharp(Buffer.from(content.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

test('official MCP stdio client discovers tools and performs a masked native edit with real rendered image results', { timeout: 15000 }, async t => {
  const { client, call } = await fixture(t);
  const { tools } = await client.listTools();
  const names = new Set(tools.map(tool => tool.name));
  for (const command of Object.keys(commandSchemas)) assert.ok(names.has(`prism_${command}`));
  assert.ok(names.has('prism_status'));
  assert.ok(names.has('prism_import_file'));
  assert.equal(tools.find(tool => tool.name === 'prism_get_document').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'prism_add_adjustment').annotations.readOnlyHint, false);
  const status = result(await call('prism_status'));
  assert.equal(status.backends.find(backend => backend.id === 'native').connected, true);
  assert.equal(status.backends.find(backend => backend.id === 'photoshop').connected, false);

  const initial = result(await call('prism_create_document', { backend: 'native', name: 'MCP pixel verification', width: 64, height: 48, background: '#406080' })).document;
  assert.equal(initial.backend, 'native');
  const inspected = result(await call('prism_get_document', { backend: 'native', documentId: initial.id })).document;
  assert.deepEqual(inspected, initial);
  const before = await image(await call('prism_get_preview', { backend: 'native', documentId: initial.id, maxWidth: 64 }));
  assert.equal(before.info.width, 64);
  assert.equal(before.info.height, 48);

  const args = { backend: 'native', documentId: initial.id, expectedRevision: initial.revision, kind: 'brightness', value: 25, name: 'Brighten center only', mask: { x: 16, y: 12, width: 32, height: 24 }, requestId: 'mcp-brightness-once' };
  const edited = result(await call('prism_add_adjustment', args)).document;
  assert.equal(edited.revision, initial.revision + 1);
  assert.equal(edited.layers.length, 2);
  assert.equal(edited.layers[1].name, 'Brighten center only');
  assert.deepEqual(result(await call('prism_add_adjustment', args)).document, edited, 'MCP retry with the same requestId must not duplicate the layer');
  const afterResponse = await call('prism_get_preview', { backend: 'native', documentId: initial.id, maxWidth: 64 });
  assert.equal(result(afterResponse).revision, edited.revision);
  const after = await image(afterResponse);
  let changed = 0;
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const offset = (y * 64 + x) * 4;
    if (x < 16 || x >= 48 || y < 12 || y >= 36) {
      assert.deepEqual(after.data.subarray(offset, offset + 4), before.data.subarray(offset, offset + 4));
    } else {
      assert.ok(after.data[offset] > before.data[offset], 'Selected pixels should be brighter');
      changed++;
    }
  }
  assert.equal(changed, 32 * 24);
  const conflict = error(await call('prism_add_adjustment', { ...args, requestId: 'new-stale-request' }));
  assert.equal(conflict.code, 'REVISION_CONFLICT');
  const disconnected = error(await call('prism_list_documents', { backend: 'photoshop' }));
  assert.equal(disconnected.code, 'PHOTOSHOP_DISCONNECTED');
});

test('MCP transaction and undo restore exact pixels through the live companion', { timeout: 15000 }, async t => {
  const { call } = await fixture(t);
  const document = result(await call('prism_create_document', { backend: 'native', name: 'MCP transaction', width: 80, height: 48, background: '#305070' })).document;
  const previewArgs = { backend: 'native', documentId: document.id, maxWidth: 80 };
  const before = await image(await call('prism_get_preview', previewArgs));
  const transaction = result(await call('prism_apply_transaction', { backend: 'native', documentId: document.id, expectedRevision: document.revision, label: 'MCP warm and brighten', operations: [
    { command: 'add_adjustment', args: { kind: 'temperature', value: 20 } },
    { command: 'add_adjustment', args: { kind: 'brightness', value: 10 } },
  ] })).document;
  assert.equal(transaction.layers.length, 3);
  assert.equal(transaction.history.length, document.history.length + 1);
  assert.notDeepEqual((await image(await call('prism_get_preview', previewArgs))).data, before.data);
  const undone = result(await call('prism_undo', { backend: 'native', documentId: document.id, expectedRevision: transaction.revision })).document;
  assert.equal(undone.layers.length, 1);
  assert.equal(undone.canRedo, true);
  assert.deepEqual((await image(await call('prism_get_preview', previewArgs))).data, before.data);
});

test('MCP imports a real local image and exports unique valid files without overwriting the original', { timeout: 15000 }, async t => {
  const { call, dataDir } = await fixture(t);
  const inputPath = path.join(dataDir, 'original.png');
  const original = await sharp({ create: { width: 50, height: 32, channels: 4, background: '#274e73' } }).png().toBuffer();
  await fs.writeFile(inputPath, original);
  const imported = result(await call('prism_import_file', { path: inputPath, name: 'Imported original' })).document;
  assert.equal(imported.name, 'Imported original');
  assert.equal(imported.width, 50);
  assert.equal(imported.height, 32);
  const first = result(await call('prism_export_document', { backend: 'native', documentId: imported.id, format: 'png' }));
  const second = result(await call('prism_export_document', { backend: 'native', documentId: imported.id, format: 'png' }));
  assert.equal(path.dirname(first.path), path.join(dataDir, 'exports'));
  assert.notEqual(first.path, second.path);
  assert.equal(first.data, undefined, 'Export returns a file path rather than image bytes in text context');
  const metadata = await sharp(await fs.readFile(first.path)).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 50);
  assert.equal(metadata.height, 32);
  assert.deepEqual(await fs.readFile(first.path), await fs.readFile(second.path));
  assert.deepEqual(await fs.readFile(inputPath), original);
  assert.match(error(await call('prism_import_file', { path: 'relative.png' })).message, /absolute path/i);
});

test('MCP exports TIFF, JPEG matte and lossless WebP with format options intact', { timeout: 15000 }, async t => {
  const { call, dataDir } = await fixture(t);
  const width = 32, height = 24;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    rgba.set([x * 7, y * 9, (x * 11 + y * 3) % 256, x < 8 ? 0 : x < 16 ? 128 : 255], (y * width + x) * 4);
  }
  const original = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const input = path.join(dataDir, 'alpha-export.png');
  await fs.writeFile(input, original);
  const document = result(await call('prism_import_file', { path: input })).document;
  const args = { backend: 'native', documentId: document.id };
  const before = await image(await call('prism_get_preview', { ...args, maxWidth: 32 }));

  for (const format of ['tiff', 'webp']) {
    const exported = result(await call('prism_export_document', { ...args, format, ...(format === 'tiff' ? { density: 300 } : { lossless: true }) }));
    assert.equal(exported.data, undefined);
    assert.equal(exported.flattened, true);
    assert.equal(exported.colorSpace, 'sRGB');
    const bytes = await fs.readFile(exported.path);
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, format);
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, height);
    assert.ok(metadata.icc);
    if (format === 'tiff') assert.equal(metadata.density, 300);
    const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < decoded.length; i += 4) {
      assert.equal(decoded[i + 3], before.data[i + 3]);
      if (decoded[i + 3] || format === 'tiff') assert.deepEqual(decoded.subarray(i, i + 4), before.data.subarray(i, i + 4));
    }
  }

  const jpeg = result(await call('prism_export_document', { ...args, format: 'jpeg', quality: 100, matte: '#204060', density: 144 }));
  const jpegBytes = await fs.readFile(jpeg.path);
  assert.equal((await sharp(jpegBytes).metadata()).density, 144);
  const jpegPixels = await sharp(jpegBytes).raw().toBuffer();
  for (const [channel, expected] of [32, 64, 96].entries()) assert.ok(Math.abs(jpegPixels[channel] - expected) <= 2);
  const filesBefore = await fs.readdir(path.join(dataDir, 'exports'));
  assert.equal(error(await call('prism_export_document', { ...args, format: 'webp', density: 300 })).code, 'INVALID_ARGUMENTS');
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'exports')), filesBefore);
  assert.deepEqual(result(await call('prism_get_document', args)).document, document);
  assert.deepEqual(await fs.readFile(input), original);
});

test('MCP nested groups preserve pixels, support hierarchy edits and enforce protected descendants', { timeout: 15000 }, async t => {
  const { call } = await fixture(t);
  let document = result(await call('prism_create_document', { backend: 'native', name: 'Nested MCP groups', width: 64, height: 48, background: '#305070' })).document;
  const args = { backend: 'native', documentId: document.id };
  async function edit(command, values = {}) {
    document = result(await call(`prism_${command}`, { ...args, expectedRevision: document.revision, ...values })).document;
    return document;
  }
  await edit('add_shape', { shape: 'rectangle', x: 4, y: 4, width: 24, height: 32, fill: '#ff8000' });
  const first = document.layers.at(-1).id;
  await edit('add_shape', { shape: 'ellipse', x: 20, y: 10, width: 32, height: 28, fill: '#30d0ff' });
  const second = document.layers.at(-1).id;
  const before = await image(await call('prism_get_preview', { ...args, maxWidth: 64 }));
  const groupArgs = { ...args, expectedRevision: document.revision, layerIds: [first, second], name: 'Outfits', requestId: 'group-once' };
  document = result(await call('prism_group_layers', groupArgs)).document;
  assert.deepEqual(result(await call('prism_group_layers', groupArgs)).document, document);
  const outer = document.layers.find(layer => layer.type === 'group').id;
  assert.equal(document.layers.find(layer => layer.id === first).parentId, outer);
  assert.deepEqual((await image(await call('prism_get_preview', { ...args, maxWidth: 64 }))).data, before.data);

  await edit('create_group', { parentId: outer, name: 'Nested', index: 0 });
  const inner = document.layers.find(layer => layer.name === 'Nested').id;
  await edit('move_layer', { layerId: first, parentId: inner });
  assert.equal(document.layers.find(layer => layer.id === first).parentId, inner);
  assert.deepEqual((await image(await call('prism_get_preview', { ...args, maxWidth: 64 }))).data, before.data);
  const groupedPreview = await image(await call('prism_get_layer_preview', { ...args, layerId: outer, maxWidth: 64 }));
  assert.equal(groupedPreview.data[3], 0, 'Isolated group preview excludes the document background.');
  assert.equal(groupedPreview.data[(12 * 64 + 12) * 4 + 3], 255);
  const cycle = error(await call('prism_move_layer', { ...args, expectedRevision: document.revision, layerId: outer, parentId: inner }));
  assert.equal(cycle.code, 'INVALID_ARGUMENT');
  assert.deepEqual(result(await call('prism_get_document', args)).document, document);

  await edit('set_layer_protection', { layerId: first, protected: true });
  for (const [command, values] of [['set_layer', { layerId: outer, opacity: 0.5 }], ['delete_layer', { layerId: outer }]]) {
    assert.equal(error(await call(`prism_${command}`, { ...args, expectedRevision: document.revision, ...values })).code, 'PROTECTED_LAYER');
    assert.deepEqual(result(await call('prism_get_document', args)).document, document);
  }
  await edit('ungroup_layer', { layerId: inner });
  assert.equal(document.layers.find(layer => layer.id === first).parentId, outer);
  await edit('ungroup_layer', { layerId: outer });
  assert.ok(document.layers.every(layer => layer.parentId === undefined));
  assert.deepEqual((await image(await call('prism_get_preview', { ...args, maxWidth: 64 }))).data, before.data);
  await edit('undo');
  assert.equal(document.layers.find(layer => layer.id === first).parentId, outer);
  assert.equal(document.layers.find(layer => layer.id === first).protected, true);
});

test('MCP saved selections remain independent, scope real edits and support one-step transactional undo', { timeout: 15000 }, async t => {
  const { call } = await fixture(t);
  let document = result(await call('prism_create_document', { backend: 'native', name: 'Reusable regions', width: 64, height: 48, background: '#305070' })).document;
  const args = { backend: 'native', documentId: document.id };
  async function edit(command, values = {}) {
    document = result(await call(`prism_${command}`, { ...args, expectedRevision: document.revision, ...values })).document;
  }
  const before = await image(await call('prism_get_preview', { ...args, maxWidth: 64 }));
  await edit('select_rectangle', { x: 4, y: 8, width: 20, height: 24 });
  await edit('save_selection', { name: 'Left outfit' });
  const selectionId = document.savedSelections[0].id, originalMask = structuredClone(document.savedSelections[0].mask);
  await edit('modify_selection', { feather: 4 });
  assert.deepEqual(document.savedSelections[0].mask, originalMask);
  await edit('clear_selection');
  const checkpoint = document;
  await edit('apply_transaction', { label: 'Load and name a reusable region', operations: [
    { command: 'rename_selection', args: { selectionId, name: 'Preserved left region' } },
    { command: 'load_selection', args: { selectionId } },
  ] });
  assert.equal(document.history.length, checkpoint.history.length + 1);
  assert.deepEqual(document.selection, originalMask);
  assert.equal(document.savedSelections[0].name, 'Preserved left region');
  await edit('add_adjustment', { kind: 'invert', value: 100 });
  const after = await image(await call('prism_get_preview', { ...args, maxWidth: 64 }));
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4;
    if (x >= 4 && x < 24 && y >= 8 && y < 32) assert.deepEqual([...after.data.subarray(i, i + 4)], [207, 175, 143, 255]);
    else assert.deepEqual(after.data.subarray(i, i + 4), before.data.subarray(i, i + 4));
  }
  await edit('undo');
  await edit('delete_selection', { selectionId });
  assert.equal(document.savedSelections.length, 0);
  assert.deepEqual(document.selection, originalMask);
  await edit('undo');
  assert.equal(document.savedSelections[0].id, selectionId);
  assert.deepEqual((await image(await call('prism_get_preview', { ...args, maxWidth: 64 }))).data, before.data);
});

test('MCP arranges protected nested content by exact integer translations with atomic undo and revision guards', { timeout: 15000 }, async t => {
  const { call } = await fixture(t);
  let document = result(await call('prism_create_document', { backend: 'native', name: 'Cutout arrangement', width: 80, height: 48 })).document;
  const args = { backend: 'native', documentId: document.id };
  async function edit(command, values = {}) {
    document = result(await call(`prism_${command}`, { ...args, expectedRevision: document.revision, ...values })).document;
  }
  const ids = [];
  for (const [x, y, width, height, fill] of [[2, 3, 8, 12, '#ad6830'], [18, 7, 6, 16, '#517462'], [66, 2, 10, 20, '#c96464']]) {
    await edit('add_shape', { shape: 'rectangle', x, y, width, height, fill });
    ids.push(document.layers.at(-1).id);
    await edit('set_layer_protection', { layerId: ids.at(-1), protected: true });
  }
  await edit('group_layers', { layerIds: ids, name: 'Protected outfits' });
  const before = structuredClone(document), previewArgs = { ...args, maxWidth: 80 };
  const beforePixels = (await image(await call('prism_get_preview', previewArgs))).data;
  await edit('align_layers', { layerIds: ids, axis: 'vertical', alignment: 'end' });
  const aligned = structuredClone(document);
  async function bounds(id) {
    return result(await call('prism_get_layer_preview', { ...previewArgs, layerId: id })).visibleBounds;
  }
  const alignedBounds = await Promise.all(ids.map(bounds));
  for (const box of alignedBounds) assert.equal(box.y + box.height, 48);
  await edit('distribute_layers', { layerIds: [...ids].reverse(), axis: 'horizontal', spacing: 'gaps' });
  const arrangedBounds = await Promise.all(ids.map(bounds));
  assert.deepEqual(arrangedBounds[0], alignedBounds[0]);
  assert.deepEqual(arrangedBounds[2], alignedBounds[2]);
  const gaps = arrangedBounds.slice(1).map((box, index) => box.x - arrangedBounds[index].x - arrangedBounds[index].width);
  assert.ok(Math.abs(gaps[0] - gaps[1]) <= 1);
  for (const id of ids) {
    const original = before.layers.find(layer => layer.id === id), arranged = document.layers.find(layer => layer.id === id);
    assert.deepEqual({ ...arranged, transforms: original.transforms }, original);
    assert.ok(arranged.transforms.every(transform => transform.type === 'affine' && Number.isInteger(transform.x) && Number.isInteger(transform.y) && transform.scaleX === 1 && transform.scaleY === 1));
  }
  assert.equal(document.history.length, before.history.length + 2);
  assert.equal(error(await call('prism_align_layers', { ...args, expectedRevision: before.revision, layerIds: ids, axis: 'horizontal', alignment: 'start' })).code, 'REVISION_CONFLICT');
  await edit('undo');
  assert.deepEqual(document.layers, aligned.layers);
  await edit('undo');
  assert.deepEqual(document.layers, before.layers);
  assert.deepEqual((await image(await call('prism_get_preview', previewArgs))).data, beforePixels);
  const group = document.layers.find(layer => layer.type === 'group');
  await edit('set_layer_mask', { layerId: group.id, mask: { x: 0, y: 0, width: 80, height: 48 } });
  const masked = structuredClone(document);
  assert.equal(error(await call('prism_align_layers', { ...args, expectedRevision: document.revision, layerIds: ids, axis: 'horizontal', alignment: 'center' })).code, 'INVALID_TARGET');
  assert.deepEqual(result(await call('prism_get_document', args)).document, masked);
});

test('MCP selection border and protected layer-mask shaping render exact scoped alpha and deduplicate retries', { timeout: 15000 }, async t => {
  const { call } = await fixture(t);
  const capabilities = result(await call('prism_capabilities', { backend: 'native' }));
  assert.deepEqual(capabilities.morphologyOperations, ['expand', 'contract', 'border', 'smooth']);
  assert.equal(capabilities.limits.maxMorphologyRadius, 100);
  assert.deepEqual(result(await call('prism_status')).backends.find(item => item.id === 'native').morphologyOperations, capabilities.morphologyOperations);
  let document = result(await call('prism_create_document', { backend: 'native', name: 'MCP mask shaping', width: 40, height: 32, background: '#285078' })).document;
  const args = { backend: 'native', documentId: document.id }, layerId = document.layers[0].id;
  async function edit(command, fields = {}) { document = result(await call(`prism_${command}`, { ...args, expectedRevision: document.revision, ...fields })).document; }
  await edit('select_rectangle', { x: 10, y: 8, width: 16, height: 12 });
  await edit('save_selection', { name: 'Original rectangle' });
  const originalSaved = structuredClone(document.savedSelections);
  const request = { ...args, expectedRevision: document.revision, operation: 'border', radius: 2, requestId: 'border-once' };
  document = result(await call('prism_morph_selection', request)).document;
  assert.deepEqual(result(await call('prism_morph_selection', request)).document, document);
  await edit('set_layer_protection', { layerId, protected: true });
  await edit('mask_from_selection', { layerId });
  const before = structuredClone(document), expected = Buffer.alloc(40 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 40; x++) {
    const outer = x >= 8 && x < 28 && y >= 6 && y < 22, inner = x >= 12 && x < 24 && y >= 10 && y < 18;
    if (outer && !inner) expected.set([40, 80, 120, 255], (y * 40 + x) * 4);
  }
  assert.deepEqual((await image(await call('prism_get_preview', { ...args, maxWidth: 40 }))).data, expected);
  await edit('morph_layer_mask', { layerId, operation: 'contract', radius: 1 });
  const contracted = (await image(await call('prism_get_preview', { ...args, maxWidth: 40 }))).data;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 40; x++) {
    let alpha = 255;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) alpha = Math.min(alpha, x + dx < 0 || x + dx >= 40 || y + dy < 0 || y + dy >= 32 ? 0 : expected[((y + dy) * 40 + x + dx) * 4 + 3]);
    assert.equal(contracted[(y * 40 + x) * 4 + 3], alpha);
  }
  assert.equal(document.layers[0].protected, true); assert.deepEqual(document.selection, before.selection); assert.deepEqual(document.savedSelections, originalSaved);
  assert.equal(error(await call('prism_morph_layer_mask', { ...args, expectedRevision: before.revision, layerId, operation: 'expand', radius: 1 })).code, 'REVISION_CONFLICT');
  await edit('undo'); assert.deepEqual(document.layers, before.layers);
  assert.deepEqual((await image(await call('prism_get_preview', { ...args, maxWidth: 40 }))).data, expected);
});

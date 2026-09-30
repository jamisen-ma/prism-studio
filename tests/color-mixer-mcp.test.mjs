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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = response => { assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text); };
const failure = response => { assert.equal(response.isError, true); const text = response.content.find(item => item.type === 'text').text; try { return JSON.parse(text); } catch { return { message: text }; } };
const unpack = response => sharp(Buffer.from(response.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer();
const rgb = (pixels, x, y = 0) => [...pixels.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];

test('official MCP edits Channel Mixer and Gradient Map through filter and adjustment scopes with exact sources and protected pixels', { timeout: 25000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-color-mcp-'));
  const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { throw Error('No keys'); }, imageProvider: async () => { throw Error('No provider'); } });
  const port = await companion.listen(), client = new Client({ name: 'color-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(async () => { await client.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.ok(!stderr.includes(companion.token)); });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' }));
  for (const kind of ['channel_mixer', 'gradient_map']) { assert.ok(caps.adjustmentKinds.includes(kind)); assert.ok(caps.layerFilterKinds.includes(kind)); }
  assert.equal(caps.adjustmentKinds.length, 28); assert.equal(caps.layerFilterKinds.length, 32);
  assert.deepEqual(value(await call('status')).backends.find(item => item.id === 'native').layerFilterKinds, caps.layerFilterKinds);
  const pixels = Buffer.from(Array.from({ length: 32 * 24 }, (_, i) => [64, 128, 192, [0, 1, 128, 255][i % 4]]).flat());
  const source = await sharp(pixels, { raw: { width: 32, height: 24, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'original.png'); await fs.writeFile(input, source);
  let document = value(await call('import_file', { path: input, name: 'Editable color source' })).document;
  const rasterId = document.layers[0].id, args = () => ({ backend: 'native', documentId: document.id });
  async function edit(command, fields = {}) { document = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })).document; }
  async function preview(id = document.id) { const response = await call('get_preview', { backend: 'native', documentId: id, maxWidth: 32 }); value(response); return unpack(response); }
  async function original() { const response = await call('get_layer_preview', { ...args(), layerId: rasterId, view: 'source', maxWidth: 32 }); value(response); return unpack(response); }
  const initial = await preview(), originalPixels = await original(), assetDir = path.join(dataDir, 'native', 'assets'), assetNames = await fs.readdir(assetDir);
  const filter = id => document.layers[0].filters.find(entry => entry.id === id);
  await edit('add_layer_filter', { layerId: rasterId, kind: 'channel_mixer', value: 0 }); const mixerId = document.layers[0].filters[0].id;
  assert.deepEqual(await preview(), initial);
  await edit('update_layer_filter', { layerId: rasterId, filterId: mixerId, parameters: { red: [0, 0, 100, 0], blue: [100, 0, 0, 0] } });
  const swapped = await preview(); assert.deepEqual(rgb(swapped, 3), [192, 128, 64, 255]);
  const colorRows = structuredClone(filter(mixerId).parameters);
  await edit('update_layer_filter', { layerId: rasterId, filterId: mixerId, parameters: { monochrome: true, gray: [100, 0, 0, 0] } });
  assert.deepEqual(rgb(await preview(), 3), [64, 64, 64, 255]); assert.deepEqual(filter(mixerId).parameters.red, colorRows.red); assert.deepEqual(filter(mixerId).parameters.blue, colorRows.blue);
  await edit('update_layer_filter', { layerId: rasterId, filterId: mixerId, parameters: { monochrome: false } }); assert.deepEqual(await preview(), swapped);
  const stops = [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }];
  await edit('add_layer_filter', { layerId: rasterId, kind: 'gradient_map', value: 0, parameters: { stops } }); const mapId = document.layers[0].filters[1].id;
  assert.deepEqual(rgb(await preview(), 3), [118, 0, 137, 255]);
  await edit('update_layer_filter', { layerId: rasterId, filterId: mapId, parameters: { reverse: true } }); assert.deepEqual(filter(mapId).parameters.stops, stops); assert.deepEqual(rgb(await preview(), 3), [137, 0, 118, 255]);
  await edit('reorder_layer_filter', { layerId: rasterId, filterId: mapId, index: 0 }); assert.deepEqual(rgb(await preview(), 3), [136, 0, 119, 255]);
  await edit('update_layer_filter', { layerId: rasterId, filterId: mapId, enabled: false }); assert.deepEqual(await preview(), swapped);
  await edit('update_layer_filter', { layerId: rasterId, filterId: mixerId, opacity: 0 }); assert.deepEqual(await preview(), initial);
  await edit('undo'); assert.deepEqual(await preview(), swapped);
  await edit('update_layer_filter', { layerId: rasterId, filterId: mapId, enabled: true });
  const filtered = await preview();
  for (let i = 3; i < pixels.length; i += 4) assert.equal(filtered[i], pixels[i]);
  assert.deepEqual(await original(), originalPixels); assert.deepEqual(await fs.readdir(assetDir), assetNames);
  const intact = structuredClone(document);
  for (const fields of [{ parameters: { reverse: true } }, { parameters: { red: [100, 0, 0] } }, { parameters: { red: [100, 0, 0, 0.001] } }, { value: 1 }]) {
    failure(await call('update_layer_filter', { ...args(), expectedRevision: document.revision, layerId: rasterId, filterId: mixerId, ...fields }));
    assert.deepEqual(value(await call('get_document', args())).document, intact);
  }
  failure(await call('set_layer_protection', { ...args(), expectedRevision: document.revision, layerId: rasterId, protected: true }));
  assert.deepEqual(value(await call('get_document', args())).document, intact); assert.deepEqual(await preview(), filtered);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'color-portable-copy' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(await preview(restored.id), filtered);
  const psd = value(await call('inspect_psd_export', { documentId: document.id, expectedRevision: document.revision })); assert.equal(psd.supported, false); assert.ok(psd.issues.some(issue => issue.code === 'FILTER_STACK_UNSUPPORTED'));

  document = value(await call('create_document', { backend: 'native', name: 'Masked color scope', width: 32, height: 24, background: '#4080c0' })).document;
  const backgroundId = document.layers[0].id;
  await edit('select_rectangle', { x: 0, y: 0, width: 16, height: 24 });
  await edit('add_adjustment', { kind: 'channel_mixer', value: 0, parameters: { red: [0, 0, 100, 0], blue: [100, 0, 0, 0] } }); const adjustmentId = document.layers.at(-1).id;
  const capturedMask = structuredClone(document.layers.at(-1).mask);
  await edit('clear_selection'); assert.deepEqual(document.layers.find(layer => layer.id === adjustmentId).mask, capturedMask);
  let output = await preview(); assert.deepEqual(rgb(output, 3), [192, 128, 64, 255]); assert.deepEqual(rgb(output, 19), [64, 128, 192, 255]);
  await edit('add_adjustment', { kind: 'gradient_map', value: 0 }); const gradientId = document.layers.at(-1).id;
  output = await preview(); assert.deepEqual(rgb(output, 3), [137, 137, 137, 255]); assert.deepEqual(rgb(output, 19), [119, 119, 119, 255]);
  const beforeReverse = structuredClone(document), reversal = { ...args(), expectedRevision: document.revision, layerId: gradientId, parameters: { reverse: true }, requestId: 'reverse-map-once' };
  document = value(await call('update_adjustment', reversal)).document; assert.deepEqual(value(await call('update_adjustment', reversal)).document, document); assert.equal(document.history.length, beforeReverse.history.length + 1);
  output = await preview(); assert.deepEqual(rgb(output, 3), [118, 118, 118, 255]); assert.deepEqual(rgb(output, 19), [136, 136, 136, 255]);
  await edit('undo'); assert.deepEqual(rgb(await preview(), 3), [137, 137, 137, 255]); await edit('redo'); assert.deepEqual(await preview(), output);
  const beforeBad = structuredClone(document);
  failure(await call('apply_transaction', { ...args(), expectedRevision: document.revision, label: 'Reject mismatched parameters', operations: [
    { command: 'set_layer', args: { layerId: gradientId, name: 'Must roll back' } },
    { command: 'update_adjustment', args: { layerId: adjustmentId, parameters: { reverse: true } } },
  ] }));
  assert.deepEqual(value(await call('get_document', args())).document, beforeBad);
  assert.equal(failure(await call('update_adjustment', { ...args(), expectedRevision: document.revision - 1, layerId: gradientId, parameters: { reverse: false } })).code, 'REVISION_CONFLICT');
  await edit('set_layer_protection', { layerId: backgroundId, protected: true }); output = await preview();
  for (let i = 0; i < output.length; i += 4) assert.deepEqual([...output.subarray(i, i + 4)], [64, 128, 192, 255]);
  assert.deepEqual(await fs.readFile(input), source); assert.deepEqual(await fs.readdir(assetDir), assetNames);
});

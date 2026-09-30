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
function value(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
}
function failure(response) {
  assert.equal(response.isError, true);
  return JSON.parse(response.content.find(item => item.type === 'text').text);
}
async function pixels(response) {
  value(response);
  const content = response.content.find(item => item.type === 'image');
  assert.equal(content?.mimeType, 'image/png');
  return sharp(Buffer.from(content.data, 'base64')).ensureAlpha().raw().toBuffer();
}

test('MCP editable filter order, contextual protection, strict commands and portable round trips retain original assets', { timeout: 20000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-filter-mcp-'));
  const companion = await createCompanion({ dataDir, port: 0 });
  const port = await companion.listen();
  const client = new Client({ name: 'filter-stack-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root,
    env: { ...process.env, PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { await client.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.ok(!stderr.includes(companion.token)); });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const capabilities = value(await call('capabilities', { backend: 'native' }));
  assert.equal(capabilities.layerFilterCoordinates, 'source');
  assert.equal(capabilities.layerFilterKinds.length, 32);
  assert.ok(capabilities.layerFilterKinds.includes('blur')); assert.ok(capabilities.layerFilterKinds.includes('sharpen')); assert.equal(capabilities.layerFilterSpatialPolicy, 'alpha-weighted-gaussian-rgb-v1');
  const status = value(await call('status'));
  assert.deepEqual(status.backends.find(backend => backend.id === 'native').layerFilterKinds, capabilities.layerFilterKinds);
  const original = await sharp({ create: { width: 40, height: 32, channels: 4, background: '#285078' } }).png().toBuffer();
  const input = path.join(dataDir, 'original.png'); await fs.writeFile(input, original);
  let document = value(await call('import_file', { path: input })).document;
  const args = { backend: 'native', documentId: document.id }, bottomId = document.layers[0].id;
  async function edit(command, fields = {}) {
    document = value(await call(command, { ...args, expectedRevision: document.revision, ...fields })).document;
  }
  const preview = () => call('get_preview', { ...args, maxWidth: 40 });
  await edit('duplicate_layer', { layerId: bottomId });
  const topId = document.layers.at(-1).id;
  await edit('set_layer_mask', { layerId: bottomId, mask: { x: 0, y: 0, width: 20, height: 32 } });
  await edit('set_layer_protection', { layerId: bottomId, protected: true });
  const before = structuredClone(document), beforePixels = await pixels(await preview());
  const assetDirectory = path.join(dataDir, 'native', 'assets'), assets = await fs.readdir(assetDirectory);
  await edit('add_layer_filter', { layerId: topId, kind: 'brightness', value: 10 });
  const first = document.layers.find(layer => layer.id === topId).filters[0].id;
  await edit('add_layer_filter', { layerId: topId, kind: 'invert', value: 100 });
  const second = document.layers.find(layer => layer.id === topId).filters[1].id;
  const expected = Buffer.alloc(40 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 40; x++) expected.set(x < 20 ? [40, 80, 120, 255] : [189, 149, 109, 255], (y * 40 + x) * 4);
  assert.deepEqual(await pixels(await preview()), expected);
  assert.deepEqual(await pixels(await call('get_layer_preview', { ...args, layerId: topId, maxWidth: 40 })), expected, 'Isolated appearance must use the same lower protected footprint.');
  assert.deepEqual(await pixels(await call('get_layer_preview', { ...args, layerId: topId, view: 'source', maxWidth: 40 })), beforePixels);
  await edit('reorder_layer_filter', { layerId: topId, filterId: second, index: 0 });
  const reordered = await pixels(await preview());
  assert.deepEqual([...reordered.subarray(25 * 4, 26 * 4)], [241, 201, 161, 255]);
  await edit('undo'); assert.deepEqual(await pixels(await preview()), expected);
  const unchanged = structuredClone(document);
  for (const [command, fields] of [
    ['add_layer_filter', { layerId: bottomId, kind: 'invert', value: 100 }],
    ['set_layer_protection', { layerId: topId, protected: true }],
    ['fill_area', { layerId: topId, color: '#ffffff' }],
    ['update_layer_filter', { layerId: topId, filterId: first, value: 101 }],
  ]) {
    failure(await call(command, { ...args, expectedRevision: document.revision, ...fields }));
    assert.deepEqual(value(await call('get_document', args)).document, unchanged);
  }
  failure(await call('apply_transaction', { ...args, expectedRevision: document.revision, label: 'Must roll back filters', operations: [
    { command: 'update_layer_filter', args: { layerId: topId, filterId: first, value: 20 } },
    { command: 'set_layer_protection', args: { layerId: topId, protected: true } },
  ] }));
  assert.deepEqual(value(await call('get_document', args)).document, unchanged);
  assert.equal(failure(await call('clear_layer_filters', { ...args, expectedRevision: before.revision, layerId: topId })).code, 'REVISION_CONFLICT');
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'filter-round-trip' })).document;
  assert.notEqual(restored.id, document.id);
  assert.deepEqual(restored.layers, document.layers);
  assert.deepEqual(await pixels(await call('get_preview', { backend: 'native', documentId: restored.id, maxWidth: 40 })), expected);
  await edit('update_layer_filter', { layerId: topId, filterId: second, enabled: false });
  await edit('update_layer_filter', { layerId: topId, filterId: first, opacity: 0 });
  assert.deepEqual(await pixels(await preview()), beforePixels);
  await edit('set_layer_protection', { layerId: topId, protected: true });
  failure(await call('clear_layer_filters', { ...args, expectedRevision: document.revision, layerId: topId }));
  await edit('set_layer_protection', { layerId: topId, protected: false });
  await edit('delete_layer_filter', { layerId: topId, filterId: second });
  await edit('clear_layer_filters', { layerId: topId });
  assert.equal(document.layers.find(layer => layer.id === topId).filters?.length ?? 0, 0);
  assert.deepEqual(await pixels(await preview()), beforePixels);
  assert.deepEqual(await fs.readdir(assetDirectory), assets);
  assert.deepEqual(await fs.readFile(input), original);
});

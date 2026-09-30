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
const failure = response => { assert.equal(response.isError, true); return JSON.parse(response.content.find(item => item.type === 'text').text); };
const decode = response => sharp(Buffer.from(response.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer();

test('official MCP clips editable fills without thickening source alpha, roundtrips whole chains, and rejects partial structural edits', { timeout: 25000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-clipping-mcp-'));
  const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { throw Error('No keys'); }, imageProvider: async () => { throw Error('No provider'); } });
  const port = await companion.listen(), client = new Client({ name: 'clipping-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(async () => { await client.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.ok(!stderr.includes(companion.token)); });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' }));
  assert.deepEqual(caps.clippingLayerTypes, ['raster', 'solid', 'text', 'shape', 'path', 'gradient']); assert.equal(caps.clippingBlendPolicy, 'grouped-base');
  assert.deepEqual(value(await call('status')).backends.find(item => item.id === 'native').clippingLayerTypes, caps.clippingLayerTypes);
  const width = 40, height = 24, original = Buffer.from(Array.from({ length: width * height }, (_, p) => [p * 13 % 256, p * 17 % 256, p * 29 % 256, p % width < 4 || p % width >= 36 || p < width * 4 || p >= width * 20 ? 0 : [1, 128, 255][p % 3]]).flat());
  const png = await sharp(original, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'source.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Soft silhouette' })).document;
  const args = { backend: 'native', documentId: document.id }, baseId = document.layers[0].id;
  async function edit(command, fields = {}) { document = value(await call(command, { ...args, expectedRevision: document.revision, ...fields })).document; }
  async function preview(id = document.id) { const response = await call('get_preview', { backend: 'native', documentId: id, maxWidth: 100 }); value(response); return decode(response); }
  async function layerPreview(layerId, view = 'layer') { const response = await call('get_layer_preview', { ...args, layerId, view, maxWidth: 100 }); value(response); return decode(response); }
  for (const [name, color] of [['Warm fill', '#804020'], ['Cool fill', '#204080']]) await edit('add_gradient', { name, kind: 'linear', start: { x: 0, y: 0 }, end: { x: width, y: 0 }, stops: [{ offset: 0, color }, { offset: 1, color }] });
  const [firstId, secondId] = document.layers.slice(1).map(layer => layer.id);
  await edit('set_layer', { layerId: secondId, opacity: 0.5 });
  const before = structuredClone(document), unlinked = await preview(), source = await layerPreview(baseId, 'source');
  const linkArgs = { ...args, expectedRevision: document.revision, baseLayerId: baseId, layerIds: [firstId, secondId], requestId: 'clip-once' };
  document = value(await call('set_clipping_chain', linkArgs)).document;
  assert.deepEqual(value(await call('set_clipping_chain', linkArgs)).document, document); assert.equal(document.history.length, before.history.length + 1);
  assert.deepEqual(document.layers.map(layer => layer.clipBaseId), [undefined, baseId, baseId]);
  const clipped = await preview();
  for (let i = 0; i < original.length; i += 4) {
    assert.equal(clipped[i + 3], original[i + 3], `alpha at ${i / 4}`);
    if (original[i + 3]) assert.deepEqual([...clipped.subarray(i, i + 3)], [80, 64, 80]);
  }
  assert.deepEqual(await layerPreview(baseId), clipped); assert.deepEqual(await layerPreview(baseId, 'source'), source);
  const member = await layerPreview(secondId);
  for (let i = 0; i < member.length; i += 4) assert.equal(member[i + 3], Math.round(original[i + 3] * 0.5));
  await edit('undo'); assert.deepEqual(await preview(), unlinked);
  await edit('redo'); assert.deepEqual(await preview(), clipped);
  const psd = value(await call('inspect_psd_export', { documentId: document.id, expectedRevision: document.revision }));
  assert.equal(psd.supported, false); assert.ok(psd.issues.some(issue => issue.code === 'CLIPPING_UNSUPPORTED'));
  const intact = structuredClone(document), assetsDir = path.join(dataDir, 'native', 'assets'), assetNames = await fs.readdir(assetsDir);
  for (const [command, fields] of [
    ['set_clipping_chain', { baseLayerId: baseId, layerIds: [secondId, firstId] }],
    ['set_layer_protection', { layerId: baseId, protected: true }],
    ['set_layer_protection', { layerId: firstId, protected: true }],
    ['set_layer_outline', { layerId: secondId, width: 1, color: '#ffffff' }],
    ['delete_layer', { layerId: firstId }], ['duplicate_layer', { layerId: baseId }],
    ['reorder_layer', { layerId: secondId, index: 0 }],
    ['move_layer', { layerId: firstId, parentId: null, index: 0 }],
    ['group_layers', { layerIds: [baseId, firstId] }],
  ]) {
    failure(await call(command, { ...args, expectedRevision: document.revision, ...fields }));
    assert.deepEqual(value(await call('get_document', args)).document, intact); assert.deepEqual(await preview(), clipped);
  }
  failure(await call('apply_transaction', { ...args, expectedRevision: document.revision, label: 'No partial clipping edit', operations: [
    { command: 'set_layer', args: { layerId: baseId, name: 'Must roll back' } },
    { command: 'set_clipping_chain', args: { baseLayerId: baseId, layerIds: [secondId] } },
  ] }));
  assert.deepEqual(value(await call('get_document', args)).document, intact);
  assert.equal(failure(await call('set_clipping_chain', { ...args, expectedRevision: document.revision - 1, baseLayerId: baseId, layerIds: [] })).code, 'REVISION_CONFLICT');
  assert.deepEqual(await fs.readdir(assetsDir), assetNames);
  await edit('group_layers', { layerIds: [baseId, firstId, secondId], name: 'Complete clipping group' });
  const groupId = document.layers.find(layer => layer.type === 'group').id;
  await edit('set_group_compositing', { layerId: groupId, mode: 'isolated' }); assert.deepEqual(await preview(), clipped);
  await edit('rasterize_layer', { layerId: firstId });
  assert.equal(document.layers.find(layer => layer.id === firstId).type, 'raster'); assert.equal(document.layers.find(layer => layer.id === firstId).clipBaseId, baseId); assert.deepEqual(await preview(), clipped);
  await edit('duplicate_layer', { layerId: groupId });
  const copyGroup = document.layers.find(layer => layer.type === 'group' && layer.id !== groupId), copied = document.layers.filter(layer => layer.parentId === copyGroup.id);
  assert.equal(copied.length, 3); assert.equal(copied[0].clipBaseId, undefined); assert.deepEqual(copied.slice(1).map(layer => layer.clipBaseId), [copied[0].id, copied[0].id]);
  await edit('set_layer', { layerId: copyGroup.id, visible: false }); assert.deepEqual(await preview(), clipped);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'clipping-portable-copy' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(await preview(restored.id), clipped);
  await edit('set_clipping_chain', { baseLayerId: baseId, layerIds: [] }); assert.ok(document.layers.filter(layer => layer.parentId === groupId).every(layer => layer.clipBaseId === undefined));
  assert.deepEqual(await preview(), unlinked);
  await edit('undo'); assert.deepEqual(await preview(), clipped);
  assert.deepEqual(await layerPreview(baseId, 'source'), source); assert.deepEqual(await fs.readFile(input), png);
});

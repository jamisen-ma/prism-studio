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
const rgb = (pixels, x, y) => [...pixels.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];

test('official MCP scopes isolated adjustments/blends, keeps history and portable state, and refuses protected isolation changes', { timeout: 20000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-isolated-mcp-'));
  const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { throw Error('No keys'); }, imageProvider: async () => { throw Error('No provider'); } });
  const port = await companion.listen(), client = new Client({ name: 'isolated-group-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(async () => { await client.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.ok(!stderr.includes(companion.token)); });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' }));
  assert.deepEqual(caps.groupModes, ['pass-through', 'isolated']); assert.equal(caps.groupBlendModes.length, 27);
  const status = value(await call('status')); assert.deepEqual(status.backends.find(item => item.id === 'native').groupBlendModes, caps.groupBlendModes);
  let document = value(await call('create_document', { backend: 'native', name: 'Scoped group adjustment', width: 8, height: 8, background: '#204060' })).document;
  const args = { backend: 'native', documentId: document.id };
  async function edit(command, fields = {}) { document = value(await call(command, { ...args, expectedRevision: document.revision, ...fields })).document; }
  async function preview(id = document.id) { const response = await call('get_preview', { backend: 'native', documentId: id, maxWidth: 32 }); value(response); return sharp(Buffer.from(response.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer(); }
  await edit('add_shape', { shape: 'rectangle', x: 2, y: 2, width: 4, height: 4, fill: '#804020', name: 'Inside only' }); const leafId = document.layers.at(-1).id;
  await edit('add_adjustment', { kind: 'invert', value: 100 }); const adjustmentId = document.layers.at(-1).id;
  await edit('group_layers', { layerIds: [leafId, adjustmentId], name: 'Local grading' }); const groupId = document.layers.find(layer => layer.type === 'group').id;
  const pass = await preview(); assert.deepEqual(rgb(pass, 0, 0), [223, 191, 159, 255]); assert.deepEqual(rgb(pass, 3, 3), [127, 191, 223, 255]);
  const prior = structuredClone(document);
  const isolation = { ...args, expectedRevision: document.revision, layerId: groupId, mode: 'isolated', requestId: 'isolate-once' };
  document = value(await call('set_group_compositing', isolation)).document;
  assert.deepEqual(value(await call('set_group_compositing', isolation)).document, document); assert.equal(document.history.length, prior.history.length + 1);
  const isolated = await preview(); assert.deepEqual(rgb(isolated, 0, 0), [32, 64, 96, 255]); assert.deepEqual(rgb(isolated, 3, 3), [127, 191, 223, 255]);
  assert.deepEqual(document.layers.filter(layer => layer.id !== groupId), prior.layers.filter(layer => layer.id !== groupId));
  await edit('undo'); assert.deepEqual(await preview(), pass);
  await edit('redo'); assert.deepEqual(await preview(), isolated);
  await edit('set_group_compositing', { layerId: groupId, mode: 'isolated', blendMode: 'multiply' });
  assert.deepEqual(rgb(await preview(), 3, 3), [16, 48, 84, 255]);
  await edit('set_layer', { layerId: groupId, opacity: 0.5 });
  assert.deepEqual(rgb(await preview(), 3, 3), [24, 56, 90, 255]);
  await edit('set_layer_mask', { layerId: groupId, mask: { x: 0, y: 0, width: 8, height: 4 } });
  const masked = await preview(); assert.deepEqual(rgb(masked, 3, 3), [24, 56, 90, 255]); assert.deepEqual(rgb(masked, 3, 5), [32, 64, 96, 255]);
  const exported = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: exported.path, requestId: 'isolated-project-copy' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(await preview(restored.id), masked);
  assert.equal(failure(await call('ungroup_layer', { ...args, expectedRevision: document.revision, layerId: groupId })).code, 'INVALID_TARGET');
  await edit('set_layer', { layerId: groupId, opacity: 1 });
  await edit('set_group_compositing', { layerId: groupId, mode: 'isolated', blendMode: 'normal' });
  await edit('set_layer_protection', { layerId: leafId, protected: true });
  const protectedState = structuredClone(document), protectedPixels = await preview();
  const invalid = [
    ['set_group_compositing', { layerId: groupId, mode: 'pass-through' }],
    ['set_group_compositing', { layerId: groupId, mode: 'isolated', blendMode: 'screen' }],
    ['set_layer', { layerId: groupId, blendMode: 'multiply' }],
    ['move_layer', { layerId: leafId, parentId: null }],
  ];
  for (const [command, fields] of invalid) {
    assert.equal(failure(await call(command, { ...args, expectedRevision: document.revision, ...fields })).code, 'PROTECTED_LAYER');
    assert.deepEqual(value(await call('get_document', args)).document, protectedState);
    assert.deepEqual(await preview(), protectedPixels);
  }
  assert.equal(failure(await call('apply_transaction', { ...args, expectedRevision: document.revision, label: 'Rollback isolation change', operations: [
    { command: 'set_layer', args: { layerId: groupId, name: 'Must not persist' } },
    { command: 'set_group_compositing', args: { layerId: groupId, mode: 'pass-through' } },
  ] })).code, 'PROTECTED_LAYER');
  assert.deepEqual(value(await call('get_document', args)).document, protectedState);
  assert.equal(failure(await call('set_group_compositing', { ...args, expectedRevision: document.revision - 1, layerId: groupId, mode: 'isolated' })).code, 'REVISION_CONFLICT');
});

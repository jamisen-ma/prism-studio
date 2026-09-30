import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = response => { assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text); };
const failure = response => { assert.equal(response.isError, true); return JSON.parse(response.content.find(item => item.type === 'text').text); };
const nonStyle = layer => { const { outline, effects, ...rest } = layer; return rest; };

test('official MCP style library copies only outside styles, applies atomically, survives portable transfer and preserves original pixels', { timeout: 20000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-style-mcp-'));
  const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { throw Error('No keys'); }, imageProvider: async () => { throw Error('No provider'); } });
  const port = await companion.listen(), client = new Client({ name: 'layer-style-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(async () => { await client.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.ok(!stderr.includes(companion.token)); });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' }));
  assert.deepEqual(caps.layerStyleProperties, ['outline', 'shadow', 'glow']); assert.equal(caps.limits.maxLayerStyles, 32);
  const status = value(await call('status')); assert.deepEqual(status.backends.find(item => item.id === 'native').layerStyleProperties, caps.layerStyleProperties);
  const pixels = Buffer.alloc(32 * 24 * 4);
  for (let y = 6; y < 18; y++) for (let x = 8; x < 24; x++) pixels.set([x * 7, y * 9, 80, [1, 128, 255][x % 3]], (y * 32 + x) * 4);
  const source = await sharp(pixels, { raw: { width: 32, height: 24, channels: 4 } }).png().toBuffer();
  const input = path.join(dataDir, 'original.png'); await fs.writeFile(input, source);
  let document = value(await call('import_file', { path: input, name: 'Reusable styles' })).document;
  const args = { backend: 'native', documentId: document.id }, sourceId = document.layers[0].id;
  async function edit(command, fields = {}) { document = value(await call(command, { ...args, expectedRevision: document.revision, ...fields })).document; }
  await edit('duplicate_layer', { layerId: sourceId }); const targetId = document.layers.at(-1).id;
  await edit('add_layer_filter', { layerId: targetId, kind: 'brightness', value: 5 });
  await edit('set_layer_mask', { layerId: targetId, mask: { x: 9, y: 5, width: 18, height: 15 } });
  await edit('set_layer_protection', { layerId: sourceId, protected: true });
  await edit('set_layer_outline', { layerId: sourceId, width: 2, color: '#fff2e2' });
  await edit('set_layer_effects', { layerId: sourceId, effects: { shadow: { blur: 1, x: 3, y: 2, opacity: 0.35, color: '#563921' } } });
  const beforeSave = await companion.native.renderGraph(document);
  await edit('save_layer_style', { layerId: sourceId, name: 'Soft autumn outline', requestId: 'save-style-once' });
  assert.equal(document.layerStyles.length, 1); const styleId = document.layerStyles[0].id;
  assert.deepEqual(await companion.native.renderGraph(document), beforeSave);
  assert.deepEqual(Object.keys(document.layerStyles[0]).sort(), ['effects', 'id', 'name', 'outline']);
  const initialStyle = structuredClone(document.layerStyles[0]);
  await edit('set_layer_outline', { layerId: targetId, width: 4, color: '#ff00ff' });
  await edit('set_layer_effects', { layerId: targetId, effects: { glow: { blur: 2, color: '#00ffff', opacity: 0.6 } } });
  const beforeApply = structuredClone(document), assetDir = path.join(dataDir, 'native', 'assets');
  const assets = await fs.readdir(assetDir), rawBefore = await Promise.all(document.layers.map(layer => companion.native.renderLayer(layer)));
  const applyArgs = { ...args, expectedRevision: document.revision, styleId, layerIds: [sourceId, targetId], requestId: 'apply-style-once' };
  document = value(await call('apply_layer_style', applyArgs)).document;
  assert.deepEqual(value(await call('apply_layer_style', applyArgs)).document, document);
  assert.equal(document.history.length, beforeApply.history.length + 1);
  for (const layer of document.layers) { assert.deepEqual(nonStyle(layer), nonStyle(beforeApply.layers.find(item => item.id === layer.id))); assert.deepEqual(layer.outline, initialStyle.outline); assert.deepEqual(layer.effects, initialStyle.effects); }
  assert.deepEqual(await Promise.all(document.layers.map(layer => companion.native.renderLayer(layer))), rawBefore);
  assert.deepEqual(await fs.readdir(assetDir), assets); assert.deepEqual(await fs.readFile(input), source);
  await edit('undo'); assert.deepEqual(document.layers, beforeApply.layers);
  await edit('redo');
  const layersAfterApply = structuredClone(document.layers);
  await edit('rename_layer_style', { styleId, name: 'Warm outline' }); assert.deepEqual(document.layers, layersAfterApply);
  await edit('set_layer_outline', { layerId: sourceId, width: 0 });
  await edit('save_layer_style', { layerId: sourceId, styleId });
  assert.equal(document.layerStyles[0].id, styleId); assert.equal(document.layerStyles[0].name, 'Warm outline');
  assert.deepEqual(document.layers.find(layer => layer.id === targetId).outline, initialStyle.outline, 'Preset overwrite does not restyle prior targets.');
  await edit('apply_layer_style', { styleId, layerIds: [targetId] });
  assert.ok(!document.layers.find(layer => layer.id === targetId).outline?.width, 'A preset without an outline clears the target outline.');
  await edit('create_group', { name: 'Invalid style target' }); const groupId = document.layers.find(layer => layer.type === 'group').id;
  const beforeReject = structuredClone(document), beforeRejectPixels = await companion.native.renderGraph(document);
  const rejected = failure(await call('apply_transaction', { ...args, expectedRevision: document.revision, label: 'Must roll back all changes', operations: [
    { command: 'rename_layer_style', args: { styleId, name: 'Must not persist' } },
    { command: 'apply_layer_style', args: { styleId, layerIds: [targetId, groupId] } },
  ] })); assert.equal(rejected.code, 'INVALID_TARGET');
  assert.deepEqual(value(await call('get_document', args)).document, beforeReject); assert.deepEqual(await companion.native.renderGraph(document), beforeRejectPixels);
  assert.equal(failure(await call('apply_layer_style', { ...args, expectedRevision: document.revision - 1, styleId, layerIds: [targetId] })).code, 'REVISION_CONFLICT');
  const exported = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: exported.path, requestId: 'style-project-roundtrip' })).document;
  assert.deepEqual(restored.layerStyles, document.layerStyles); assert.deepEqual(restored.layers, document.layers); assert.deepEqual(await companion.native.renderGraph(restored), beforeRejectPixels);
  const beforeDelete = structuredClone(document.layers);
  await edit('delete_layer_style', { styleId }); assert.deepEqual(document.layerStyles, []); assert.deepEqual(document.layers, beforeDelete);
  await edit('undo'); assert.equal(document.layerStyles[0].id, styleId);
});

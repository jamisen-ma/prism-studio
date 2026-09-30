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

test('official MCP guides retain source pixels, follow canvas geometry, preserve stable IDs and portable state, and reject invalid transactions', { timeout: 20000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-guides-mcp-'));
  const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { throw Error('No keys'); }, imageProvider: async () => { throw Error('No provider'); } });
  const port = await companion.listen(), client = new Client({ name: 'guide-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(async () => { await client.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.ok(!stderr.includes(companion.token)); });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' }));
  assert.deepEqual(caps.guideAxes, ['horizontal', 'vertical']); assert.equal(caps.guideCoordinates, 'document-pixels'); assert.equal(caps.limits.maxGuides, 64);
  const status = value(await call('status')); assert.deepEqual(status.backends.find(item => item.id === 'native').guideAxes, caps.guideAxes);
  const pixels = Buffer.from(Array.from({ length: 40 * 30 }, (_, i) => [i * 13 % 256, i * 17 % 256, i * 29 % 256, [0, 1, 128, 255][i % 4]]).flat());
  const source = await sharp(pixels, { raw: { width: 40, height: 30, channels: 4 } }).png().toBuffer();
  const input = path.join(dataDir, 'original.png'); await fs.writeFile(input, source);
  let document = value(await call('import_file', { path: input, name: 'Guided source' })).document;
  assert.deepEqual(document.guides, []);
  const args = { backend: 'native', documentId: document.id };
  async function edit(command, fields = {}) { document = value(await call(command, { ...args, expectedRevision: document.revision, ...fields })).document; }
  async function preview(id = document.id) { const response = await call('get_preview', { backend: 'native', documentId: id, maxWidth: 100 }); value(response); return Buffer.from(response.content.find(item => item.type === 'image').data, 'base64'); }
  await edit('set_layer_protection', { layerId: document.layers[0].id, protected: true });
  const initial = structuredClone(document), initialPreview = await preview(), assetDir = path.join(dataDir, 'native', 'assets'), assets = await fs.readdir(assetDir);
  for (const [axis, positions] of [['vertical', [0, 10, 40]], ['horizontal', [0, 15, 30]]]) for (const position of positions) await edit('add_guide', { axis, position });
  assert.equal(document.guides.length, 6); assert.deepEqual(document.layers, initial.layers); assert.deepEqual(await preview(), initialPreview);
  assert.deepEqual(await fs.readdir(assetDir), assets); assert.deepEqual(await fs.readFile(input), source);
  const moving = document.guides[1], updateArgs = { ...args, expectedRevision: document.revision, guideId: moving.id, position: 12, requestId: 'move-guide-once' };
  const beforeUpdate = structuredClone(document);
  document = value(await call('update_guide', updateArgs)).document; assert.deepEqual(value(await call('update_guide', updateArgs)).document, document);
  assert.equal(document.history.length, beforeUpdate.history.length + 1); assert.deepEqual(document.guides[1], { ...moving, position: 12 });
  const geometryStart = structuredClone(document.guides);
  await edit('resize_document', { width: 60, height: 45 });
  assert.deepEqual(document.guides, geometryStart.map(guide => ({ ...guide, position: Math.round(guide.position * 1.5) })));
  const resized = structuredClone(document.guides);
  await edit('crop_document', { x: 10, y: 5, width: 40, height: 30 });
  const cropped = resized.map(guide => ({ ...guide, position: guide.position - (guide.axis === 'vertical' ? 10 : 5) })).filter(guide => guide.position >= 0 && guide.position <= (guide.axis === 'vertical' ? 40 : 30));
  assert.deepEqual(document.guides, cropped); assert.equal(cropped.length, 2);
  await edit('resize_canvas', { width: 50, height: 40, anchor: 'center' });
  assert.deepEqual(document.guides, cropped.map(guide => ({ ...guide, position: guide.position + 5 })));
  const expanded = structuredClone(document), expandedPreview = await preview();
  await edit('undo'); assert.deepEqual(document.guides, cropped);
  await edit('redo'); assert.deepEqual(document.guides, expanded.guides); assert.deepEqual(await preview(), expandedPreview);
  const beforeReject = structuredClone(document);
  failure(await call('apply_transaction', { ...args, expectedRevision: document.revision, label: 'Reject invalid guide atomically', operations: [
    { command: 'add_guide', args: { axis: 'vertical', position: 1 } },
    { command: 'add_guide', args: { axis: 'horizontal', position: 41 } },
  ] }));
  assert.deepEqual(value(await call('get_document', args)).document, beforeReject); assert.deepEqual(await preview(), expandedPreview);
  assert.equal(failure(await call('clear_guides', { ...args, expectedRevision: document.revision - 1 })).code, 'REVISION_CONFLICT');
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'guides-portable-copy' })).document;
  assert.deepEqual(restored.guides, document.guides); assert.deepEqual(restored.layers, document.layers); assert.deepEqual(await preview(restored.id), expandedPreview);
  const beforeDelete = structuredClone(document.guides);
  await edit('delete_guide', { guideId: document.guides[0].id }); assert.equal(document.guides.length, beforeDelete.length - 1);
  await edit('undo'); assert.deepEqual(document.guides, beforeDelete);
  await edit('clear_guides'); assert.deepEqual(document.guides, []); assert.deepEqual(await preview(), expandedPreview);
  await edit('undo'); assert.deepEqual(document.guides, beforeDelete); assert.deepEqual(await fs.readFile(input), source); assert.deepEqual(await fs.readdir(assetDir), assets);
});

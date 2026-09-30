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

 test('official MCP mask density preserves raw masks and source pixels through edits, retries, rollback, portable projects and PSD precision checks', { timeout: 25000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-density-mcp-'));
  const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { throw Error('No keys'); }, imageProvider: async () => { throw Error('No provider'); } });
  const port = await companion.listen(), client = new Client({ name: 'mask-density-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(async () => { await client.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.ok(!stderr.includes(companion.token)); });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' }));
  assert.deepEqual(caps.layerMaskProperties, ['feather', 'invert', 'density']);
  assert.deepEqual(value(await call('status')).backends.find(item => item.id === 'native').layerMaskProperties, caps.layerMaskProperties);
  const pixels = Buffer.from(Array.from({ length: 32 * 24 }, (_, i) => [30, 120, 210, [0, 1, 128, 255][i % 4]]).flat());
  const source = await sharp(pixels, { raw: { width: 32, height: 24, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'original.png'); await fs.writeFile(input, source);
  let document = value(await call('import_file', { path: input, name: 'Density source' })).document;
  const sourceId = document.layers[0].id, args = () => ({ backend: 'native', documentId: document.id });
  const layer = () => document.layers.find(item => item.id === sourceId);
  async function edit(command, fields = {}) { document = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })).document; }
  async function preview(id = document.id) { const response = await call('get_preview', { backend: 'native', documentId: id, maxWidth: 32 }); value(response); return unpack(response); }
  async function original() { const response = await call('get_layer_preview', { ...args(), layerId: sourceId, view: 'source', maxWidth: 32 }); value(response); return unpack(response); }
  const initial = await preview(), originalPixels = await original(), assetDir = path.join(dataDir, 'native', 'assets'), assetNames = await fs.readdir(assetDir);
  assert.equal(failure(await call('modify_layer_mask', { ...args(), layerId: sourceId, density: 0 })).code, 'NO_MASK');
  await edit('set_layer_mask', { layerId: sourceId, mask: { x: 0, y: 0, width: 16, height: 24 } });
  const rawMask = structuredClone(layer().mask), fullMask = await preview(), before = structuredClone(document);
  const once = { ...args(), expectedRevision: document.revision, layerId: sourceId, density: 0.5, requestId: 'density-once' };
  document = value(await call('modify_layer_mask', once)).document;
  assert.deepEqual(value(await call('modify_layer_mask', once)).document, document);
  assert.equal(document.history.length, before.history.length + 1); assert.deepEqual(layer().mask, rawMask); assert.equal(layer().maskDensity, 0.5);
  const half = await preview();
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
    const i = (y * 32 + x) * 4, alpha = Math.round(pixels[i + 3] * (x < 16 ? 1 : 0.5));
    assert.equal(half[i + 3], alpha); if (alpha) assert.deepEqual([...half.subarray(i, i + 3)], [30, 120, 210]);
  }
  await edit('undo'); assert.deepEqual(await preview(), fullMask); assert.equal(layer().maskDensity, undefined);
  await edit('redo'); assert.deepEqual(await preview(), half); assert.equal(layer().maskDensity, 0.5);
  const intact = structuredClone(document);
  for (const density of [-0.1, 1.1, '0.5']) {
    failure(await call('modify_layer_mask', { ...args(), expectedRevision: document.revision, layerId: sourceId, density }));
    assert.deepEqual(value(await call('get_document', args())).document, intact);
  }
  assert.equal(failure(await call('modify_layer_mask', { ...args(), expectedRevision: document.revision - 1, layerId: sourceId, density: 0 })).code, 'REVISION_CONFLICT');
  failure(await call('apply_transaction', { ...args(), expectedRevision: document.revision, label: 'Rollback density', operations: [
    { command: 'modify_layer_mask', args: { layerId: sourceId, density: 0 } },
    { command: 'modify_layer_mask', args: { layerId: 'missing-layer', density: 0.5 } },
  ] }));
  assert.deepEqual(value(await call('get_document', args())).document, intact); assert.deepEqual(await preview(), half);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'density-portable-copy' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(await preview(restored.id), half);
  await edit('modify_layer_mask', { layerId: sourceId, density: 0 }); assert.deepEqual(await preview(), initial); assert.deepEqual(layer().mask, rawMask);
  await edit('modify_layer_mask', { layerId: sourceId, feather: 2, invert: true }); assert.equal(layer().maskDensity, 0); assert.deepEqual(await preview(), initial);
  await edit('modify_layer_mask', { layerId: sourceId, density: 1 }); assert.equal(layer().maskDensity, undefined); assert.equal(layer().mask.feather, 2); assert.equal(layer().mask.invert, true);
  await edit('modify_layer_mask', { layerId: sourceId, density: 0.25 });
  await edit('set_layer_mask', { layerId: sourceId, mask: rawMask }); assert.equal(layer().maskDensity, undefined); assert.deepEqual(await preview(), fullMask);
  await edit('modify_layer_mask', { layerId: sourceId, density: 0.25 });
  await edit('set_layer_mask', { layerId: sourceId, mask: null }); assert.equal(layer().maskDensity, undefined); assert.equal(layer().mask, null); assert.deepEqual(await preview(), initial);
  assert.deepEqual(await original(), originalPixels); assert.deepEqual(await fs.readFile(input), source); assert.deepEqual(await fs.readdir(assetDir), assetNames);

  document = value(await call('create_document', { backend: 'native', name: 'Density PSD precision', width: 32, height: 24, background: '#ffffff' })).document;
  await edit('duplicate_layer', { layerId: document.layers[0].id }); const topId = document.layers.at(-1).id;
  await edit('set_layer_mask', { layerId: topId, mask: { x: 0, y: 0, width: 16, height: 24 } });
  await edit('modify_layer_mask', { layerId: topId, density: 0.5 });
  let psd = value(await call('inspect_psd_export', { documentId: document.id, expectedRevision: document.revision }));
  assert.equal(psd.supported, false); assert.ok(psd.issues.some(issue => issue.code === 'MASK_NOT_REPRESENTABLE'));
  await edit('modify_layer_mask', { layerId: topId, density: 128 / 255 });
  psd = value(await call('inspect_psd_export', { documentId: document.id, expectedRevision: document.revision }));
  assert.equal(psd.supported, true); assert.match(psd.warnings.find(item => item.code === 'MASK_RASTERIZED').message, /density, feather and inversion baked/);
  const exported = value(await call('export_psd', { documentId: document.id, expectedRevision: document.revision }));
  assert.equal((await fs.readFile(exported.path)).subarray(0, 4).toString(), '8BPS');
});

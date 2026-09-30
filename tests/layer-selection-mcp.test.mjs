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
function selectionBytes(mask, width, height) {
  assert.equal(mask.shape, 'bitmap'); assert.equal(mask.width, width); assert.equal(mask.height, height);
  assert.ok(!mask.invert && !mask.feather && !mask.clip); assert.equal(mask.maskDensity, undefined); assert.equal(mask.density, undefined);
  const out = Buffer.alloc(width * height);
  for (let i = 0; i < mask.runs.length; i += 3) out.fill(mask.runs[i + 2], mask.runs[i], mask.runs[i] + mask.runs[i + 1]);
  return out;
}

test('official MCP reuses exact layer alpha and mask coverage with empty-selection safety, atomic transactions, retries and portable/restart persistence', { timeout: 30000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-layer-selection-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('No model, provider or credentials'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
    const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'layer-selection-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', chunk => { stderr += chunk; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.ok(caps.commands.includes('load_layer_selection'));
  for (const [key, expected] of Object.entries({ layerSelectionSources: ['content', 'layer-mask'], layerSelectionMaskModes: ['raw', 'effective'], layerSelectionContentTypes: ['raster', 'solid', 'text', 'shape', 'path', 'gradient'] })) { assert.deepEqual(caps[key], expected); assert.deepEqual(status[key], expected); }
  const tool = (await client.listTools()).tools.find(item => item.name === 'prism_load_layer_selection');
  assert.equal(tool.annotations.readOnlyHint, false); assert.ok(tool.inputSchema.properties.layerId); assert.match(tool.description, /without segmentation/);

  const width = 32, height = 24;
  const pixels = Buffer.from(Array.from({ length: width * height }, (_, p) => [p * 13 % 256, p * 17 % 256, p * 29 % 256, [0, 1, 128, 255][p % 4]]).flat());
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'original.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Source alpha' })).document;
  const sourceId = document.layers[0].id, assetDir = path.join(dataDir, 'native/assets');
  const args = () => ({ backend: 'native', documentId: document.id });
  async function edit(command, fields = {}) { document = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })).document; }
  const selection = () => selectionBytes(document.selection, width, height);
  async function preview() { const response = await call('get_preview', { ...args(), maxWidth: 32 }); value(response); return sharp(Buffer.from(response.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer(); }
  await edit('set_layer_mask', { layerId: sourceId, mask: { x: 0, y: 0, width: 16, height: 24 } });
  await edit('modify_layer_mask', { layerId: sourceId, density: 0.5 });
  await edit('set_layer', { layerId: sourceId, opacity: 0, visible: false });
  await edit('set_layer_outline', { layerId: sourceId, width: 2 });
  await edit('add_layer_filter', { layerId: sourceId, kind: 'invert', value: 100 });
  await edit('transform_layer', { layerId: sourceId, x: 2, y: 1 });
  const alpha = Buffer.alloc(width * height);
  for (let y = 1; y < height; y++) for (let x = 2; x < width; x++) alpha[y * width + x] = pixels[((y - 1) * width + x - 2) * 4 + 3];
  const unchangedLayers = structuredClone(document.layers), beforePreview = await preview(), assetNames = await fs.readdir(assetDir), history = document.history.length;
  const once = { ...args(), expectedRevision: document.revision, layerId: sourceId, requestId: 'load-source-once' };
  document = value(await call('load_layer_selection', once)).document;
  assert.deepEqual(selection(), alpha); assert.deepEqual(document.layers, unchangedLayers); assert.equal(document.history.length, history + 1);
  assert.deepEqual(value(await call('load_layer_selection', once)).document, document); assert.deepEqual(await preview(), beforePreview);
  assert.deepEqual(await fs.readdir(assetDir), assetNames); assert.deepEqual(await fs.readFile(path.join(assetDir, document.layers[0].sourceAsset)), png);
  await edit('save_selection', { name: 'Exact source silhouette' }); const saved = structuredClone(document.savedSelections);
  const raw = Buffer.from(Array.from({ length: width * height }, (_, p) => p % width < 16 ? 255 : 0)), effective = Buffer.from(raw.map(byte => byte ? 255 : 128));
  await edit('load_layer_selection', { layerId: sourceId, source: 'layer-mask', maskMode: 'raw' }); assert.deepEqual(selection(), raw);
  await edit('load_layer_selection', { layerId: sourceId, source: 'layer-mask' }); assert.deepEqual(selection(), effective);
  await edit('load_layer_selection', { layerId: sourceId, source: 'layer-mask', invert: true }); assert.deepEqual(selection(), Buffer.from(effective.map(byte => 255 - byte)));
  await edit('load_layer_selection', { layerId: sourceId, mode: 'intersect' }); assert.deepEqual(selection(), Buffer.from(alpha.map((byte, p) => Math.round(byte * (255 - effective[p]) / 255))));
  assert.deepEqual(document.savedSelections, saved);
  const intact = structuredClone(document);
  for (const fields of [{ source: 'content', maskMode: 'raw' }, { source: 'wrong' }, { invert: 'true' }, { layerId: 'missing' }]) { failure(await call('load_layer_selection', { ...args(), layerId: sourceId, ...fields })); assert.deepEqual(value(await call('get_document', args())).document, intact); }
  assert.equal(failure(await call('load_layer_selection', { ...args(), layerId: sourceId, expectedRevision: document.revision - 1 })).code, 'REVISION_CONFLICT');
  failure(await call('apply_transaction', { ...args(), expectedRevision: document.revision, label: 'Roll back alpha selection', operations: [
    { command: 'load_layer_selection', args: { layerId: sourceId, invert: true } }, { command: 'load_layer_selection', args: { layerId: 'missing' } },
  ] })); assert.deepEqual(value(await call('get_document', args())).document, intact);
  const transactionHistory = document.history.length;
  await edit('apply_transaction', { label: 'Load and save exact alpha', operations: [
    { command: 'load_layer_selection', args: { layerId: sourceId } }, { command: 'save_selection', args: { name: 'Transaction alpha' } },
  ] }); assert.equal(document.history.length, transactionHistory + 1); assert.deepEqual(selection(), alpha);
  await edit('undo'); assert.deepEqual(document.selection, intact.selection); assert.deepEqual(document.savedSelections, intact.savedSelections);
  await edit('redo'); assert.deepEqual(selection(), alpha);
  await edit('add_paint_layer', { name: 'Empty source' }); const emptyId = document.layers.at(-1).id;
  assert.equal(failure(await call('load_layer_selection', { ...args(), layerId: emptyId, source: 'layer-mask' })).code, 'NO_MASK');
  await edit('load_layer_selection', { layerId: emptyId }); assert.ok(document.selection); assert.deepEqual(document.selection.runs, []);
  assert.equal(failure(await call('edit_image', { documentId: document.id, expectedRevision: document.revision, scope: 'selection', prompt: 'This empty area must not create a generation handoff', requestId: 'empty-layer-selection-generation' })).code, 'EMPTY_SELECTION');
  assert.deepEqual(value(await call('list_generation_jobs')).jobs, []);
  const beforeEmptyFill = await preview(); await edit('fill_area', { layerId: emptyId, color: '#ff0000' }); assert.deepEqual(await preview(), beforeEmptyFill);
  await edit('load_layer_selection', { layerId: sourceId, mode: 'add' }); assert.deepEqual(selection(), alpha);
  await edit('clear_selection'); assert.equal(failure(await call('load_layer_selection', { ...args(), layerId: sourceId, mode: 'subtract' })).code, 'NO_SELECTION');
  await edit('load_layer_selection', { layerId: sourceId, mode: 'add' }); assert.deepEqual(selection(), alpha);

  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'layer-selection-copy' })).document;
  assert.deepEqual(restored.selection, document.selection); assert.deepEqual(restored.savedSelections, document.savedSelections); assert.deepEqual(restored.layers, document.layers);
  const persisted = structuredClone(document);
  await client.close(); await companion.close(); await start();
  document = value(await call('get_document', args())).document; assert.deepEqual(document, persisted); assert.deepEqual(selection(), alpha);
  assert.deepEqual(await fs.readFile(input), png); assert.deepEqual(await fs.readFile(path.join(assetDir, document.layers[0].sourceAsset)), png);
});

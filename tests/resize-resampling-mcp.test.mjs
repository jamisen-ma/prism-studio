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
function nearestReference(input, oldWidth, oldHeight, width, height) {
  const bytes = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Number(BigInt(2 * x + 1) * BigInt(oldWidth) / BigInt(2 * width));
    const sy = Number(BigInt(2 * y + 1) * BigInt(oldHeight) / BigInt(2 * height));
    bytes.push(...input.subarray((sy * oldWidth + sx) * 4, (sy * oldWidth + sx + 1) * 4));
  }
  return Buffer.from(bytes);
}

test('official MCP retains resize methods through exact nearest pixels, defaults, metadata, transactions, portable files and restart', { timeout: 35000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-resample-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Resizing must not use a model or key'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
    const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'resize-resampling-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.deepEqual(caps.documentResizeMethods, ['nearest', 'cubic', 'mitchell', 'lanczos3']); assert.deepEqual(status.documentResizeMethods, caps.documentResizeMethods);
  assert.equal(caps.documentResizeDefault, 'lanczos3'); assert.equal(status.documentResizeDefault, caps.documentResizeDefault);
  const tool = (await client.listTools()).tools.find(item => item.name === 'prism_resize_document');
  assert.deepEqual(tool.inputSchema.properties.resample.enum, caps.documentResizeMethods); assert.ok(!tool.inputSchema.required.includes('resample'));
  assert.match(tool.description, /pixel-center/); assert.match(tool.description, /cubic enlargement/);

  const width = 13, height = 9, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let i = 0; i < alpha.length; i++) { raw.set([(i * 31 + 17) % 256, (i * 53 + 3) % 256, (i * 7 + 99) % 256, [0, 1, 128, 255][i % 4]], i * 4); alpha[i] = [255, 128, 1, 0][Math.floor(i / 4) % 4]; }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'source.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Pixel-center MCP fixture' })).document;
  const layerId = document.layers[0].id;
  const args = () => ({ backend: 'native', documentId: document.id });
  const get = async () => value(await call('get_document', args())).document;
  const layer = () => document.layers.find(item => item.id === layerId);
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported(id = document.id) {
    const result = value(await call('export_document', { backend: 'native', documentId: id, format: 'png' }));
    return sharp(await fs.readFile(result.path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  }
  // A valid separate-alpha fixture is installed without a segmentation call.
  // The resize and lifecycle operations below all use the official SDK.
  const project = companion.native.projects.get(document.id), graph = structuredClone(project.states[project.cursor].graph);
  graph.layers[0].alphaAsset = await companion.native.storeAlpha(alpha, width, height);
  await companion.native.commit(project, graph, 'Fixture source alpha'); document = await get();
  await edit('add_layer_filter', { layerId, kind: 'invert', value: 100 });
  await edit('select_rectangle', { x: 1, y: 2, width: 8, height: 5 });
  await edit('save_selection', { name: 'Retained region' });
  await edit('add_guide', { axis: 'vertical', position: 4 });
  const before = structuredClone(document), pixelsBefore = await exported();
  const assets = new Map(); for (const name of await fs.readdir(companion.native.assetsDir)) assets.set(name, await fs.readFile(path.join(companion.native.assetsDir, name)));
  const oldLayer = structuredClone(layer());
  const once = { ...args(), expectedRevision: document.revision, width: 21, height: 5, resample: 'nearest', requestId: 'nearest-once' };
  const resized = value(await call('resize_document', once)); document = resized.document;
  assert.deepEqual(value(await call('resize_document', once)), resized);
  assert.equal(document.history.length, before.history.length + 1);
  assert.deepEqual(layer().transforms, [{ type: 'resample', width: 21, height: 5, kernel: 'nearest' }]);
  assert.deepEqual({ ...layer(), transforms: oldLayer.transforms }, oldLayer);
  assert.deepEqual((await exported()).data, nearestReference(pixelsBefore.data, width, height, 21, 5));
  assert.equal(document.guides[0].id, before.guides[0].id); assert.equal(document.guides[0].position, Math.round(4 * 21 / 13));
  assert.equal(document.savedSelections[0].id, before.savedSelections[0].id); assert.deepEqual(document.selection, document.savedSelections[0].mask);
  assert.equal(document.selection.x, 21 / 13); assert.equal(document.selection.y, 2 * 5 / 9);
  const nearestPixels = (await exported()).data;
  await edit('undo'); assert.deepEqual(document.layers, before.layers); assert.deepEqual((await exported()).data, pixelsBefore.data);
  await edit('redo'); assert.deepEqual((await exported()).data, nearestPixels);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const copy = value(await call('import_project_file', { path: portable.path, requestId: 'nearest-portable' })).document;
  assert.deepEqual(copy.layers, document.layers); assert.deepEqual((await exported(copy.id)).data, nearestPixels);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get();
  assert.deepEqual(document, persisted); assert.deepEqual((await exported()).data, nearestPixels);
  assert.equal(failure(await call('resize_document', once)).code, 'REVISION_CONFLICT');

  await edit('undo');
  await edit('resize_document', { width: 7, height: 15 }); const defaultGraph = structuredClone(document), defaultPixels = (await exported()).data;
  assert.deepEqual(layer().transforms, [{ type: 'resize', width: 7, height: 15 }]);
  await edit('undo'); await edit('resize_document', { width: 7, height: 15, resample: 'lanczos3' });
  assert.deepEqual(document.layers, defaultGraph.layers); assert.deepEqual((await exported()).data, defaultPixels);
  await edit('undo');
  const stable = structuredClone(document), file = path.join(companion.native.projectsDir, `${document.id}.json`), stableFile = await fs.readFile(file);
  const bad = failure(await call('apply_transaction', { ...args(), expectedRevision: document.revision, label: 'Rejected after resize', operations: [
    { command: 'resize_document', args: { width: 7, height: 5, resample: 'mitchell' } },
    { command: 'set_layer', args: { layerId: 'missing-layer', name: 'Missing' } },
  ] })); assert.equal(bad.code, 'NOT_FOUND'); assert.deepEqual(await get(), stable); assert.deepEqual(await fs.readFile(file), stableFile);
  await edit('apply_transaction', { label: 'Resize and label', operations: [
    { command: 'resize_document', args: { width: 7, height: 5, resample: 'cubic' } },
    { command: 'set_layer', args: { layerId, name: 'Cubic reduction' } },
  ] }); assert.equal(layer().transforms.at(-1).kernel, 'cubic');
  await edit('undo'); assert.deepEqual(document.layers, stable.layers);
  await edit('set_layer_mask', { layerId, mask: { x: 1, y: 1, width: 7, height: 5 } });
  await edit('set_layer_mask_position', { layerId, x: 2, y: 0 });
  const positioned = structuredClone(document);
  assert.equal(failure(await call('resize_document', { ...args(), expectedRevision: document.revision, width: 7, height: 5, resample: 'nearest' })).code, 'MASK_POSITION_REQUIRES_RASTERIZE');
  assert.deepEqual(await get(), positioned);
  await edit('apply_transaction', { label: 'Rasterize mask and resize', operations: [
    { command: 'apply_layer_mask_position', args: { layerId } },
    { command: 'resize_document', args: { width: 7, height: 5, resample: 'mitchell' } },
  ] }); assert.equal(layer().mask.shape, 'bitmap'); assert.equal(layer().transforms.at(-1).kernel, 'mitchell');
  await edit('undo'); assert.deepEqual(document.layers, positioned.layers);
  assert.deepEqual(await fs.readFile(input), png);
  assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), [...assets.keys()].sort());
  for (const [name, bytes] of assets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, name)), bytes);
});

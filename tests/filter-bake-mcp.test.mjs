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
const unpack = response => { value(response); return sharp(Buffer.from(response.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer(); };
const redShift = { shadows: [20, 0, 0], midtones: [20, 0, 0], highlights: [20, 0, 0], preserveLuminosity: false };
const maxGray = { reds: 100, yellows: 100, greens: 100, cyans: 100, blues: 100, magentas: 100 };

test('official MCP explicitly bakes source filters with separate alpha, exact appearance, reversible pixels and atomic follow-on painting', { timeout: 35000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-bake-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Filter baking must not use a model or key'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'filter-bake-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.equal(caps.layerFilterBaking, 'source-rgb'); assert.equal(status.layerFilterBaking, caps.layerFilterBaking);
  for (const [key, expected] of Object.entries({ maxFilterBakeWorkingBytes: 256 * 1024 * 1024, maxFilterBakeAssetBytes: 128 * 1024 * 1024 })) { assert.equal(caps.limits[key], expected); assert.equal(status.limits[key], expected); }
  const tool = (await client.listTools()).tools.find(item => item.name === 'prism_bake_layer_filters'); assert.ok(tool.inputSchema.required.includes('expectedRevision')); assert.equal(tool.annotations.readOnlyHint, false);
  const width = 32, height = 24, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    raw.set([20 + x * 4, 35 + y * 4, 90, [0, 1, 128, 255][x % 4]], (y * width + x) * 4);
    alpha[y * width + x] = [0, 1, 128, 255][Math.floor(x / 4) % 4];
  }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'original.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Source-space bake fixture' })).document;
  const rasterId = document.layers[0].id, args = () => ({ backend: 'native', documentId: document.id });
  const get = async () => value(await call('get_document', args())).document;
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  const layer = () => document.layers.find(item => item.id === rasterId);
  const preview = async (id = document.id) => unpack(await call('get_preview', { backend: 'native', documentId: id, maxWidth: width }));
  const inspect = async view => unpack(await call('get_layer_preview', { ...args(), layerId: rasterId, view, maxWidth: width }));
  // Seed a valid separate-alpha fixture without invoking segmentation. Every
  // operation under verification below uses the official MCP transport.
  const project = companion.native.projects.get(document.id), graph = structuredClone(project.states[project.cursor].graph);
  graph.layers[0].alphaAsset = await companion.native.storeAlpha(alpha, width, height);
  await companion.native.commit(project, graph, 'Fixture separate alpha'); document = await get();
  const sourceAsset = layer().sourceAsset, workingAsset = layer().asset, alphaAsset = layer().alphaAsset;
  const assetDir = companion.native.assetsDir, assetBytes = async name => fs.readFile(path.join(assetDir, name));
  const originalBytes = await assetBytes(sourceAsset), originalAlpha = await assetBytes(alphaAsset), sourcePreview = await inspect('source'), alphaPreview = await inspect('mask');
  await edit('set_layer_mask', { layerId: rasterId, mask: { x: 1, y: 1, width: 28, height: 21 } });
  await edit('set_layer_mask_position', { layerId: rasterId, x: 2, y: -1 });
  await edit('modify_layer_mask', { layerId: rasterId, density: 0.75 });
  await edit('transform_layer', { layerId: rasterId, x: 1, y: -1 });
  await edit('select_rectangle', { x: 0, y: 0, width: 2, height: 2 }); const unfiltered = await preview();
  await edit('add_layer_filter', { layerId: rasterId, kind: 'color_balance', value: 0, parameters: redShift });
  await edit('add_layer_filter', { layerId: rasterId, kind: 'black_white', value: 0, parameters: maxGray });
  await edit('add_layer_filter', { layerId: rasterId, kind: 'invert', value: 100, enabled: false });
  const before = structuredClone(document), filtered = await preview(), storedBefore = structuredClone(layer()); assert.notDeepEqual(filtered, unfiltered);
  failure(await call('bake_layer_filters', { ...args(), layerId: rasterId })); assert.deepEqual(await get(), before);
  const once = { ...args(), expectedRevision: document.revision, layerId: rasterId, requestId: 'source-bake-once' };
  const result = value(await call('bake_layer_filters', once)); document = result.document; assert.deepEqual(value(await call('bake_layer_filters', once)), result);
  assert.equal(document.history.length, before.history.length + 1); assert.deepEqual(layer().filters, []); assert.notEqual(layer().asset, workingAsset);
  const bakedAsset = layer().asset;
  assert.deepEqual({ ...layer(), asset: storedBefore.asset, filters: storedBefore.filters }, storedBefore);
  assert.deepEqual(await preview(), filtered); assert.deepEqual(document.selection, before.selection);
  assert.deepEqual(await inspect('source'), sourcePreview); assert.deepEqual(await inspect('mask'), alphaPreview);
  const baked = await sharp(await assetBytes(bakedAsset)).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < alpha.length; i++) {
    const offset = i * 4, effective = Math.round(raw[offset + 3] * alpha[i] / 255);
    assert.equal(baked[offset + 3], raw[offset + 3]);
    if (!effective) assert.deepEqual(baked.subarray(offset, offset + 3), raw.subarray(offset, offset + 3));
    else { const gray = Math.max(Math.min(255, raw[offset] + 51), raw[offset + 1], raw[offset + 2]); assert.deepEqual([...baked.subarray(offset, offset + 3)], [gray, gray, gray]); }
  }
  assert.deepEqual(await assetBytes(sourceAsset), originalBytes); assert.deepEqual(await assetBytes(alphaAsset), originalAlpha);
  await edit('undo'); assert.deepEqual(document.layers, before.layers); assert.deepEqual(await preview(), filtered);
  await edit('clear_layer_filters', { layerId: rasterId }); assert.deepEqual(await preview(), unfiltered); assert.equal(layer().asset, workingAsset);
  await edit('undo'); await edit('bake_layer_filters', { layerId: rasterId }); assert.equal(layer().asset, bakedAsset); assert.deepEqual(await preview(), filtered);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const imported = value(await call('import_project_file', { path: portable.path, requestId: 'baked-portable-copy' })).document;
  assert.deepEqual(imported.layers, document.layers); assert.deepEqual(await preview(imported.id), filtered);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get();
  assert.deepEqual(document, persisted); assert.deepEqual(await preview(), filtered); assert.equal(failure(await call('bake_layer_filters', once)).code, 'REVISION_CONFLICT');
  assert.equal(failure(await call('bake_layer_filters', { ...args(), expectedRevision: document.revision, layerId: rasterId })).code, 'NO_FILTERS');

  await edit('undo'); // Restores the editable stack and original working asset.
  await edit('clear_selection');
  const beforeTransaction = structuredClone(document), assetsBefore = (await fs.readdir(assetDir)).sort(), beforeTransactionPixels = await preview();
  const stroke = { command: 'paint_stroke', args: { layerId: rasterId, tool: 'brush', color: '#e74c9c', points: [{ x: 12.5, y: 10.5 }], size: 5, opacity: 1, hardness: 1 } };
  const operations = [{ command: 'bake_layer_filters', args: { layerId: rasterId } }, stroke];
  failure(await call('apply_transaction', { ...args(), label: 'Missing pinned revision', operations })); assert.deepEqual(await get(), beforeTransaction);
  failure(await call('apply_transaction', { ...args(), expectedRevision: document.revision, label: 'Rollback bake and paint', operations: [...operations, { command: 'set_layer', args: { layerId: 'missing', name: 'Must roll back' } }] }));
  assert.deepEqual(await get(), beforeTransaction); assert.deepEqual((await fs.readdir(assetDir)).sort(), assetsBefore); assert.deepEqual(await preview(), beforeTransactionPixels);
  const transaction = await edit('apply_transaction', { label: 'Bake and paint one step', operations });
  assert.equal(document.history.length, beforeTransaction.history.length + 1); assert.deepEqual(layer().filters, []); const painted = await preview(); assert.notDeepEqual(painted, beforeTransactionPixels);
  await edit('undo'); assert.deepEqual(document.layers, beforeTransaction.layers); assert.deepEqual(await preview(), beforeTransactionPixels);
  await edit('redo'); assert.deepEqual(document.layers, transaction.document.layers); assert.deepEqual(await preview(), painted);
  assert.deepEqual(await assetBytes(sourceAsset), originalBytes); assert.deepEqual(await assetBytes(alphaAsset), originalAlpha); assert.deepEqual(await fs.readFile(input), png);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = response => { assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text); };
const failure = response => { assert.equal(response.isError, true); const text = response.content.find(item => item.type === 'text').text; try { return JSON.parse(text); } catch { return { message: text }; } };

test('official MCP repairs use declared frozen sampling, atomic create/stroke, retry, portable data and immutable originals', { timeout: 30000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-retouch-sampling-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Retouch is local'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'retouch-sampling-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  for (const [key, expected] of Object.entries({ retouchSampleModes: ['current', 'current-and-below', 'all'], retouchSamplingTools: ['clone', 'heal'], retouchIgnoreAdjustments: true, retouchCurrentAndBelowScope: 'root-target', repairLayerPlacement: 'above-root-raster' })) { assert.deepEqual(caps[key], expected); assert.deepEqual(status[key], expected); }
  const tools = (await client.listTools()).tools;
  assert.ok(tools.find(item => item.name === 'prism_paint_stroke').inputSchema.properties.sampleMode);
  assert.equal(tools.find(item => item.name === 'prism_create_repair_layer').annotations.readOnlyHint, false);
  const width = 32, height = 24, raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(x < 16 ? [40, 60, 80, 255] : [90, 110, 130, 255], (y * width + x) * 4);
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'source.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Retouch source' })).document;
  const original = structuredClone(document.layers[0]), assetDir = path.join(dataDir, 'native/assets');
  const args = () => ({ backend: 'native', documentId: document.id });
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  const get = async () => value(await call('get_document', args())).document;
  const preview = async (layerId, id = document.id) => { const result = await call(layerId ? 'get_layer_preview' : 'get_preview', { backend: 'native', documentId: id, ...(layerId ? { layerId } : {}), maxWidth: width }); value(result); return sharp(Buffer.from(result.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer(); };
  const pixel = (data, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x + 1) * 4)];
  await edit('add_adjustment', { kind: 'invert', value: 100 });
  await edit('add_shape', { shape: 'rectangle', x: 0, y: 0, width: 9, height: 9, fill: '#ff0080', stroke: null });
  const initialPixels = await preview(), upper = structuredClone(document.layers.slice(1));
  const repairId = randomUUID(), createArgs = { ...args(), expectedRevision: document.revision, sourceLayerId: original.id, newLayerId: repairId, name: 'Separate repair', requestId: 'repair-once' };
  const created = value(await call('create_repair_layer', createArgs)); document = created.document;
  assert.equal(created.layerId, repairId); assert.deepEqual(value(await call('create_repair_layer', createArgs)), created);
  assert.equal(document.layers[1].id, repairId); assert.deepEqual(document.layers.slice(2), upper); assert.deepEqual(await preview(), initialPixels);
  assert.equal(document.layers[1].role, 'paint'); assert.equal(document.layers[1].sourceAsset, document.layers[1].asset);
  const stroke = { layerId: repairId, tool: 'clone', points: [{ x: 24.5, y: 12.5 }], source: { x: 4.5, y: 4.5 }, size: 1, hardness: 1, opacity: 1 };
  await edit('paint_stroke', { ...stroke, sampleMode: 'current-and-below', ignoreAdjustments: true });
  assert.deepEqual(pixel(await preview(repairId), 24, 12), [40, 60, 80, 255]);
  assert.deepEqual(pixel(await preview(), 24, 12), [215, 195, 175, 255]);
  assert.deepEqual(pixel(await preview(), 4, 4), [255, 0, 128, 255]);
  const repaired = structuredClone(document), repairedPixels = await preview();
  // All samples the upper patch; omitted options and explicit legacy values agree.
  await edit('paint_stroke', { ...stroke, points: [{ x: 24.5, y: 17.5 }] }); const legacy = await preview(repairId);
  assert.deepEqual(pixel(legacy, 24, 17), [255, 0, 128, 255]);
  await edit('undo'); await edit('paint_stroke', { ...stroke, points: [{ x: 24.5, y: 17.5 }], sampleMode: 'all', ignoreAdjustments: false }); assert.deepEqual(await preview(repairId), legacy);
  await edit('undo');
  // Skipping the standalone invert prevents sampling its already graded RGB.
  await edit('paint_stroke', { ...stroke, points: [{ x: 24.5, y: 20.5 }], source: { x: 12.5, y: 4.5 }, sampleMode: 'all', ignoreAdjustments: true });
  assert.deepEqual(pixel(await preview(repairId), 24, 20), [40, 60, 80, 255]); assert.deepEqual(pixel(await preview(), 24, 20), [215, 195, 175, 255]);
  await edit('undo'); assert.deepEqual(document.layers, repaired.layers); assert.deepEqual(await preview(), repairedPixels);
  // Current on a transparent location cannot borrow RGB from another layer.
  await edit('paint_stroke', { ...stroke, points: [{ x: 24.5, y: 17.5 }], sampleMode: 'current' }); assert.deepEqual(await preview(), repairedPixels);
  const beforeFailure = structuredClone(document), filesBefore = (await fs.readdir(assetDir)).sort();
  failure(await call('create_repair_layer', { ...args(), sourceLayerId: original.id, newLayerId: repairId }));
  failure(await call('paint_stroke', { ...args(), ...stroke, sampleMode: 'current', ignoreAdjustments: true }));
  assert.equal(failure(await call('paint_stroke', { ...args(), expectedRevision: document.revision - 1, ...stroke, sampleMode: 'all' })).code, 'REVISION_CONFLICT');
  const failedId = randomUUID();
  failure(await call('apply_transaction', { ...args(), expectedRevision: document.revision, label: 'Atomic failed repair', operations: [
    { command: 'create_repair_layer', args: { sourceLayerId: original.id, newLayerId: failedId } },
    { command: 'paint_stroke', args: { ...stroke, layerId: failedId, points: [{ x: 20.5, y: 18.5 }], sampleMode: 'current-and-below', ignoreAdjustments: true } },
    { command: 'set_layer', args: { layerId: randomUUID(), name: 'Missing target' } },
  ] }));
  assert.deepEqual(await get(), beforeFailure); assert.deepEqual((await fs.readdir(assetDir)).sort(), filesBefore);
  const transactionId = randomUUID(), priorHistory = document.history.length;
  const once = { ...args(), expectedRevision: document.revision, requestId: 'atomic-repair-once', label: 'One undo repair', operations: [
    { command: 'create_repair_layer', args: { sourceLayerId: original.id, newLayerId: transactionId, name: 'Atomic repair' } },
    { command: 'paint_stroke', args: { ...stroke, layerId: transactionId, sampleMode: 'current-and-below', ignoreAdjustments: true } },
  ] };
  document = value(await call('apply_transaction', once)).document; assert.deepEqual(value(await call('apply_transaction', once)).document, document); assert.equal(document.history.length, priorHistory + 1);
  assert.equal(document.layers[1].id, transactionId); const authored = structuredClone(document), authoredPixels = await preview();
  await edit('undo'); assert.deepEqual(document.layers, beforeFailure.layers); await edit('redo'); assert.deepEqual(document.layers, authored.layers); assert.deepEqual(await preview(), authoredPixels);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const imported = value(await call('import_project_file', { path: portable.path, requestId: 'repair-project-copy' })).document;
  assert.deepEqual(imported.layers, document.layers); assert.deepEqual(await preview(undefined, imported.id), authoredPixels);
  assert.deepEqual(document.layers[0], original); assert.deepEqual(await fs.readFile(path.join(assetDir, original.sourceAsset)), png);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get();
  assert.deepEqual(document, persisted); assert.deepEqual(await preview(), authoredPixels); assert.deepEqual(await fs.readFile(input), png);
});

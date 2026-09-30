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
const gray = pixels => Buffer.from(Array.from({ length: pixels.length / 4 }, (_, i) => { assert.equal(pixels[i * 4], pixels[i * 4 + 1]); assert.equal(pixels[i * 4], pixels[i * 4 + 2]); assert.equal(pixels[i * 4 + 3], 255); return pixels[i * 4]; }));

test('official MCP positions masks independently, retains source frames through crop and transfer, and rasterizes explicitly before image resize', { timeout: 30000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-mask-position-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Mask positioning must not use a model or key'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'mask-position-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  for (const [key, expected] of Object.entries({ layerMaskPositioning: 'independent-translation', layerMaskPositionUnits: 'document-pixels', layerMaskPositionOperations: ['set', 'rasterize'] })) { assert.deepEqual(caps[key], expected); assert.deepEqual(status[key], expected); }
  assert.equal(caps.limits.maxLayerMaskPosition, 16384); assert.equal(caps.limits.maxLayerMaskSourcePixels, 24_000_000);
  const tools = (await client.listTools()).tools;
  for (const command of ['set_layer_mask_position', 'apply_layer_mask_position']) {
    const tool = tools.find(item => item.name === `prism_${command}`); assert.ok(tool); assert.equal(tool.annotations.readOnlyHint, false); assert.ok(tool.inputSchema.properties.requestId);
  }
  const width = 32, height = 24, raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([40 + x, 70 + y, 155, [0, 1, 128, 255][x % 4]], (y * width + x) * 4);
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'retained-source.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Independently positioned mask' })).document;
  const sourceId = document.layers[0].id, sourceLayer = structuredClone(document.layers[0]), args = () => ({ backend: 'native', documentId: document.id });
  const layer = () => document.layers.find(item => item.id === sourceId);
  const get = async () => value(await call('get_document', args())).document;
  async function edit(command, fields = {}) { document = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })).document; }
  const preview = async (id = document.id) => unpack(await call('get_preview', { backend: 'native', documentId: id, maxWidth: 64 }));
  const maskView = async (maskMode = 'raw') => gray(await unpack(await call('get_mask_preview', { ...args(), expectedRevision: document.revision, source: 'layer-mask', layerId: sourceId, maskMode })));
  const assets = new Map(await Promise.all((await fs.readdir(companion.native.assetsDir)).map(async name => [name, await fs.readFile(path.join(companion.native.assetsDir, name))])));
  assert.equal(failure(await call('set_layer_mask_position', { ...args(), layerId: sourceId, x: 1, y: 0 })).code, 'NO_MASK');
  await edit('set_layer_mask', { layerId: sourceId, mask: { x: 4, y: 2, width: 12, height: 18 } });
  await edit('set_layer_protection', { layerId: sourceId, protected: true });
  const originalMask = structuredClone(layer().mask), originalPixels = await preview(), before = structuredClone(document);
  const once = { ...args(), expectedRevision: document.revision, layerId: sourceId, x: 7, y: -1, requestId: 'mask-position-once' };
  document = value(await call('set_layer_mask_position', once)).document;
  assert.deepEqual(value(await call('set_layer_mask_position', once)).document, document); assert.equal(document.history.length, before.history.length + 1);
  assert.deepEqual(layer().mask.source, originalMask); assert.equal(layer().mask.shape, 'positioned'); assert.equal(layer().mask.sourceWidth, width); assert.equal(layer().mask.sourceHeight, height);
  const binary = Buffer.from(Array.from({ length: width * height }, (_, i) => i % width >= 11 && i % width < 23 && Math.floor(i / width) >= 1 && Math.floor(i / width) < 19 ? 255 : 0));
  assert.deepEqual(await maskView(), binary); const positionedPixels = await preview();
  await edit('set_layer_mask_position', { layerId: sourceId, x: -16384, y: 16384 }); assert.deepEqual(await maskView(), Buffer.alloc(width * height));
  await edit('set_layer_mask_position', { layerId: sourceId, x: 7, y: -1 }); assert.deepEqual(await preview(), positionedPixels); assert.deepEqual(layer().mask.source, originalMask);
  await edit('set_layer_mask_position', { layerId: sourceId, x: 0, y: 0 }); assert.deepEqual(layer().mask, originalMask); assert.deepEqual(await preview(), originalPixels);
  await edit('set_layer_mask_position', { layerId: sourceId, x: 7, y: -1 });
  await edit('modify_layer_mask', { layerId: sourceId, density: 128 / 255 });
  const effective = Buffer.alloc(binary.length);
  for (let i = 0; i < binary.length; i++) effective[i] = binary[i] ? 255 : 127;
  assert.deepEqual(await maskView('effective'), effective); assert.deepEqual(await maskView(), binary);
  const pixels = await preview();
  for (let i = 0; i < binary.length; i++) {
    const alpha = Math.round(raw[i * 4 + 3] * effective[i] / 255); assert.equal(pixels[i * 4 + 3], alpha);
    if (alpha) assert.deepEqual(pixels.subarray(i * 4, i * 4 + 3), raw.subarray(i * 4, i * 4 + 3));
  }
  await edit('load_layer_selection', { layerId: sourceId, source: 'layer-mask', maskMode: 'effective', invert: true });
  assert.deepEqual(gray(await unpack(await call('get_mask_preview', { ...args(), source: 'selection' }))), Buffer.from([...effective].map(byte => 255 - byte)));
  await edit('clear_selection');
  const intact = structuredClone(document), file = path.join(companion.native.projectsDir, `${document.id}.json`), bytesBefore = await fs.readFile(file);
  assert.equal(failure(await call('set_layer_mask_position', { ...args(), expectedRevision: document.revision - 1, layerId: sourceId, x: 0, y: 0 })).code, 'REVISION_CONFLICT');
  failure(await call('apply_transaction', { ...args(), expectedRevision: document.revision, label: 'Failed mask edit', operations: [
    { command: 'apply_layer_mask_position', args: { layerId: sourceId } },
    { command: 'set_layer_mask_position', args: { layerId: 'missing-layer', x: 0, y: 0 } },
  ] }));
  assert.deepEqual(await get(), intact); assert.deepEqual(await fs.readFile(file), bytesBefore);
  const assetPath = path.join(companion.native.assetsDir, sourceLayer.asset), sourceBytes = await fs.readFile(assetPath);
  await fs.writeFile(assetPath, 'Mask-only commands must not decode source RGB');
  try { await edit('set_layer_mask_position', { layerId: sourceId, x: 7, y: -1 }); assert.deepEqual(await maskView(), binary); }
  finally { await fs.writeFile(assetPath, sourceBytes); }
  await edit('crop_document', { x: 5, y: 0, width: 24, height: 20 });
  assert.equal(layer().mask.x, 2); assert.equal(layer().mask.y, -1); assert.equal(layer().mask.sourceWidth, width); assert.deepEqual(layer().mask.source, originalMask);
  const cropped = Buffer.concat(Array.from({ length: 20 }, (_, y) => binary.subarray(y * width + 5, y * width + 29))); assert.deepEqual(await maskView(), cropped);
  const croppedDoc = structuredClone(document), croppedPixels = await preview();
  assert.equal(failure(await call('resize_document', { ...args(), expectedRevision: document.revision, width: 12, height: 10 })).code, 'MASK_POSITION_REQUIRES_RASTERIZE'); assert.deepEqual(await get(), croppedDoc);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'position-project-copy' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(await preview(restored.id), croppedPixels);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get(); assert.deepEqual(document, persisted); assert.deepEqual(await maskView(), cropped);
  await edit('apply_layer_mask_position', { layerId: sourceId }); assert.equal(layer().mask.shape, 'bitmap'); assert.equal(layer().mask.width, 24); assert.equal(layer().mask.height, 20); assert.equal(layer().maskDensity, 128 / 255); assert.deepEqual(await maskView(), cropped);
  await edit('undo'); assert.deepEqual(layer().mask, persisted.layers.find(item => item.id === sourceId).mask);
  const historyBefore = document.history.length;
  await edit('apply_transaction', { label: 'Rasterize mask position and resize image', operations: [{ command: 'apply_layer_mask_position', args: { layerId: sourceId } }, { command: 'resize_document', args: { width: 12, height: 10 } }] });
  assert.equal(document.width, 12); assert.equal(document.height, 10); assert.equal(document.history.length, historyBefore); // Replaces the undone branch with one committed state.
  assert.equal(layer().sourceAsset, sourceLayer.sourceAsset); assert.equal(layer().asset, sourceLayer.asset); assert.equal(layer().alphaAsset, sourceLayer.alphaAsset);
  assert.deepEqual(await fs.readFile(input), png); assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), [...assets.keys()].sort());
  for (const [name, bytes] of assets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, name)), bytes);

  document = value(await call('create_document', { backend: 'native', name: 'Positioned PSD mask', width: 32, height: 24, background: '#ffffff' })).document;
  await edit('duplicate_layer', { layerId: document.layers[0].id }); const top = document.layers.at(-1).id;
  await edit('set_layer_mask', { layerId: top, mask: { x: 0, y: 0, width: 16, height: 24 } });
  await edit('set_layer_mask_position', { layerId: top, x: 4, y: 0 });
  await edit('modify_layer_mask', { layerId: top, density: 128 / 255 });
  const psdBefore = structuredClone(document), psd = value(await call('inspect_psd_export', { documentId: document.id, expectedRevision: document.revision }));
  assert.equal(psd.supported, true); assert.ok(psd.warnings.some(item => item.code === 'MASK_POSITION_NOT_PORTABLE' && item.layerId === top));
  const exported = value(await call('export_psd', { documentId: document.id, expectedRevision: document.revision })); assert.equal((await fs.readFile(exported.path)).subarray(0, 4).toString(), '8BPS'); assert.deepEqual(await get(), psdBefore);
  await edit('modify_layer_mask', { layerId: top, density: 0.5 });
  const fractional = value(await call('inspect_psd_export', { documentId: document.id, expectedRevision: document.revision })); assert.equal(fractional.supported, false); assert.ok(fractional.issues.some(item => item.code === 'MASK_NOT_REPRESENTABLE'));
});

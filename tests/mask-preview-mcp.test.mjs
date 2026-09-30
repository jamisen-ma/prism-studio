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
const bitmap = (bytes, width, height) => ({ shape: 'bitmap', x: 0, y: 0, width, height, feather: 0, invert: false, runs: [...bytes].flatMap((byte, i) => byte ? [i, 1, byte] : []) });

test('official MCP inspects exact opaque grayscale coverage with source-bound metadata and no document, cache, activity or image-source changes', { timeout: 25000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-mask-preview-mcp-')); let forbiddenCalls = 0;
  const forbidden = async () => { forbiddenCalls++; throw Error('Mask inspection must not use images or models'); };
  const companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
  const port = await companion.listen(), client = new Client({ name: 'mask-preview-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', bytes => { stderr += bytes; });
  t.after(async () => { await client.close(); await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.equal(forbiddenCalls, 0); assert.ok(!stderr.includes(companion.token)); });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  for (const [key, expected] of Object.entries({ maskPreviewSources: ['selection', 'layer-mask', 'filter-mask'], maskPreviewMaskModes: ['raw', 'effective'] })) { assert.deepEqual(caps[key], expected); assert.deepEqual(status[key], expected); }
  assert.equal(caps.limits.maxMaskPreviewEdge, 2400); assert.equal(caps.limits.maxMaskPreviewBytes, 8 * 1024 * 1024);
  const tool = (await client.listTools()).tools.find(item => item.name === 'prism_get_mask_preview');
  assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.idempotentHint, true); assert.equal(tool.inputSchema.properties.requestId, undefined);

  const width = 32, height = 8, gray = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const source = await sharp({ create: { width, height, channels: 4, background: '#8a5b32' } }).png().toBuffer(), input = path.join(dataDir, 'source.png'); await fs.writeFile(input, source);
  const imported = value(await call('import_file', { path: input })).document;
  const masked = { ...imported.layers[0], visible: false, opacity: 0, mask: bitmap(gray, width, height) };
  let document = (await companion.native.newProject({ name: 'All grayscale values', width, height, layers: [masked], selection: bitmap(gray, width, height) }, 'Mask inspection fixture')).document;
  const layerId = masked.id, args = () => ({ backend: 'native', documentId: document.id, expectedRevision: document.revision });
  async function edit(command, fields = {}) { document = value(await call(command, { ...args(), ...fields })).document; }
  const projectFile = path.join(companion.native.projectsDir, `${document.id}.json`);
  await call('get_preview', { backend: 'native', documentId: document.id, maxWidth: 32 });

  async function inspect(fields, expected, expectedWidth = width, expectedHeight = height) {
    const before = await fs.readFile(projectFile), cache = companion.native.previewCache.stats(), activity = value(await call('status')).activity;
    const response = await call('get_mask_preview', { ...args(), ...fields }), meta = value(response), image = response.content.find(item => item.type === 'image');
    assert.ok(image); assert.equal(image.mimeType, 'image/png'); assert.equal(meta.data, undefined);
    assert.equal(meta.documentId, document.id); assert.equal(meta.revision, document.revision); assert.equal(meta.source, fields.source ?? 'selection');
    assert.equal(meta.width, expectedWidth); assert.equal(meta.height, expectedHeight); assert.equal(meta.sourceWidth, document.width); assert.equal(meta.sourceHeight, document.height);
    assert.equal(meta.maxEdge, fields.maxEdge ?? 700); assert.equal(meta.sampling, 'nearest-pixel-center');
    if (fields.source === 'layer-mask') { assert.equal(meta.layerId, fields.layerId); assert.equal(meta.maskMode, fields.maskMode ?? 'effective'); }
    else { assert.equal(meta.layerId, undefined); assert.equal(meta.maskMode, undefined); }
    const decoded = await sharp(Buffer.from(image.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, expectedWidth); assert.equal(decoded.info.height, expectedHeight);
    for (let p = 0; p < expected.length; p++) assert.deepEqual([...decoded.data.subarray(4 * p, 4 * p + 4)], [expected[p], expected[p], expected[p], 255], `gray pixel ${p}`);
    assert.deepEqual(await fs.readFile(projectFile), before); assert.deepEqual(companion.native.previewCache.stats(), cache); assert.deepEqual(value(await call('status')).activity, activity);
    assert.deepEqual(value(await call('get_document', { backend: 'native', documentId: document.id })).document, document);
    return meta;
  }
  await inspect({}, gray); await inspect({ source: 'layer-mask', layerId, maskMode: 'raw' }, gray);
  await edit('modify_layer_mask', { layerId, density: 0 }); await inspect({ source: 'layer-mask', layerId }, Buffer.alloc(width * height, 255)); await inspect({ source: 'layer-mask', layerId, maskMode: 'raw' }, gray);
  const assetFile = path.join(companion.native.assetsDir, masked.asset), assetBytes = await fs.readFile(assetFile);
  const render = companion.native.renderLayer; companion.native.renderLayer = forbidden;
  await fs.writeFile(assetFile, 'Deliberately corrupt unrelated RGB source');
  try { await inspect({}, gray); await inspect({ source: 'layer-mask', layerId, maskMode: 'raw' }, gray); }
  finally { companion.native.renderLayer = render; await fs.writeFile(assetFile, assetBytes); }
  const intact = await fs.readFile(projectFile), beforeErrors = value(await call('status')).activity;
  for (const fields of [{ layerId }, { maskMode: 'raw' }, { source: 'layer-mask' }, { maxEdge: 31 }, { source: 'content' }, { expectedRevision: document.revision - 1 }]) failure(await call('get_mask_preview', { ...args(), ...fields }));
  assert.deepEqual(await fs.readFile(projectFile), intact); assert.deepEqual(value(await call('status')).activity, beforeErrors);
  await edit('clear_selection'); assert.equal(failure(await call('get_mask_preview', args())).code, 'NO_SELECTION');
  await edit('set_layer_mask', { layerId, mask: { x: 0, y: 0, width, height, invert: true } });
  await edit('load_layer_selection', { layerId, source: 'layer-mask' }); await inspect({}, Buffer.alloc(width * height));
  await edit('modify_selection', { invert: true }); await inspect({}, Buffer.alloc(width * height, 255));
  await edit('set_layer_mask', { layerId, mask: null }); assert.equal(failure(await call('get_mask_preview', { ...args(), source: 'layer-mask', layerId })).code, 'NO_MASK');
  assert.deepEqual(await fs.readFile(input), source); assert.deepEqual(await fs.readFile(assetFile), assetBytes);

  const tallWidth = 37, tallHeight = 101, tall = Buffer.from(Array.from({ length: tallWidth * tallHeight }, (_, p) => (p * 47 + Math.floor(p / tallWidth) * 11) % 256));
  const background = value(await call('create_document', { backend: 'native', name: 'Tall mask fixture', width: tallWidth, height: tallHeight })).document;
  document = (await companion.native.newProject({ name: 'Odd ratio', width: tallWidth, height: tallHeight, layers: background.layers, selection: bitmap(tall, tallWidth, tallHeight) }, 'Tall fixture')).document;
  const response = await call('get_mask_preview', { ...args(), maxEdge: 32 }), meta = value(response);
  assert.equal(meta.width, 12); assert.equal(meta.height, 32); assert.equal(meta.sourceWidth, 37); assert.equal(meta.sourceHeight, 101);
  const pixels = await sharp(Buffer.from(response.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < 32; y++) for (let x = 0; x < 12; x++) {
    const at = y * 12 + x, sourceX = Math.floor((2 * x + 1) * 37 / 24), sourceY = Math.floor((2 * y + 1) * 101 / 64), expected = tall[sourceY * 37 + sourceX];
    assert.deepEqual([...pixels.subarray(at * 4, at * 4 + 4)], [expected, expected, expected, 255]);
  }
  document = value(await call('create_document', { backend: 'native', name: 'Half-pixel preview ratio', width: 420, height: 840 })).document;
  await edit('select_rectangle', { x: 0, y: 0, width: 420, height: 840 });
  const tied = await call('get_mask_preview', { ...args(), maxEdge: 457 }), tiedMeta = value(tied);
  assert.equal(tiedMeta.width, 229); assert.equal(tiedMeta.height, 457);
  const tiedPixels = await sharp(Buffer.from(tied.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer();
  assert.deepEqual(tiedPixels, Buffer.alloc(229 * 457 * 4, 255));
});

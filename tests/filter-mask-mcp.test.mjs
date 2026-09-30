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
const bitmap = (bytes, width, height) => ({ shape: 'bitmap', width, height, runs: [...bytes].flatMap((byte, i) => byte ? [i, 1, byte] : []) });
const shown = input => { const out = Buffer.from(input); for (let i = 0; i < out.length; i += 4) if (!out[i + 3]) out.fill(0, i, i + 3); return out; };
function filtered(input, entries) {
  const out = Buffer.from(input);
  for (const entry of entries) {
    if (entry.enabled === false || entry.opacity === 0) continue;
    for (let i = 0; i < out.length; i += 4) if (out[i + 3]) for (let c = 0; c < 3; c++) {
      assert.ok(['invert', 'brightness'].includes(entry.kind));
      const candidate = entry.kind === 'invert' ? 255 - out[i + c] : Math.max(0, Math.min(255, Math.round(out[i + c] + entry.value * 2.55)));
      out[i + c] = Math.round(out[i + c] + (candidate - out[i + c]) * (entry.opacity ?? 1));
    }
  }
  return out;
}
function masked(input, entries, coverage, density = 1, enabled = true) {
  const result = filtered(input, entries);
  if (!enabled) return result;
  for (let p = 0; p < coverage.length; p++) if (input[p * 4 + 3]) {
    const weight = BigInt(Math.round(255 - density * (255 - coverage[p])));
    for (let c = 0; c < 3; c++) {
      const n = BigInt(input[p * 4 + c]) * (255n - weight) + BigInt(result[p * 4 + c]) * weight;
      result[p * 4 + c] = Number((2n * n + 255n) / 510n);
    }
  }
  return result;
}
async function session(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-filter-mask-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Filter masks cannot use models or credentials'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'filter-mask-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  async function close() { await client?.close(); await companion?.close(); }
  t.after(async () => { await close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  return { dataDir, get companion() { return companion; }, get client() { return client; }, call: (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args }), restart: async () => { await close(); await start(); } };
}

test('official MCP whole-stack masks preserve scoped RGB, public projection and lifecycle through Bake and portable restart', { timeout: 35000 }, async t => {
  const s = await session(t), call = s.call;
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  for (const [key, expected] of Object.entries({ layerFilterMaskPolicy: 'source-stack-alpha8-v1', layerFilterMaskCoordinates: 'source', layerFilterMaskSources: ['selection', 'all', 'none', 'mask'], layerFilterMaskShapes: ['rectangle', 'ellipse', 'bitmap', 'alpha8'], layerFilterMaskCaptureGeometry: 'integer-copy-v1' })) { assert.deepEqual(caps[key], expected); assert.deepEqual(status[key], expected); }
  for (const property of ['enabled', 'density', 'feather', 'invert']) assert.ok(caps.layerFilterMaskProperties.includes(property));
  assert.deepEqual(status.layerFilterMaskProperties, caps.layerFilterMaskProperties); assert.equal(caps.limits.maxFilterMaskCaptureWork, 384_000_000);
  const tools = (await s.client.listTools()).tools;
  for (const name of ['set_layer_filter_mask', 'modify_layer_filter_mask', 'clear_layer_filter_mask']) {
    const tool = tools.find(item => item.name === `prism_${name}`); assert.ok(tool.inputSchema.required.includes('expectedRevision')); assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const width = 16, height = 16, coverage = Buffer.from(Array.from({ length: 256 }, (_, i) => i)), raw = Buffer.alloc(1024), alpha = Buffer.alloc(256);
  for (let p = 0; p < 256; p++) { raw.set([(p * 47 + 9) % 256, (p * 71 + 177) % 256, (p * 23 + 13) % 256, [0, 1, 128, 255][p % 4]], p * 4); alpha[p] = [255, 128, 1, 0][Math.floor(p / 4) % 4]; }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(s.dataDir, 'original.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Scoped filter colors' })).document;
  const layerId = document.layers[0].id, args = () => ({ backend: 'native', documentId: document.id }), layer = () => document.layers.find(item => item.id === layerId);
  const get = async () => value(await call('get_document', args())).document;
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported(id = document.id) { const file = value(await call('export_document', { backend: 'native', documentId: id, format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  const sourceView = async view => { const response = await call('get_layer_preview', { ...args(), layerId, view, maxWidth: 32 }); value(response); return Buffer.from(response.content.find(item => item.type === 'image').data, 'base64'); };
  const project = s.companion.native.projects.get(document.id), graph = structuredClone(project.states[project.cursor].graph);
  graph.layers[0].alphaAsset = await s.companion.native.storeAlpha(alpha, width, height); await s.companion.native.commit(project, graph, 'Separate source alpha fixture'); document = await get();
  const originalView = await sourceView('source'), alphaView = await sourceView('mask'), originals = new Map();
  for (const name of await fs.readdir(s.companion.native.assetsDir)) originals.set(name, await fs.readFile(path.join(s.companion.native.assetsDir, name)));
  const effective = Buffer.from(raw); for (let p = 0; p < 256; p++) effective[p * 4 + 3] = Math.round(raw[p * 4 + 3] * alpha[p] / 255);
  const entries = [{ kind: 'invert', value: 100 }, { kind: 'brightness', value: 20, opacity: .625 }];
  for (const entry of entries) await edit('add_layer_filter', { layerId, ...entry });
  await edit('set_layer_filter_mask', { layerId, source: 'mask', mask: bitmap(coverage, width, height) });
  assert.ok(Array.isArray(layer().filters)); assert.equal(layer().filters.length, 2); assert.equal(layer().filterMask.enabled, true); assert.equal(layer().filterMask.density, 1); assert.equal(layer().filterMask.sourceWidth, width);
  const internal = () => s.companion.native.projects.get(document.id).states[s.companion.native.projects.get(document.id).cursor].graph.layers.find(item => item.id === layerId);
  assert.equal(internal().filters.version, 1); assert.equal(internal().filters.entries.length, 2); assert.ok(!Object.hasOwn(internal(), 'filterMask'));
  assert.deepEqual(await exported(), shown(masked(effective, entries, coverage)));
  await edit('modify_layer_filter_mask', { layerId, density: .1 }); assert.deepEqual(await exported(), shown(masked(effective, entries, coverage, .1)));
  const maskBeforeToggle = structuredClone(layer().filterMask);
  await edit('modify_layer_filter_mask', { layerId, enabled: false }); assert.deepEqual(layer().filterMask, { ...maskBeforeToggle, enabled: false }); assert.deepEqual(await exported(), shown(filtered(effective, entries)));
  await edit('modify_layer_filter_mask', { layerId, enabled: true }); assert.deepEqual(layer().filterMask, maskBeforeToggle);
  const stable = structuredClone(document), assetNames = (await fs.readdir(s.companion.native.assetsDir)).sort();
  for (const fields of [{ source: 'mask', mask: { ...bitmap(coverage, width, height), width: 8 } }, { source: 'all', mask: bitmap(coverage, width, height) }, { source: 'all', density: 0 }]) failure(await call('set_layer_filter_mask', { ...args(), expectedRevision: document.revision, layerId, ...fields }));
  failure(await call('modify_layer_filter_mask', { ...args(), expectedRevision: document.revision, layerId, density: .5, scope: 'selection' }));
  failure(await call('clear_layer_filter_mask', { ...args(), layerId })); assert.deepEqual(await get(), stable); assert.deepEqual((await fs.readdir(s.companion.native.assetsDir)).sort(), assetNames);
  const beforeReorder = structuredClone(layer().filterMask);
  await edit('reorder_layer_filter', { layerId, filterId: layer().filters[1].id, index: 0 }); assert.deepEqual(layer().filterMask, beforeReorder); assert.deepEqual(await exported(), shown(masked(effective, [...entries].reverse(), coverage, .1))); await edit('undo');
  const recipe = await edit('save_edit_recipe', { name: 'Append within existing scope', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'brightness', value: -10 } }] });
  const beforeValidation = structuredClone(document); assert.equal(value(await call('validate_edit_recipe', { ...args(), recipeId: recipe.recipeId, bindings: { photo: layerId } })).valid, true); assert.deepEqual(await get(), beforeValidation);
  const applyArgs = { ...args(), expectedRevision: document.revision, recipeId: recipe.recipeId, bindings: { photo: layerId }, requestId: 'masked-recipe-append' };
  const applied = value(await call('apply_edit_recipe', applyArgs)); document = applied.document; assert.deepEqual(value(await call('apply_edit_recipe', applyArgs)), applied); assert.deepEqual(layer().filterMask, beforeReorder);
  const completeEntries = [...entries, { kind: 'brightness', value: -10 }], expected = masked(effective, completeEntries, coverage, .1);
  assert.deepEqual(await exported(), shown(expected)); await edit('undo'); assert.equal(layer().filters.length, 2); await edit('redo'); assert.equal(layer().filters.length, 3);
  await edit('clear_layer_filter_mask', { layerId }); assert.equal(layer().filterMask, undefined); assert.ok(Array.isArray(internal().filters)); assert.deepEqual(await exported(), shown(filtered(effective, completeEntries))); await edit('undo');
  await edit('apply_transaction', { label: 'Whole-stack identity discriminator', operations: [
    { command: 'clear_layer_filters', args: { layerId } },
    { command: 'add_layer_filter', args: { layerId, kind: 'invert', value: 100 } },
    { command: 'add_layer_filter', args: { layerId, kind: 'invert', value: 100 } },
    { command: 'set_layer_filter_mask', args: { layerId, source: 'mask', mask: bitmap(Buffer.alloc(256, 128), width, height) } },
  ] }); assert.deepEqual(await exported(), shown(effective)); await edit('undo'); assert.deepEqual(await exported(), shown(expected));
  for (let i = 0; i < 3; i++) { await edit('delete_layer_filter', { layerId, filterId: layer().filters[0].id }); assert.equal(Boolean(layer().filterMask), i < 2); }
  assert.deepEqual(internal().filters, []); for (let i = 0; i < 3; i++) await edit('undo'); assert.deepEqual(await exported(), shown(expected));
  await edit('set_layer_mask', { layerId, mask: { x: 1, y: 1, width: 14, height: 14 } }); await edit('set_layer_mask_position', { layerId, x: 1, y: 0 }); await edit('modify_layer_mask', { layerId, density: .75 }); await edit('transform_layer', { layerId, x: 1, y: -1 });
  const editable = structuredClone(document), beforeBake = await exported();
  const bakeArgs = { ...args(), expectedRevision: document.revision, layerId, requestId: 'masked-bake' }, baked = value(await call('bake_layer_filters', bakeArgs)); document = baked.document; assert.deepEqual(value(await call('bake_layer_filters', bakeArgs)), baked);
  assert.deepEqual(layer().filters, []); assert.equal(layer().filterMask, undefined); assert.deepEqual(await exported(), beforeBake);
  const expectedWorking = Buffer.from(expected); for (let p = 0; p < 256; p++) expectedWorking[p * 4 + 3] = raw[p * 4 + 3];
  assert.deepEqual(await sharp(await fs.readFile(path.join(s.companion.native.assetsDir, layer().asset))).ensureAlpha().raw().toBuffer(), expectedWorking);
  assert.deepEqual(await sourceView('source'), originalView); assert.deepEqual(await sourceView('mask'), alphaView); await edit('undo'); assert.deepEqual(document.layers, editable.layers);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision })), restored = value(await call('import_project_file', { path: portable.path, requestId: 'masked-portable' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(restored.editRecipes, document.editRecipes); assert.deepEqual(await exported(restored.id), beforeBake);
  const persisted = structuredClone(document); await s.restart(); document = await get(); assert.deepEqual(document, persisted); assert.deepEqual(await exported(), beforeBake);
  assert.equal(failure(await call('bake_layer_filters', bakeArgs)).code, 'REVISION_CONFLICT');
  for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(s.companion.native.assetsDir, name)), bytes); assert.deepEqual(await fs.readFile(input), png);
});

test('official MCP filter-mask capture honors irreversible source clips and source-frame inspection without RGB reads', { timeout: 35000 }, async t => {
  const s = await session(t), call = s.call, width = 4, height = 3, raw = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) raw.set([p * 17, 255 - p * 17, p * 7, 255], p * 4);
  const input = path.join(s.dataDir, 'capture.png'); await fs.writeFile(input, await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer());
  let document = value(await call('import_file', { path: input, name: 'Retained source frame' })).document, layerId = document.layers[0].id;
  const args = () => ({ backend: 'native', documentId: document.id }), layer = () => document.layers.find(item => item.id === layerId), get = async () => value(await call('get_document', args())).document;
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  await edit('add_layer_filter', { layerId, kind: 'invert', value: 100 }); await edit('crop_document', { x: 1, y: 0, width: 2, height: 3 });
  await edit('resize_canvas', { width: 4, height: 3, anchor: 'center' }); await edit('select_rectangle', { x: 0, y: 0, width: 4, height: 3 });
  const selection = structuredClone(document.selection); await edit('set_layer_filter_mask', { layerId, source: 'selection' }); assert.deepEqual(document.selection, selection);
  const lostDomain = Buffer.from([0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0]);
  async function inspect(maskMode, expected) {
    const file = path.join(s.companion.native.projectsDir, `${document.id}.json`), before = await fs.readFile(file), cache = s.companion.native.previewCache.stats(), activity = value(await call('status')).activity;
    const response = await call('get_mask_preview', { ...args(), expectedRevision: document.revision, layerId, source: 'filter-mask', maskMode, maxEdge: 32 }), meta = value(response);
    assert.equal(meta.coordinates, 'source'); assert.equal(meta.sourceWidth, width); assert.equal(meta.sourceHeight, height); assert.equal(meta.width, width); assert.equal(meta.height, height); assert.equal(meta.layerId, layerId); assert.equal(meta.revision, document.revision); assert.equal(meta.source, 'filter-mask'); assert.equal(meta.maskMode, maskMode);
    const pixels = await sharp(Buffer.from(response.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer();
    for (let p = 0; p < expected.length; p++) assert.deepEqual([...pixels.subarray(p * 4, p * 4 + 4)], [expected[p], expected[p], expected[p], 255]);
    assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(s.companion.native.previewCache.stats(), cache); assert.deepEqual(value(await call('status')).activity, activity); assert.deepEqual(await get(), document);
  }
  await inspect('raw', lostDomain); await inspect('effective', lostDomain);
  await edit('modify_layer_filter_mask', { layerId, density: .1 }); const dense = Buffer.from([...lostDomain].map(byte => Math.round(255 - .1 * (255 - byte)))); await inspect('effective', dense); assert.equal(dense[0], 230);
  await edit('modify_layer_filter_mask', { layerId, enabled: false }); await inspect('effective', Buffer.alloc(12, 255)); await inspect('raw', lostDomain);
  await edit('resize_document', { width: 8, height: 6, resample: 'nearest' }); assert.equal(layer().filterMask.sourceWidth, 4); assert.equal(document.width, 8); await inspect('raw', lostDomain);
  const sourcePath = path.join(s.companion.native.assetsDir, layer().asset), sourceBytes = await fs.readFile(sourcePath), renderer = s.companion.native.renderLayer;
  s.companion.native.renderLayer = async () => { throw Error('Mask preview must not render RGB'); }; await fs.writeFile(sourcePath, 'Deliberately unavailable RGB fixture');
  try { await inspect('raw', lostDomain); await inspect('effective', Buffer.alloc(12, 255)); }
  finally { s.companion.native.renderLayer = renderer; await fs.writeFile(sourcePath, sourceBytes); }
  const stable = structuredClone(document), names = (await fs.readdir(s.companion.native.assetsDir)).sort();
  assert.equal(failure(await call('set_layer_filter_mask', { ...args(), expectedRevision: document.revision, layerId, source: 'selection' })).code, 'FILTER_MASK_CAPTURE_GEOMETRY'); assert.deepEqual(await get(), stable); assert.deepEqual((await fs.readdir(s.companion.native.assetsDir)).sort(), names);
  await edit('set_layer_filter_mask', { layerId, source: 'mask', mask: { shape: 'rectangle', x: 0, y: 0, width: 2, height: 3 } }); assert.equal(layer().filterMask.enabled, true); assert.equal(layer().filterMask.density, 1); await inspect('raw', Buffer.from([255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0]));
  await edit('update_layer_filter', { layerId, filterId: layer().filters[0].id, enabled: false });
  await fs.writeFile(sourcePath, 'Inactive Bake must not read RGB');
  try { await edit('bake_layer_filters', { layerId }); assert.deepEqual(layer().filters, []); assert.equal(layer().filterMask, undefined); }
  finally { await fs.writeFile(sourcePath, sourceBytes); }

  document = value(await call('create_document', { backend: 'native', name: 'Bounded polygon capture', width: 1024, height: 1024 })).document;
  await edit('add_paint_layer', { name: 'Capture target' }); layerId = document.layers.at(-1).id; await edit('add_layer_filter', { layerId, kind: 'invert', value: 100 });
  const points = Array.from({ length: 256 }, (_, i) => ({ x: 512 + 500 * Math.cos(i * Math.PI / 128), y: 512 + 500 * Math.sin(i * Math.PI / 128) }));
  await edit('select_region', { shape: 'polygon', points, feather: 1 });
  const beforeLimit = structuredClone(document), assetsBeforeLimit = (await fs.readdir(s.companion.native.assetsDir)).sort();
  assert.equal(failure(await call('set_layer_filter_mask', { ...args(), expectedRevision: document.revision, layerId, source: 'selection' })).code, 'LIMIT_EXCEEDED'); assert.deepEqual(await get(), beforeLimit); assert.deepEqual((await fs.readdir(s.companion.native.assetsDir)).sort(), assetsBeforeLimit);
});

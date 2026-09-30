import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { authoredCube, authoredLookupGolden } from './fixtures/color-lookup/reference.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = result => { assert.notEqual(result.isError, true, JSON.stringify(result.content)); return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text); };
const failure = result => { assert.equal(result.isError, true); const message = result.content.find(item => item.type === 'text').text; try { return JSON.parse(message); } catch { return { message }; } };
async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-color-lookup-mcp-'));
  let companion, client, forbiddenCalls = 0, stderr = ''; const tokens = [], traffic = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Color Lookup must not use a provider, segmentation or key'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
    companion.server.on('request', request => traffic.push(new URL(request.url, 'http://127.0.0.1').pathname));
    const port = await companion.listen(); tokens.push(companion.token); client = new Client({ name: 'color-lookup-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.equal(forbiddenCalls, 0); for (const token of tokens) assert.ok(!stderr.includes(token)); });
  await start(); return { dataDir, traffic, call: (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args }), get native() { return companion.native; }, get client() { return client; }, restart: async () => { await client.close(); await companion.close(); await start(); } };
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const half = (n, d) => Number((2n * n + d) / (2n * d));
const displayed = input => { const result = Buffer.from(input); for (let i = 0; i < result.length; i += 4) if (!result[i + 3]) result.fill(0, i, i + 3); return result; };
function sourceReference(raw, alpha, name, maskedBlend = false) {
  const result = Buffer.from(raw);
  for (let p = 0; p < alpha.length; p++) {
    const i = p * 4; result[i + 3] = Math.round(raw[i + 3] * alpha[p] / 255); if (!result[i + 3]) continue;
    const mapped = authoredLookupGolden(name, [...raw.subarray(i, i + 3)]), effect = maskedBlend && (p % 256 < 32 || p % 256 >= 224) ? 128 : 255;
    for (let c = 0; c < 3; c++) {
      const original = raw[i + c], candidate = maskedBlend ? half(BigInt(original * 255 + original * mapped[c]), 510n) : mapped[c];
      result[i + c] = half(BigInt(original * (255 - effect) + candidate * effect), 255n);
    }
  }
  return result;
}

test('official MCP original LUT import/replacement preserves source blend, masks, alpha, Bake, Undo and portable files', { timeout: 35000 }, async t => {
  const env = await setup(t), { call, dataDir } = env;
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.equal(caps.colorLookupPolicy, 'cube3d-f64-trilinear-srgb-v1');
  assert.deepEqual(caps.colorLookupFormats, ['cube-3d']); assert.deepEqual(caps.colorLookupInputSpaces, ['srgb']);
  for (const key of ['colorLookupPolicy', 'colorLookupFormats', 'colorLookupInputSpaces', 'colorLookupLimits']) assert.deepEqual(status[key], caps[key]);
  assert.equal(caps.adjustmentKinds.length, 28); assert.equal(caps.layerFilterKinds.length, 32); assert.ok(caps.commands.includes('import_color_lookup'));
  const tools = (await env.client.listTools()).tools;
  for (const name of ['import_color_lookup', 'import_color_lookup_file', 'add_adjustment', 'update_adjustment', 'add_layer_filter', 'update_layer_filter']) assert.match(tools.find(tool => tool.name === `prism_${name}`).description, /cube3d-f64-trilinear-srgb-v1/);
  const width = 256, height = 4, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let p = 0; p < alpha.length; p++) { const x = p % width, row = Math.floor(p / width); raw.set([x, 255 - x, x * 7 % 256, [255, 128, 1, 0][row]], p * 4); alpha[p] = row === 0 ? 255 : [0, 1, 128, 255][x % 4]; }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'source.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Imported source look' })).document; const layerId = document.layers[0].id;
  const args = () => ({ backend: 'native', documentId: document.id }), get = async () => value(await call('get_document', args())).document, layer = () => document.layers.find(item => item.id === layerId);
  async function edit(name, fields = {}) { const result = value(await call(name, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported(id = document.id) { const file = value(await call('export_document', { backend: 'native', documentId: id, format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  const project = env.native.project(document.id), graph = structuredClone(project.states[project.cursor].graph); graph.layers[0].alphaAsset = await env.native.storeAlpha(alpha, width, height); await env.native.commit(project, graph, 'Fixture cutout alpha'); document = await get();
  const originals = new Map(await Promise.all((await fs.readdir(env.native.assetsDir)).map(async name => [name, await fs.readFile(path.join(env.native.assetsDir, name))])));
  const identity = authoredCube('identity'), cross = authoredCube('cross-products'), identityPath = path.join(dataDir, 'Identity.cube'), crossPath = path.join(dataDir, 'Cross.cube');
  await fs.writeFile(identityPath, identity); await fs.writeFile(crossPath, cross);
  const once = { documentId: document.id, expectedRevision: document.revision, target: 'layer-filter', layerId, path: identityPath, inputSpace: 'srgb', requestId: 'source-lookup-once' };
  const beforeHistory = document.history.length, added = value(await call('import_color_lookup_file', once)); document = added.document;
  assert.equal(added.layerId, layerId); assert.equal(added.filterId, layer().filters[0].id); assert.equal(document.history.length, beforeHistory + 1);
  assert.deepEqual(value(await call('import_color_lookup_file', once)), added);
  assert.equal(failure(await call('import_color_lookup_file', { ...once, path: crossPath })).code, 'REQUEST_CONFLICT');
  const filterId = added.filterId; assert.equal(layer().filters[0].parameters.asset, digest(identity)); assert.deepEqual(await exported(), displayed(sourceReference(raw, alpha, 'identity')));
  await edit('update_layer_filter', { layerId, filterId, blendMode: 'multiply', opacity: .5 });
  await edit('set_layer_filter_mask', { layerId, source: 'mask', mask: { shape: 'rectangle', x: 32, y: 0, width: 192, height } }); await edit('modify_layer_filter_mask', { layerId, density: .5 });
  const retainedMask = structuredClone(layer().filterMask), prior = structuredClone(document);
  const replaced = value(await call('import_color_lookup_file', { ...once, expectedRevision: document.revision, path: crossPath, filterId, requestId: 'source-lookup-replace' })); document = replaced.document;
  assert.equal(replaced.filterId, filterId); assert.equal(layer().filters[0].blendMode, 'multiply'); assert.equal(layer().filters[0].opacity, .5); assert.deepEqual(layer().filterMask, retainedMask);
  const descriptor = layer().filters[0].parameters;
  assert.deepEqual(descriptor, { asset: digest(cross), bytes: cross.length, gridSize: 2, inputSpace: 'srgb', sourceName: 'Cross.cube', title: 'Prism authored cross-products' });
  const expected = sourceReference(raw, alpha, 'cross-products', true); assert.deepEqual(await exported(), displayed(expected));
  await edit('undo'); assert.deepEqual(document.layers, prior.layers); await edit('redo'); assert.deepEqual(layer().filters[0].parameters, descriptor);
  const stable = structuredClone(document), assetNames = (await fs.readdir(env.native.assetsDir)).sort();
  for (const malformed of [{ ...once, inputSpace: 'log' }, { ...once, extra: true }, { backend: 'native', documentId: document.id, expectedRevision: document.revision, target: 'adjustment', filterId, data: cross.toString('base64'), sourceName: 'x.cube', inputSpace: 'srgb' }]) {
    const requests = env.traffic.length; failure(await call(malformed.data ? 'import_color_lookup' : 'import_color_lookup_file', malformed)); assert.equal(env.traffic.length, requests);
  }
  failure(await call('update_layer_filter', { ...args(), expectedRevision: document.revision, layerId, filterId, parameters: { asset: digest(identity) } }));
  assert.deepEqual(await get(), stable); assert.deepEqual((await fs.readdir(env.native.assetsDir)).sort(), assetNames);
  await edit('update_layer_filter', { layerId, filterId, parameters: {} }); assert.deepEqual(layer().filters[0].parameters, descriptor);
  await edit('add_layer_filter', { layerId, kind: 'color_lookup', value: 0, parameters: descriptor, enabled: false }); await edit('undo');
  await edit('add_layer_distort', { layerId, corners: [{ x: 1, y: 0 }, { x: width + 1, y: 0 }, { x: width + 1, y: height }, { x: 1, y: height }] });
  const editable = structuredClone(document), appearance = await exported(); await edit('bake_layer_filters', { layerId }); assert.deepEqual(layer().filters, []); assert.equal(layer().filterMask, undefined); assert.deepEqual(await exported(), appearance);
  const working = Buffer.from(expected); for (let p = 0; p < alpha.length; p++) working[p * 4 + 3] = raw[p * 4 + 3];
  assert.deepEqual(await sharp(await fs.readFile(path.join(env.native.assetsDir, layer().asset))).ensureAlpha().raw().toBuffer(), working);
  await edit('undo'); assert.deepEqual(document.layers, editable.layers);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'source-lookup-portable' })).document; assert.deepEqual(restored.layers, document.layers); assert.deepEqual(await exported(restored.id), appearance);
  const persisted = structuredClone(document); await env.restart(); document = await get(); assert.deepEqual(document, persisted); assert.deepEqual(await exported(), appearance);
  for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(env.native.assetsDir, name)), bytes);
  for (const bytes of [identity, cross]) assert.deepEqual(await fs.readFile(path.join(env.native.assetsDir, digest(bytes))), bytes);
  assert.deepEqual(await fs.readFile(input), png);
});

test('official MCP global LUTs retain selection/settings, refuse recipe dependencies and roll back new assets atomically', { timeout: 35000 }, async t => {
  const env = await setup(t), { call, dataDir } = env, raw = Buffer.alloc(256 * 2 * 4);
  for (let p = 0; p < 512; p++) raw.set([p % 256, 255 - p % 256, p * 7 % 256, 255], p * 4);
  const png = await sharp(raw, { raw: { width: 256, height: 2, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'ramp.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Global lookup ownership' })).document; const rasterId = document.layers[0].id;
  const args = () => ({ backend: 'native', documentId: document.id }), get = async () => value(await call('get_document', args())).document;
  async function edit(name, fields = {}) { const result = value(await call(name, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported() { const file = value(await call('export_document', { ...args(), format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  await edit('select_rectangle', { x: 16, y: 0, width: 224, height: 2 });
  const cross = authoredCube('cross-products'), gain = authoredCube('gain-half');
  const imported = await edit('import_color_lookup', { target: 'adjustment', data: cross.toString('base64'), sourceName: 'Cross.cube', inputSpace: 'srgb' }); const gradeId = imported.layerId;
  assert.equal(document.layers.at(-1).id, gradeId); assert.deepEqual(document.layers.at(-1).mask, { ...document.selection, feather: 0, invert: false });
  const map = (name, opacity = 1) => { const result = Buffer.from(raw); for (let p = 0; p < 512; p++) { if (p % 256 < 16 || p % 256 >= 240) continue; const i = p * 4, mapped = authoredLookupGolden(name, [...raw.subarray(i, i + 3)]); for (let c = 0; c < 3; c++) result[i + c] = Math.round(raw[i + c] + (mapped[c] - raw[i + c]) * opacity); } return result; };
  assert.deepEqual(await exported(), map('cross-products'));
  await edit('set_layer', { layerId: gradeId, name: 'Retain my grade name', opacity: .75 }); const mask = structuredClone(document.layers.at(-1).mask);
  await edit('clear_selection'); await edit('import_color_lookup', { target: 'adjustment', layerId: gradeId, data: gain.toString('base64'), sourceName: 'Gain.cube', inputSpace: 'srgb' });
  assert.equal(document.layers.at(-1).name, 'Retain my grade name'); assert.equal(document.layers.at(-1).opacity, .75); assert.deepEqual(document.layers.at(-1).mask, mask); assert.deepEqual(await exported(), map('gain-half', .75));
  const descriptor = document.layers.at(-1).parameters, definitions = [
    { name: 'No asset recipe', slots: [{ key: 'grade', type: 'adjustment', kind: 'color_lookup' }], steps: [{ command: 'update_adjustment', target: 'grade', args: { value: 0, parameters: descriptor } }] },
    { name: 'No disabled asset recipe', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'color_lookup', value: 0, enabled: false, parameters: descriptor } }] },
  ];
  for (const definition of definitions) failure(await call('save_edit_recipe', { ...args(), expectedRevision: document.revision, ...definition }));
  await edit('add_layer_filter', { layerId: rasterId, kind: 'color_lookup', value: 0, parameters: descriptor, enabled: false });
  const recipe = await edit('save_edit_recipe', { name: 'Ordinary append', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'brightness', value: 0 } }] });
  await edit('apply_edit_recipe', { recipeId: recipe.recipeId, bindings: { photo: rasterId } }); assert.equal(document.layers[0].filters.length, 2); assert.deepEqual(document.layers[0].filters[0].parameters, descriptor);
  const stable = structuredClone(document), assetNames = (await fs.readdir(env.native.assetsDir)).sort(), projectPath = path.join(env.native.projectsDir, `${document.id}.json`), projectBytes = await fs.readFile(projectPath), fresh = authoredCube('rgb-cycle');
  const operation = { command: 'import_color_lookup', args: { target: 'adjustment', layerId: gradeId, data: fresh.toString('base64'), sourceName: 'Fresh.cube', inputSpace: 'srgb' } };
  failure(await call('apply_transaction', { ...args(), expectedRevision: document.revision, label: 'Roll back lookup', operations: [operation, { command: 'delete_layer', args: { layerId: 'missing' } }] }));
  assert.deepEqual(await get(), stable); assert.deepEqual(await fs.readFile(projectPath), projectBytes); assert.deepEqual((await fs.readdir(env.native.assetsDir)).sort(), assetNames);
  // A real filesystem publication failure, with an already-shared old lookup.
  const projectsDir = env.native.projectsDir, blocker = path.join(dataDir, 'not-a-directory'); await fs.writeFile(blocker, 'blocked'); env.native.projectsDir = blocker;
  try { failure(await call('import_color_lookup', { ...args(), expectedRevision: document.revision, ...operation.args })); }
  finally { env.native.projectsDir = projectsDir; }
  assert.deepEqual(await get(), stable); assert.deepEqual(await fs.readFile(projectPath), projectBytes); assert.deepEqual((await fs.readdir(env.native.assetsDir)).sort(), assetNames);
  const stale = { ...args(), expectedRevision: document.revision - 1, ...operation.args }; assert.equal(failure(await call('import_color_lookup', stale)).code, 'REVISION_CONFLICT');
  await env.restart(); document = await get(); assert.deepEqual(document, stable); assert.deepEqual(await exported(), map('gain-half', .75));
  for (const bytes of [cross, gain]) assert.deepEqual(await fs.readFile(path.join(env.native.assetsDir, digest(bytes))), bytes);
});

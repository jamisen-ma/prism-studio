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

// Deliberately naive 2D BigInt reference. It imports no production filter math,
// cache, work planner or normalization helper.
function spatialReference(input, width, height, kind, sigma, opacity = 1) {
  if (sigma === 0) return Buffer.from(input);
  const radius = Math.ceil(3 * sigma), half = [];
  for (let i = 1; i <= radius; i++) half.push(Math.exp(-i * i / (2 * sigma * sigma)));
  const total = 1 + half.reduce((sum, weight) => sum + 2 * weight, 0);
  const integers = half.map(weight => Math.round(65536 * weight / total));
  const weights = [...integers].reverse().concat(65536 - 2 * integers.reduce((a, b) => a + b, 0), integers).map(BigInt);
  const output = Buffer.from(input), at = (x, y) => (Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4; if (input[offset + 3] === 0) continue;
    let denominator = 0n; const sums = [0n, 0n, 0n];
    for (let sy = -radius; sy <= radius; sy++) for (let sx = -radius; sx <= radius; sx++) {
      const index = at(x + sx, y + sy), weight = weights[sx + radius] * weights[sy + radius] * BigInt(input[index + 3]);
      denominator += weight; for (let c = 0; c < 3; c++) sums[c] += weight * BigInt(input[index + c]);
    }
    assert.ok(denominator > 0n);
    for (let c = 0; c < 3; c++) {
      const numerator = kind === 'sharpen' ? 2n * BigInt(input[offset + c]) * denominator - sums[c] : sums[c];
      const candidate = numerator <= 0n ? 0 : numerator >= 255n * denominator ? 255 : Number((2n * numerator + denominator) / (2n * denominator));
      output[offset + c] = Math.round(input[offset + c] + (candidate - input[offset + c]) * opacity);
    }
  }
  return output;
}

test('official MCP source Gaussian and RGB sharpen preserve exact alpha/color math, recipes, baking and radius admission', { timeout: 35000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-spatial-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Native source filtering cannot use models or credentials'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'source-spatial-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.equal(caps.layerFilterKinds.length, 32); assert.equal(caps.adjustmentKinds.length, 28);
  assert.equal(caps.layerFilterSpatialPolicy, 'alpha-weighted-gaussian-rgb-v1'); assert.equal(status.layerFilterSpatialPolicy, caps.layerFilterSpatialPolicy);
  const tool = (await client.listTools()).tools.find(item => item.name === 'prism_add_layer_filter');
  for (const kind of ['blur', 'sharpen']) assert.ok(tool.inputSchema.properties.kind.enum.includes(kind));
  assert.match(tool.description, /fixed RGB unsharp amount1/); assert.match(tool.description, /cutout coverage/);

  const width = 9, height = 7, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let p = 0; p < alpha.length; p++) { raw.set([(p * 41 + 9) % 256, (p * 23 + 177) % 256, (p * 71 + 13) % 256, [0, 1, 128, 255][p % 4]], p * 4); alpha[p] = [255, 128, 1, 0][Math.floor(p / 4) % 4]; }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'original.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Source Gaussian detail' })).document;
  const layerId = document.layers[0].id;
  const args = () => ({ backend: 'native', documentId: document.id });
  const get = async () => value(await call('get_document', args())).document;
  const layer = () => document.layers.find(item => item.id === layerId);
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported(id = document.id) { const file = value(await call('export_document', { backend: 'native', documentId: id, format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  const inspect = async view => { const response = await call('get_layer_preview', { ...args(), layerId, view, maxWidth: 32 }); value(response); return Buffer.from(response.content.find(item => item.type === 'image').data, 'base64'); };
  const project = companion.native.projects.get(document.id), graph = structuredClone(project.states[project.cursor].graph);
  graph.layers[0].alphaAsset = await companion.native.storeAlpha(alpha, width, height);
  await companion.native.commit(project, graph, 'Fixture independent source alpha'); document = await get();
  const sourceView = await inspect('source'), alphaView = await inspect('mask'), originalAssets = new Map();
  for (const name of await fs.readdir(companion.native.assetsDir)) originalAssets.set(name, await fs.readFile(path.join(companion.native.assetsDir, name)));
  const effective = Buffer.from(raw); for (let p = 0; p < alpha.length; p++) effective[p * 4 + 3] = Math.round(raw[p * 4 + 3] * alpha[p] / 255);
  const expected = spatialReference(spatialReference(effective, width, height, 'blur', .7, .625), width, height, 'sharpen', 1.25, .75);
  await edit('add_layer_filter', { layerId, kind: 'blur', value: .7, opacity: .625 });
  await edit('add_layer_filter', { layerId, kind: 'sharpen', value: 1.25, opacity: .75 });
  const filterIds = layer().filters.map(item => item.id), originalStack = structuredClone(layer().filters);
  const renderedExpected = Buffer.from(expected); for (let p = 0; p < alpha.length; p++) if (renderedExpected[p * 4 + 3] === 0) renderedExpected.fill(0, p * 4, p * 4 + 3);
  assert.deepEqual(await exported(), renderedExpected);
  await edit('reorder_layer_filter', { layerId, filterId: filterIds[1], index: 0 }); assert.notDeepEqual(await exported(), renderedExpected);
  await edit('undo'); assert.deepEqual(layer().filters, originalStack); assert.deepEqual(await exported(), renderedExpected);
  assert.deepEqual(await inspect('source'), sourceView); assert.deepEqual(await inspect('mask'), alphaView);
  assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), [...originalAssets.keys()].sort());

  const recipe = await edit('save_edit_recipe', { name: 'Source blur and detail', slots: [{ key: 'photo', type: 'raster' }], steps: [
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'blur', value: .7, opacity: .625 } },
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'sharpen', value: 1.25, opacity: .75 } },
  ] });
  await edit('clear_layer_filters', { layerId }); const clear = structuredClone(document), clearPixels = await exported();
  const checked = value(await call('validate_edit_recipe', { ...args(), expectedRevision: document.revision, recipeId: recipe.recipeId, bindings: { photo: layerId } })); assert.equal(checked.valid, true); assert.deepEqual(await get(), clear);
  await edit('apply_edit_recipe', { recipeId: recipe.recipeId, bindings: { photo: layerId } }); assert.deepEqual(await exported(), renderedExpected);
  await edit('undo'); assert.deepEqual(await exported(), clearPixels); assert.deepEqual(layer().filters, []);
  await edit('redo'); assert.deepEqual(await exported(), renderedExpected);
  await edit('set_layer_mask', { layerId, mask: { x: 1, y: 1, width: 7, height: 5 } });
  await edit('set_layer_mask_position', { layerId, x: 1, y: 0 });
  await edit('modify_layer_mask', { layerId, density: .75 });
  await edit('transform_layer', { layerId, x: 1, y: -1 });
  const editable = structuredClone(document), beforeBake = await exported();
  const bakeOnce = { ...args(), expectedRevision: document.revision, layerId, requestId: 'source-spatial-bake' };
  const baked = value(await call('bake_layer_filters', bakeOnce)); document = baked.document; assert.deepEqual(value(await call('bake_layer_filters', bakeOnce)), baked);
  assert.deepEqual(layer().filters, []); assert.deepEqual(await exported(), beforeBake);
  const expectedWorking = Buffer.from(expected); for (let p = 0; p < alpha.length; p++) expectedWorking[p * 4 + 3] = raw[p * 4 + 3];
  assert.deepEqual(await sharp(await fs.readFile(path.join(companion.native.assetsDir, layer().asset))).ensureAlpha().raw().toBuffer(), expectedWorking);
  assert.deepEqual(await inspect('source'), sourceView); assert.deepEqual(await inspect('mask'), alphaView);
  await edit('undo'); assert.deepEqual(document.layers, editable.layers); assert.deepEqual(await exported(), beforeBake);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'spatial-project' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(restored.editRecipes, document.editRecipes); assert.deepEqual(await exported(restored.id), beforeBake);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get();
  assert.deepEqual(document, persisted); assert.deepEqual(await exported(), beforeBake);
  assert.equal(failure(await call('bake_layer_filters', bakeOnce)).code, 'REVISION_CONFLICT');
  for (const [name, bytes] of originalAssets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, name)), bytes);
  assert.deepEqual(await fs.readFile(input), png);

  document = value(await call('create_document', { backend: 'native', name: 'Radius admission', width: 1024, height: 1024, background: '#ffffff' })).document;
  await edit('add_paint_layer', { name: 'Large source' }); const largeId = document.layers.at(-1).id;
  await edit('add_layer_filter', { layerId: largeId, kind: 'blur', value: 50, enabled: false }); const largeFilterId = document.layers.at(-1).filters[0].id;
  const tooLarge = await edit('save_edit_recipe', { name: 'Excessive radius', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'blur', value: 50 } }] });
  const safe = structuredClone(document), assetNames = (await fs.readdir(companion.native.assetsDir)).sort(), file = path.join(companion.native.projectsDir, `${document.id}.json`), projectBytes = await fs.readFile(file);
  const refused = failure(await call('update_layer_filter', { ...args(), expectedRevision: document.revision, layerId: largeId, filterId: largeFilterId, enabled: true })); assert.equal(refused.code, 'LIMIT_EXCEEDED');
  const admission = value(await call('validate_edit_recipe', { ...args(), expectedRevision: document.revision, recipeId: tooLarge.recipeId, bindings: { photo: largeId } })); assert.equal(admission.valid, false); assert.ok(admission.issues.some(issue => issue.code === 'LIMIT_EXCEEDED'));
  assert.equal(failure(await call('apply_edit_recipe', { ...args(), expectedRevision: document.revision, recipeId: tooLarge.recipeId, bindings: { photo: largeId } })).code, 'LIMIT_EXCEEDED');
  assert.deepEqual(await get(), safe); assert.deepEqual(await fs.readFile(file), projectBytes); assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), assetNames);
});

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
const rounded = (n, d) => n <= 0n ? 0 : n >= 255n * d ? 255 : Number((2n * n + d) / (2n * d));
function displayed(input) { const output = Buffer.from(input); for (let i = 0; i < output.length; i += 4) if (!output[i + 3]) output.fill(0, i, i + 3); return output; }

// Independent slow 2D BigInt oracle, including the unrounded mean and the
// subsequent rational Overlay/Multiply stage. Fixture opacities are dyadic.
function highPass(input, width, height, sigma, mode = 'normal', opacity = 1) {
  const radius = Math.ceil(3 * sigma), side = [];
  for (let k = 1; k <= radius; k++) side.push(Math.exp(-k * k / (2 * sigma * sigma)));
  const total = 1 + 2 * side.reduce((a, b) => a + b, 0), quantized = side.map(v => Math.round(v / total * 65536));
  const weights = [...quantized].reverse().concat(65536 - 2 * quantized.reduce((a, b) => a + b, 0), quantized).map(BigInt);
  const output = Buffer.from(input), a = BigInt(opacity * 8), q = 8n;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = 4 * (y * width + x); if (!input[offset + 3]) continue;
    const sums = [0n, 0n, 0n]; let d = 0n;
    for (let ky = -radius; ky <= radius; ky++) for (let kx = -radius; kx <= radius; kx++) {
      const index = 4 * (Math.max(0, Math.min(height - 1, y + ky)) * width + Math.max(0, Math.min(width - 1, x + kx)));
      const w = weights[kx + radius] * weights[ky + radius] * BigInt(input[index + 3]);
      d += w; for (let c = 0; c < 3; c++) sums[c] += w * BigInt(input[index + c]);
    }
    assert.ok(d > 0n);
    for (let c = 0; c < 3; c++) {
      const b = BigInt(input[offset + c]), candidate = BigInt(rounded((128n + b) * d - sums[c], d));
      if (mode === 'normal') { output[offset + c] = Math.round(Number(b) + Number(candidate - b) * opacity); continue; }
      const n = mode === 'multiply' ? b * candidate : b <= 127n ? 2n * b * candidate : 65025n - 2n * (255n - b) * (255n - candidate);
      assert.ok(mode === 'multiply' || mode === 'overlay');
      output[offset + c] = rounded(b * 255n * q + (n - b * 255n) * a, 255n * q);
    }
  }
  return output;
}

test('official MCP High Pass keeps exact detail, alpha and saved blending through recipes, Bake and restart', { timeout: 35000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-high-pass-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('High Pass must not use generation, segmentation or credentials'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'high-pass-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.equal(caps.layerFilterKinds.length, 32); assert.equal(caps.adjustmentKinds.length, 28);
  assert.equal(caps.layerFilterHighPassPolicy, 'alpha-weighted-residual-128-v1'); assert.equal(status.layerFilterHighPassPolicy, caps.layerFilterHighPassPolicy);
  const tools = (await client.listTools()).tools, addTool = tools.find(item => item.name === 'prism_add_layer_filter');
  assert.ok(addTool.inputSchema.properties.kind.enum.includes('high_pass')); assert.match(addTool.description, /Sigma 0 produces gray 128/);
  assert.ok(!tools.find(item => item.name === 'prism_add_adjustment').inputSchema.properties.kind.enum.includes('high_pass'));

  let document, layerId;
  const args = () => ({ backend: 'native', documentId: document.id });
  const get = async () => value(await call('get_document', args())).document, layer = () => document.layers.find(item => item.id === layerId);
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported(id = document.id) { const file = value(await call('export_document', { backend: 'native', documentId: id, format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  async function imported(raw, width, height, name) {
    const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, `${name}.png`); await fs.writeFile(input, png);
    document = value(await call('import_file', { path: input, name })).document; layerId = document.layers[0].id; return { png, input };
  }
  const pair = Buffer.from([80, 80, 80, 255, 144, 144, 144, 255]); await imported(pair, 2, 1, 'Residual ties');
  await edit('add_layer_filter', { layerId, kind: 'high_pass', value: .3977 });
  assert.deepEqual(await exported(), Buffer.from([126, 126, 126, 255, 131, 131, 131, 255]));
  await edit('update_layer_filter', { layerId, filterId: layer().filters[0].id, value: 0 });
  assert.deepEqual(await exported(), Buffer.from([128, 128, 128, 255, 128, 128, 128, 255]));
  const ramp = Buffer.alloc(256 * 4); for (let b = 0; b < 256; b++) ramp.set([b, 255 - b, (b * 43) % 256, 255], b * 4);
  await imported(ramp, 256, 1, 'Gray neutral ramp');
  await edit('add_layer_filter', { layerId, kind: 'high_pass', value: 0, blendMode: 'overlay', opacity: .625 }); assert.deepEqual(await exported(), ramp);
  await edit('update_layer_filter', { layerId, filterId: layer().filters[0].id, blendMode: 'soft_light' }); assert.deepEqual(await exported(), ramp);
  await edit('update_layer_filter', { layerId, filterId: layer().filters[0].id, value: Number.MIN_VALUE }); assert.deepEqual(await exported(), ramp);

  const width = 9, height = 7, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let p = 0; p < alpha.length; p++) { raw.set([(p * 41 + 9) % 256, (p * 23 + 177) % 256, (p * 71 + 13) % 256, [0, 1, 128, 255][p % 4]], p * 4); alpha[p] = [255, 128, 1, 0][Math.floor(p / 4) % 4]; }
  const { png, input } = await imported(raw, width, height, 'Editable source detail');
  const project = companion.native.projects.get(document.id), graph = structuredClone(project.states[project.cursor].graph);
  graph.layers[0].alphaAsset = await companion.native.storeAlpha(alpha, width, height);
  await companion.native.commit(project, graph, 'Fixture independent source alpha'); document = await get();
  const inspect = async view => { const response = await call('get_layer_preview', { ...args(), layerId, view, maxWidth: 32 }); value(response); return Buffer.from(response.content.find(item => item.type === 'image').data, 'base64'); };
  const sourceView = await inspect('source'), alphaView = await inspect('mask'), originalAssets = new Map();
  for (const name of await fs.readdir(companion.native.assetsDir)) originalAssets.set(name, await fs.readFile(path.join(companion.native.assetsDir, name)));
  const effective = Buffer.from(raw); for (let p = 0; p < alpha.length; p++) effective[p * 4 + 3] = Math.round(raw[p * 4 + 3] * alpha[p] / 255);
  const first = { kind: 'high_pass', value: .3977, opacity: .625, blendMode: 'overlay' }, second = { kind: 'high_pass', value: 1.25, opacity: .75, blendMode: 'multiply' };
  const expected = highPass(highPass(effective, width, height, first.value, first.blendMode, first.opacity), width, height, second.value, second.blendMode, second.opacity);
  await edit('add_layer_filter', { layerId, ...first }); const filterId = layer().filters[0].id;
  await edit('update_layer_filter', { layerId, filterId, value: .7 }); assert.equal(layer().filters[0].blendMode, 'overlay'); assert.equal(layer().filters[0].opacity, .625);
  await edit('update_layer_filter', { layerId, filterId, value: first.value });
  await edit('add_layer_filter', { layerId, ...second }); assert.deepEqual(await exported(), displayed(expected));
  const originalStack = structuredClone(layer().filters);
  await edit('reorder_layer_filter', { layerId, filterId, index: 1 }); assert.notDeepEqual(await exported(), displayed(expected)); await edit('undo'); assert.deepEqual(layer().filters, originalStack);
  const saved = structuredClone(document), filesBefore = (await fs.readdir(companion.native.assetsDir)).sort();
  for (const settings of [{ value: -1 }, { value: 51 }, { parameters: { sigma: 1 } }, { parameters: { amount: 0 } }]) assert.equal((await call('update_layer_filter', { ...args(), expectedRevision: document.revision, layerId, filterId, ...settings })).isError, true);
  for (const parameters of [{}, { sigma: 1 }]) assert.equal((await call('add_layer_filter', { ...args(), expectedRevision: document.revision, layerId, kind: 'high_pass', value: 0, enabled: false, parameters })).isError, true);
  assert.equal((await call('add_adjustment', { ...args(), kind: 'high_pass', value: 1 })).isError, true);
  assert.deepEqual(await get(), saved); assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), filesBefore);
  const definition = { name: 'Editable High Pass details', slots: [{ key: 'photo', type: 'raster' }], steps: [first, second, { kind: 'high_pass', value: 0, enabled: false }].map(entry => ({ command: 'add_layer_filter', target: 'photo', args: entry })) };
  const recipe = await edit('save_edit_recipe', definition); assert.ok(document.editRecipes.find(r => r.id === recipe.recipeId).steps.every(s => !Object.hasOwn(s.args, 'parameters')));
  await edit('clear_layer_filters', { layerId }); const clear = structuredClone(document);
  assert.equal(value(await call('validate_edit_recipe', { ...args(), recipeId: recipe.recipeId, bindings: { photo: layerId } })).valid, true); assert.deepEqual(await get(), clear);
  const applyArgs = { ...args(), expectedRevision: document.revision, recipeId: recipe.recipeId, bindings: { photo: layerId }, requestId: 'high-pass-recipe' };
  const applied = value(await call('apply_edit_recipe', applyArgs)); document = applied.document; assert.deepEqual(value(await call('apply_edit_recipe', applyArgs)), applied); assert.deepEqual(await exported(), displayed(expected));
  await edit('undo'); assert.deepEqual(layer().filters, []); await edit('redo'); assert.deepEqual(await exported(), displayed(expected));
  await edit('set_layer_mask', { layerId, mask: { x: 1, y: 1, width: 7, height: 5 } }); await edit('set_layer_mask_position', { layerId, x: 1, y: 0 });
  await edit('modify_layer_mask', { layerId, density: .75 }); await edit('transform_layer', { layerId, x: 1, y: -1 });
  const editable = structuredClone(document), beforeBake = await exported();
  await edit('bake_layer_filters', { layerId }); assert.deepEqual(layer().filters, []); assert.deepEqual(await exported(), beforeBake);
  const expectedWorking = Buffer.from(expected); for (let p = 0; p < alpha.length; p++) expectedWorking[p * 4 + 3] = raw[p * 4 + 3];
  assert.deepEqual(await sharp(await fs.readFile(path.join(companion.native.assetsDir, layer().asset))).ensureAlpha().raw().toBuffer(), expectedWorking);
  assert.deepEqual(await inspect('source'), sourceView); assert.deepEqual(await inspect('mask'), alphaView);
  await edit('undo'); assert.deepEqual(document.layers, editable.layers);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision })), restored = value(await call('import_project_file', { path: portable.path, requestId: 'high-pass-project' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(restored.editRecipes, document.editRecipes); assert.deepEqual(await exported(restored.id), beforeBake);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get(); assert.deepEqual(document, persisted); assert.deepEqual(await exported(), beforeBake);
  assert.equal(failure(await call('apply_edit_recipe', applyArgs)).code, 'REVISION_CONFLICT');
  for (const [name, bytes] of originalAssets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, name)), bytes); assert.deepEqual(await fs.readFile(input), png);

  document = value(await call('create_document', { backend: 'native', name: 'High Pass admission', width: 1024, height: 1024, background: '#ffffff' })).document;
  await edit('add_paint_layer', { name: 'Large source' }); layerId = document.layers.at(-1).id;
  await edit('add_layer_filter', { layerId, kind: 'high_pass', value: 50, enabled: false }); const largeFilterId = layer().filters[0].id;
  const safe = structuredClone(document), assetNames = (await fs.readdir(companion.native.assetsDir)).sort();
  assert.equal(failure(await call('update_layer_filter', { ...args(), expectedRevision: document.revision, layerId, filterId: largeFilterId, enabled: true })).code, 'LIMIT_EXCEEDED');
  assert.deepEqual(await get(), safe); assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), assetNames);
});

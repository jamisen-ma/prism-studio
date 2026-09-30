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

// Independent direct 2D BigInt reference: no production math, normalization,
// work-plan or Gaussian helper imports. Threshold compares unrounded residuals.
function reference(input, width, height, { amount = 100, sigma = 1, threshold = 0 } = {}, opacity = 1) {
  const output = Buffer.from(input);
  if (amount === 0 || sigma === 0 || threshold === 255) return output;
  const radius = Math.ceil(3 * sigma), sides = [];
  for (let i = 1; i <= radius; i++) sides.push(Math.exp(-i * i / (2 * sigma * sigma)));
  const total = 1 + 2 * sides.reduce((a, b) => a + b, 0), integers = sides.map(weight => Math.round(65536 * weight / total));
  const kernel = [...integers].reverse().concat(65536 - 2 * integers.reduce((a, b) => a + b, 0), integers).map(BigInt);
  const at = (x, y) => (Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4; if (!input[i + 3]) continue;
    let denominator = 0n; const sums = [0n, 0n, 0n];
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const j = at(x + dx, y + dy), weight = kernel[dx + radius] * kernel[dy + radius] * BigInt(input[j + 3]);
      denominator += weight; for (let c = 0; c < 3; c++) sums[c] += weight * BigInt(input[j + c]);
    }
    for (let c = 0; c < 3; c++) {
      const original = BigInt(input[i + c]), residual = original * denominator - sums[c];
      if ((residual < 0n ? -residual : residual) <= BigInt(threshold) * denominator) continue;
      const wideDenominator = 10000n * denominator, numerator = original * wideDenominator + BigInt(Math.round(amount * 100)) * residual;
      const candidate = numerator <= 0n ? 0 : numerator >= 255n * wideDenominator ? 255 : Number((2n * numerator + wideDenominator) / (2n * wideDenominator));
      output[i + c] = Math.round(input[i + c] + (candidate - input[i + c]) * opacity);
    }
  }
  return output;
}
function displayed(input) { const result = Buffer.from(input); for (let i = 0; i < result.length; i += 4) if (!result[i + 3]) result.fill(0, i, i + 3); return result; }

test('official MCP Unsharp Mask has separate source contracts, exact residuals, recipes, Bake and cumulative admission', { timeout: 35000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-unsharp-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Native Unsharp Mask cannot use models or credentials'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'unsharp-mask-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.equal(caps.layerFilterKinds.length, 32); assert.equal(caps.adjustmentKinds.length, 28); assert.ok(!caps.adjustmentKinds.includes('unsharp_mask'));
  assert.equal(caps.layerFilterUnsharpPolicy, 'rgb-residual-threshold-v1'); assert.equal(status.layerFilterUnsharpPolicy, caps.layerFilterUnsharpPolicy);
  const tool = (await client.listTools()).tools.find(item => item.name === 'prism_add_layer_filter');
  assert.ok(tool.inputSchema.properties.kind.enum.includes('unsharp_mask')); assert.match(tool.description, /strictly greater than threshold/); assert.match(tool.description, /Amount100\/threshold0 equals source sharpen/);

  const width = 9, height = 7, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let p = 0; p < alpha.length; p++) { raw.set([(p * 41 + 9) % 256, (p * 23 + 177) % 256, (p * 71 + 13) % 256, [0, 1, 128, 255][p % 4]], p * 4); alpha[p] = [255, 128, 1, 0][Math.floor(p / 4) % 4]; }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'original.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Unsharp detail' })).document;
  const layerId = document.layers[0].id, args = () => ({ backend: 'native', documentId: document.id });
  const get = async () => value(await call('get_document', args())).document, layer = () => document.layers.find(item => item.id === layerId);
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported(id = document.id) { const file = value(await call('export_document', { backend: 'native', documentId: id, format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  const inspect = async view => { const response = await call('get_layer_preview', { ...args(), layerId, view, maxWidth: 32 }); value(response); return Buffer.from(response.content.find(item => item.type === 'image').data, 'base64'); };
  const project = companion.native.projects.get(document.id), graph = structuredClone(project.states[project.cursor].graph);
  graph.layers[0].alphaAsset = await companion.native.storeAlpha(alpha, width, height);
  await companion.native.commit(project, graph, 'Independent source alpha fixture'); document = await get();
  const sourceView = await inspect('source'), alphaView = await inspect('mask'), originalAssets = new Map();
  for (const name of await fs.readdir(companion.native.assetsDir)) originalAssets.set(name, await fs.readFile(path.join(companion.native.assetsDir, name)));
  const effective = Buffer.from(raw); for (let p = 0; p < alpha.length; p++) effective[p * 4 + 3] = Math.round(raw[p * 4 + 3] * alpha[p] / 255);

  await edit('add_layer_filter', { layerId, kind: 'unsharp_mask', value: 0 }); const filterId = layer().filters[0].id;
  assert.deepEqual(layer().filters[0].parameters, { amount: 100, sigma: 1, threshold: 0 }); const defaultPixels = await exported();
  assert.deepEqual(defaultPixels, displayed(reference(effective, width, height)));
  await edit('clear_layer_filters', { layerId }); await edit('add_layer_filter', { layerId, kind: 'sharpen', value: 1 }); assert.deepEqual(await exported(), defaultPixels);
  await edit('undo'); await edit('undo'); assert.equal(layer().filters[0].id, filterId);
  await edit('update_layer_filter', { layerId, filterId, parameters: { amount: 133.33, sigma: .3977 } });
  await edit('update_layer_filter', { layerId, filterId, parameters: { threshold: 9 }, opacity: .625 });
  const first = { amount: 133.33, sigma: .3977, threshold: 9 }, second = { amount: 25, sigma: 1.25, threshold: 3 };
  assert.deepEqual(layer().filters[0].parameters, first); assert.equal(layer().filters[0].id, filterId);
  await edit('add_layer_filter', { layerId, kind: 'unsharp_mask', value: 0, parameters: second, opacity: .75 });
  const expected = reference(reference(effective, width, height, first, .625), width, height, second, .75);
  assert.deepEqual(await exported(), displayed(expected));
  const saved = structuredClone(document);
  for (const [command, fields] of [['update_layer_filter', { layerId, filterId, parameters: { amount: .001 } }], ['add_adjustment', { kind: 'unsharp_mask', value: 0 }], ['add_adjustment', { kind: 'sharpen', value: 1, parameters: { threshold: 1 } }]]) assert.equal((await call(command, { ...args(), expectedRevision: document.revision, ...fields })).isError, true);
  assert.deepEqual(await get(), saved); assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), [...originalAssets.keys()].sort());

  const recipe = await edit('save_edit_recipe', { name: 'Two source detail passes', slots: [{ key: 'photo', type: 'raster' }], steps: [
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'unsharp_mask', value: 0, parameters: first, opacity: .625 } },
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'unsharp_mask', value: 0, parameters: second, opacity: .75 } },
  ] });
  await edit('clear_layer_filters', { layerId }); const clear = structuredClone(document);
  assert.equal(value(await call('validate_edit_recipe', { ...args(), expectedRevision: document.revision, recipeId: recipe.recipeId, bindings: { photo: layerId } })).valid, true); assert.deepEqual(await get(), clear);
  const applyArgs = { ...args(), expectedRevision: document.revision, recipeId: recipe.recipeId, bindings: { photo: layerId }, requestId: 'unsharp-recipe' };
  const applied = value(await call('apply_edit_recipe', applyArgs)); document = applied.document; assert.deepEqual(value(await call('apply_edit_recipe', applyArgs)), applied); assert.deepEqual(await exported(), displayed(expected));
  await edit('undo'); assert.deepEqual(layer().filters, []); await edit('redo'); assert.deepEqual(await exported(), displayed(expected));
  await edit('set_layer_mask', { layerId, mask: { x: 1, y: 1, width: 7, height: 5 } });
  await edit('set_layer_mask_position', { layerId, x: 1, y: 0 }); await edit('modify_layer_mask', { layerId, density: .75 }); await edit('transform_layer', { layerId, x: 1, y: -1 });
  const editable = structuredClone(document), beforeBake = await exported();
  await edit('bake_layer_filters', { layerId }); assert.deepEqual(layer().filters, []); assert.deepEqual(await exported(), beforeBake);
  const expectedWorking = Buffer.from(expected); for (let p = 0; p < alpha.length; p++) expectedWorking[p * 4 + 3] = raw[p * 4 + 3];
  assert.deepEqual(await sharp(await fs.readFile(path.join(companion.native.assetsDir, layer().asset))).ensureAlpha().raw().toBuffer(), expectedWorking);
  assert.deepEqual(await inspect('source'), sourceView); assert.deepEqual(await inspect('mask'), alphaView);
  await edit('undo'); assert.deepEqual(document.layers, editable.layers);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision })), restored = value(await call('import_project_file', { path: portable.path, requestId: 'unsharp-project' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(restored.editRecipes, document.editRecipes); assert.deepEqual(await exported(restored.id), beforeBake);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get(); assert.deepEqual(document, persisted); assert.deepEqual(await exported(), beforeBake);
  assert.equal(failure(await call('apply_edit_recipe', applyArgs)).code, 'REVISION_CONFLICT');
  for (const [name, bytes] of originalAssets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, name)), bytes); assert.deepEqual(await fs.readFile(input), png);

  document = value(await call('create_document', { backend: 'native', name: 'Unsharp identity admission', width: 1024, height: 1024, background: '#ffffff' })).document;
  await edit('add_paint_layer', { name: 'Large source' }); const largeId = document.layers.at(-1).id;
  await edit('add_layer_filter', { layerId: largeId, kind: 'unsharp_mask', value: 0, parameters: { amount: 0, sigma: 50, threshold: 0 } }); const largeFilterId = document.layers.at(-1).filters[0].id;
  const tooLarge = await edit('save_edit_recipe', { name: 'Excessive radius', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'unsharp_mask', value: 0, parameters: { sigma: 50 } } }] });
  const safe = structuredClone(document), assetNames = (await fs.readdir(companion.native.assetsDir)).sort(), file = path.join(companion.native.projectsDir, `${document.id}.json`), projectBytes = await fs.readFile(file);
  assert.equal(failure(await call('update_layer_filter', { ...args(), expectedRevision: document.revision, layerId: largeId, filterId: largeFilterId, parameters: { amount: 100 } })).code, 'LIMIT_EXCEEDED');
  const admission = value(await call('validate_edit_recipe', { ...args(), expectedRevision: document.revision, recipeId: tooLarge.recipeId, bindings: { photo: largeId } })); assert.equal(admission.valid, false); assert.ok(admission.issues.some(issue => issue.code === 'LIMIT_EXCEEDED'));
  assert.equal(failure(await call('apply_edit_recipe', { ...args(), expectedRevision: document.revision, recipeId: tooLarge.recipeId, bindings: { photo: largeId } })).code, 'LIMIT_EXCEEDED');
  assert.deepEqual(await get(), safe); assert.deepEqual(await fs.readFile(file), projectBytes); assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), assetNames);
});

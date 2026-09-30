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
const defaults = { shadows: 25, highlights: 0, shadowWidth: 50, highlightWidth: 50, sigma: 3 };
const halfUp = (n, d) => Number((2n * n + d) / (2n * d));
const displayed = input => { const output = Buffer.from(input); for (let i = 0; i < output.length; i += 4) if (!output[i + 3]) output.fill(0, i, i + 3); return output; };

// Direct two-dimensional BigInt reference, independent of source helpers.
// It retains the three declared byte stages and then the existing entry blend.
function localTone(input, width, height, parameters = {}, blendMode = 'normal', opacity = 1) {
  const p = { ...defaults, ...parameters }, radius = Math.ceil(3 * p.sigma);
  const side = Array.from({ length: radius }, (_, i) => Math.exp(-((i + 1) ** 2) / (2 * p.sigma * p.sigma)));
  const denominator = 1 + 2 * side.reduce((a, b) => a + b, 0), quantized = side.map(v => Math.round(v / denominator * 65536));
  const weights = [...quantized].reverse().concat(65536 - 2 * quantized.reduce((a, b) => a + b, 0), quantized).map(BigInt);
  const yBytes = Array.from({ length: width * height }, (_, pixel) => Math.floor((2126 * input[pixel * 4] + 7152 * input[pixel * 4 + 1] + 722 * input[pixel * 4 + 2] + 5000) / 10000));
  const response = (amount, toneWidth, tone) => {
    const A = BigInt(Math.round(amount * 100)), T = BigInt(Math.round(toneWidth * 100)), span = 255n * T;
    const distance = span > 10000n * BigInt(tone) ? span - 10000n * BigInt(tone) : 0n;
    return BigInt(halfUp(65536n * A * distance * distance, 10000n * span * span));
  };
  const output = Buffer.from(input), op = BigInt(opacity * 8), oq = 8n;
  assert.ok(Number.isInteger(opacity * 8));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = y * width + x, offset = pixel * 4; if (!input[offset + 3]) continue;
    let n = 0n, d = 0n;
    for (let ky = -radius; ky <= radius; ky++) for (let kx = -radius; kx <= radius; kx++) {
      const index = Math.max(0, Math.min(height - 1, y + ky)) * width + Math.max(0, Math.min(width - 1, x + kx));
      const weight = weights[kx + radius] * weights[ky + radius] * BigInt(input[index * 4 + 3]);
      n += BigInt(yBytes[index]) * weight; d += weight;
    }
    const L = halfUp(n, d), s = response(p.shadows, p.shadowWidth, L), h = response(p.highlights, p.highlightWidth, 255 - L);
    const a = 65536n + 3n * s, b = 65536n + 3n * h;
    for (let c = 0; c < 3; c++) {
      const original = BigInt(input[offset + c]), candidate = BigInt(halfUp(255n * a * original, b * (255n - original) + a * original));
      if (blendMode === 'normal') output[offset + c] = Math.round(Number(original) + Number(candidate - original) * opacity);
      else { assert.equal(blendMode, 'multiply'); output[offset + c] = halfUp(original * 255n * oq + (original * candidate - original * 255n) * op, 255n * oq); }
    }
  }
  return output;
}
function masked(original, filtered, coverage, density) {
  const output = Buffer.from(filtered);
  for (let i = 0; i < coverage.length; i++) {
    if (!original[i * 4 + 3]) continue;
    const effective = density === 1 ? coverage[i] : density === 0 ? 255 : Math.round(255 - density * (255 - coverage[i]));
    for (let c = 0; c < 3; c++) output[i * 4 + c] = halfUp(BigInt(original[i * 4 + c] * (255 - effective) + filtered[i * 4 + c] * effective), 255n);
  }
  return output;
}

test('official MCP local tone keeps neighborhood pixels, mask scope and exact parameters through recipes, Bake and restart', { timeout: 35000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-local-tone-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Local tone does not use generation or credentials'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'local-tone-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.equal(caps.layerFilterKinds.length, 32); assert.equal(caps.adjustmentKinds.length, 28);
  assert.equal(caps.layerFilterLocalTonePolicy, 'alpha-weighted-local-tone-v1'); assert.equal(status.layerFilterLocalTonePolicy, caps.layerFilterLocalTonePolicy);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.find(item => item.name === 'prism_add_layer_filter').inputSchema.properties.kind.enum.includes('shadows_highlights'));
  assert.ok(!tools.find(item => item.name === 'prism_add_adjustment').inputSchema.properties.kind.enum.includes('shadows_highlights'));

  let document, layerId;
  const args = () => ({ backend: 'native', documentId: document.id });
  const get = async () => value(await call('get_document', args())).document, layer = () => document.layers.find(item => item.id === layerId);
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported(id = document.id) { const file = value(await call('export_document', { backend: 'native', documentId: id, format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  async function imported(raw, width, height, name) {
    const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, `${name}.png`); await fs.writeFile(input, png);
    document = value(await call('import_file', { path: input, name })).document; layerId = document.layers[0].id; return { png, input };
  }

  const neighbors = Buffer.alloc(9 * 4);
  for (let i = 0; i < 9; i++) neighbors.set([...(i < 4 ? [0, 0, 0] : [255, 255, 255]), 255], i * 4);
  neighbors.set([64, 64, 64, 255], 4); neighbors.set([64, 64, 64, 255], 7 * 4);
  await imported(neighbors, 9, 1, 'Local versus pointwise');
  await edit('add_layer_filter', { layerId, kind: 'shadows_highlights', value: 0, parameters: { sigma: 1 } });
  assert.deepEqual(layer().filters[0].parameters, { ...defaults, sigma: 1 });
  let result = await exported(); assert.deepEqual(result, localTone(neighbors, 9, 1, { sigma: 1 })); assert.notEqual(result[4], result[28]);
  const localId = layer().filters[0].id;
  for (const sigma of [0, Number.MIN_VALUE]) {
    await edit('update_layer_filter', { layerId, filterId: localId, parameters: { sigma } });
    assert.equal(layer().filters[0].parameters.sigma, sigma); result = await exported(); assert.deepEqual(result, localTone(neighbors, 9, 1, { sigma })); assert.equal(result[4], result[28]);
  }
  await edit('update_layer_filter', { layerId, filterId: localId, parameters: { shadows: 0, highlights: 0 }, blendMode: 'multiply' });
  result = await exported(); assert.equal(result[4], 16); assert.equal(result[28], 16);
  assert.deepEqual(result, localTone(neighbors, 9, 1, { shadows: 0, highlights: 0, sigma: Number.MIN_VALUE }, 'multiply'));

  const width = 9, height = 7, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height), coverage = [];
  for (let p = 0; p < alpha.length; p++) { raw.set([(p * 41 + 9) % 256, (p * 23 + 177) % 256, (p * 71 + 13) % 256, [0, 1, 128, 255][p % 4]], p * 4); alpha[p] = [255, 128, 1, 0][Math.floor(p / 4) % 4]; coverage.push([0, 1, 64, 128, 200, 255][p % 6]); }
  const { png, input } = await imported(raw, width, height, 'Editable local tones');
  const project = companion.native.projects.get(document.id), graph = structuredClone(project.states[project.cursor].graph);
  graph.layers[0].alphaAsset = await companion.native.storeAlpha(alpha, width, height);
  await companion.native.commit(project, graph, 'Fixture independent source alpha'); document = await get();
  const inspect = async view => { const response = await call('get_layer_preview', { ...args(), layerId, view, maxWidth: 32 }); value(response); return Buffer.from(response.content.find(item => item.type === 'image').data, 'base64'); };
  const sourceView = await inspect('source'), alphaView = await inspect('mask'), originalAssets = new Map();
  for (const name of await fs.readdir(companion.native.assetsDir)) originalAssets.set(name, await fs.readFile(path.join(companion.native.assetsDir, name)));
  const effective = Buffer.from(raw); for (let p = 0; p < alpha.length; p++) effective[p * 4 + 3] = Math.round(raw[p * 4 + 3] * alpha[p] / 255);
  const first = { kind: 'shadows_highlights', value: 0, parameters: { shadows: 73.45, highlights: 34.56, shadowWidth: 89.01, highlightWidth: 67.89, sigma: .528474 }, opacity: .625 };
  const second = { kind: 'shadows_highlights', value: 0, parameters: { shadows: 0, highlights: 83.21, shadowWidth: 1, highlightWidth: 100, sigma: 1.25 }, blendMode: 'multiply', opacity: .75 };
  await edit('add_layer_filter', { layerId, ...first }); const filterId = layer().filters[0].id;
  await edit('update_layer_filter', { layerId, filterId, parameters: { shadows: 0 } }); assert.deepEqual(layer().filters[0].parameters, { ...first.parameters, shadows: 0 });
  await edit('update_layer_filter', { layerId, filterId, parameters: { shadows: first.parameters.shadows } });
  await edit('add_layer_filter', { layerId, ...second });
  const full = localTone(localTone(effective, width, height, first.parameters, 'normal', first.opacity), width, height, second.parameters, second.blendMode, second.opacity);
  assert.deepEqual(await exported(), displayed(full));
  const runs = coverage.flatMap((byte, i) => byte ? [i, 1, byte] : []);
  await edit('set_layer_filter_mask', { layerId, source: 'mask', mask: { shape: 'bitmap', width, height, runs } });
  await edit('modify_layer_filter_mask', { layerId, density: .1 });
  const expected = masked(effective, full, coverage, .1); assert.deepEqual(await exported(), displayed(expected));
  const saved = structuredClone(document), filesBefore = (await fs.readdir(companion.native.assetsDir)).sort();
  for (const fields of [{ value: 1 }, { parameters: { shadowWidth: 0 } }, { parameters: { highlights: 1.001 } }, { parameters: { radius: 3 } }, { parameters: { sigma: 51 } }]) failure(await call('update_layer_filter', { ...args(), expectedRevision: document.revision, layerId, filterId, ...fields }));
  failure(await call('add_adjustment', { ...args(), kind: 'shadows_highlights', value: 0 }));
  failure(await call('update_adjustment', { ...args(), layerId, parameters: { shadowWidth: 50 } }));
  failure(await call('update_layer_filter', { ...args(), layerId, filterId, parameters: { sigma: 1 }, pretendOption: true }));
  assert.deepEqual(await get(), saved); assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), filesBefore);
  await edit('reorder_layer_filter', { layerId, filterId, index: 1 }); assert.notDeepEqual(await exported(), displayed(expected)); await edit('undo'); assert.deepEqual(document.layers, saved.layers);

  const definition = { name: 'Local tonal correction', slots: [{ key: 'photo', type: 'raster' }], steps: [first, second, { kind: 'shadows_highlights', value: 0, enabled: false, parameters: { shadows: 0 } }].map(entry => ({ command: 'add_layer_filter', target: 'photo', args: entry })) };
  const recipe = await edit('save_edit_recipe', definition), persistedRecipe = document.editRecipes.find(r => r.id === recipe.recipeId);
  assert.deepEqual(persistedRecipe.steps[2].args.parameters, { ...defaults, shadows: 0 });
  await edit('clear_layer_filters', { layerId });
  await edit('add_layer_filter', { layerId, kind: 'brightness', value: 0 });
  await edit('set_layer_filter_mask', { layerId, source: 'mask', mask: { shape: 'bitmap', width, height, runs } }); await edit('modify_layer_filter_mask', { layerId, density: .1 });
  const clear = structuredClone(document), scope = structuredClone(layer().filterMask);
  assert.equal(value(await call('validate_edit_recipe', { ...args(), recipeId: recipe.recipeId, bindings: { photo: layerId } })).valid, true); assert.deepEqual(await get(), clear);
  const applyArgs = { ...args(), expectedRevision: document.revision, recipeId: recipe.recipeId, bindings: { photo: layerId }, requestId: 'local-tone-recipe' };
  const applied = value(await call('apply_edit_recipe', applyArgs)); document = applied.document; assert.deepEqual(value(await call('apply_edit_recipe', applyArgs)), applied); assert.deepEqual(layer().filterMask, scope); assert.deepEqual(await exported(), displayed(expected));
  await edit('undo'); assert.deepEqual(document.layers, clear.layers); await edit('redo'); assert.deepEqual(await exported(), displayed(expected));
  await edit('set_layer_mask', { layerId, mask: { x: 1, y: 1, width: 7, height: 5 } }); await edit('set_layer_mask_position', { layerId, x: 1, y: 0 }); await edit('modify_layer_mask', { layerId, density: .75 });
  await edit('transform_layer', { layerId, x: 1, y: -1 });
  const editable = structuredClone(document), beforeBake = await exported();
  await edit('bake_layer_filters', { layerId }); assert.deepEqual(layer().filters, []); assert.equal(layer().filterMask, undefined); assert.deepEqual(await exported(), beforeBake);
  const expectedWorking = Buffer.from(expected); for (let p = 0; p < alpha.length; p++) expectedWorking[p * 4 + 3] = raw[p * 4 + 3];
  assert.deepEqual(await sharp(await fs.readFile(path.join(companion.native.assetsDir, layer().asset))).ensureAlpha().raw().toBuffer(), expectedWorking);
  assert.deepEqual(await inspect('source'), sourceView); assert.deepEqual(await inspect('mask'), alphaView);
  await edit('undo'); assert.deepEqual(document.layers, editable.layers);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision })), restored = value(await call('import_project_file', { path: portable.path, requestId: 'local-tone-project' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(restored.editRecipes, document.editRecipes); assert.deepEqual(await exported(restored.id), beforeBake);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get(); assert.deepEqual(document, persisted); assert.deepEqual(await exported(), beforeBake);
  assert.equal(failure(await call('apply_edit_recipe', applyArgs)).code, 'REVISION_CONFLICT');
  for (const [name, bytes] of originalAssets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, name)), bytes); assert.deepEqual(await fs.readFile(input), png);

  document = value(await call('create_document', { backend: 'native', name: 'Local tone admission', width: 1024, height: 1024, background: '#ffffff' })).document;
  await edit('add_paint_layer', { name: 'Large source' }); layerId = document.layers.at(-1).id;
  await edit('add_layer_filter', { layerId, kind: 'shadows_highlights', value: 0, parameters: { shadows: 0, highlights: 0, sigma: 50 } }); const largeFilterId = layer().filters[0].id;
  const safe = structuredClone(document), assetNames = (await fs.readdir(companion.native.assetsDir)).sort();
  assert.equal(failure(await call('update_layer_filter', { ...args(), expectedRevision: document.revision, layerId, filterId: largeFilterId, parameters: { shadows: 25 } })).code, 'LIMIT_EXCEEDED');
  assert.deepEqual(await get(), safe); assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), assetNames);
});

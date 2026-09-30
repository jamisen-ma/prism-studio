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

// Independent exact rational oracle. Opacity is the actual binary64 value,
// including arbitrary decimal spellings; no production blend helper is used.
function fraction(number) {
  if (number === 0) return [0n, 1n];
  const bytes = Buffer.alloc(8); bytes.writeDoubleBE(number);
  const bits = bytes.readBigUInt64BE(), exponent = Number((bits >> 52n) & 2047n);
  const mantissa = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
  const power = exponent ? exponent - 1075 : -1074;
  return power >= 0 ? [mantissa << BigInt(power), 1n] : [mantissa, 1n << BigInt(-power)];
}
const byte = n => Math.max(0, Math.min(255, Math.round(n)));
function reference(input, entries) {
  const result = Buffer.from(input);
  for (const entry of entries) {
    if (entry.enabled === false || entry.opacity === 0) continue;
    const opacity = entry.opacity ?? 1, mode = entry.blendMode ?? 'normal', [a, q] = fraction(opacity);
    for (let i = 0; i < result.length; i += 4) {
      if (!result[i + 3]) continue;
      for (let c = 0; c < 3; c++) {
        const current = result[i + c], candidate = entry.kind === 'gradient_map' ? parseInt(entry.parameters.stops[0].color.slice(1 + c * 2, 3 + c * 2), 16)
          : entry.kind === 'brightness' ? byte(current + entry.value * 2.55) : current;
        if (mode === 'normal') { result[i + c] = byte(current + (candidate - current) * opacity); continue; }
        const b = BigInt(current), f = BigInt(candidate);
        let numerator, denominator;
        if (mode === 'multiply') { numerator = b * f; denominator = 255n; }
        else if (mode === 'screen') { numerator = 255n * (b + f) - b * f; denominator = 255n; }
        else if (mode === 'difference') { numerator = b > f ? b - f : f - b; denominator = 1n; }
        else throw Error(`Unsupported independent fixture mode ${mode}`);
        const d = denominator * q, n = b * d + (numerator - b * denominator) * a;
        result[i + c] = n <= 0n ? 0 : n >= 255n * d ? 255 : Number((2n * n + d) / (2n * d));
      }
    }
  }
  return result;
}
function displayed(input) { const output = Buffer.from(input); for (let i = 0; i < output.length; i += 4) if (!output[i + 3]) output.fill(0, i, i + 3); return output; }
const constant = color => ({ stops: [{ offset: 0, color }, { offset: 1, color }] });

test('official MCP filter blending preserves exact source RGB semantics through recipes, Bake and portable restart', { timeout: 35000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-filter-blend-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Source filter blending cannot use models or credentials'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'source-filter-blend-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.equal(caps.layerFilterKinds.length, 32); assert.equal(caps.adjustmentKinds.length, 28);
  assert.equal(caps.layerFilterBlendPolicy, 'candidate-rgb-v1'); assert.equal(status.layerFilterBlendPolicy, caps.layerFilterBlendPolicy);
  assert.equal(caps.layerFilterBlendModes.length, 26); assert.ok(!caps.layerFilterBlendModes.includes('dissolve')); assert.deepEqual(status.layerFilterBlendModes, caps.layerFilterBlendModes);
  const tools = (await client.listTools()).tools, addSchema = tools.find(item => item.name === 'prism_add_layer_filter').inputSchema;
  assert.deepEqual(addSchema.properties.blendMode.enum, caps.layerFilterBlendModes);
  assert.ok(!tools.find(item => item.name === 'prism_add_adjustment').inputSchema.properties.blendMode);

  const width = 9, height = 7, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let p = 0; p < alpha.length; p++) { raw.set([(p * 41 + 13) % 256, (p * 23 + 17) % 256, (p * 71 + 2) % 256, [255, 128, 1, 0][p % 4]], p * 4); alpha[p] = [255, 128, 1, 0][Math.floor(p / 4) % 4]; }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'original.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Editable filter blends' })).document;
  const layerId = document.layers[0].id, args = () => ({ backend: 'native', documentId: document.id });
  const get = async () => value(await call('get_document', args())).document, layer = () => document.layers.find(item => item.id === layerId);
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported(id = document.id) { const file = value(await call('export_document', { backend: 'native', documentId: id, format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  const inspect = async view => { const response = await call('get_layer_preview', { ...args(), layerId, view, maxWidth: 32 }); value(response); return Buffer.from(response.content.find(item => item.type === 'image').data, 'base64'); };
  const project = companion.native.projects.get(document.id), graph = structuredClone(project.states[project.cursor].graph);
  const alphaAsset = await companion.native.storeAlpha(alpha, width, height); graph.layers[0].alphaAsset = alphaAsset;
  await companion.native.commit(project, graph, 'Independent source alpha fixture'); document = await get();
  const sourceView = await inspect('source'), alphaView = await inspect('mask'), originalAssets = new Map();
  for (const name of await fs.readdir(companion.native.assetsDir)) originalAssets.set(name, await fs.readFile(path.join(companion.native.assetsDir, name)));
  const effective = Buffer.from(raw); for (let p = 0; p < alpha.length; p++) effective[p * 4 + 3] = Math.round(raw[p * 4 + 3] * alpha[p] / 255);
  const first = { kind: 'gradient_map', value: 0, parameters: constant('#555555'), opacity: .75, blendMode: 'multiply' };
  await edit('add_layer_filter', { layerId, ...first }); const filterId = layer().filters[0].id;
  assert.equal(layer().blendMode, 'normal'); assert.equal(layer().filters[0].blendMode, 'multiply');
  assert.equal(reference(effective, [first])[0], 7); assert.deepEqual(await exported(), displayed(reference(effective, [first])));
  await edit('update_layer_filter', { layerId, filterId, blendMode: 'normal' }); assert.ok(!Object.hasOwn(layer().filters[0], 'blendMode'));
  assert.deepEqual(await exported(), displayed(reference(effective, [{ ...first, blendMode: 'normal' }])));
  await edit('update_layer_filter', { layerId, filterId, blendMode: 'multiply' }); await edit('update_layer_filter', { layerId, filterId, opacity: .75 }); assert.equal(layer().filters[0].blendMode, 'multiply');
  const second = { kind: 'brightness', value: 20, opacity: .375, blendMode: 'screen' }, third = { kind: 'add_noise', value: 0, parameters: { amount: 0, distribution: 'gaussian', monochromatic: false, seed: 0 }, opacity: .1, blendMode: 'multiply' };
  await edit('add_layer_filter', { layerId, ...second }); await edit('add_layer_filter', { layerId, ...third });
  const expected = reference(effective, [first, second, third]);
  assert.deepEqual(await exported(), displayed(expected));
  for (const maxWidth of [32, 100, 700]) value(await call('get_preview', { ...args(), maxWidth })); assert.deepEqual(await exported(), displayed(expected));
  const saved = structuredClone(document);
  for (const blendMode of ['dissolve', 'unknown', null, 1]) assert.equal((await call('update_layer_filter', { ...args(), expectedRevision: document.revision, layerId, filterId, blendMode })).isError, true);
  assert.equal((await call('add_adjustment', { ...args(), kind: 'brightness', value: 1, blendMode: 'multiply' })).isError, true);
  assert.deepEqual(await get(), saved); assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), [...originalAssets.keys()].sort());
  const definition = { name: 'Exact three-pass filter blend', slots: [{ key: 'photo', type: 'raster' }], steps: [first, second, third, { kind: 'blur', value: 0, enabled: false, opacity: .5, blendMode: 'normal' }].map(entry => ({ command: 'add_layer_filter', target: 'photo', args: entry })) };
  const recipe = await edit('save_edit_recipe', definition);
  const storedRecipe = document.editRecipes.find(item => item.id === recipe.recipeId);
  assert.equal(storedRecipe.steps[0].args.blendMode, 'multiply'); assert.ok(!Object.hasOwn(storedRecipe.steps[3].args, 'blendMode'));
  await edit('clear_layer_filters', { layerId });
  const beforeValidation = structuredClone(document), validation = value(await call('validate_edit_recipe', { ...args(), recipeId: recipe.recipeId, bindings: { photo: layerId } })); assert.equal(validation.valid, true); assert.deepEqual(await get(), beforeValidation);
  const applyArgs = { ...args(), expectedRevision: document.revision, recipeId: recipe.recipeId, bindings: { photo: layerId }, requestId: 'exact-filter-blend-recipe' };
  const applied = value(await call('apply_edit_recipe', applyArgs)); document = applied.document; assert.deepEqual(value(await call('apply_edit_recipe', applyArgs)), applied); assert.deepEqual(await exported(), displayed(expected));
  assert.equal(layer().filters.length, 4); assert.ok(!Object.hasOwn(layer().filters[3], 'blendMode'));
  await edit('undo'); assert.deepEqual(layer().filters, []); await edit('redo'); assert.deepEqual(await exported(), displayed(expected));
  await edit('set_layer_mask', { layerId, mask: { x: 1, y: 1, width: 7, height: 5 } }); await edit('set_layer_mask_position', { layerId, x: 1, y: 0 });
  await edit('modify_layer_mask', { layerId, density: .75 }); await edit('transform_layer', { layerId, x: 1, y: -1 });
  const editable = structuredClone(document), beforeBake = await exported();
  await edit('bake_layer_filters', { layerId }); assert.deepEqual(layer().filters, []); assert.deepEqual(await exported(), beforeBake);
  const expectedWorking = Buffer.from(expected); for (let p = 0; p < alpha.length; p++) expectedWorking[p * 4 + 3] = raw[p * 4 + 3];
  assert.deepEqual(await sharp(await fs.readFile(path.join(companion.native.assetsDir, layer().asset))).ensureAlpha().raw().toBuffer(), expectedWorking);
  assert.deepEqual(await inspect('source'), sourceView); assert.deepEqual(await inspect('mask'), alphaView);
  await edit('undo'); assert.deepEqual(document.layers, editable.layers);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision })), restored = value(await call('import_project_file', { path: portable.path, requestId: 'filter-blend-project' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(restored.editRecipes, document.editRecipes); assert.deepEqual(await exported(restored.id), beforeBake);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get(); assert.deepEqual(document, persisted); assert.deepEqual(await exported(), beforeBake);
  assert.equal(failure(await call('apply_edit_recipe', applyArgs)).code, 'REVISION_CONFLICT');
  for (const [name, bytes] of originalAssets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, name)), bytes); assert.deepEqual(await fs.readFile(input), png);
});

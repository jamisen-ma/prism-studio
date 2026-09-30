import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = response => { assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text); };
const failure = response => { assert.equal(response.isError, true); return JSON.parse(response.content.find(item => item.type === 'text').text); };

// Independent BigInt word/rational operations and a digest-pinned certified
// table fixture. No production hash, table, candidate or rounding is imported.
const mask = (1n << 32n) - 1n;
function mix(word) {
  word = ((word ^ (word >> 16n)) * 0x7feb352dn) & mask;
  word = ((word ^ (word >> 15n)) * 0x846ca68bn) & mask;
  return (word ^ (word >> 16n)) & mask;
}
function reference(input, parameters, table, opacity = 1) {
  const { amount = 5, distribution = 'uniform', monochromatic = true, seed = 1 } = parameters;
  const output = Buffer.from(input); if (amount === 0) return output;
  const seedKey = mix((BigInt(seed) + 0x9e3779b9n) & mask), scale = distribution === 'uniform' ? 65536n : 8192n, denominator = scale * 10000n;
  for (let p = 0; p < input.length / 4; p++) {
    if (!input[p * 4 + 3]) continue;
    for (let c = 0; c < 3; c++) {
      const counter = BigInt(3 * p + (monochromatic ? 0 : c)), word = mix(((counter * 0x9e3779b9n) & mask) ^ seedKey);
      const index = Number(word >> 20n), q = distribution === 'uniform' ? 2n * (word >> 16n) + 1n - 65536n : BigInt(index < 2048 ? -table.readInt16LE((2047 - index) * 2) : table.readInt16LE((index - 2048) * 2));
      const current = input[p * 4 + c], numerator = BigInt(current) * denominator + q * 255n * BigInt(Math.round(amount * 100));
      const candidate = numerator <= 0n ? 0 : numerator >= 255n * denominator ? 255 : Number((2n * numerator + denominator) / (2n * denominator));
      output[p * 4 + c] = Math.round(current + (candidate - current) * opacity);
    }
  }
  return output;
}
function displayed(input) { const result = Buffer.from(input); for (let i = 0; i < result.length; i += 4) if (!result[i + 3]) result.fill(0, i, i + 3); return result; }

test('official MCP seeded noise retains exact patterns across scopes, recipes, Bake, portable transfer and restart', { timeout: 35000 }, async t => {
  const table = await fs.readFile(path.join(root, 'tests/fixtures/noise/gaussian-positive-q8192.bin'));
  assert.equal(table.length, 4096); assert.equal(createHash('sha256').update(table).digest('hex'), '317cfb8ef5c5cb825f7f0530359f16c72bb981d69be1c4e7e0119d728ba15ea3');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-noise-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Native source noise cannot use models or credentials'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'source-noise-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.equal(caps.layerFilterKinds.length, 32); assert.equal(caps.adjustmentKinds.length, 28); assert.ok(!caps.adjustmentKinds.includes('add_noise'));
  assert.equal(caps.layerFilterNoisePolicy, 'seeded-rgb-discrete-v1'); assert.equal(status.layerFilterNoisePolicy, caps.layerFilterNoisePolicy);
  const tool = (await client.listTools()).tools.find(item => item.name === 'prism_add_layer_filter'); assert.ok(tool.inputSchema.properties.kind.enum.includes('add_noise')); assert.match(tool.description, /Rendering|rendering/); assert.match(tool.description, /never reseed/);

  const width = 9, height = 7, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let p = 0; p < alpha.length; p++) { raw.set([(p * 41 + 9) % 256, (p * 23 + 177) % 256, (p * 71 + 13) % 256, [0, 1, 128, 255][p % 4]], p * 4); alpha[p] = [255, 128, 1, 0][Math.floor(p / 4) % 4]; }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'original.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Seeded source texture' })).document;
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
  await edit('add_layer_filter', { layerId, kind: 'add_noise', value: 0 }); const filterId = layer().filters[0].id;
  assert.deepEqual(layer().filters[0].parameters, { amount: 5, distribution: 'uniform', monochromatic: true, seed: 1 });
  assert.deepEqual(await exported(), displayed(reference(effective, {}, table)));
  await edit('update_layer_filter', { layerId, filterId, parameters: { monochromatic: false, seed: 0 } });
  await edit('update_layer_filter', { layerId, filterId, parameters: { amount: 13.37 }, opacity: .625 });
  const first = { amount: 13.37, distribution: 'uniform', monochromatic: false, seed: 0 }, second = { amount: 2.5, distribution: 'gaussian', monochromatic: false, seed: 4294967295 };
  assert.deepEqual(layer().filters[0].parameters, first); assert.equal(layer().filters[0].id, filterId);
  await edit('add_layer_filter', { layerId, kind: 'add_noise', value: 0, parameters: second, opacity: .75 });
  const expected = reference(reference(effective, first, table, .625), second, table, .75);
  for (let repeat = 0; repeat < 3; repeat++) assert.deepEqual(await exported(), displayed(expected));
  for (const maxWidth of [32, 100, 700]) value(await call('get_preview', { ...args(), maxWidth })); assert.deepEqual(await exported(), displayed(expected));
  const saved = structuredClone(document);
  for (const [command, fields] of [['update_layer_filter', { layerId, filterId, parameters: { seed: 4294967296 } }], ['add_adjustment', { kind: 'add_noise', value: 0 }], ['add_adjustment', { kind: 'brightness', value: 1, parameters: { seed: 0 } }]]) assert.equal((await call(command, { ...args(), expectedRevision: document.revision, ...fields })).isError, true);
  assert.deepEqual(await get(), saved); assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), [...originalAssets.keys()].sort());

  const definition = { name: 'Repeatable two-pass grain', slots: [{ key: 'photo', type: 'raster' }], steps: [
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'add_noise', value: 0, parameters: first, opacity: .625 } },
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'add_noise', value: 0, parameters: second, opacity: .75 } },
  ] };
  const recipe = await edit('save_edit_recipe', definition);
  await edit('clear_layer_filters', { layerId }); const clear = structuredClone(document);
  assert.equal(value(await call('validate_edit_recipe', { ...args(), expectedRevision: document.revision, recipeId: recipe.recipeId, bindings: { photo: layerId } })).valid, true); assert.deepEqual(await get(), clear);
  const applyArgs = { ...args(), expectedRevision: document.revision, recipeId: recipe.recipeId, bindings: { photo: layerId }, requestId: 'seeded-noise-recipe' };
  const applied = value(await call('apply_edit_recipe', applyArgs)); document = applied.document; assert.deepEqual(value(await call('apply_edit_recipe', applyArgs)), applied); assert.deepEqual(await exported(), displayed(expected));
  await edit('undo'); assert.deepEqual(layer().filters, []); await edit('redo'); assert.deepEqual(await exported(), displayed(expected));
  // Equal sources in a separate document get new graph/filter IDs but the same
  // saved recipe seed. Only the independently specified source-alpha fixture
  // is installed directly; recipe creation/application use the official SDK.
  let other = value(await call('import_file', { path: input, name: 'Independent texture target' })).document;
  const otherLayerId = other.layers[0].id, otherProject = companion.native.projects.get(other.id), otherGraph = structuredClone(otherProject.states[otherProject.cursor].graph);
  otherGraph.layers[0].alphaAsset = alphaAsset; await companion.native.commit(otherProject, otherGraph, 'Equal source alpha fixture');
  other = value(await call('get_document', { backend: 'native', documentId: other.id })).document;
  const transferred = value(await call('save_edit_recipe', { backend: 'native', documentId: other.id, expectedRevision: other.revision, ...definition })); other = transferred.document;
  other = value(await call('apply_edit_recipe', { backend: 'native', documentId: other.id, expectedRevision: other.revision, recipeId: transferred.recipeId, bindings: { photo: otherLayerId } })).document;
  assert.notEqual(other.layers[0].filters[0].id, layer().filters[0].id); assert.deepEqual(await exported(other.id), displayed(expected));

  await edit('set_layer_mask', { layerId, mask: { x: 1, y: 1, width: 7, height: 5 } }); await edit('set_layer_mask_position', { layerId, x: 1, y: 0 });
  await edit('modify_layer_mask', { layerId, density: .75 }); await edit('transform_layer', { layerId, x: 1, y: -1 });
  const editable = structuredClone(document), beforeBake = await exported();
  await edit('bake_layer_filters', { layerId }); assert.deepEqual(layer().filters, []); assert.deepEqual(await exported(), beforeBake);
  const expectedWorking = Buffer.from(expected); for (let p = 0; p < alpha.length; p++) expectedWorking[p * 4 + 3] = raw[p * 4 + 3];
  assert.deepEqual(await sharp(await fs.readFile(path.join(companion.native.assetsDir, layer().asset))).ensureAlpha().raw().toBuffer(), expectedWorking);
  assert.deepEqual(await inspect('source'), sourceView); assert.deepEqual(await inspect('mask'), alphaView);
  await edit('undo'); assert.deepEqual(document.layers, editable.layers);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision })), restored = value(await call('import_project_file', { path: portable.path, requestId: 'seeded-noise-project' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(restored.editRecipes, document.editRecipes); assert.deepEqual(await exported(restored.id), beforeBake);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get(); assert.deepEqual(document, persisted); assert.deepEqual(await exported(), beforeBake);
  assert.equal(failure(await call('apply_edit_recipe', applyArgs)).code, 'REVISION_CONFLICT');
  for (const [name, bytes] of originalAssets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, name)), bytes); assert.deepEqual(await fs.readFile(input), png);
});

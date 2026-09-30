import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = result => { assert.notEqual(result.isError, true, JSON.stringify(result.content)); return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text); };
const failure = result => { assert.equal(result.isError, true); const message = result.content.find(item => item.type === 'text').text; try { return JSON.parse(message); } catch { return { message }; } };
const points = [{ x: 0, y: 0 }, { x: 85, y: 170 }, { x: 170, y: 170 }, { x: 255, y: 255 }];
const half = (n, d) => Number((2n * n + d) / (2n * d));
// Independent closed-form PCHIP fixture. Secants are 2,0,1; knot
// derivatives are 3,0,0,1.5. Evaluate exact rational cubics, not the helper.
function smoothByte(input) {
  const h = 85n, cube = h ** 3n;
  if (input <= 85) { const x = BigInt(input); return half(255n * x * h * h - 85n * x ** 3n, cube); }
  if (input <= 170) return 170;
  const x = BigInt(input - 170); return half(340n * cube + 255n * x * x * h - 85n * x ** 3n, 2n * cube);
}
function linearByte(input) { return input <= 85 ? input * 2 : input <= 170 ? 170 : input; }
const displayed = input => { const result = Buffer.from(input); for (let i = 0; i < result.length; i += 4) if (!result[i + 3]) result.fill(0, i, i + 3); return result; };
function candidate(raw, alpha, { channel = 'rgb', multiply = false, mask = false } = {}) {
  const result = Buffer.from(raw);
  for (let p = 0; p < alpha.length; p++) {
    const i = p * 4; result[i + 3] = Math.round(raw[i + 3] * alpha[p] / 255); if (!result[i + 3]) continue;
    const effect = mask && (p % 256 < 32 || p % 256 >= 224) ? 128 : 255;
    for (let c = 0; c < 3; c++) {
      const original = raw[i + c], mapped = channel === 'rgb' || ['red', 'green', 'blue'][c] === channel ? smoothByte(original) : original;
      const filtered = multiply ? half(BigInt(original * 255 + original * mapped), 510n) : mapped;
      result[i + c] = half(BigInt(original * (255 - effect) + filtered * effect), 255n);
    }
  }
  return result;
}
async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-smooth-curves-mcp-'));
  let companion, client, forbiddenCalls = 0, stderr = ''; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Curves must not use a provider, segmentation or key'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
    const port = await companion.listen(); tokens.push(companion.token); client = new Client({ name: 'smooth-curves-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.equal(forbiddenCalls, 0); for (const token of tokens) assert.ok(!stderr.includes(token)); });
  await start(); return { dataDir, call: (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args }), get native() { return companion.native; }, get client() { return client; }, restart: async () => { await client.close(); await companion.close(); await start(); } };
}

test('official MCP Smooth Curves preserves exact source scope, sparse updates, mask/blend order, Bake and portable restart', { timeout: 35000 }, async t => {
  const env = await setup(t), { call, dataDir } = env;
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.equal(caps.curvesInterpolationPolicy, 'shape-preserving-pchip-v1'); assert.deepEqual(caps.curvesInterpolationModes, ['linear', 'smooth']);
  for (const key of ['curvesInterpolationPolicy', 'curvesInterpolationModes']) assert.deepEqual(status[key], caps[key]);
  assert.equal(caps.adjustmentKinds.length, 28); assert.equal(caps.layerFilterKinds.length, 32);
  const tools = (await env.client.listTools()).tools;
  for (const name of ['add_adjustment', 'update_adjustment', 'add_layer_filter', 'update_layer_filter']) assert.match(tools.find(tool => tool.name === `prism_${name}`).description, /shape-preserving-pchip-v1/);
  const width = 256, height = 4, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let p = 0; p < alpha.length; p++) { const x = p % width, row = Math.floor(p / width); raw.set([x, 255 - x, x * 7 % 256, [255, 128, 1, 0][row]], p * 4); alpha[p] = row === 0 ? 255 : [0, 1, 128, 255][x % 4]; }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'source.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Smooth source curve' })).document; const layerId = document.layers[0].id;
  const args = () => ({ backend: 'native', documentId: document.id }), get = async () => value(await call('get_document', args())).document, layer = () => document.layers.find(item => item.id === layerId);
  async function edit(name, fields = {}) { const result = value(await call(name, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported(id = document.id) { const file = value(await call('export_document', { backend: 'native', documentId: id, format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  const project = env.native.project(document.id), graph = structuredClone(project.states[project.cursor].graph); graph.layers[0].alphaAsset = await env.native.storeAlpha(alpha, width, height); await env.native.commit(project, graph, 'Fixture cutout alpha'); document = await get();
  const originalAssets = new Map(await Promise.all((await fs.readdir(env.native.assetsDir)).map(async name => [name, await fs.readFile(path.join(env.native.assetsDir, name))])));
  await edit('add_layer_filter', { layerId, kind: 'curves', value: 0, parameters: { points, interpolation: 'smooth' } }); const filterId = layer().filters[0].id;
  assert.deepEqual(await exported(), displayed(candidate(raw, alpha)));
  await edit('update_layer_filter', { layerId, filterId, parameters: { channel: 'red' } }); assert.equal(layer().filters[0].parameters.interpolation, 'smooth'); assert.deepEqual(layer().filters[0].parameters.points, points); assert.deepEqual(await exported(), displayed(candidate(raw, alpha, { channel: 'red' })));
  await edit('update_layer_filter', { layerId, filterId, parameters: { channel: 'rgb' }, blendMode: 'multiply', opacity: .5 });
  await edit('set_layer_filter_mask', { layerId, source: 'mask', mask: { shape: 'rectangle', x: 32, y: 0, width: 192, height } }); await edit('modify_layer_filter_mask', { layerId, density: .5 });
  const expected = candidate(raw, alpha, { multiply: true, mask: true }); assert.deepEqual(await exported(), displayed(expected));
  const stable = structuredClone(document); const rejected = await call('update_layer_filter', { ...args(), expectedRevision: document.revision, layerId, filterId, parameters: { interpolation: 'smooth', tension: 1 } }); failure(rejected); assert.deepEqual(await get(), stable);
  await edit('update_layer_filter', { layerId, filterId, parameters: { interpolation: 'linear' } }); assert.equal(layer().filters[0].parameters.interpolation, undefined); assert.deepEqual(layer().filters[0].parameters.points, points);
  await edit('undo'); assert.deepEqual(document.layers, stable.layers); assert.deepEqual(await exported(), displayed(expected));
  await edit('transform_layer', { layerId, x: 1, y: 0 }); const editable = structuredClone(document), appearance = await exported();
  await edit('bake_layer_filters', { layerId }); assert.deepEqual(layer().filters, []); assert.equal(layer().filterMask, undefined); assert.deepEqual(await exported(), appearance);
  const working = Buffer.from(expected); for (let p = 0; p < alpha.length; p++) working[p * 4 + 3] = raw[p * 4 + 3];
  assert.deepEqual(await sharp(await fs.readFile(path.join(env.native.assetsDir, layer().asset))).ensureAlpha().raw().toBuffer(), working);
  await edit('undo'); assert.deepEqual(document.layers, editable.layers);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'smooth-source-portable' })).document; assert.deepEqual(restored.layers, document.layers); assert.deepEqual(await exported(restored.id), appearance);
  const persisted = structuredClone(document); await env.restart(); document = await get(); assert.deepEqual(document, persisted); assert.deepEqual(await exported(), appearance);
  for (const [name, bytes] of originalAssets) assert.deepEqual(await fs.readFile(path.join(env.native.assetsDir, name)), bytes); assert.deepEqual(await fs.readFile(input), png);
});

test('official MCP curve recipes reset Smooth to canonical Linear atomically and retain stable definitions across replay', { timeout: 35000 }, async t => {
  const env = await setup(t), { call, dataDir } = env, raw = Buffer.alloc(256 * 2 * 4);
  for (let p = 0; p < 512; p++) raw.set([p % 256, 255 - p % 256, p * 7 % 256, 255], p * 4);
  const png = await sharp(raw, { raw: { width: 256, height: 2, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'ramp.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Curve recipe defaults' })).document;
  const args = () => ({ backend: 'native', documentId: document.id }), get = async () => value(await call('get_document', args())).document;
  async function edit(name, fields = {}) { const result = value(await call(name, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported() { const file = value(await call('export_document', { ...args(), format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  const mapped = fn => { const result = Buffer.from(raw); for (let i = 0; i < result.length; i++) if (i % 4 !== 3) result[i] = fn(result[i]); return result; };
  await edit('add_adjustment', { kind: 'curves', value: 0, parameters: { points, interpolation: 'smooth' } }); const gradeId = document.layers.at(-1).id;
  assert.deepEqual(await exported(), mapped(smoothByte));
  await edit('update_adjustment', { layerId: gradeId, parameters: { channel: 'blue' } }); assert.equal(document.layers.at(-1).parameters.interpolation, 'smooth'); await edit('update_adjustment', { layerId: gradeId, parameters: { channel: 'rgb' } });
  const definition = { name: 'Legacy linear grade', slots: [{ key: 'grade', type: 'adjustment', kind: 'curves' }], steps: [{ command: 'update_adjustment', target: 'grade', args: { value: 0, parameters: { points, channel: 'rgb' } } }] };
  const saved = await edit('save_edit_recipe', definition), recipeId = saved.recipeId, bindings = { grade: gradeId };
  const inspected = value(await call('get_edit_recipe', { ...args(), recipeId })); assert.equal(inspected.recipe.steps[0].args.parameters.interpolation, undefined);
  const before = structuredClone(document), assets = (await fs.readdir(env.native.assetsDir)).sort();
  const report = value(await call('validate_edit_recipe', { ...args(), recipeId, bindings })); assert.equal(report.valid, true); assert.equal(report.validation, 'metadata-only'); assert.deepEqual(await get(), before); assert.deepEqual((await fs.readdir(env.native.assetsDir)).sort(), assets);
  const once = { ...args(), expectedRevision: document.revision, recipeId, bindings, requestId: 'linear-resets-smooth' };
  const applied = value(await call('apply_edit_recipe', once)); document = applied.document; assert.deepEqual(value(await call('apply_edit_recipe', once)), applied);
  assert.equal(document.layers.at(-1).parameters.interpolation, undefined); assert.deepEqual(await exported(), mapped(linearByte)); assert.equal(document.history.length, before.history.length + 1); assert.deepEqual(value(await call('get_edit_recipe', { ...args(), recipeId })), { ...inspected, revision: document.revision });
  await edit('undo'); assert.deepEqual(document.layers, before.layers); assert.deepEqual(await exported(), mapped(smoothByte));
  await edit('apply_transaction', { label: 'Explicit Linear reset', operations: [{ command: 'update_adjustment', args: { layerId: gradeId, parameters: { points, channel: 'rgb', interpolation: 'linear' } } }] }); assert.deepEqual(await exported(), mapped(linearByte)); assert.deepEqual(document.editRecipes, before.editRecipes);
  const snapshot = structuredClone(document), pathToProject = path.join(env.native.projectsDir, `${document.id}.json`), bytes = await fs.readFile(pathToProject);
  failure(await call('apply_transaction', { ...args(), expectedRevision: document.revision, label: 'Late rejected curve', operations: [{ command: 'update_adjustment', args: { layerId: gradeId, parameters: { interpolation: 'smooth' } } }, { command: 'delete_layer', args: { layerId: 'missing' } }] })); assert.deepEqual(await get(), snapshot); assert.deepEqual(await fs.readFile(pathToProject), bytes);
  const smoothRecipe = await edit('save_edit_recipe', { ...definition, name: 'Explicit Smooth grade', steps: [{ command: 'update_adjustment', target: 'grade', args: { value: 0, parameters: { points, interpolation: 'smooth' } } }] });
  await edit('apply_edit_recipe', { recipeId: smoothRecipe.recipeId, bindings }); assert.deepEqual(await exported(), mapped(smoothByte));
  const stable = structuredClone(document); await env.restart(); document = await get(); assert.deepEqual(document, stable); assert.deepEqual(await exported(), mapped(smoothByte)); assert.equal(failure(await call('apply_edit_recipe', once)).code, 'REVISION_CONFLICT');
  assert.deepEqual((await fs.readdir(env.native.assetsDir)).sort(), assets); assert.deepEqual(await fs.readFile(input), png);
});

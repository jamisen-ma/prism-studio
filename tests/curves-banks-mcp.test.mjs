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
async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-curves-banks-mcp-'));
  let companion, client, forbiddenCalls = 0, stderr = ''; const tokens = [], traffic = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Curves must not use a provider, segmentation or key'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
    companion.server.on('request', request => traffic.push(new URL(request.url, 'http://127.0.0.1').pathname));
    const port = await companion.listen(); tokens.push(companion.token); client = new Client({ name: 'curves-banks-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); assert.equal(forbiddenCalls, 0); for (const token of tokens) assert.ok(!stderr.includes(token)); });
  await start(); return { dataDir, traffic, call: (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args }), get native() { return companion.native; }, get client() { return client; }, restart: async () => { await client.close(); await companion.close(); await start(); } };
}

const identity = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
const halfScale = [{ x: 0, y: 0 }, { x: 255, y: 127.5 }];
const invert = [{ x: 0, y: 255 }, { x: 255, y: 0 }];
const bankSpec = () => ({ mode: 'banks', banks: { master: { points, interpolation: 'smooth' }, red: { points: halfScale, interpolation: 'linear' }, green: { points: invert, interpolation: 'linear' }, blue: { points, interpolation: 'smooth' } } });
const bankByte = (x, c) => { const m = smoothByte(x); return c === 0 ? Math.round(m / 2) : c === 1 ? 255 - m : smoothByte(m); };
function candidate(raw, alpha, { blend = false, mask = false, map = bankByte } = {}) {
  const result = Buffer.from(raw);
  for (let p = 0; p < alpha.length; p++) {
    const i = p * 4; result[i + 3] = Math.round(raw[i + 3] * alpha[p] / 255); if (!result[i + 3]) continue;
    const effect = mask && (p % 256 < 32 || p % 256 >= 224) ? 128 : 255;
    for (let c = 0; c < 3; c++) {
      const original = raw[i + c], mapped = map(original, c);
      const filtered = blend ? half(BigInt(original * 255 + original * mapped), 510n) : mapped;
      result[i + c] = half(BigInt(original * (255 - effect) + filtered * effect), 255n);
    }
  }
  return result;
}

test('official MCP four-bank Curves preserves explicit upgrades, nested updates, blend/mask order, Bake and portable restart', { timeout: 35000 }, async t => {
  const env = await setup(t), { call, dataDir } = env;
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.equal(caps.curvesBanksPolicy, 'master-byte-then-channel-byte-v1'); assert.deepEqual(caps.curvesBankNames, ['master', 'red', 'green', 'blue']);
  for (const key of ['curvesBanksPolicy', 'curvesBankNames', 'curvesInterpolationPolicy', 'curvesInterpolationModes']) assert.deepEqual(status[key], caps[key]);
  assert.equal(caps.adjustmentKinds.length, 28); assert.equal(caps.layerFilterKinds.length, 32);
  const tools = (await env.client.listTools()).tools;
  for (const name of ['add_adjustment', 'update_adjustment', 'add_layer_filter', 'update_layer_filter']) assert.match(tools.find(tool => tool.name === `prism_${name}`).description, /master-byte-then-channel-byte-v1/);
  const width = 256, height = 4, raw = Buffer.alloc(width * height * 4), alpha = Buffer.alloc(width * height);
  for (let p = 0; p < alpha.length; p++) { const x = p % width, row = Math.floor(p / width); raw.set([x, 255 - x, x * 7 % 256, [255, 128, 1, 0][row]], p * 4); alpha[p] = row === 0 ? 255 : [0, 1, 128, 255][x % 4]; }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'source.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Four source curves' })).document; const layerId = document.layers[0].id;
  const args = () => ({ backend: 'native', documentId: document.id }), get = async () => value(await call('get_document', args())).document, layer = () => document.layers.find(item => item.id === layerId);
  async function edit(name, fields = {}) { const result = value(await call(name, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported(id = document.id) { const file = value(await call('export_document', { backend: 'native', documentId: id, format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  const project = env.native.project(document.id), graph = structuredClone(project.states[project.cursor].graph); graph.layers[0].alphaAsset = await env.native.storeAlpha(alpha, width, height); await env.native.commit(project, graph, 'Fixture cutout alpha'); document = await get();
  const originals = new Map(await Promise.all((await fs.readdir(env.native.assetsDir)).map(async name => [name, await fs.readFile(path.join(env.native.assetsDir, name))])));
  await edit('add_layer_filter', { layerId, kind: 'curves', value: 0, parameters: { points, interpolation: 'smooth' } }); const filterId = layer().filters[0].id, legacyAppearance = await exported();
  assert.deepEqual(legacyAppearance, displayed(candidate(raw, alpha, { map: smoothByte })));
  await edit('update_layer_filter', { layerId, filterId, parameters: { mode: 'banks', banks: { master: { points, interpolation: 'smooth' } } } });
  assert.deepEqual(await exported(), legacyAppearance); assert.equal(layer().filters[0].parameters.mode, 'banks');
  for (const name of ['red', 'green', 'blue']) assert.deepEqual(layer().filters[0].parameters.banks[name], { points: identity, interpolation: 'linear' });
  await edit('update_layer_filter', { layerId, filterId, parameters: { mode: 'banks', banks: { red: { points: halfScale }, green: { points: invert }, blue: { points, interpolation: 'smooth' } } } });
  assert.deepEqual(layer().filters[0].parameters, bankSpec()); assert.deepEqual(await exported(), displayed(candidate(raw, alpha)));
  await edit('update_layer_filter', { layerId, filterId, parameters: { mode: 'banks', banks: { red: { interpolation: 'smooth' } } } });
  assert.deepEqual(layer().filters[0].parameters.banks.red.points, halfScale); assert.deepEqual(layer().filters[0].parameters.banks.blue, bankSpec().banks.blue);
  await edit('update_layer_filter', { layerId, filterId, parameters: { mode: 'banks', banks: { red: { interpolation: 'linear' } } }, blendMode: 'multiply', opacity: .5 });
  await edit('set_layer_filter_mask', { layerId, source: 'mask', mask: { shape: 'rectangle', x: 32, y: 0, width: 192, height } }); await edit('modify_layer_filter_mask', { layerId, density: .5 });
  const expected = candidate(raw, alpha, { blend: true, mask: true }); assert.deepEqual(await exported(), displayed(expected));
  const stable = structuredClone(document), projectPath = path.join(env.native.projectsDir, `${document.id}.json`), projectBytes = await fs.readFile(projectPath);
  for (const parameters of [{ channel: 'blue' }, { points: identity }, { interpolation: 'linear' }, { banks: { master: {} } }, { mode: 'banks', banks: { blue: { points: [{ x: 1, y: 0 }, identity[1]] } } }]) {
    const requests = env.traffic.length; failure(await call('update_layer_filter', { ...args(), expectedRevision: document.revision, layerId, filterId, parameters }));
    if (parameters.banks) assert.equal(env.traffic.length, requests, 'Malformed bank schemas must reject before HTTP');
    assert.deepEqual(await get(), stable); assert.deepEqual(await fs.readFile(projectPath), projectBytes);
  }
  await edit('update_layer_filter', { layerId, filterId, parameters: {} }); assert.deepEqual(layer().filters, stable.layers.find(item => item.id === layerId).filters);
  await edit('update_layer_filter', { layerId, filterId, parameters: { mode: 'single', points: halfScale, channel: 'red', interpolation: 'linear' } });
  assert.deepEqual(layer().filters[0].parameters, { points: halfScale, channel: 'red' }); await edit('undo'); assert.deepEqual(layer().filters[0].parameters, bankSpec());
  await edit('add_layer_distort', { layerId, corners: [{ x: 1, y: 0 }, { x: width + 1, y: 0 }, { x: width + 1, y: height }, { x: 1, y: height }] });
  const editable = structuredClone(document), appearance = await exported(); await edit('bake_layer_filters', { layerId });
  assert.deepEqual(layer().filters, []); assert.equal(layer().filterMask, undefined); assert.deepEqual(await exported(), appearance);
  const working = Buffer.from(expected); for (let p = 0; p < alpha.length; p++) working[p * 4 + 3] = raw[p * 4 + 3];
  assert.deepEqual(await sharp(await fs.readFile(path.join(env.native.assetsDir, layer().asset))).ensureAlpha().raw().toBuffer(), working);
  await edit('undo'); assert.deepEqual(document.layers, editable.layers);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'bank-source-portable' })).document;
  assert.deepEqual(restored.layers, document.layers); assert.deepEqual(await exported(restored.id), appearance);
  const persisted = structuredClone(document); await env.restart(); document = await get(); assert.deepEqual(document, persisted); assert.deepEqual(await exported(), appearance);
  for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(env.native.assetsDir, name)), bytes); assert.deepEqual(await fs.readFile(input), png);
});

test('official MCP Curves recipes explicitly reset both representations while retaining legacy hashes and atomic replay', { timeout: 35000 }, async t => {
  const env = await setup(t), { call, dataDir } = env, raw = Buffer.alloc(256 * 2 * 4);
  for (let p = 0; p < 512; p++) raw.set([p % 256, 255 - p % 256, p * 7 % 256, 255], p * 4);
  const png = await sharp(raw, { raw: { width: 256, height: 2, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'ramp.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Complete curves recipe reset' })).document; const rasterId = document.layers[0].id;
  const args = () => ({ backend: 'native', documentId: document.id }), get = async () => value(await call('get_document', args())).document;
  async function edit(name, fields = {}) { const result = value(await call(name, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  async function exported() { const file = value(await call('export_document', { ...args(), format: 'png' })); return sharp(await fs.readFile(file.path)).ensureAlpha().raw().toBuffer(); }
  const mapped = fn => { const result = Buffer.from(raw); for (let i = 0; i < result.length; i++) if (i % 4 !== 3) result[i] = fn(result[i], i % 4); return result; };
  await edit('add_adjustment', { kind: 'curves', value: 0, parameters: bankSpec() }); const gradeId = document.layers.at(-1).id;
  assert.deepEqual(await exported(), mapped(bankByte));
  const definition = parameters => ({ name: 'Curves recipe', slots: [{ key: 'grade', type: 'adjustment', kind: 'curves' }], steps: [{ command: 'update_adjustment', target: 'grade', args: { value: 0, parameters } }] });
  const legacy = await edit('save_edit_recipe', { ...definition({ points, channel: 'rgb' }), name: 'Legacy linear curve' });
  const originalRecipe = value(await call('get_edit_recipe', { ...args(), recipeId: legacy.recipeId }));
  assert.equal(originalRecipe.recipe.steps[0].args.parameters.mode, undefined); assert.equal(originalRecipe.recipe.steps[0].args.parameters.interpolation, undefined);
  const before = structuredClone(document), assets = (await fs.readdir(env.native.assetsDir)).sort(), bindings = { grade: gradeId };
  const report = value(await call('validate_edit_recipe', { ...args(), recipeId: legacy.recipeId, bindings })); assert.equal(report.valid, true); assert.equal(report.validation, 'metadata-only'); assert.deepEqual(await get(), before); assert.deepEqual((await fs.readdir(env.native.assetsDir)).sort(), assets);
  const once = { ...args(), expectedRevision: document.revision, recipeId: legacy.recipeId, bindings, requestId: 'legacy-replaces-four-banks' };
  const applied = value(await call('apply_edit_recipe', once)); document = applied.document; assert.deepEqual(value(await call('apply_edit_recipe', once)), applied);
  assert.deepEqual(document.layers.at(-1).parameters, { points, channel: 'rgb' }); assert.deepEqual(await exported(), mapped(linearByte)); assert.equal(document.history.length, before.history.length + 1);
  assert.deepEqual(value(await call('get_edit_recipe', { ...args(), recipeId: legacy.recipeId })), { ...originalRecipe, revision: document.revision });
  await edit('undo'); assert.deepEqual(document.layers, before.layers); assert.deepEqual(await exported(), mapped(bankByte));
  await edit('apply_transaction', { label: 'Explicit single representation', operations: [{ command: 'update_adjustment', args: { layerId: gradeId, parameters: { mode: 'single', points, channel: 'rgb', interpolation: 'linear' } } }] }); assert.deepEqual(await exported(), mapped(linearByte));
  const reset = await edit('save_edit_recipe', { ...definition({ mode: 'banks' }), name: 'Four identity curves' });
  const resetDefinition = value(await call('get_edit_recipe', { ...args(), recipeId: reset.recipeId })).recipe;
  for (const bank of Object.values(resetDefinition.steps[0].args.parameters.banks)) assert.deepEqual(bank, { points: identity, interpolation: 'linear' });
  await edit('apply_edit_recipe', { recipeId: reset.recipeId, bindings }); assert.deepEqual(await exported(), raw); assert.equal(document.layers.at(-1).parameters.mode, 'banks');
  await edit('update_adjustment', { layerId: gradeId, parameters: bankSpec() }); await edit('apply_edit_recipe', { recipeId: reset.recipeId, bindings }); assert.deepEqual(await exported(), raw);
  await edit('add_layer_filter', { layerId: rasterId, kind: 'brightness', value: 0 }); await edit('set_layer_filter_mask', { layerId: rasterId, source: 'none' });
  const mask = structuredClone(document.layers[0].filterMask), append = await edit('save_edit_recipe', { name: 'Append four curves', slots: [{ key: 'photo', type: 'raster' }], steps: [{ command: 'add_layer_filter', target: 'photo', args: { kind: 'curves', value: 0, parameters: bankSpec() } }] });
  await edit('apply_edit_recipe', { recipeId: append.recipeId, bindings: { photo: rasterId } }); assert.deepEqual(document.layers[0].filterMask, mask); assert.deepEqual(document.layers[0].filters.at(-1).parameters, bankSpec()); assert.deepEqual(await exported(), raw);
  const stable = structuredClone(document), projectPath = path.join(env.native.projectsDir, `${document.id}.json`), projectBytes = await fs.readFile(projectPath);
  failure(await call('apply_transaction', { ...args(), expectedRevision: document.revision, label: 'Late rejected conversion', operations: [{ command: 'update_adjustment', args: { layerId: gradeId, parameters: { mode: 'single', points, interpolation: 'smooth' } } }, { command: 'delete_layer', args: { layerId: 'missing' } }] }));
  assert.deepEqual(await get(), stable); assert.deepEqual(await fs.readFile(projectPath), projectBytes);
  await env.restart(); document = await get(); assert.deepEqual(document, stable); assert.deepEqual(await exported(), raw); assert.equal(failure(await call('apply_edit_recipe', once)).code, 'REVISION_CONFLICT');
  assert.deepEqual((await fs.readdir(env.native.assetsDir)).sort(), assets); assert.deepEqual(await fs.readFile(input), png);
});

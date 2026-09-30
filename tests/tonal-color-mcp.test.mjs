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
const unpack = response => { value(response); return sharp(Buffer.from(response.content.find(item => item.type === 'image').data, 'base64')).ensureAlpha().raw().toBuffer(); };
const balanceDefault = { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true };
const whiteDefault = { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintColor: '#b98952', tintAmount: 100 };
const maxGray = { reds: 100, yellows: 100, greens: 100, cyans: 100, blues: 100, magentas: 100 };
const redShift = { shadows: [20, 0, 0], midtones: [20, 0, 0], highlights: [20, 0, 0], preserveLuminosity: false };

test('official MCP tonal edits preserve exact assets and alpha, canonical recipe settings, portable state and restart behavior', { timeout: 35000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-tonal-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Tonal color must not use a model or key'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'tonal-color-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  assert.equal(caps.adjustmentKinds.length, 28); assert.equal(caps.layerFilterKinds.length, 32);
  assert.deepEqual(status.adjustmentKinds, caps.adjustmentKinds); assert.deepEqual(status.layerFilterKinds, caps.layerFilterKinds);
  const listed = (await client.listTools()).tools;
  for (const kind of ['color_balance', 'black_white']) for (const command of ['add_adjustment', 'add_layer_filter']) assert.ok(listed.find(tool => tool.name === `prism_${command}`).inputSchema.properties.kind.enum.includes(kind));
  const width = 32, height = 24, raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([30 + x * 5, 40 + y * 4, 90, [0, 1, 128, 255][x % 4]], (y * width + x) * 4);
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'original.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Tonal photograph' })).document;
  const rasterId = document.layers[0].id, args = () => ({ backend: 'native', documentId: document.id });
  const get = async () => value(await call('get_document', args())).document;
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  const preview = async (id = document.id) => unpack(await call('get_preview', { backend: 'native', documentId: id, maxWidth: width }));
  const filter = id => document.layers.find(layer => layer.id === rasterId).filters.find(entry => entry.id === id);
  const assets = new Map(await Promise.all((await fs.readdir(companion.native.assetsDir)).map(async name => [name, await fs.readFile(path.join(companion.native.assetsDir, name))])));
  const initial = await preview();
  await edit('add_layer_filter', { layerId: rasterId, kind: 'color_balance', value: 0 }); const balanceId = document.layers[0].filters[0].id;
  assert.deepEqual(filter(balanceId).parameters, balanceDefault); assert.deepEqual(await preview(), initial);
  await edit('update_layer_filter', { layerId: rasterId, filterId: balanceId, parameters: redShift });
  const shifted = await preview();
  for (let i = 0; i < raw.length; i += 4) {
    assert.equal(shifted[i + 3], raw[i + 3]);
    if (raw[i + 3]) assert.deepEqual([...shifted.subarray(i, i + 3)], [Math.min(255, raw[i] + 51), raw[i + 1], raw[i + 2]]);
  }
  await edit('add_layer_filter', { layerId: rasterId, kind: 'black_white', value: 0, parameters: maxGray }); const whiteId = document.layers[0].filters[1].id;
  const gray = await preview();
  for (let i = 0; i < raw.length; i += 4) if (raw[i + 3]) { const expected = Math.max(Math.min(255, raw[i] + 51), raw[i + 1], raw[i + 2]); assert.deepEqual([...gray.subarray(i, i + 4)], [expected, expected, expected, raw[i + 3]]); }
  await edit('update_layer_filter', { layerId: rasterId, filterId: whiteId, parameters: { tint: false, tintColor: '#C5913F', tintAmount: 35.25 } });
  assert.equal(filter(whiteId).parameters.tintColor, '#c5913f'); assert.deepEqual(await preview(), gray);
  await edit('update_layer_filter', { layerId: rasterId, filterId: whiteId, parameters: { tint: true } }); assert.notDeepEqual(await preview(), gray);
  await edit('update_layer_filter', { layerId: rasterId, filterId: whiteId, parameters: { tint: false } });
  assert.equal(filter(whiteId).parameters.tintAmount, 35.25); assert.deepEqual(await preview(), gray);
  await edit('reorder_layer_filter', { layerId: rasterId, filterId: whiteId, index: 0 });
  const reversed = await preview();
  for (let i = 0; i < raw.length; i += 4) if (raw[i + 3]) { const expected = Math.max(raw[i], raw[i + 1], raw[i + 2]); assert.deepEqual([...reversed.subarray(i, i + 4)], [Math.min(255, expected + 51), expected, expected, raw[i + 3]]); }
  await edit('update_layer_filter', { layerId: rasterId, filterId: balanceId, opacity: 0 }); assert.notDeepEqual(await preview(), reversed);
  await edit('undo'); assert.deepEqual(await preview(), reversed);
  const beforeBad = structuredClone(document);
  for (const fields of [{ parameters: { midtones: [1, 2] } }, { parameters: { midtones: [0.001, 0, 0] } }, { parameters: { tint: true } }, { value: 1 }]) failure(await call('update_layer_filter', { ...args(), layerId: rasterId, filterId: balanceId, ...fields }));
  assert.deepEqual(await get(), beforeBad);
  await edit('add_adjustment', { kind: 'color_balance', value: 0, parameters: redShift }); const gradeId = document.layers.at(-1).id;
  const saved = await edit('save_edit_recipe', { name: 'Neutral grade and retained tint', slots: [{ key: 'photo', type: 'raster' }, { key: 'grade', type: 'adjustment', kind: 'color_balance' }], steps: [
    { command: 'update_adjustment', target: 'grade', args: { value: 0, parameters: { midtones: [1.25, 0, -2.5] } } },
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'black_white', value: 0, enabled: false, parameters: { tint: false, tintColor: '#A78956', tintAmount: 62.5 } } },
  ] });
  const recipeId = saved.recipeId, bindings = { photo: rasterId, grade: gradeId }, recipe = value(await call('get_edit_recipe', { ...args(), recipeId })).recipe;
  assert.deepEqual(recipe.steps[0].args.parameters, { ...balanceDefault, midtones: [1.25, 0, -2.5] });
  assert.deepEqual(recipe.steps[1].args.parameters, { ...whiteDefault, tintColor: '#a78956', tintAmount: 62.5 });
  const beforeRecipe = structuredClone(document), valid = value(await call('validate_edit_recipe', { ...args(), expectedRevision: document.revision, recipeId, bindings }));
  assert.equal(valid.valid, true); assert.deepEqual(await get(), beforeRecipe);
  const once = { ...args(), expectedRevision: document.revision, recipeId, bindings, requestId: 'tonal-recipe-once' };
  document = value(await call('apply_edit_recipe', once)).document; assert.deepEqual(value(await call('apply_edit_recipe', once)).document, document);
  assert.equal(document.history.length, beforeRecipe.history.length + 1);
  assert.deepEqual(document.layers.find(layer => layer.id === gradeId).parameters, recipe.steps[0].args.parameters);
  const recipePixels = await preview();
  await edit('undo'); assert.deepEqual(document.layers, beforeRecipe.layers);
  await edit('apply_transaction', { label: 'Equivalent tonal recipe', operations: recipe.steps.map(step => ({ command: step.command, args: { ...step.args, layerId: bindings[step.target] } })) }); assert.deepEqual(await preview(), recipePixels);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const imported = value(await call('import_project_file', { path: portable.path, requestId: 'tonal-portable' })).document;
  assert.deepEqual(imported.layers, document.layers); assert.deepEqual(imported.editRecipes, document.editRecipes); assert.deepEqual(await preview(imported.id), recipePixels);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get(); assert.deepEqual(document, persisted); assert.deepEqual(await preview(), recipePixels);
  assert.equal(failure(await call('apply_edit_recipe', once)).code, 'REVISION_CONFLICT'); assert.deepEqual(await get(), persisted);
  assert.deepEqual((await fs.readdir(companion.native.assetsDir)).sort(), [...assets.keys()].sort());
  for (const [name, bytes] of assets) assert.deepEqual(await fs.readFile(path.join(companion.native.assetsDir, name)), bytes);
  assert.deepEqual(await fs.readFile(input), png);

  document = value(await call('create_document', { backend: 'native', width, height, name: 'Exact half ties and masked tones', background: '#015901' })).document;
  const backgroundId = document.layers[0].id;
  await edit('select_rectangle', { x: 0, y: 0, width: 16, height });
  await edit('add_adjustment', { kind: 'color_balance', value: 0, parameters: { shadows: [100, -100, 100], midtones: [100, -100, 100], highlights: [100, -100, 100] } }); const maskedId = document.layers.at(-1).id, mask = structuredClone(document.layers.at(-1).mask);
  await edit('clear_selection');
  let output = await preview(); assert.deepEqual([...output.subarray(0, 4)], [225, 0, 225, 255]); assert.deepEqual([...output.subarray(20 * 4, 21 * 4)], [1, 89, 1, 255]);
  await edit('update_adjustment', { layerId: maskedId, parameters: { highlights: [-10, 0, 0] } });
  const settings = document.layers.find(layer => layer.id === maskedId); assert.deepEqual(settings.parameters.midtones, [100, -100, 100]); assert.deepEqual(settings.mask, mask);
  await edit('add_adjustment', { kind: 'black_white', value: 0, parameters: maxGray });
  await edit('set_layer_protection', { layerId: backgroundId, protected: true }); output = await preview();
  for (let i = 0; i < output.length; i += 4) assert.deepEqual([...output.subarray(i, i + 4)], [1, 89, 1, 255]);
});

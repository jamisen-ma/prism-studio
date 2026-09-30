import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = response => { assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text); };
const failure = response => { assert.equal(response.isError, true); const text = response.content.find(item => item.type === 'text').text; try { return JSON.parse(text); } catch { return { message: text }; } };

test('official MCP recipes preserve inert PSD/library data, stage read-only, apply one undo, and reconcile restart retries', { timeout: 30000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-edit-recipes-mcp-'));
  let companion, client, stderr = '', forbiddenCalls = 0; const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Recipe editing is local'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden }); const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'edit-recipe-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; }); await client.connect(transport);
  }
  t.after(async () => { await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true }); for (const token of tokens) assert.ok(!stderr.includes(token)); assert.equal(forbiddenCalls, 0); });
  await start();
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  const caps = value(await call('capabilities', { backend: 'native' })), status = value(await call('status')).backends.find(item => item.id === 'native');
  for (const [key, expected] of Object.entries({ editRecipeVersion: 1, editRecipeCommands: ['add_layer_filter', 'update_adjustment', 'update_text', 'set_layer_effects', 'set_layer_outline'], editRecipeSlotTypes: ['raster', 'text', 'content', 'adjustment'] })) { assert.deepEqual(caps[key], expected); assert.deepEqual(status[key], expected); }
  for (const [key, expected] of Object.entries({ maxEditRecipes: 16, maxEditRecipeSteps: 30, maxEditRecipeSlots: 16, maxEditRecipeBytes: 32768, maxEditRecipeLibraryBytes: 262144 })) { assert.equal(caps.limits[key], expected); assert.equal(status.limits[key], expected); }
  const tools = (await client.listTools()).tools;
  for (const name of ['get', 'validate']) assert.equal(tools.find(item => item.name === `prism_${name}_edit_recipe`).annotations.readOnlyHint, true);
  assert.ok(tools.find(item => item.name === 'prism_apply_edit_recipe').inputSchema.required.includes('expectedRevision'));
  const width = 64, height = 48, raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([30 + x * 2, 45 + y * 2, 95, 255], (y * width + x) * 4);
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(), input = path.join(dataDir, 'retained-photo.png'); await fs.writeFile(input, png);
  let document = value(await call('import_file', { path: input, name: 'Recipe photo' })).document;
  const original = structuredClone(document.layers[0]), assetDir = path.join(dataDir, 'native/assets');
  const originalAssets = (await fs.readdir(assetDir)).sort(); assert.deepEqual(document.editRecipes, []);
  const args = () => ({ backend: 'native', documentId: document.id });
  async function edit(command, fields = {}) { const result = value(await call(command, { ...args(), expectedRevision: document.revision, ...fields })); document = result.document; return result; }
  const get = async () => value(await call('get_document', args())).document;
  const preview = async (id = document.id) => { const result = await call('get_preview', { backend: 'native', documentId: id, maxWidth: width }); value(result); return Buffer.from(result.content.find(item => item.type === 'image').data, 'base64'); };
  const originalPixels = await preview(), firstPsd = value(await call('export_psd', { documentId: document.id, expectedRevision: document.revision }));
  const recipeInput = { name: 'Warm cover treatment', slots: [{ key: 'photo', type: 'raster' }, { key: 'heading', type: 'text', label: 'Title' }, { key: 'grade', type: 'adjustment', kind: 'channel_mixer' }], steps: [
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'temperature', value: 12 } },
    { command: 'add_layer_filter', target: 'photo', args: { kind: 'gradient_map', value: 0, parameters: { stops: [{ offset: 0, color: '#203040' }, { offset: 1, color: '#F8E7CF' }] } } },
    { command: 'update_adjustment', target: 'grade', args: { value: 0, parameters: { red: [100, 0, 0, 1], blue: [0, 0, 100, -1] } } },
    { command: 'update_text', target: 'heading', args: { fontFamily: 'Fraunces', fontSize: 14, color: '#593C2C', tracking: 0, leading: null } },
    { command: 'set_layer_effects', target: 'heading', args: { effects: { shadow: { color: '#000000', opacity: 0.5, blur: 1, x: 1, y: 1 } } } },
    { command: 'set_layer_outline', target: 'photo', args: { width: 1, color: '#ffffff' } },
  ] };
  const saved = await edit('save_edit_recipe', recipeInput), recipeId = saved.recipeId;
  assert.equal(document.editRecipes.length, 1); assert.equal(document.editRecipes[0].id, recipeId); assert.deepEqual(await preview(), originalPixels);
  const secondPsd = value(await call('export_psd', { documentId: document.id, expectedRevision: document.revision }));
  assert.deepEqual(await fs.readFile(secondPsd.path), await fs.readFile(firstPsd.path));
  assert.ok(secondPsd.report.warnings.some(warning => /recipes/.test(warning.message)));
  const inspected = value(await call('get_edit_recipe', { ...args(), recipeId }));
  assert.match(inspected.recipeHash, /^[a-f0-9]{64}$/); assert.equal(inspected.recipe.steps[1].args.parameters.stops[1].color, '#f8e7cf');
  assert.equal(inspected.recipe.steps[0].args.enabled, true); assert.equal(inspected.recipe.steps[0].args.opacity, 1);
  assert.equal(inspected.recipe.steps[3].args.leading, null); assert.equal(inspected.recipe.steps[3].args.tracking, 0);
  assert.deepEqual((await fs.readdir(assetDir)).sort(), originalAssets);
  // Targets are selected only at application, so definitions can travel first.
  await edit('add_adjustment', { kind: 'channel_mixer', value: 0 }); const gradeId = document.layers.at(-1).id;
  await edit('add_text', { text: 'Keep this text', x: 2, y: 3, fontSize: 12, fontFamily: 'sans-serif', tracking: 80, leading: 17, color: '#ffffff' }); const textId = document.layers.at(-1).id;
  await edit('select_rectangle', { x: 2, y: 2, width: 4, height: 4 });
  const bindings = { photo: original.id, heading: textId, grade: gradeId }, before = structuredClone(document), beforePixels = await preview();
  const activityBefore = value(await call('status')).activity;
  const valid = value(await call('validate_edit_recipe', { ...args(), expectedRevision: document.revision, recipeId, bindings }));
  assert.equal(valid.valid, true); assert.equal(valid.validation, 'metadata-only'); assert.equal(valid.stepCount, 6); assert.equal(valid.changes.length, 6); assert.deepEqual(valid.bindings, bindings);
  assert.deepEqual(value(await call('validate_edit_recipe', { ...args(), recipeId, bindings })), valid);
  for (const bound of [{}, { ...bindings, extra: randomUUID() }, { ...bindings, heading: original.id }, { ...bindings, photo: randomUUID() }]) {
    const invalid = value(await call('validate_edit_recipe', { ...args(), recipeId, bindings: bound })); assert.equal(invalid.valid, false); assert.deepEqual(invalid.changes, []); assert.ok(invalid.issues.length > 0);
  }
  assert.deepEqual(await get(), before); assert.deepEqual(value(await call('status')).activity, activityBefore); assert.deepEqual((await fs.readdir(assetDir)).sort(), originalAssets);
  failure(await call('apply_edit_recipe', { ...args(), recipeId, bindings }));
  const once = { ...args(), expectedRevision: document.revision, recipeId, bindings, requestId: 'apply-recipe-once' };
  const applied = value(await call('apply_edit_recipe', once)); document = applied.document;
  assert.equal(applied.appliedSteps, 6); assert.equal(document.history.length, before.history.length + 1); assert.equal(document.layers[0].filters.length, 2);
  assert.deepEqual(value(await call('apply_edit_recipe', once)), applied);
  const text = document.layers.find(layer => layer.id === textId); assert.equal(text.text, 'Keep this text'); assert.equal(text.x, 2); assert.equal(text.y, 3); assert.equal(text.tracking, undefined); assert.equal(text.leading, undefined);
  assert.deepEqual(document.selection, before.selection); assert.deepEqual(document.layers.map(layer => layer.id), before.layers.map(layer => layer.id));
  const appliedPixels = await preview(); assert.notDeepEqual(appliedPixels, beforePixels); assert.deepEqual((await fs.readdir(assetDir)).sort(), originalAssets);
  const authored = structuredClone(document); await edit('undo'); assert.deepEqual(document.layers, before.layers); assert.deepEqual(await preview(), beforePixels);
  await edit('redo'); assert.deepEqual(document.layers, authored.layers); assert.deepEqual(await preview(), appliedPixels);
  // Equivalent explicit commands give identical pixels and metadata except IDs
  // generated for newly appended filters, which are intentionally per-apply.
  const restoredBefore = await edit('undo'); const definition = inspected.recipe;
  await edit('apply_transaction', { label: 'Equivalent explicit edits', operations: definition.steps.map(step => ({ command: step.command, args: { ...step.args, layerId: bindings[step.target] } })) });
  assert.deepEqual(await preview(), appliedPixels); assert.deepEqual(document.editRecipes, restoredBefore.document.editRecipes);
  const portable = value(await call('export_project', { documentId: document.id, expectedRevision: document.revision }));
  const imported = value(await call('import_project_file', { path: portable.path, requestId: 'recipe-project-copy' })).document;
  assert.deepEqual(imported.editRecipes, document.editRecipes); assert.deepEqual(imported.layers, document.layers); assert.deepEqual(await preview(imported.id), appliedPixels);
  await edit('set_layer_protection', { layerId: textId, protected: true }); const protectedDoc = structuredClone(document);
  const blocked = value(await call('validate_edit_recipe', { ...args(), recipeId, bindings })); assert.equal(blocked.valid, false); assert.ok(blocked.issues.some(issue => issue.code === 'PROTECTED_LAYER'));
  failure(await call('apply_edit_recipe', { ...args(), expectedRevision: document.revision, recipeId, bindings })); assert.deepEqual(await get(), protectedDoc);
  await edit('set_layer_protection', { layerId: textId, protected: false });
  await edit('rename_edit_recipe', { recipeId, name: 'Reusable warm cover' }); assert.equal(document.editRecipes[0].id, recipeId); assert.equal(document.editRecipes[0].name, 'Reusable warm cover');
  await edit('delete_edit_recipe', { recipeId }); assert.deepEqual(document.editRecipes, []); const layersAfterDelete = structuredClone(document.layers);
  await edit('undo'); assert.equal(document.editRecipes[0].id, recipeId); assert.deepEqual(document.layers, layersAfterDelete);
  const persisted = structuredClone(document); await client.close(); await companion.close(); await start(); document = await get();
  assert.deepEqual(document, persisted);
  assert.equal(failure(await call('apply_edit_recipe', once)).code, 'REVISION_CONFLICT'); assert.deepEqual(await get(), persisted);
  assert.deepEqual(await fs.readFile(path.join(assetDir, original.sourceAsset)), png); assert.deepEqual(await fs.readFile(input), png);
});

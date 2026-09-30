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
import { layerFillReference, LAYER_FILL_REFERENCE_MODES } from './fixtures/layer-fill/reference.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Large image assertion diffs can themselves exhaust V8's heap. Preserve exact
// byte comparison while reporting only the first differing byte and its context.
function equal(actual, expected, message) {
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    assert.equal(actual.length, expected.length, message || 'Byte lengths differ');
    const a = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
    const b = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
    if (a.equals(b)) return;
    let first = 0; while (a[first] === b[first]) first++;
    assert.fail(`${message || 'Exact bytes differ'} at ${first}: actual=${a[first]}, expected=${b[first]}; length=${a.length}`);
  }
  assert.deepEqual(actual, expected, message);
}

const value = result => {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
};
const failure = result => {
  assert.equal(result.isError, true);
  const message = result.content.find(item => item.type === 'text').text;
  try { return JSON.parse(message); } catch { return { message }; }
};
async function rgba(png) { return sharp(png).toColourspace('srgb').ensureAlpha().raw().toBuffer(); }

async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-layer-fill-mcp-'));
  let companion, client, forbiddenCalls = 0, stderr = '';
  const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Layer Fill must not call a provider, key or segmentation'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
    const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'layer-fill-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root,
      env: { PRISM_URL: `http://127.0.0.1:${port}`, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr += bytes; });
    await client.connect(transport);
  }
  t.after(async () => {
    await client?.close(); await companion?.close(); await fs.rm(dataDir, { recursive: true, force: true });
    assert.equal(forbiddenCalls, 0); for (const token of tokens) assert.ok(!stderr.includes(token));
  });
  await start();
  return { dataDir, call: (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args }),
    get native() { return companion.native; }, get client() { return client; },
    restart: async () => { await client.close(); await companion.close(); await start(); } };
}

async function importPixels(env, name, pixels, width, height) {
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return importPng(env, name, png);
}
async function importPng(env, name, png) {
  const input = path.join(env.dataDir, `${name}.png`); await fs.writeFile(input, png);
  return { document: value(await env.call('import_file', { path: input, name })).document, input, png };
}
function editor(env, initial) {
  let document = initial;
  const args = () => ({ backend: 'native', documentId: document.id });
  return { args, get document() { return document; },
    set document(next) { document = next; },
    get: async () => value(await env.call('get_document', args())).document,
    edit: async (command, fields = {}) => {
      const result = value(await env.call(command, { ...args(), expectedRevision: document.revision, ...fields }));
      document = result.document; return result;
    },
    exported: async () => {
      const result = value(await env.call('export_document', { ...args(), format: 'png' }));
      return rgba(await fs.readFile(result.path));
    },
  };
}

const width = 32, height = 16;
function bodyPixels() {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 4; y < 10; y++) for (let x = 4; x < 12; x++)
    pixels.set([35 + x * 11, 40 + y * 13, 179, [1, 128, 255][x % 3]], (y * width + x) * 4);
  return pixels;
}
function shadowPixels(body) {
  const pixels = Buffer.alloc(body.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width - 12; x++) {
    const alpha = body[(y * width + x) * 4 + 3];
    if (alpha) pixels.set([84, 48, 24, alpha], (y * width + x + 12) * 4);
  }
  return pixels;
}
const shadow = { shadow: { color: '#543018', opacity: 1, blur: 0, x: 12, y: 0 } };
const layer = (state, id) => state.document.layers.find(item => item.id === id);
async function preview(env, state, layerId, view) {
  const result = await env.call('get_layer_preview', { ...state.args(), layerId, view, maxWidth: 32 });
  value(result); const image = result.content.find(item => item.type === 'image');
  assert.equal(image?.mimeType, 'image/png'); return rgba(Buffer.from(image.data, 'base64'));
}
async function backdrop(state) {
  await state.edit('add_shape', { name: 'Backdrop', shape: 'rectangle', x: 0, y: 0, width, height, fill: '#527baf', stroke: null });
  const id = state.document.layers.at(-1).id;
  await state.edit('reorder_layer', { layerId: id, index: 0 });
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([82, 123, 175, 255], i);
  return pixels;
}
const projectBytes = (env, document) => fs.readFile(path.join(env.native.projectsDir, `${document.id}.json`));

test('official MCP Layer Fill advertises its contract and matches independent body/decorative pixels across six blends', { timeout: 60000 }, async t => {
  const env = await setup(t), caps = value(await env.call('capabilities', { backend: 'native' }));
  assert.equal(caps.layerFillPolicy, 'content-alpha-outside-effects-v1');
  equal(caps.layerFillContentTypes, ['raster', 'solid', 'text', 'shape', 'path', 'gradient']);
  assert.ok(caps.commands.includes('set_layer_fill'));
  const status = value(await env.call('status')).backends.find(item => item.id === 'native');
  equal(status.layerFillContentTypes, caps.layerFillContentTypes); assert.equal(status.layerFillPolicy, caps.layerFillPolicy);
  const listed = (await env.client.listTools()).tools.find(item => item.name === 'prism_set_layer_fill');
  assert.ok(listed); assert.equal(listed.annotations.readOnlyHint, false);
  assert.ok(listed.inputSchema.required.includes('expectedRevision')); assert.equal(listed.inputSchema.additionalProperties, false);
  const body = bodyPixels(), fixture = await importPixels(env, 'Fill pixel reference', body, width, height);
  const state = editor(env, fixture.document), id = state.document.layers[0].id, decoration = shadowPixels(body);
  await state.edit('set_layer_effects', { layerId: id, effects: shadow });
  await state.edit('set_layer', { layerId: id, opacity: 0.5 });
  const request = { ...state.args(), expectedRevision: state.document.revision, layerId: id, fillOpacity: 0.5, requestId: 'fill-stable-once' };
  state.document = value(await env.call('set_layer_fill', request)).document;
  equal(value(await env.call('set_layer_fill', request)).document, state.document);
  const transparent = Buffer.alloc(body.length);
  equal(await state.exported(), layerFillReference(transparent, body, { decoration, opacity: 0.5, fillOpacity: 0.5 }));
  const lowAlphaIndex = (4 * width + 6) * 4;
  assert.equal((await state.exported())[lowAlphaIndex + 3], 0, 'A1*O0.5*F0.5 rounds only at final alpha.');
  equal(await preview(env, state, id, 'source'), body);
  equal(await preview(env, state, id, 'layer'), await state.exported());
  const background = await backdrop(state);
  for (const blendMode of LAYER_FILL_REFERENCE_MODES) {
    await state.edit('set_layer', { layerId: id, opacity: 0.63, blendMode });
    await state.edit('set_layer_fill', { layerId: id, fillOpacity: 0.375 });
    equal(await state.exported(), layerFillReference(background, body, { decoration, opacity: 0.63, fillOpacity: 0.375, blendMode }), blendMode);
  }
  await state.edit('set_layer', { layerId: id, opacity: 0.5, blendMode: 'normal' });
  await state.edit('set_layer_fill', { layerId: id, fillOpacity: 0 });
  equal(await state.exported(), layerFillReference(background, body, { decoration, opacity: 0.5, fillOpacity: 0 }));
  equal(layer(state, id).effects, shadow); assert.equal(layer(state, id).fillOpacity, 0);
  await state.edit('load_layer_selection', { layerId: id, source: 'content' });
  const selected = state.document.selection, alpha = Buffer.alloc(width * height);
  for (let i = 0; i < selected.runs.length; i += 3) alpha.fill(selected.runs[i + 2], selected.runs[i], selected.runs[i] + selected.runs[i + 1]);
  for (let p = 0; p < alpha.length; p++) assert.equal(alpha[p], body[p * 4 + 3]);
  await state.edit('set_layer', { layerId: id, opacity: 0 }); equal(await state.exported(), background);
  equal(await fs.readFile(fixture.input), fixture.png);
  equal(await fs.readFile(path.join(env.native.assetsDir, layer(state, id).sourceAsset)), fixture.png);
});

test('official MCP Layer Fill survives style reuse, Bake, rasterization, zero-body placement, portable transfer and restart', { timeout: 60000 }, async t => {
  const env = await setup(t), body = bodyPixels(), fixture = await importPixels(env, 'Editable Fill retention', body, width, height);
  const state = editor(env, fixture.document), id = state.document.layers[0].id;
  await state.edit('set_layer_fill', { layerId: id, fillOpacity: 1 / 3 });
  await state.edit('set_layer_effects', { layerId: id, effects: shadow });
  await state.edit('save_layer_style', { layerId: id, name: 'Shadow without Fill' });
  const styleId = state.document.layerStyles[0].id;
  assert.equal(state.document.layerStyles[0].fillOpacity, undefined);
  await state.edit('set_layer_effects', { layerId: id, effects: null });
  assert.equal(layer(state, id).fillOpacity, 1 / 3); assert.equal(layer(state, id).effects, undefined);
  await state.edit('apply_layer_style', { styleId, layerIds: [id] });
  assert.equal(layer(state, id).fillOpacity, 1 / 3); equal(layer(state, id).effects, shadow);
  await state.edit('add_layer_filter', { layerId: id, kind: 'invert', value: 100 });
  const beforeBake = await state.exported();
  await state.edit('bake_layer_filters', { layerId: id });
  equal(await state.exported(), beforeBake); assert.equal(layer(state, id).fillOpacity, 1 / 3);
  assert.ok(!layer(state, id).filters?.length); equal(await preview(env, state, id, 'source'), body);
  await state.edit('add_shape', { name: 'Recoverable vector', shape: 'rectangle', x: 2, y: 2, width: 6, height: 6, fill: '#aa5533', stroke: null });
  const shapeId = state.document.layers.at(-1).id;
  await state.edit('set_layer_fill', { layerId: shapeId, fillOpacity: 0 });
  await state.edit('set_layer_outline', { layerId: shapeId, width: 1, color: '#ffffff' });
  const beforeRasterize = await state.exported();
  await state.edit('rasterize_layer', { layerId: shapeId });
  assert.equal(layer(state, shapeId).type, 'raster'); assert.equal(layer(state, shapeId).fillOpacity, 0);
  equal(await state.exported(), beforeRasterize);
  const rawShape = await preview(env, state, shapeId, 'source'); assert.ok(rawShape.some((value, index) => index % 4 === 3 && value > 0));
  await state.edit('set_layer', { layerId: shapeId, visible: false });
  await state.edit('set_layer_fill', { layerId: id, fillOpacity: 0 });
  await state.edit('set_layer', { layerId: id, opacity: 0.5 });
  const target = editor(env, value(await env.call('create_document', { backend: 'native', name: 'Placed style-only content', width, height, background: '#527baf' })).document);
  await target.edit('place_layer', { sourceDocumentId: state.document.id, sourceLayerId: id, sourceExpectedRevision: state.document.revision, x: 2, y: 2, width: 8, height: 6, protect: true });
  const placed = target.document.layers.at(-1);
  assert.equal(placed.fillOpacity, 0); assert.equal(placed.opacity, 0.5); assert.equal(placed.protected, true); equal(placed.effects, shadow);
  const placedSource = await preview(env, target, placed.id, 'source'); assert.ok(placedSource.some((value, index) => index % 4 === 3 && value > 0));
  const report = value(await env.call('inspect_psd_export', { documentId: state.document.id, expectedRevision: state.document.revision }));
  assert.equal(report.supported, false); assert.ok(report.issues.some(issue => issue.code === 'FILL_UNSUPPORTED'));
  const finalPixels = await state.exported(), portable = value(await env.call('export_project', { documentId: state.document.id, expectedRevision: state.document.revision }));
  const restored = value(await env.call('import_project_file', { path: portable.path, requestId: 'fill-portable-once' })).document;
  equal(restored.layers, state.document.layers); equal(await editor(env, restored).exported(), finalPixels);
  const persisted = structuredClone(state.document); await env.restart(); state.document = await state.get();
  equal(state.document, persisted); equal(await state.exported(), finalPixels);
  equal(await fs.readFile(fixture.input), fixture.png); equal(await fs.readFile(path.join(env.native.assetsDir, layer(state, id).sourceAsset)), fixture.png);
});

test('official MCP Layer Fill preserves atomic history, protection/clipping guards and state after actual save failure', { timeout: 60000 }, async t => {
  const env = await setup(t), fixture = await importPixels(env, 'Atomic Fill', bodyPixels(), width, height);
  const state = editor(env, fixture.document), id = state.document.layers[0].id, initial = structuredClone(state.document);
  await state.edit('apply_transaction', { label: 'Fill and protect', operations: [
    { command: 'set_layer_fill', args: { layerId: id, fillOpacity: 0.375 } },
    { command: 'set_layer_protection', args: { layerId: id, protected: true } },
  ] });
  assert.equal(state.document.history.length, initial.history.length + 1);
  assert.equal(layer(state, id).protected, true); assert.equal(layer(state, id).fillOpacity, 0.375);
  const protectedState = structuredClone(state.document);
  assert.equal(failure(await env.call('set_layer_fill', { ...state.args(), expectedRevision: state.document.revision, layerId: id, fillOpacity: 0.5 })).code, 'PROTECTED_LAYER');
  equal(await state.get(), protectedState);
  assert.equal(failure(await env.call('apply_transaction', { ...state.args(), expectedRevision: state.document.revision, label: 'Bad order', operations: [
    { command: 'set_layer_fill', args: { layerId: id, fillOpacity: 0.5 } }, { command: 'set_layer_protection', args: { layerId: id, protected: false } },
  ] })).code, 'PROTECTED_LAYER'); equal(await state.get(), protectedState);
  await state.edit('undo'); equal(state.document.layers, initial.layers);
  await state.edit('redo'); equal(state.document.layers, protectedState.layers);
  await state.edit('apply_transaction', { label: 'Explicitly change protected Fill', operations: [
    { command: 'set_layer_protection', args: { layerId: id, protected: false } },
    { command: 'set_layer_fill', args: { layerId: id, fillOpacity: 1 } },
    { command: 'set_layer_protection', args: { layerId: id, protected: true } },
  ] });
  assert.equal(layer(state, id).fillOpacity, undefined);
  await state.edit('set_layer_protection', { layerId: id, protected: false });
  await state.edit('duplicate_layer', { layerId: id }); const clippedId = state.document.layers.at(-1).id;
  await state.edit('set_clipping_chain', { baseLayerId: id, layerIds: [clippedId] });
  const clipped = structuredClone(state.document);
  for (const layerId of [id, clippedId]) assert.equal(failure(await env.call('set_layer_fill', { ...state.args(), expectedRevision: state.document.revision, layerId, fillOpacity: 0.5 })).code, 'INVALID_TARGET');
  equal(await state.get(), clipped);
  await state.edit('set_clipping_chain', { baseLayerId: id, layerIds: [] });
  const stable = structuredClone(state.document), bytes = await projectBytes(env, stable), assetNames = (await fs.readdir(env.native.assetsDir)).sort();
  failure(await env.call('apply_transaction', { ...state.args(), expectedRevision: state.document.revision, label: 'Late failure', operations: [
    { command: 'set_layer_fill', args: { layerId: id, fillOpacity: 0 } }, { command: 'delete_layer', args: { layerId: 'missing-layer' } },
  ] })); equal(await state.get(), stable); equal(await projectBytes(env, stable), bytes);
  const projectsDir = env.native.projectsDir, blocker = path.join(env.dataDir, 'not-a-directory'); await fs.writeFile(blocker, 'isolated ENOTDIR fixture');
  try {
    env.native.projectsDir = blocker;
    failure(await env.call('set_layer_fill', { ...state.args(), expectedRevision: stable.revision, layerId: id, fillOpacity: 0.375, requestId: 'fill-save-failure' }));
  } finally { env.native.projectsDir = projectsDir; }
  equal(await state.get(), stable); equal(await projectBytes(env, stable), bytes); equal((await fs.readdir(env.native.assetsDir)).sort(), assetNames);
  assert.equal(failure(await env.call('set_layer_fill', { ...state.args(), expectedRevision: stable.revision - 1, layerId: id, fillOpacity: 0.5 })).code, 'REVISION_CONFLICT');
});

test('official MCP Codex handoff uses Fill-aware hard protection, including zero body and positive Fill that underflows visibly', { timeout: 60000 }, async t => {
  const env = await setup(t), body = bodyPixels(), decoration = shadowPixels(body);
  for (const fillOpacity of [0, Number.MIN_VALUE]) {
    const fixture = await importPixels(env, `Protected Fill ${fillOpacity}`, body, width, height);
    const state = editor(env, fixture.document), id = state.document.layers[0].id;
    await backdrop(state);
    await state.edit('set_layer_effects', { layerId: id, effects: shadow });
    await state.edit('set_layer', { layerId: id, opacity: 0.5 });
    await state.edit('set_layer_fill', { layerId: id, fillOpacity });
    await state.edit('set_layer_protection', { layerId: id, protected: true });
    await state.edit('select_rectangle', { x: 0, y: 0, width, height });
    const before = await state.exported();
    const job = value(await env.call('edit_image', { documentId: state.document.id, expectedRevision: state.document.revision,
      scope: 'selection', prompt: 'Edit selected background while retaining protected visible content.', requestId: `fill-handoff-${fillOpacity}` })).job;
    assert.equal(job.provider, 'codex'); assert.equal(job.status, 'awaiting_image');
    const handoff = value(await env.call('get_generation_handoff', { jobId: job.id }));
    equal(await rgba(await fs.readFile(handoff.assets.input.path)), before);
    const mask = await rgba(await fs.readFile(handoff.assets.mask.path));
    const protectedAt = p => decoration[p * 4 + 3] > 0 || fillOpacity > 0 && body[p * 4 + 3] > 0;
    for (let p = 0; p < width * height; p++) assert.equal(mask[p * 4 + 3], protectedAt(p) ? 255 : 0);
    // Synthetic return exercises the transport and local hard clip, not a model call.
    const returned = path.join(env.dataDir, `synthetic-fill-result-${fillOpacity}.png`);
    await sharp({ create: { width, height, channels: 4, background: '#35b780' } }).png().toFile(returned);
    const completed = value(await env.call('complete_generation', { jobId: job.id, path: returned }));
    assert.equal(completed.job.status, 'succeeded'); state.document = await state.get();
    const result = await state.exported(), expected = Buffer.from(before);
    for (let p = 0; p < width * height; p++) if (!protectedAt(p)) expected.set([53, 183, 128, 255], p * 4);
    equal(result, expected);
    assert.equal(value(await env.call('complete_generation', { jobId: job.id, path: returned })).job.status, 'succeeded');
    equal(await state.get(), state.document);
    await state.edit('undo'); equal(await state.exported(), before);
    equal(await fs.readFile(path.join(env.native.assetsDir, layer(state, id).sourceAsset)), fixture.png);
  }
});

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
import { authoredFrame } from './fixtures/dense-mask/reference.mjs';
import { COLOR_RANGE_GOLDENS, colorRangePlaneReference, colorRangePreviewReference } from './fixtures/color-range/reference.mjs';

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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-color-range-mcp-'));
  let companion, client, forbiddenCalls = 0, stderr = '';
  const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Color Range must not call a provider, key or segmentation'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
    const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'color-range-verification', version: '1.0.0' });
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
async function grayResult(result) {
  const metadata = value(result), block = result.content.find(item => item.type === 'image');
  assert.equal(block?.mimeType, 'image/png'); assert.equal(metadata.data, undefined);
  const decoded = await sharp(Buffer.from(block.data, 'base64')).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, metadata.width); assert.equal(decoded.info.height, metadata.height); assert.equal(decoded.info.channels, 4);
  const gray = Buffer.alloc(decoded.info.width * decoded.info.height);
  for (let p = 0; p < gray.length; p++) {
    const i = p * 4; assert.equal(decoded.data[i], decoded.data[i + 1]); assert.equal(decoded.data[i], decoded.data[i + 2]);
    assert.equal(decoded.data[i + 3], 255); gray[p] = decoded.data[i];
  }
  return { metadata, gray };
}
async function storedPlane(env, mask) {
  assert.ok(mask); assert.equal(mask.feather, 0); assert.equal(mask.invert, false);
  if (mask.shape === 'alpha8') {
    const bytes = await fs.readFile(path.join(env.native.assetsDir, mask.asset));
    assert.equal(bytes.length, mask.bytes); const plane = bytes.subarray(32);
    const authored = authoredFrame(plane, mask.width, mask.height);
    equal(bytes, authored.bytes); equal(mask, authored.descriptor);
    return Buffer.from(plane);
  }
  assert.equal(mask.shape, 'bitmap');
  const output = Buffer.alloc(mask.width * mask.height);
  for (let i = 0; i < mask.runs.length; i += 3) output.fill(mask.runs[i + 2], mask.runs[i], mask.runs[i] + mask.runs[i + 1]);
  return output;
}
const assetNames = async env => (await fs.readdir(env.native.assetsDir)).sort();
const projectBytes = (env, document) => fs.readFile(path.join(env.native.projectsDir, `${document.id}.json`));

test('official MCP Color Range discovers strict read/load tools and exact two-stage pixels, owned previews, transactions and replay', { timeout: 45000 }, async t => {
  const env = await setup(t), { call } = env;
  const caps = value(await call('capabilities', { backend: 'native' }));
  const status = value(await call('status')).backends.find(item => item.id === 'native');
  for (const field of ['colorRangePolicy', 'colorRangeLimits', 'colorRangePreviewLimits']) equal(status[field], caps[field]);
  assert.equal(caps.colorRangePolicy, 'sampled-rgb-chebyshev-alpha-v1');
  assert.equal(caps.colorRangeLimits.maxComparisons, 192000000); assert.equal(caps.colorRangeLimits.maxColors, 8);
  const tools = (await env.client.listTools()).tools;
  for (const name of ['get_color_range_preview', 'load_color_range_selection']) {
    const tool = tools.find(item => item.name === `prism_${name}`); assert.ok(caps.commands.includes(name));
    assert.equal(tool.annotations.readOnlyHint, name === 'get_color_range_preview');
    assert.equal(tool.inputSchema.additionalProperties, false); assert.match(tool.description, /sampled-rgb-chebyshev-alpha-v1/);
  }
  const pixels = Buffer.from(COLOR_RANGE_GOLDENS.flatMap(row => row.rgba));
  const fixture = await importPixels(env, 'Literal range pixels', pixels, COLOR_RANGE_GOLDENS.length, 1), state = editor(env, fixture.document);
  const before = structuredClone(state.document), bytes = await projectBytes(env, before), names = await assetNames(env);
  const rendered = await state.exported();
  for (let i = 0; i < COLOR_RANGE_GOLDENS.length; i++) {
    const { parameters, expected } = COLOR_RANGE_GOLDENS[i];
    const { metadata, gray } = await grayResult(await call('get_color_range_preview', { ...state.args(), expectedRevision: before.revision, ...parameters, maxEdge: 32 }));
    equal(gray, colorRangePlaneReference(rendered, parameters)); assert.equal(gray[i], expected);
    assert.equal(metadata.documentId, before.id); assert.equal(metadata.revision, before.revision);
    assert.equal(metadata.coveragePolicy, caps.colorRangePolicy); assert.equal(metadata.sampling, 'nearest-pixel-center');
    equal(metadata.colors, parameters.colors); assert.equal(metadata.tolerance, parameters.tolerance ?? 32);
  }
  equal(await state.get(), before); equal(await projectBytes(env, before), bytes); equal(await assetNames(env), names);
  const parameters = { colors: ['#ABCDEF', '#000000'], tolerance: 32, falloff: 64, invert: true };
  const expected = colorRangePlaneReference(rendered, parameters);
  const request = { ...state.args(), expectedRevision: state.document.revision, ...parameters, requestId: 'range-load-once' };
  const result = value(await call('load_color_range_selection', request)); state.document = result.document;
  equal(await storedPlane(env, state.document.selection), expected); equal(value(await call('load_color_range_selection', request)), result);
  assert.equal(failure(await call('load_color_range_selection', { ...request, requestId: 'range-stale' })).code, 'REVISION_CONFLICT');
  await state.edit('undo'); assert.equal(state.document.selection, null);
  await state.edit('apply_transaction', { label: 'Load and save range', operations: [
    { command: 'load_color_range_selection', args: parameters }, { command: 'save_selection', args: { name: 'Range snapshot' } },
  ] });
  equal(await storedPlane(env, state.document.selection), expected); equal(state.document.savedSelections[0].mask, state.document.selection);
  const stable = structuredClone(state.document), stableBytes = await projectBytes(env, stable), stableNames = await assetNames(env);
  failure(await call('apply_transaction', { ...state.args(), expectedRevision: stable.revision, label: 'Late failure', operations: [
    { command: 'load_color_range_selection', args: { colors: ['#ffffff'], tolerance: 255 } }, { command: 'delete_layer', args: { layerId: 'missing' } },
  ] }));
  equal(await state.get(), stable); equal(await projectBytes(env, stable), stableBytes); equal(await assetNames(env), stableNames);
  await state.edit('clear_selection');
  assert.equal(failure(await call('load_color_range_selection', { ...state.args(), expectedRevision: state.document.revision, colors: ['#000000'], mode: 'intersect' })).code, 'NO_SELECTION');
  await state.edit('set_layer', { layerId: state.document.layers[0].id, visible: false });
  await state.edit('load_color_range_selection', { colors: ['#000000'] }); equal(state.document.selection.runs, []);
  const inverted = await grayResult(await call('get_color_range_preview', { ...state.args(), colors: ['#000000'], invert: true }));
  assert.ok(inverted.gray.every(byte => byte === 255));
  const single = await importPixels(env, 'Continuous range feather', Buffer.from([186, 0, 0, 255]), 1, 1), continuous = editor(env, single.document);
  await continuous.edit('select_region', { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: 3 });
  await continuous.edit('load_color_range_selection', { colors: ['#000000'], tolerance: 0, falloff: 255, mode: 'intersect' });
  equal(await storedPlane(env, continuous.document.selection), Buffer.from([11]));
  equal(await fs.readFile(fixture.input), fixture.png);
});

test('official MCP photographic Color Range survives editing, preview sampling, source filters and Fill, portable transfer and restart', { timeout: 60000 }, async t => {
  const env = await setup(t), { call } = env;
  const png = await fs.readFile(path.join(root, 'tests/fixtures/tonal-color/astronaut.png'));
  const fixture = await importPng(env, 'Photographic Color Range', png), original = await rgba(png), state = editor(env, fixture.document);
  const sourceId = state.document.layers[0].id, parameters = { colors: ['#e06942', '#190d38'], tolerance: 32, falloff: 32 };
  const expected = colorRangePlaneReference(original, parameters);
  await state.edit('load_color_range_selection', parameters); equal(await storedPlane(env, state.document.selection), expected);
  equal(await state.exported(), original);
  await state.edit('save_selection', { name: 'Warm and blue' }); const savedId = state.document.savedSelections[0].id;
  const preview = await grayResult(await call('get_color_range_preview', { ...state.args(), expectedRevision: state.document.revision, ...parameters, maxEdge: 137 }));
  const sampled = colorRangePreviewReference(original, 512, 512, parameters, 137);
  equal(preview.gray, sampled.gray); assert.equal(preview.metadata.width, sampled.width); assert.equal(preview.metadata.height, sampled.height);
  await state.edit('add_adjustment', { kind: 'invert', value: 100 });
  const adjustment = state.document.layers.at(-1), graded = Buffer.from(original);
  for (let p = 0; p < expected.length; p++) for (let c = 0; c < 3; c++) { const i = p * 4 + c; graded[i] = Math.round(original[i] + (255 - 2 * original[i]) * expected[p] / 255); }
  equal(await state.exported(), graded);
  await state.edit('delete_layer', { layerId: adjustment.id });
  await state.edit('add_layer_filter', { layerId: sourceId, kind: 'brightness', value: 10 });
  await state.edit('set_layer_fill', { layerId: sourceId, fillOpacity: .625 });
  await state.edit('set_layer_effects', { layerId: sourceId, effects: { shadow: { color: '#663311', opacity: .4, x: 3, y: 5, blur: 3 } } });
  const treated = await state.exported(), treatedRange = colorRangePlaneReference(treated, parameters);
  await state.edit('load_color_range_selection', parameters); equal(await storedPlane(env, state.document.selection), treatedRange);
  await state.edit('load_selection', { selectionId: savedId }); equal(await storedPlane(env, state.document.selection), expected);
  const portable = value(await call('export_project', { documentId: state.document.id, expectedRevision: state.document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'range-photo-portable' })).document;
  equal(restored.layers, state.document.layers); equal(restored.selection, state.document.selection); equal(restored.savedSelections, state.document.savedSelections);
  equal(await editor(env, restored).exported(), treated);
  const persisted = structuredClone(state.document); await env.restart(); state.document = await state.get(); equal(state.document, persisted);
  equal(await storedPlane(env, state.document.selection), expected); equal(await state.exported(), treated);
  equal(await fs.readFile(fixture.input), png); equal(await fs.readFile(path.join(env.native.assetsDir, state.document.layers[0].sourceAsset)), png);
});

test('official MCP Codex handoff retains Color Range coverage and hard protected pixels across a stale result, local apply and restart', { timeout: 60000 }, async t => {
  const env = await setup(t), { call } = env, width = 512, height = 512;
  const png = await fs.readFile(path.join(root, 'tests/fixtures/tonal-color/astronaut.png'));
  const fixture = await importPng(env, 'Dense protected handoff', png), original = await rgba(png);
  const state = editor(env, fixture.document), parameters = { colors: ['#e06942', '#190d38'], tolerance: 32, falloff: 32 }, coverage = colorRangePlaneReference(original, parameters);
  await state.edit('load_color_range_selection', parameters);
  equal(await storedPlane(env, state.document.selection), coverage);
  const dense = structuredClone(state.document.selection);
  await state.edit('add_shape', { shape: 'rectangle', x: 128, y: 128, width: 128, height: 128, fill: '#2255ee' });
  const protectedId = state.document.layers.at(-1).id;
  await state.edit('mask_from_selection', { layerId: protectedId });
  equal(state.document.layers.at(-1).mask, dense);
  await state.edit('set_layer_protection', { layerId: protectedId, protected: true });
  await state.edit('group_layers', { layerIds: [protectedId], name: 'Protected dense-mask content' });
  const before = await state.exported();
  const request = { documentId: state.document.id, expectedRevision: state.document.revision, scope: 'selection',
    prompt: 'Replace only selected background pixels; preserve protected content exactly.', requestId: 'range-codex-selection-once' };
  const job = value(await call('edit_image', request)).job;
  assert.equal(job.provider, 'codex'); assert.equal(job.status, 'awaiting_image');
  assert.equal(value(await call('edit_image', request)).job.id, job.id);
  const response = await call('get_generation_handoff', { jobId: job.id }), handoff = value(response);
  assert.equal(response.content.filter(item => item.type === 'image').length, 2);
  equal(await rgba(await fs.readFile(handoff.assets.input.path)), before);
  const mask = await rgba(await fs.readFile(handoff.assets.mask.path)), expectedAlpha = Buffer.alloc(width * height);
  let protectedCount = 0, partialCount = 0, emptyCount = 0;
  for (let p = 0; p < expectedAlpha.length; p++) {
    const x = p % width, y = Math.floor(p / width), protectedPixel = x >= 128 && x < 256 && y >= 128 && y < 256 && coverage[p] > 0;
    expectedAlpha[p] = protectedPixel ? 0 : coverage[p];
    assert.equal(mask[p * 4 + 3], 255 - expectedAlpha[p]);
    if (protectedPixel) protectedCount++;
    else if (expectedAlpha[p] > 0 && expectedAlpha[p] < 255) partialCount++;
    else if (expectedAlpha[p] === 0) emptyCount++;
  }
  assert.ok(protectedCount > 0); assert.ok(partialCount > 0); assert.ok(emptyCount > 0);
  equal(value(await call('get_generation_handoff', { jobId: job.id })).assets, handoff.assets);
  await state.edit('clear_selection');
  const pendingDocument = structuredClone(state.document);
  // This is an injected transport fixture, not evidence of a model-generated image.
  const returned = path.join(env.dataDir, 'synthetic-conversation-result.png'), generatedColor = [53, 183, 128];
  const returnedPng = await sharp({ create: { width, height, channels: 4, background: '#35b780' } }).png().toBuffer();
  await fs.writeFile(returned, returnedPng);
  const completed = value(await call('complete_generation', { jobId: job.id, path: returned }));
  assert.equal(completed.job.status, 'ready'); assert.equal(completed.job.error.code, 'REVISION_CONFLICT');
  equal(await state.get(), pendingDocument);
  const applied = value(await call('apply_generation', { jobId: job.id, expectedRevision: state.document.revision }));
  state.document = applied.document;
  assert.equal(state.document.selection, null);
  const generated = state.document.layers.find(layer => layer.provenance?.jobId === job.id);
  assert.ok(generated); assert.equal(generated.role, 'generated');
  equal(await fs.readFile(path.join(env.native.assetsDir, generated.sourceAsset)), returnedPng);
  const working = await rgba(await fs.readFile(path.join(env.native.assetsDir, generated.asset))), after = await state.exported();
  for (let p = 0; p < expectedAlpha.length; p++) {
    assert.equal(working[p * 4 + 3], expectedAlpha[p]);
    if (expectedAlpha[p] === 0) equal(after.subarray(p * 4, p * 4 + 4), before.subarray(p * 4, p * 4 + 4));
    else for (let c = 0; c < 3; c++) assert.equal(after[p * 4 + c], Math.round((before[p * 4 + c] * (255 - expectedAlpha[p]) + generatedColor[c] * expectedAlpha[p]) / 255));
    assert.equal(after[p * 4 + 3], 255);
  }
  const installed = structuredClone(state.document);
  assert.equal(value(await call('complete_generation', { jobId: job.id, path: returned })).job.status, 'succeeded');
  equal(await state.get(), installed);
  await state.edit('undo'); equal(await state.exported(), before);
  await state.edit('redo'); equal(await state.exported(), after);
  const persisted = structuredClone(state.document); await env.restart(); state.document = await state.get();
  equal(state.document, persisted); equal(await state.exported(), after);
  equal(await fs.readFile(fixture.input), png);
});

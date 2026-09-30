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
import { CHANNELS, CHANNEL_GOLDENS, channelPlaneReference, authoredFrame, highFrequencyRGBA, runCount } from './fixtures/dense-mask/reference.mjs';

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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-dense-mask-mcp-'));
  let companion, client, forbiddenCalls = 0, stderr = '';
  const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Channel selections must not call a provider, key or segmentation'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
    const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'dense-mask-channel-verification', version: '1.0.0' });
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

test('official MCP channels expose independent read/mutation policies, exact alpha/luma stages and one-step selection ownership', { timeout: 45000 }, async t => {
  const env = await setup(t), { call } = env;
  const caps = value(await call('capabilities', { backend: 'native' }));
  const status = value(await call('status')).backends.find(item => item.id === 'native');
  for (const field of ['denseMaskPolicy', 'denseMaskLimits', 'channelSelectionPolicy', 'channelSelectionChannels', 'channelPreviewLimits'])
    equal(status[field], caps[field]);
  assert.equal(caps.denseMaskPolicy, 'framed-raw-alpha8-v1'); assert.equal(caps.channelSelectionPolicy, 'composite-byte-alpha-v1');
  equal(caps.channelSelectionChannels, CHANNELS); assert.equal(caps.denseMaskLimits.maxHistoryBytes, 3_221_225_472);
  assert.equal(caps.channelPreviewLimits.maxBytes, 8_388_608);
  const tools = (await env.client.listTools()).tools;
  for (const command of ['get_channel_preview', 'load_channel_selection']) {
    assert.ok(caps.commands.includes(command)); const tool = tools.find(item => item.name === `prism_${command}`);
    assert.equal(tool.annotations.readOnlyHint, command === 'get_channel_preview');
    assert.equal(tool.inputSchema.additionalProperties, false); assert.match(tool.description, /composite-byte-alpha-v1/);
  }
  const pixels = Buffer.from(CHANNEL_GOLDENS.flatMap(item => item.rgba));
  const fixture = await importPixels(env, 'Channel literal bytes', pixels, CHANNEL_GOLDENS.length, 1);
  const state = editor(env, fixture.document), originalAssets = await assetNames(env);
  const initial = structuredClone(state.document), persisted = await projectBytes(env, initial);
  for (const channel of CHANNELS) for (const invert of [false, true]) {
    const { metadata, gray } = await grayResult(await call('get_channel_preview', { ...state.args(), expectedRevision: initial.revision, channel, invert, maxEdge: 32 }));
    assert.equal(metadata.documentId, initial.id); assert.equal(metadata.revision, initial.revision);
    assert.equal(metadata.channel, channel); assert.equal(metadata.invert, invert);
    assert.equal(metadata.coveragePolicy, 'composite-byte-alpha-v1'); assert.equal(metadata.sampling, 'nearest-pixel-center');
    assert.equal(metadata.sourceWidth, pixels.length / 4); assert.equal(metadata.sourceHeight, 1);
    const column = CHANNELS.indexOf(channel);
    equal(gray, Buffer.from(CHANNEL_GOLDENS.map(item => invert ? 255 - item.expected[column] : item.expected[column])));
  }
  equal(await state.get(), initial); equal(await projectBytes(env, initial), persisted); equal(await assetNames(env), originalAssets);
  await state.edit('select_rectangle', { x: 0, y: 0, width: 1, height: 1 });
  const preview = await grayResult(await call('get_channel_preview', { ...state.args(), expectedRevision: state.document.revision }));
  equal(preview.gray, channelPlaneReference(pixels, 'luma'));
  const once = { ...state.args(), expectedRevision: state.document.revision, channel: 'luma', requestId: 'channel-luma-load-once' };
  const result = value(await call('load_channel_selection', once)); state.document = result.document;
  equal(await storedPlane(env, state.document.selection), preview.gray);
  assert.equal(state.document.revision, once.expectedRevision + 1); equal(value(await call('load_channel_selection', once)), result);
  assert.equal(failure(await call('load_channel_selection', { ...once, requestId: 'channel-stale-load' })).code, 'REVISION_CONFLICT');
  const untouched = structuredClone(state.document), untouchedBytes = await projectBytes(env, untouched);
  for (const extra of [{ channel: 'rgb' }, { invert: 1 }, { layerId: initial.layers[0].id }, { threshold: 128 }]) {
    failure(await call('load_channel_selection', { ...state.args(), expectedRevision: state.document.revision, ...extra }));
    equal(await state.get(), untouched); equal(await projectBytes(env, untouched), untouchedBytes);
  }
  await state.edit('set_layer', { layerId: initial.layers[0].id, visible: false });
  await state.edit('load_channel_selection', { channel: 'alpha' });
  assert.ok(state.document.selection); assert.equal(state.document.selection.shape, 'bitmap'); equal(state.document.selection.runs, []);
  const inverted = await grayResult(await call('get_channel_preview', { ...state.args(), channel: 'alpha', invert: true }));
  assert.ok(inverted.gray.every(byte => byte === 255));
  await state.edit('clear_selection');
  assert.equal(failure(await call('load_channel_selection', { ...state.args(), expectedRevision: state.document.revision, mode: 'intersect' })).code, 'NO_SELECTION');

  const continuousFixture = await importPixels(env, 'Continuous feather combination', Buffer.from([69, 69, 69, 255]), 1, 1);
  const continuous = editor(env, continuousFixture.document);
  await continuous.edit('select_region', { shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: 3 });
  await continuous.edit('load_channel_selection', { channel: 'red', mode: 'intersect' });
  equal(await storedPlane(env, continuous.document.selection), Buffer.from([11]));
  equal(await fs.readFile(fixture.input), fixture.png);
});

test('official MCP photographic dense selections remain exact through masks, filling, canvas changes, portable transfer and restart', { timeout: 60000 }, async t => {
  const env = await setup(t), { call } = env;
  const png = await fs.readFile(path.join(root, 'tests/fixtures/tonal-color/astronaut.png'));
  const fixture = await importPng(env, 'Photographic channel workflow', png), original = await rgba(png);
  const state = editor(env, fixture.document), sourceId = state.document.layers[0].id;
  const sourceAssets = new Map(await Promise.all((await assetNames(env)).map(async name => [name, await fs.readFile(path.join(env.native.assetsDir, name))])));
  const expected = channelPlaneReference(original, 'luma'); assert.equal(runCount(expected), 205876);
  await state.edit('load_channel_selection');
  assert.equal(state.document.selection.shape, 'alpha8'); equal(await storedPlane(env, state.document.selection), expected);
  equal(await state.exported(), original);
  const selection = structuredClone(state.document.selection), stored = await assetNames(env);
  await state.edit('save_selection', { name: 'Photographic luma' }); const savedId = state.document.savedSelections[0].id;
  await state.edit('load_channel_selection'); equal(state.document.selection, selection); equal(await assetNames(env), stored);
  const reduced = await grayResult(await call('get_channel_preview', { ...state.args(), expectedRevision: state.document.revision, channel: 'luma', maxEdge: 137 }));
  const sampled = Buffer.alloc(137 * 137);
  for (let y = 0; y < 137; y++) for (let x = 0; x < 137; x++) sampled[y * 137 + x] = expected[Math.floor((2 * y + 1) * 512 / 274) * 512 + Math.floor((2 * x + 1) * 512 / 274)];
  equal(reduced.gray, sampled); assert.equal(reduced.metadata.maxEdge, 137);
  const maskView = await grayResult(await call('get_mask_preview', { ...state.args(), source: 'selection', maxEdge: 700 }));
  equal(maskView.gray, expected);
  await state.edit('add_adjustment', { kind: 'invert', value: 100 });
  const adjustment = state.document.layers.at(-1); equal(adjustment.mask, selection);
  await state.edit('clear_selection');
  const graded = Buffer.from(original);
  for (let p = 0; p < expected.length; p++) for (let c = 0; c < 3; c++) {
    const i = p * 4 + c; graded[i] = Math.round(original[i] + (255 - 2 * original[i]) * expected[p] / 255);
  }
  equal(await state.exported(), graded);
  await state.edit('delete_layer', { layerId: adjustment.id });
  await state.edit('load_selection', { selectionId: savedId });
  await state.edit('add_layer_filter', { layerId: sourceId, kind: 'brightness', value: 0 });
  await state.edit('set_layer_filter_mask', { layerId: sourceId, source: 'selection' });
  equal(state.document.layers.find(layer => layer.id === sourceId).filterMask.coverage, selection);
  await state.edit('add_paint_layer', { name: 'Selection fill' }); const paintId = state.document.layers.at(-1).id;
  await state.edit('fill_area', { layerId: paintId, color: '#ff0000' });
  const paintLayer = state.document.layers.find(layer => layer.id === paintId);
  const paint = await rgba(await fs.readFile(path.join(env.native.assetsDir, paintLayer.asset)));
  for (let p = 0; p < expected.length; p++) {
    assert.equal(paint[p * 4 + 3], expected[p]); assert.equal(paint[p * 4], expected[p] ? 255 : 0);
    assert.equal(paint[p * 4 + 1], 0); assert.equal(paint[p * 4 + 2], 0);
  }
  await state.edit('mask_from_selection', { layerId: paintId });
  await state.edit('crop_document', { x: 1, y: 1, width: 510, height: 510 });
  const cropped = Buffer.alloc(510 * 510);
  for (let y = 0; y < 510; y++) expected.copy(cropped, y * 510, (y + 1) * 512 + 1, (y + 1) * 512 + 511);
  equal(await storedPlane(env, state.document.selection), cropped);
  await state.edit('resize_canvas', { width: 518, height: 516, anchor: 'bottom-right' });
  const expanded = Buffer.alloc(518 * 516);
  for (let y = 0; y < 510; y++) cropped.copy(expanded, (y + 6) * 518 + 8, y * 510, (y + 1) * 510);
  equal(await storedPlane(env, state.document.selection), expanded);
  equal(await storedPlane(env, state.document.savedSelections[0].mask), expanded);
  const layerMask = await grayResult(await call('get_mask_preview', { ...state.args(), source: 'layer-mask', layerId: paintId, maskMode: 'raw', maxEdge: 700 }));
  equal(layerMask.gray, expanded);
  equal(state.document.layers.find(layer => layer.id === sourceId).filterMask.coverage, selection);
  const finalGraph = structuredClone(state.document), finalPixels = await state.exported();
  await state.edit('undo'); equal(await storedPlane(env, state.document.selection), cropped);
  await state.edit('redo'); equal(state.document.selection, finalGraph.selection);
  const portable = value(await call('export_project', { documentId: state.document.id, expectedRevision: state.document.revision }));
  const restored = value(await call('import_project_file', { path: portable.path, requestId: 'dense-photo-portable' })).document;
  equal(restored.selection, state.document.selection); equal(restored.savedSelections, state.document.savedSelections);
  equal(restored.layers, state.document.layers); equal(await storedPlane(env, restored.selection), expanded);
  const copy = editor(env, restored); equal(await copy.exported(), finalPixels);
  const persisted = structuredClone(state.document); await env.restart(); state.document = await state.get();
  equal(state.document, persisted); equal(await storedPlane(env, state.document.selection), expanded);
  equal(await state.exported(), finalPixels);
  for (const [name, bytes] of sourceAssets) equal(await fs.readFile(path.join(env.native.assetsDir, name)), bytes);
  equal(await fs.readFile(fixture.input), png);
});

test('official MCP dense publication on a 1MP mixed-alpha source is atomic for transactions, deduplication and real persistence failure', { timeout: 60000 }, async t => {
  const env = await setup(t), { call } = env, width = 1024, height = 1024;
  const raw = highFrequencyRGBA(width, height), fixture = await importPixels(env, 'Dense one-megapixel source', raw, width, height);
  const state = editor(env, fixture.document), red = channelPlaneReference(raw, 'red'), blue = channelPlaneReference(raw, 'blue');
  assert.ok(runCount(red) > 200000); assert.ok(runCount(blue) > 200000);
  const before = structuredClone(state.document);
  await state.edit('apply_transaction', { label: 'Load and save exact red channel', operations: [
    { command: 'load_channel_selection', args: { channel: 'red' } }, { command: 'save_selection', args: { name: 'Red channel' } },
  ] });
  assert.equal(state.document.history.length, before.history.length + 1); assert.equal(state.document.selection.shape, 'alpha8');
  equal(await storedPlane(env, state.document.selection), red); equal(state.document.savedSelections[0].mask, state.document.selection);
  const stable = structuredClone(state.document), names = await assetNames(env), bytes = await projectBytes(env, stable);
  failure(await call('apply_transaction', { ...state.args(), expectedRevision: stable.revision, label: 'Rollback new blue mask', operations: [
    { command: 'load_channel_selection', args: { channel: 'blue' } }, { command: 'delete_layer', args: { layerId: 'missing-layer' } },
  ] }));
  equal(await state.get(), stable); equal(await projectBytes(env, stable), bytes); equal(await assetNames(env), names);
  const blueHash = authoredFrame(blue, width, height).descriptor.asset; assert.ok(!names.includes(blueHash));
  const projectsDir = env.native.projectsDir, blocker = path.join(env.dataDir, 'not-a-project-directory');
  await fs.writeFile(blocker, 'Intentional isolated ENOTDIR fixture');
  try {
    env.native.projectsDir = blocker;
    failure(await call('load_channel_selection', { ...state.args(), expectedRevision: stable.revision, channel: 'blue', requestId: 'dense-real-persist-failure' }));
  } finally { env.native.projectsDir = projectsDir; }
  equal(await state.get(), stable); equal(await projectBytes(env, stable), bytes); equal(await assetNames(env), names);
  await state.edit('load_channel_selection', { channel: 'red' });
  equal(await assetNames(env), names); equal(await storedPlane(env, state.document.selection), red);
  await state.edit('undo'); equal(state.document.selection, stable.selection);
  await state.edit('undo'); assert.equal(state.document.selection, before.selection); equal(state.document.savedSelections, before.savedSelections);
  await state.edit('redo'); equal(await storedPlane(env, state.document.selection), red);
  const persisted = structuredClone(state.document); await env.restart(); state.document = await state.get(); equal(state.document, persisted);
  equal(await storedPlane(env, state.document.selection), red);
  equal(await fs.readFile(fixture.input), fixture.png);
  equal(await fs.readFile(path.join(env.native.assetsDir, state.document.layers[0].sourceAsset)), fixture.png);
});

test('official MCP Codex handoff retains dense selection coverage and hard protected pixels across a stale result, local apply and restart', { timeout: 60000 }, async t => {
  const env = await setup(t), { call } = env, width = 512, height = 512;
  const png = await fs.readFile(path.join(root, 'tests/fixtures/tonal-color/astronaut.png'));
  const fixture = await importPng(env, 'Dense protected handoff', png), original = await rgba(png);
  const state = editor(env, fixture.document), coverage = channelPlaneReference(original, 'luma');
  await state.edit('load_channel_selection');
  assert.equal(state.document.selection.shape, 'alpha8');
  const dense = structuredClone(state.document.selection);
  await state.edit('add_shape', { shape: 'rectangle', x: 128, y: 128, width: 128, height: 128, fill: '#2255ee' });
  const protectedId = state.document.layers.at(-1).id;
  await state.edit('mask_from_selection', { layerId: protectedId });
  equal(state.document.layers.at(-1).mask, dense);
  await state.edit('set_layer_protection', { layerId: protectedId, protected: true });
  await state.edit('group_layers', { layerIds: [protectedId], name: 'Protected dense-mask content' });
  const before = await state.exported();
  const request = { documentId: state.document.id, expectedRevision: state.document.revision, scope: 'selection',
    prompt: 'Replace only selected background pixels; preserve protected content exactly.', requestId: 'dense-codex-selection-once' };
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
  assert.ok(protectedCount > 10000); assert.ok(partialCount > 100000); assert.ok(emptyCount > 0);
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

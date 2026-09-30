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
import { linkedPerspectiveCorners } from '../shared/linked-perspective.mjs';

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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-linked-perspective-mcp-'));
  let companion, client, forbiddenCalls = 0, stderr = '';
  const tokens = [];
  const forbidden = async () => { forbiddenCalls++; throw Error('Linked Perspective must not call a provider, key or segmentation'); };
  async function start() {
    companion = await createCompanion({ dataDir, port: 0, getImageKey: forbidden, imageProvider: forbidden, segmentSubject: forbidden });
    const port = await companion.listen(); tokens.push(companion.token);
    client = new Client({ name: 'linked-perspective-verification', version: '1.0.0' });
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

test('official MCP linked Perspective corners retain ordinary Distort pixels, historical stages, source data and atomic refusal', { timeout: 60000 }, async t => {
  const env = await setup(t), width = 32, height = 24, pixels = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) pixels.set([(p * 17 + 41) % 256, (p * 31 + 7) % 256, (p * 43 + 113) % 256, [0, 1, 128, 255][p % 4]], p * 4);
  const fixture = await importPixels(env, 'Linked perspective source', pixels, width, height);
  const a = editor(env, fixture.document);
  const b = editor(env, value(await env.call('import_file', { path: fixture.input, name: 'Independent manual corners' })).document);
  const aId = a.document.layers[0].id, bId = b.document.layers[0].id;
  const layer = (state, id) => state.document.layers.find(item => item.id === id);
  const baseline = [{ x: 2.25, y: 1.25 }, { x: 29.5, y: 0.75 }, { x: 30.125, y: 22.5 }, { x: 1.5, y: 23.25 }];
  const frozen = structuredClone(baseline);
  for (const [state, id] of [[a, aId], [b, bId]]) {
    await state.edit('set_layer_fill', { layerId: id, fillOpacity: 0.375 });
    await state.edit('set_layer_effects', { layerId: id, effects: { shadow: { color: '#543018', opacity: 0.5, blur: 0, x: 2, y: 1 } } });
    await state.edit('add_layer_distort', { layerId: id, corners: baseline });
  }
  // Literal pair results use dyadic values, independently specified here.
  const cases = [
    ['horizontal', 0, 2, 4.25, 27.5], ['horizontal', 1, 2, 31.5, 0.25],
    ['horizontal', 2, 2, 32.125, -0.5], ['horizontal', 3, 2, 3.5, 28.125],
    ['vertical', 0, 1.5, 2.75, 21.75], ['vertical', 1, 1.5, 2.25, 21],
    ['vertical', 2, 1.5, 24, -0.75], ['vertical', 3, 1.5, 24.75, -0.25],
  ];
  for (const [axis, cornerIndex, delta, selected, partnerValue] of cases) {
    const manual = structuredClone(baseline), partnerIndex = axis === 'horizontal' ? [1, 0, 3, 2][cornerIndex] : [3, 2, 1, 0][cornerIndex], coordinate = axis === 'horizontal' ? 'x' : 'y';
    manual[cornerIndex][coordinate] = selected; manual[partnerIndex][coordinate] = partnerValue;
    const candidate = linkedPerspectiveCorners(baseline, { cornerIndex, axis, delta });
    equal(candidate.corners, manual); assert.equal(candidate.partnerIndex, partnerIndex); assert.equal(candidate.withinBounds, true);
    const request = { ...a.args(), expectedRevision: a.document.revision, layerId: aId, transformIndex: 0, corners: candidate.corners,
      requestId: `linked-${axis}-${cornerIndex}` };
    const beforeHistory = a.document.history.length;
    a.document = value(await env.call('update_layer_distort', request)).document;
    equal(value(await env.call('update_layer_distort', request)).document, a.document);
    assert.equal(a.document.history.length, beforeHistory + 1);
    await b.edit('update_layer_distort', { layerId: bId, transformIndex: 0, corners: manual });
    equal(layer(a, aId).transforms, layer(b, bId).transforms); equal(await a.exported(), await b.exported());
    assert.equal(layer(a, aId).fillOpacity, 0.375);
  }
  equal(baseline, frozen);
  for (const [state, id] of [[a, aId], [b, bId]]) {
    await state.edit('transform_layer', { layerId: id, x: 1, y: -1 });
    await state.edit('resize_document', { width: 40, height: 30, resample: 'nearest' });
  }
  const suffix = structuredClone(layer(a, aId).transforms.slice(1));
  const beforeUpdate = structuredClone(a.document), beforePixels = await a.exported();
  const candidate = linkedPerspectiveCorners(baseline, { cornerIndex: 0, axis: 'horizontal', delta: 2 });
  const manual = [{ x: 4.25, y: 1.25 }, { x: 27.5, y: 0.75 }, { x: 30.125, y: 22.5 }, { x: 1.5, y: 23.25 }];
  await a.edit('update_layer_distort', { layerId: aId, transformIndex: 0, corners: candidate.corners });
  await b.edit('update_layer_distort', { layerId: bId, transformIndex: 0, corners: manual });
  equal(layer(a, aId).transforms.slice(1), suffix); equal(layer(a, aId).transforms, layer(b, bId).transforms);
  assert.equal(layer(a, aId).transforms[0].width, width); assert.equal(layer(a, aId).transforms[0].height, height);
  const accepted = structuredClone(a.document), finalPixels = await a.exported(); equal(finalPixels, await b.exported());
  await a.edit('undo'); equal(a.document.layers, beforeUpdate.layers); equal(await a.exported(), beforePixels);
  await a.edit('redo'); equal(a.document.layers, accepted.layers); equal(await a.exported(), finalPixels);
  const stable = structuredClone(a.document), file = path.join(env.native.projectsDir, `${a.document.id}.json`), disk = await fs.readFile(file);
  const outOfBounds = linkedPerspectiveCorners(baseline, { cornerIndex: 0, axis: 'horizontal', delta: 32768 });
  assert.equal(outOfBounds.withinBounds, false);
  failure(await env.call('update_layer_distort', { ...a.args(), expectedRevision: a.document.revision, layerId: aId, transformIndex: 0, corners: outOfBounds.corners }));
  failure(await env.call('update_layer_distort', { ...a.args(), expectedRevision: a.document.revision, layerId: aId, transformIndex: 0, corners: manual, mode: 'perspective' }));
  const crossed = linkedPerspectiveCorners(baseline, { cornerIndex: 0, axis: 'horizontal', delta: 20 });
  assert.equal(crossed.withinBounds, true);
  failure(await env.call('apply_transaction', { ...a.args(), expectedRevision: a.document.revision, label: 'Reject a later invalid paired quad', operations: [
    { command: 'update_layer_distort', args: { layerId: aId, transformIndex: 0, corners: baseline } },
    { command: 'update_layer_distort', args: { layerId: aId, transformIndex: 0, corners: crossed.corners } },
  ] }));
  equal(await a.get(), stable); equal(await fs.readFile(file), disk); equal(await a.exported(), finalPixels);
  const portable = value(await env.call('export_project', { documentId: a.document.id, expectedRevision: a.document.revision }));
  const restored = value(await env.call('import_project_file', { path: portable.path, requestId: 'linked-perspective-portable' })).document;
  equal(restored.layers, a.document.layers); equal(await editor(env, restored).exported(), finalPixels);
  await env.restart(); equal(await a.get(), stable); equal(await a.exported(), finalPixels);
  equal(await fs.readFile(fixture.input), fixture.png); equal(await fs.readFile(path.join(env.native.assetsDir, layer(a, aId).sourceAsset)), fixture.png);
});

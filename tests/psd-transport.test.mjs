import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCompanion } from '../server/index.mjs';
import { createPsdRoutes } from '../server/psd-routes.mjs';
import { PSD_MIME_TYPE } from '../server/psd-export.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = response => { assert.notEqual(response.isError, true, JSON.stringify(response.content)); return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text); };
const failure = response => { assert.equal(response.isError, true); return JSON.parse(response.content.find(item => item.type === 'text').text); };
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function until(predicate) { for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('Expected event did not arrive.'); }
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-psd-transport-'));
  const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { throw Error('No keys'); }, imageProvider: async () => { throw Error('No provider'); } });
  const origin = `http://127.0.0.1:${await companion.listen()}`;
  t.after(async () => { await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { companion, dataDir, origin, headers: { authorization: `Bearer ${companion.token}` } };
}
function merged(bytes, width, height) {
  const count = width * height, start = bytes.length - count * 3;
  assert.equal(bytes.readUInt16BE(start - 2), 0);
  const rgba = Buffer.alloc(count * 4, 255);
  for (let c = 0; c < 3; c++) for (let i = 0; i < count; i++) rgba[i * 4 + c] = bytes[start + c * count + i];
  return rgba;
}

test('PSD HTTP inspection/download enforce auth, expose precise compatibility and export the same unchanged revision', { timeout: 15000 }, async t => {
  const { companion, origin, headers } = await fixture(t);
  let document = (await companion.native.execute('create_document', { name: 'HTTP layered image', width: 32, height: 24, background: '#315579' })).document;
  const route = suffix => `${origin}/api/psd/${document.id}/${suffix}`;
  const wrongHost = url => new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { ...headers, host: 'untrusted.example' }, agent: false }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); request.on('error', reject);
  });
  for (const suffix of ['inspect', 'export']) {
    assert.equal((await fetch(route(suffix))).status, 401);
    assert.equal((await fetch(route(suffix), { headers: { ...headers, origin: 'https://untrusted.example' } })).status, 403);
    assert.equal(await wrongHost(route(suffix)), 403);
  }
  const status = await (await fetch(`${origin}/api/status`, { headers })).json();
  assert.deepEqual(status.backends.find(item => item.id === 'native').layeredExportFormats, ['psd']);
  const report = await (await fetch(route(`inspect?expectedRevision=${document.revision}`), { headers })).json();
  assert.equal(report.supported, true); assert.equal(report.requiresPixelValidation, false); assert.equal(report.documentId, document.id);
  const response = await fetch(route(`export?expectedRevision=${report.revision}`), { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), PSD_MIME_TYPE); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-prism-revision'), String(report.revision)); assert.equal(response.headers.get('x-prism-layer-count'), '1');
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, report.estimatedBytes); assert.equal(bytes.subarray(0, 4).toString(), '8BPS');
  assert.deepEqual(merged(bytes, 32, 24), await companion.native.renderGraph(document));
  assert.deepEqual((await companion.native.execute('get_document', { documentId: document.id })).document, document);
  for (const suffix of ['inspect?expectedRevision=0', 'inspect?expectedRevision=NaN', 'export?expectedRevision=1.5']) assert.equal((await fetch(route(suffix), { headers })).status, 400);
  assert.equal((await fetch(`${origin}/api/psd/not-a-uuid/export`, { headers })).status, 400);
  assert.equal((await fetch(route('import'), { headers })).status, 404);
  assert.equal((await fetch(route('export'), { method: 'POST', headers })).status, 404);
  document = (await companion.native.execute('add_text', { documentId: document.id, expectedRevision: document.revision, text: 'Keep editable', x: 1, y: 1, fontSize: 10, color: '#ffffff' })).document;
  const unsupported = await fetch(route('export'), { headers }); assert.equal(unsupported.status, 422);
  const body = await unsupported.json(); assert.equal(body.error.code, 'PSD_UNSUPPORTED'); assert.equal(body.report.supported, false);
  assert.ok(body.report.issues.some(item => item.layerId === document.layers.at(-1).id && item.layerName === document.layers.at(-1).name));
  for (const suffix of ['inspect', 'export']) assert.equal((await fetch(route(`${suffix}?expectedRevision=${report.revision}`), { headers })).status, 409);
});

test('disconnected PSD downloads release both bounded slots after queued exports finish', { timeout: 10000 }, async t => {
  const barrier = gate(); let entered = 0, closed = 0;
  const handler = createPsdRoutes({ exportPsd: async ({ documentId }) => { entered++; await barrier.promise; return { data: Buffer.from('fixture'), filename: 'Fixture.psd', documentId, revision: 1, report: { layerCount: 1 } }; } });
  const server = http.createServer((request, response) => {
    response.on('close', () => { closed++; });
    const json = (reply, status, body) => { reply.writeHead(status, { 'content-type': 'application/json' }); reply.end(JSON.stringify(body)); };
    handler({ request, response, url: new URL(request.url, 'http://127.0.0.1'), json }).catch(error => { if (!response.destroyed) json(response, 400, { code: error.code }); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { barrier.release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/psd/${randomUUID()}/export`;
  const clients = Array.from({ length: 2 }, () => { const request = http.get(url); request.on('error', () => {}); return request; });
  await until(() => entered === 2);
  assert.equal((await (await fetch(url)).json()).code, 'QUEUE_FULL'); assert.equal(entered, 2);
  clients.forEach(request => request.destroy()); await until(() => closed >= 2);
  barrier.release(); await new Promise(resolve => setTimeout(resolve, 20));
  const response = await fetch(url); assert.equal(response.status, 200); assert.equal(await response.text(), 'fixture'); assert.equal(entered, 3);
});

test('official MCP writes private unique layered PSD copies and rejects stale/unsupported/racing exports without files', { timeout: 20000 }, async t => {
  const { companion, origin, dataDir } = await fixture(t);
  const client = new Client({ name: 'psd-mcp-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], cwd: root, env: { PRISM_URL: origin, PRISM_DATA_DIR: dataDir }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(async () => { await client.close(); assert.ok(!stderr.includes(companion.token)); });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name: `prism_${name}`, arguments: args });
  let document = value(await call('create_document', { backend: 'native', name: 'MCP layered image', width: 40, height: 32, background: '#315579' })).document;
  async function edit(name, fields) { document = value(await call(name, { backend: 'native', documentId: document.id, expectedRevision: document.revision, ...fields })).document; }
  const source = await sharp({ create: { width: 20, height: 16, channels: 4, background: '#cf7954' } }).png().toBuffer();
  const input = path.join(dataDir, 'source.png'); await fs.writeFile(input, source);
  const sourceDoc = value(await call('import_file', { path: input, name: '髪 🌿' })).document;
  await edit('place_layer', { sourceDocumentId: sourceDoc.id, sourceLayerId: sourceDoc.layers[0].id, sourceExpectedRevision: sourceDoc.revision, x: 2, y: 3, width: 20, height: 16 });
  await edit('set_layer_mask', { layerId: document.layers.at(-1).id, mask: { x: 3, y: 4, width: 16, height: 12 } });
  const args = { documentId: document.id, expectedRevision: document.revision };
  const report = value(await call('inspect_psd_export', args)); assert.equal(report.supported, true); assert.equal(report.layerCount, 2);
  const first = value(await call('export_psd', args)), second = value(await call('export_psd', args));
  assert.notEqual(first.path, second.path); assert.equal(first.mimeType, PSD_MIME_TYPE); assert.equal(first.layered, true); assert.equal(first.revision, document.revision);
  assert.equal(path.dirname(first.path), path.join(dataDir, 'exports')); assert.equal(path.extname(first.path), '.psd'); assert.equal((await fs.stat(first.path)).mode & 0o777, 0o600);
  const bytes = await fs.readFile(first.path); assert.deepEqual(await fs.readFile(second.path), bytes); assert.equal(first.bytes, bytes.length); assert.equal(first.report.estimatedBytes, bytes.length);
  assert.deepEqual(merged(bytes, 40, 32), await companion.native.renderGraph(document));
  assert.deepEqual(await fs.readFile(input), source);
  assert.deepEqual(value(await call('get_document', { backend: 'native', documentId: document.id })).document, document);
  const files = await fs.readdir(path.join(dataDir, 'exports'));
  assert.equal(failure(await call('export_psd', { ...args, expectedRevision: document.revision - 1 })).code, 'REVISION_CONFLICT');
  await edit('set_layer_protection', { layerId: document.layers.at(-1).id, protected: false });
  await edit('add_layer_filter', { layerId: document.layers.at(-1).id, kind: 'brightness', value: 5 });
  const unsupported = failure(await call('export_psd', { documentId: document.id }));
  assert.equal(unsupported.code, 'PSD_UNSUPPORTED'); assert.ok(unsupported.report.issues.some(item => item.code === 'FILTER_STACK_UNSUPPORTED'));
  await edit('clear_layer_filters', { layerId: document.layers.at(-1).id });
  const inspect = companion.native.inspectPsdExport.bind(companion.native);
  companion.native.inspectPsdExport = async fields => {
    const checked = await inspect(fields);
    document = (await companion.native.execute('set_layer', { documentId: document.id, expectedRevision: document.revision, layerId: document.layers.at(-1).id, name: 'Changed after inspection' })).document;
    return checked;
  };
  assert.equal(failure(await call('export_psd', { documentId: document.id })).code, 'REVISION_CONFLICT');
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'exports')), files);
});

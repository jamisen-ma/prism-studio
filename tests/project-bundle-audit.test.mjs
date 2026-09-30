import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NativeBackend } from '../server/native.mjs';
import { encodeProjectBundle } from '../server/project-bundle.mjs';
import { createProjectRoutes, PROJECT_MIME, MAX_PROJECT_BUNDLE_BYTES } from '../server/project-routes.mjs';
import { createCompanion } from '../server/index.mjs';

const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#23578b' } }).png().toBuffer();
const other = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#cc6622' } }).png().toBuffer();
const hash = data => createHash('sha256').update(data).digest('hex');
const coded = code => cause => cause.code === code;
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function until(predicate) { for (let tries = 0; tries < 500; tries++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('Fixture did not reach the required event.'); }
async function backend(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-project-audit-'));
  const native = await new NativeBackend({ dataDir }).init();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return native;
}
async function files(directory) { return Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name))]))); }
const importPNG = async (native, bytes = png) => (await native.execute('import_image', { name: 'Existing original', data: bytes.toString('base64'), mimeType: 'image/png' })).document;

test('clients aborting before native export completes release both transfer slots', { timeout: 10000 }, async t => {
  const barrier = gate(); let entered = 0, closed = 0;
  const route = createProjectRoutes({ exportProject: async () => { entered++; await barrier.promise; return { data: Buffer.from('fixture'), filename: 'Fixture.prism', documentId: randomUUID(), revision: 1 }; } });
  const server = http.createServer((request, response) => {
    response.on('close', () => { closed++; });
    const json = (reply, status, result) => { reply.writeHead(status, { 'content-type': 'application/json' }); reply.end(JSON.stringify(result)); };
    route({ request, response, url: new URL(request.url, 'http://127.0.0.1'), json }).catch(error => { if (!response.destroyed) json(response, 400, { code: error.code }); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { barrier.release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const clients = Array.from({ length: 2 }, () => { const request = http.get(`${origin}/api/projects/${randomUUID()}/export`); request.on('error', () => {}); return request; });
  await until(() => entered === 2);
  assert.equal((await (await fetch(`${origin}/api/projects/missing`)).json()).code, 'QUEUE_FULL', 'A third transfer must reject while two exports are active.');
  assert.equal(entered, 2);
  clients.forEach(request => request.destroy()); await until(() => closed >= 2);
  barrier.release(); await new Promise(resolve => setTimeout(resolve, 20));
  const response = await fetch(`${origin}/api/projects/missing`);
  assert.equal((await response.json()).code, 'NOT_FOUND', 'Aborted responses must not permanently occupy the two allowed transfer slots.');
});

test('failed import rolls back fresh images and a newly persisted document while preserving shared existing assets', async t => {
  const source = await backend(t), target = await backend(t);
  let sourceDoc = await importPNG(source), targetDoc = await importPNG(target);
  const second = await importPNG(source, other);
  sourceDoc = (await source.execute('place_layer', { documentId: sourceDoc.id, expectedRevision: sourceDoc.revision, sourceDocumentId: second.id,
    sourceLayerId: second.layers[0].id, sourceExpectedRevision: second.revision, x: 0, y: 0, width: 8, height: 8 })).document;
  const bundle = (await source.exportProject({ documentId: sourceDoc.id })).data;
  const beforeProjects = await files(target.projectsDir), beforeAssets = await files(target.assetsDir), beforePixels = await target.renderGraph(targetDoc);
  const persist = target.persist.bind(target); let reached = false;
  target.persist = async project => { await persist(project); reached = true; throw Object.assign(new Error('Injected failure after publication'), { code: 'EIO' }); };
  await assert.rejects(target.importProject({ data: bundle }), coded('PROJECT_IMPORT_FAILED'));
  assert.equal(reached, true);
  assert.deepEqual(await files(target.projectsDir), beforeProjects); assert.deepEqual(await files(target.assetsDir), beforeAssets);
  assert.equal(target.projects.size, 1); assert.deepEqual(await target.renderGraph(targetDoc), beforePixels);
  target.persist = persist;
  const reopened = await new NativeBackend({ dataDir: target.dataDir }).init();
  assert.equal(reopened.projects.size, 1); assert.deepEqual(reopened.loadWarnings, []);
});

test('hash-valid malformed images and wrong source dimensions reject before publishing any files', async t => {
  const native = await backend(t), original = await importPNG(native);
  const beforeProjects = await files(native.projectsDir), beforeAssets = await files(native.assetsDir);
  for (const bytes of [png.subarray(0, 48), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///unreadable"/></svg>'), await sharp(png).resize(7, 8).png().toBuffer()]) {
    const id = hash(bytes), graph = { name: 'Invalid source', width: 8, height: 8, selection: null, layers: [{ ...original.layers[0], asset: id, sourceAsset: id, sourceFormat: 'png' }] };
    const data = await encodeProjectBundle({ graph, readAsset: async () => bytes, validateGraph: native.validateGraph.bind(native) });
    await assert.rejects(native.importProject({ data }), coded('INVALID_PROJECT_BUNDLE'));
    assert.deepEqual(await files(native.projectsDir), beforeProjects); assert.deepEqual(await files(native.assetsDir), beforeAssets);
  }
  assert.equal(native.projects.size, 1);
});

test('imported generated provenance cannot intercept completion of the original live generation job', async t => {
  const source = await backend(t), target = await backend(t), jobId = randomUUID();
  const generated = await source.installGeneratedImage({ data: png, provenance: { jobId, mode: 'generate', model: 'codex-imagegen' } });
  const data = (await source.exportProject({ documentId: generated.document.id })).data;
  const imported = await target.importProject({ data });
  assert.equal(imported.document.layers[0].provenance.jobId, jobId);
  assert.equal(imported.document.layers[0].provenance.imported, true);
  const completed = await target.installGeneratedImage({ data: other, provenance: { jobId, mode: 'generate', model: 'codex-imagegen' } });
  assert.notEqual(completed.document.id, imported.document.id); assert.equal(target.projects.size, 2);
  assert.deepEqual(await target.renderGraph(imported.document), await sharp(png).ensureAlpha().raw().toBuffer());
  assert.deepEqual(await target.renderGraph(completed.document), await sharp(other).ensureAlpha().raw().toBuffer());
  assert.equal((await target.installGeneratedImage({ data: other, provenance: { jobId, mode: 'generate' } })).document.id, completed.document.id);
  assert.equal(target.projects.size, 2);
});

test('binary project routes require origin/authentication, keep bounded receipts and leave originals unchanged', { timeout: 10000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-project-http-audit-'));
  const companion = await createCompanion({ dataDir, port: 0, getImageKey: async () => { throw Error('No key reads'); }, imageProvider: async () => { throw Error('No provider calls'); } });
  t.after(async () => { await companion.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${await companion.listen()}`;
  const headers = { authorization: `Bearer ${companion.token}` };
  const rawRequest = (route, options = {}) => new Promise((resolve, reject) => {
    const request = http.request(origin + route, { ...options, agent: false }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject); request.setTimeout(1500, () => request.destroy(new Error(`Fixture HTTP request timed out: ${route} ${options.headers?.host || options.headers?.['content-length'] || options.headers?.['content-type'] || ''}`))); request.end();
  });
  const create = await fetch(`${origin}/api/command`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'native', command: 'create_document', args: { name: 'HTTP original', width: 8, height: 8 } }) });
  const original = (await create.json()).result.document;
  const exportPath = `/api/projects/${original.id}/export?expectedRevision=${original.revision}`;
  for (const route of [exportPath, '/api/projects/import']) {
    const options = route.endsWith('/import') ? { method: 'POST', body: Buffer.from('invalid'), headers: { 'content-type': PROJECT_MIME } } : {};
    assert.equal((await fetch(origin + route, options)).status, 401);
    assert.equal((await fetch(origin + route, { ...options, headers: { ...options.headers, ...headers, origin: 'https://untrusted.example' } })).status, 403);
    const wrongHost = await rawRequest(route, { method: options.method || 'GET', headers: { ...options.headers, ...headers, host: 'untrusted.example' } });
    assert.equal(wrongHost.status, 403); assert.equal(wrongHost.body.error.code, 'FORBIDDEN');
  }
  const oversized = await rawRequest('/api/projects/import', { method: 'POST', headers: { ...headers, 'content-type': PROJECT_MIME, 'content-length': String(MAX_PROJECT_BUNDLE_BYTES + 1) } });
  assert.equal(oversized.status, 413); assert.equal(oversized.body.error.code, 'PAYLOAD_TOO_LARGE');
  const wrongType = await rawRequest('/api/projects/import', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } });
  assert.equal(wrongType.status, 400); assert.equal(wrongType.body.error.code, 'INVALID_ARGUMENTS');
  const exported = await fetch(origin + exportPath, { headers });
  assert.equal(exported.headers.get('content-type'), PROJECT_MIME); assert.equal(exported.headers.get('x-prism-history-included'), 'false');
  const data = Buffer.from(await exported.arrayBuffer());
  const post = (name = 'Imported copy') => fetch(`${origin}/api/projects/import?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...headers, 'content-type': PROJECT_MIME, 'x-prism-request-id': 'http-import-retry' }, body: data });
  const results = await Promise.all([post(), post()]); const [first, second] = await Promise.all(results.map(response => response.json()));
  assert.equal(first.document.id, second.document.id); assert.notEqual(first.document.id, original.id);
  assert.equal(first.historyIncluded, false); assert.equal(first.document.history.length, 1);
  const conflict = await post('Different name'); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'REQUEST_CONFLICT');
  const again = await fetch(origin + exportPath, { headers }); assert.deepEqual(Buffer.from(await again.arrayBuffer()), data);
});
